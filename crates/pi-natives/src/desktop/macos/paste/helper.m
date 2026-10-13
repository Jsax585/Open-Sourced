// Paste worker: one JSON request per line, one JSON reply per request, plus a
// `read` line when an application requests the promised text; the request
// does not say which application made it. AppKit asks a data provider for
// promised pasteboard data on the owner's main run loop only, so this process
// keeps one running; the addon's host runs none. The worker owns the saved
// clipboard, and puts it back itself when its input closes or its parent
// exits with the text still promised.
#import <AppKit/AppKit.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// Clipboard history tools skip items carrying this marker (nspasteboard.org).
static NSPasteboardType const kTransientType = @"org.nspasteboard.TransientType";
// Marks the text's item with data unique to the paste. A tool that saves the
// clipboard by copying every type and puts that copy back later carries it
// along, so the worker can tell its own text coming back from a new copy,
// which never holds it.
static NSPasteboardType const kNonceType = @"org.oh-my-pi.paste-nonce";

static NSPasteboard *gBoard;
static NSString *gText;
static NSData *gNonce;
// The user's clipboard, one entry per item: its readable [type, data] pairs,
// and all its types, which include conversions AppKit derives and reads as nil.
// Kept after a conflict until `Reclaim` has run.
static NSArray<NSArray<NSArray *> *> *gSaved;
static NSArray<NSArray<NSPasteboardType> *> *gSavedTypes;
// The change count the text's write produced.
static NSInteger gWritten = -1;
// Whether the text is still promised and not yet put back or given up.
static BOOL gPromised;
// Test runs only: pause before each ownership check (see `main`).
static BOOL gStall;

static void Reply(NSDictionary *value) {
	NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
	if (!data) return;
	NSMutableData *line = [data mutableCopy];
	[line appendBytes:"\n" length:1];
	const uint8_t *cursor = line.bytes;
	size_t count = line.length;
	// A closed pipe only loses the reply; the restore on end of input still runs.
	while (count) {
		ssize_t written = write(STDOUT_FILENO, cursor, count);
		if (written < 0 && errno == EINTR) continue;
		if (written <= 0) return;
		cursor += written;
		count -= (size_t)written;
	}
}

@interface Provider : NSObject <NSPasteboardItemDataProvider>
@end

@implementation Provider
- (void)pasteboard:(NSPasteboard *)pasteboard item:(NSPasteboardItem *)item provideDataForType:(NSPasteboardType)type {
	if (gText) [item setString:gText forType:type];
	Reply(@{ @"kind": @"read", @"type": type });
}
@end

static Provider *gProvider;

static NSArray<NSArray<NSPasteboardType> *> *CurrentTypes(void) {
	NSMutableArray *types = [NSMutableArray array];
	for (NSPasteboardItem *item in gBoard.pasteboardItems) [types addObject:item.types ?: @[]];
	return types;
}

// Under `gStall`, says where it pauses and gives a test one second to copy.
static void Stall(NSString *at) {
	if (!gStall) return;
	Reply(@{ @"kind": @"stall", @"at": at });
	usleep(1000000);
}

static void Forget(void) {
	gSaved = nil;
	gSavedTypes = nil;
	gNonce = nil;
}

// Puts the saved clipboard back only while the pasteboard's change count is
// still `owner`: any later count belongs to someone else's copy. The count is
// read after the items are built, right before the clear, so a copy made
// meanwhile is kept; AppKit has no check-and-write, so a copy landing between
// those two calls can still be replaced.
static NSMutableDictionary *PutBack(NSInteger owner) {
	NSMutableArray *items = [NSMutableArray arrayWithCapacity:gSaved.count];
	for (NSArray<NSArray *> *entries in gSaved) {
		NSPasteboardItem *item = [NSPasteboardItem new];
		for (NSArray *entry in entries) [item setData:entry[1] forType:entry[0]];
		[items addObject:item];
	}
	Stall(@"restore");
	NSInteger before = gBoard.changeCount;
	NSMutableDictionary *reply = [@{
		@"kind": @"restore",
		@"ours": @(owner),
		@"before": @(before),
		@"saved": gSavedTypes,
	} mutableCopy];
	if (before == owner) {
		[gBoard prepareForNewContentsWithOptions:NSPasteboardContentsCurrentHostOnly];
		if (items.count) [gBoard writeObjects:items];
		reply[@"after"] = @(gBoard.changeCount);
		reply[@"now"] = CurrentTypes();
	}
	return reply;
}

// Puts the saved clipboard back while the pasteboard still holds the text. On
// a conflict the snapshot stays for `Reclaim`.
static NSDictionary *Restore(void) {
	if (!gPromised) return @{ @"kind": @"restore" };
	gPromised = NO;
	NSDictionary *reply = PutBack(gWritten);
	gText = nil;
	if (reply[@"after"]) Forget();
	return reply;
}

static BOOL HoldsNonce(void) {
	for (NSPasteboardItem *item in gBoard.pasteboardItems) {
		if ([[item dataForType:kNonceType] isEqual:gNonce]) return YES;
	}
	return NO;
}

