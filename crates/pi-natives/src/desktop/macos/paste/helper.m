// Paste worker: one JSON request per line, one JSON reply per request, plus a
// `read` line when an application reads the promised text. AppKit asks a data
// provider for promised pasteboard data on the owner's main run loop only, so
// this process keeps one running; the addon's host runs none. The worker owns
// the saved clipboard, and puts it back itself when its input closes or its
// parent exits with the text still promised.
#import <AppKit/AppKit.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

// Clipboard history tools skip items carrying this marker (nspasteboard.org).
static NSPasteboardType const kTransientType = @"org.nspasteboard.TransientType";

static NSPasteboard *gBoard;
static NSString *gText;
// The user's clipboard, one entry per item: its readable [type, data] pairs,
// and all its types, which include conversions AppKit derives and reads as nil.
static NSArray<NSArray<NSArray *> *> *gSaved;
static NSArray<NSArray<NSPasteboardType> *> *gSavedTypes;
// The change count the text's write produced; -1 while nothing is promised.
static NSInteger gOurs = -1;

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

// Puts the saved clipboard back only while the pasteboard still holds this
// worker's write: any later change count belongs to someone else's copy.
static NSDictionary *Restore(void) {
	if (gOurs < 0) return @{ @"kind": @"restore" };
	NSInteger before = gBoard.changeCount;
	NSMutableDictionary *reply = [@{
		@"kind": @"restore",
		@"ours": @(gOurs),
		@"before": @(before),
		@"saved": gSavedTypes,
	} mutableCopy];
	if (before == gOurs) {
		NSMutableArray *items = [NSMutableArray arrayWithCapacity:gSaved.count];
		for (NSArray<NSArray *> *entries in gSaved) {
			NSPasteboardItem *item = [NSPasteboardItem new];
			for (NSArray *entry in entries) [item setData:entry[1] forType:entry[0]];
			[items addObject:item];
		}
		[gBoard prepareForNewContentsWithOptions:NSPasteboardContentsCurrentHostOnly];
		if (items.count) [gBoard writeObjects:items];
		reply[@"after"] = @(gBoard.changeCount);
		reply[@"now"] = CurrentTypes();
	}
	gOurs = -1;
	gSaved = nil;
	gSavedTypes = nil;
	gText = nil;
	return reply;
}

static void Write(NSString *text) {
	if (gOurs >= 0) {
		Reply(@{ @"kind": @"error", @"error": @"text is already on the clipboard" });
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
	if (gBoard.changeCount != before) {
		Reply(@{ @"kind": @"changed" });
		return;
	}
	NSPasteboardItem *item = [NSPasteboardItem new];
	[item setDataProvider:gProvider forTypes:@[NSPasteboardTypeString]];
	[item setData:[NSData data] forType:kTransientType];
	gSaved = saved;
	gSavedTypes = types;
	gText = text;
	gOurs = [gBoard prepareForNewContentsWithOptions:NSPasteboardContentsCurrentHostOnly];
	if (![gBoard writeObjects:@[item]]) {
		Reply(@{ @"kind": @"error", @"error": @"the pasteboard refused the text" });
		return;
	}
	Reply(@{ @"kind": @"written", @"changeCount": @(gOurs) });
}

static void Request(NSData *line) {
	NSDictionary *request = [NSJSONSerialization JSONObjectWithData:line options:0 error:NULL];
	NSString *op = [request isKindOfClass:NSDictionary.class] ? request[@"op"] : nil;
	NSString *text = [op isEqual:@"write"] ? request[@"text"] : nil;
	if ([text isKindOfClass:NSString.class]) {
		Write(text);
	} else if ([op isEqual:@"restore"]) {
		Reply(Restore());
	} else {
		Reply(@{ @"kind": @"error", @"error": @"malformed paste request" });
	}
}

int main(void) {
	@autoreleasepool {
		signal(SIGPIPE, SIG_IGN);
		gBoard = NSPasteboard.generalPasteboard;
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