// After a conflict, watches the pasteboard for up to `seconds`: once it holds
// this paste's nonce again, another tool has put back a copy it saved of the
// text, as one that saves the clipboard around its own paste does, and the
// saved clipboard goes back over it, gated on that change count. The reply
// reads as a conflict when the nonce never came back. Every poll looks for the
// nonce, not only those that see a new change count: a write clears the
// pasteboard, which raises the count, and adds its items a moment later (about
// 1 ms, up to 5 ms measured on macOS 26.5), so a poll in between finds the new
// count with nothing on it.
static NSDictionary *Reclaim(double seconds) {
	if (!gSaved || gPromised) return @{ @"kind": @"restore" };
	NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:seconds];
	while (deadline.timeIntervalSinceNow > 0) {
		NSInteger count = gBoard.changeCount;
		if (HoldsNonce()) {
			NSDictionary *reply = PutBack(count);
			if (reply[@"after"]) {
				Forget();
				return reply;
			}
		}
		usleep(20000);
	}
	Forget();
	return @{ @"kind": @"restore", @"ours": @(gWritten), @"before": @(gBoard.changeCount) };
}

// Saves the clipboard and promises `text` in its place, unless the clipboard
// changed since the save began; as in `Restore`, the check comes right before
// the clear.
static void Write(NSString *text) {
	if (gWritten >= 0) {
		Reply(@{ @"kind": @"error", @"error": @"this worker already wrote its text" });
		return;
	}
	NSInteger before = gBoard.changeCount;
	NSArray<NSArray<NSPasteboardType> *> *types = CurrentTypes();
	NSMutableArray *saved = [NSMutableArray arrayWithCapacity:types.count];
	for (NSPasteboardItem *item in gBoard.pasteboardItems) {
		NSMutableArray *entries = [NSMutableArray array];
		for (NSPasteboardType type in item.types) {
			NSData *data = [item dataForType:type];
			if (data) [entries addObject:@[type, data]];
		}
		[saved addObject:entries];
	}
	NSPasteboardItem *item = [NSPasteboardItem new];
	NSData *nonce = [NSUUID.UUID.UUIDString dataUsingEncoding:NSUTF8StringEncoding];
	[item setDataProvider:gProvider forTypes:@[NSPasteboardTypeString]];
	[item setData:[NSData data] forType:kTransientType];
	[item setData:nonce forType:kNonceType];
	Stall(@"write");
	if (gBoard.changeCount != before) {
		Reply(@{ @"kind": @"changed" });
		return;
	}
	gSaved = saved;
	gSavedTypes = types;
	gText = text;
	gNonce = nonce;
	gWritten = [gBoard prepareForNewContentsWithOptions:NSPasteboardContentsCurrentHostOnly];
	gPromised = YES;
	if (![gBoard writeObjects:@[item]]) {
		Reply(@{ @"kind": @"error", @"error": @"the pasteboard refused the text" });
		return;
	}
	Reply(@{ @"kind": @"written", @"changeCount": @(gWritten) });
}

static void Request(NSData *line) {
	NSDictionary *request = [NSJSONSerialization JSONObjectWithData:line options:0 error:NULL];
	NSString *op = [request isKindOfClass:NSDictionary.class] ? request[@"op"] : nil;
	NSString *text = [op isEqual:@"write"] ? request[@"text"] : nil;
	if ([text isKindOfClass:NSString.class]) {
		Write(text);
	} else if ([op isEqual:@"restore"]) {
		Reply(Restore());
	} else if ([op isEqual:@"reclaim"] && [request[@"seconds"] isKindOfClass:NSNumber.class]) {
		Reply(Reclaim([request[@"seconds"] doubleValue]));
	} else {
		Reply(@{ @"kind": @"error", @"error": @"malformed paste request" });
	}
}

// The addon passes no arguments. Tests pass a pasteboard name to work on
// instead of the user's clipboard, and `stall` to pause before each
// ownership check.
int main(int argc, char **argv) {
	@autoreleasepool {
		signal(SIGPIPE, SIG_IGN);
		gBoard = argc > 1 ? [NSPasteboard pasteboardWithName:@(argv[1])] : NSPasteboard.generalPasteboard;
		gStall = argc > 2 && strcmp(argv[2], "stall") == 0;
		gProvider = [Provider new];
		pid_t parent = getppid();
		__attribute__((objc_precise_lifetime)) dispatch_source_t death = dispatch_source_create(
			DISPATCH_SOURCE_TYPE_PROC, (uintptr_t)parent, DISPATCH_PROC_EXIT, dispatch_get_main_queue());
		if (death) {
			dispatch_source_set_event_handler(death, ^{
				Restore();
				_exit(0);
			});
			dispatch_resume(death);
		}
		dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
			char *line = NULL;
			size_t capacity = 0;
			ssize_t length;
			while ((length = getline(&line, &capacity, stdin)) > 0) {
				NSData *data = [NSData dataWithBytes:line length:(NSUInteger)length];
				dispatch_sync(dispatch_get_main_queue(), ^{
					@autoreleasepool {
						Request(data);
					}
				});
			}
			free(line);
			dispatch_sync(dispatch_get_main_queue(), ^{
				Restore();
			});
			_exit(0);
		});
		[[NSRunLoop mainRunLoop] addPort:[NSMachPort port] forMode:NSDefaultRunLoopMode];
		[[NSRunLoop mainRunLoop] run];
		return 0;
	}
}
