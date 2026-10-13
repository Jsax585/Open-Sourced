//! Pasting text through the user's clipboard without keeping it there.
//!
//! A worker process saves every item and type on the clipboard, puts the text
//! there as a promise and serves it to whichever application requests it;
//! once one has, the worker puts the saved clipboard back unless
//! someone else wrote the clipboard meanwhile. `AppKit` asks a promise's owner
//! for the data on the owner's main run loop only, and the process hosting the
//! addon runs none, so the promise lives in a process that does.

use std::{
	io::{self, BufRead, BufReader, BufWriter, Write},
	process::{Child, ChildStdin, ChildStdout, Command, Stdio},
	thread,
	time::{Duration, Instant},
};

use objc2_app_kit::NSPasteboard;
use serde::{Deserialize, Serialize};

use super::super::{
	control,
	error::{CoreResult, DesktopError},
	native_helper::HelperDirectory,
};

const HELPER: &[u8] = include_bytes!(env!("OMP_PASTE_DARWIN_HELPER"));
/// How long the clipboard must stay unchanged before the text replaces it, so
/// an application still reading what another tool just put there (a
/// dictation tool's own paste) reads that, not the text.
const CLIPBOARD_QUIET: Duration = Duration::from_millis(200);
/// How long a paste waits for the clipboard to go quiet before giving up with
/// nothing written.
const QUIET_LIMIT: Duration = Duration::from_secs(2);
/// How long an application has to request the text after ⌘V before the
/// clipboard is put back.
const READ_TIMEOUT: Duration = Duration::from_secs(2);
/// Lets the target finish a paste whose text it requested before the
/// clipboard changes under it.
const READ_SETTLE: Duration = Duration::from_millis(150);
/// Bound on each worker reply; saving the clipboard has every application that
/// promised data on it render that data.
const REPLY_TIMEOUT: Duration = Duration::from_secs(5);
/// How often a wait on the worker checks for cancellation.
const POLL: Duration = Duration::from_millis(20);
/// How long after a conflict the worker watches for another app putting back
/// a copy it saved of the text, as a tool that saves the clipboard around its
/// own paste does.
const RECLAIM_WINDOW: Duration = Duration::from_secs(3);
/// How long a worker's helper has to put the clipboard back and exit once its
/// input closes before it is killed; longer than [`RECLAIM_WINDOW`].
const TEARDOWN_GRACE: Duration = REPLY_TIMEOUT;

/// The clipboard as a paste drives it; [`Worker`] is the real one.
pub(super) trait Clipboard {
	/// The pasteboard's change count, which every write raises.
	fn change_count(&self) -> isize;
	/// Saves the clipboard and promises `text` in its place.
	fn write(&mut self, text: &str) -> CoreResult<Written>;
	/// Whether an application requested the text, waiting up to `timeout`.
	fn await_read(&mut self, timeout: Duration) -> CoreResult<bool>;
	/// Puts the saved clipboard back while the pasteboard still holds the
	/// text; `None` when the worker did not answer.
	fn restore(&mut self) -> Option<Restored>;
	/// After a conflict, watches up to `window` for the pasteboard to hold this
	/// paste's text again, put back by an app that had saved it, and puts the
	/// saved clipboard back over it; `None` when the worker did not answer.
	fn reclaim(&mut self, window: Duration) -> Option<Restored>;
}

/// The worker's answer to a write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Written {
	/// The text is on the clipboard; the write raised the change count to this.
	Text(isize),
	/// The clipboard changed while it was being saved; nothing was written.
	Changed,
}

/// The worker's report of a restore, its fields as the worker read them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub(super) struct Restored {
	/// The change count the worker restores over: the text's write, or, after
	/// a reclaim, another app's copy of the text; absent when nothing was
	/// written.
	ours:   Option<isize>,
	/// The change count when the restore began.
	before: Option<isize>,
	/// The change count after the restore wrote; absent when it did not.
	after:  Option<isize>,
	/// Each saved item's types.
	#[serde(default)]
	saved:  Vec<Vec<String>>,
	/// Each item's types after the restore.
	#[serde(default)]
	now:    Vec<Vec<String>>,
}

/// What became of the user's clipboard.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Restore {
	/// Nothing was written, so nothing needed putting back.
	Untouched,
	/// The saved clipboard is back with every item and type.
	Back,
	/// Someone else wrote the clipboard after the text; it holds their copy.
	Conflict,
	/// Another app put back a copy it saved of the text, and the saved
	/// clipboard is back over it with every item and type.
	Reclaimed,
	/// The restore was attempted, but its result could not be read back.
	Unconfirmed,
}

/// Judges the worker's restore report. The worker writes only while the
/// change count is still the text's, so another count means someone else
/// wrote; a confirmed restore is one write later and has every saved type back
/// on the same item (`AppKit` may list derived conversions besides).
fn restore_verdict(reply: Option<&Restored>) -> Restore {
	let Some(reply) = reply else {
		return Restore::Unconfirmed;
	};
	let Some(ours) = reply.ours else {
		return Restore::Untouched;
	};
	if reply.before != Some(ours) {
		return Restore::Conflict;
	}
	let complete = reply.now.len() == reply.saved.len()
		&& reply
			.saved
			.iter()
			.zip(&reply.now)
			.all(|(saved, now)| saved.iter().all(|kind| now.contains(kind)));
	if reply.after == Some(ours + 1) && complete {
		Restore::Back
	} else {
		Restore::Unconfirmed
	}
}

/// What a paste did with its text and with the user's clipboard.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PasteOutcome {
	/// An application requested the text, and the user's clipboard is back.
	/// The request does not say which application made it, so it does not
	/// prove the target pasted.
	Provided,
	/// ⌘V went out, but no application requested the text in time; the user's
	/// clipboard is back, so a later read gets it, not the text.
	NoReadSeen,
	/// Another app wrote the clipboard while the text was on it, so it keeps
	/// that app's copy and was not put back.
	ClipboardConflict,
	/// Another app saved the clipboard while the text was on it and later put
	/// that copy back, as a tool that saves the clipboard around its own paste
	/// does; the user's clipboard is back over it. Its save requests the text,
	/// so `read` may be that app's request.
	Reclaimed,
	/// Putting the user's clipboard back was attempted but not confirmed.
	RestoreUnconfirmed,
}

impl PasteOutcome {
	pub(super) const fn as_str(self) -> &'static str {
		match self {
			Self::Provided => "provided",
			Self::NoReadSeen => "noReadSeen",
			Self::ClipboardConflict => "clipboardConflict",
			Self::Reclaimed => "reclaimed",
			Self::RestoreUnconfirmed => "restoreUnconfirmed",
		}
	}
}

/// What a paste did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Pasted {
	pub(super) outcome: PasteOutcome,
	/// Whether an application requested the text.
	pub(super) read:    bool,
}

/// The outcome a paste reports, from whether the text was requested and what
/// became of the clipboard; a clipboard left changed outranks the read.
const fn outcome(read: bool, restore: Restore) -> PasteOutcome {
	match restore {
		Restore::Conflict => PasteOutcome::ClipboardConflict,
		Restore::Reclaimed => PasteOutcome::Reclaimed,
		Restore::Unconfirmed => PasteOutcome::RestoreUnconfirmed,
		Restore::Back | Restore::Untouched if read => PasteOutcome::Provided,
		Restore::Back | Restore::Untouched => PasteOutcome::NoReadSeen,
	}
}

/// Adds what became of the clipboard to an error that ended a paste after
/// the text was written.
fn with_clipboard(mut error: DesktopError, restore: Restore) -> DesktopError {
	match restore {
		Restore::Untouched | Restore::Back | Restore::Reclaimed => {},
		Restore::Conflict => error.message.push_str(
			"; another app wrote the clipboard while the text was on it, so the clipboard was left \
			 as that app set it",
		),
		Restore::Unconfirmed => {
			error
				.message
				.push_str("; putting the user's clipboard back could not be confirmed");
		},
	}
	error
}

/// Waits until the clipboard has stayed unchanged for [`CLIPBOARD_QUIET`],
/// giving up after [`QUIET_LIMIT`].
struct Quiet {
	start: Instant,
	since: Instant,
	count: isize,
}

impl Quiet {
	const fn new(now: Instant, count: isize) -> Self {
		Self { start: now, since: now, count }
	}

	/// How much longer to wait when the change count reads `count` at `now`;
	/// `None` once the clipboard is quiet. A change seen between two reads
	/// counts from the later read.
	fn remaining(&mut self, now: Instant, count: isize) -> CoreResult<Option<Duration>> {
		if count != self.count {
			self.count = count;
			self.since = now;
		}
		let quiet = now.saturating_duration_since(self.since);
		if quiet >= CLIPBOARD_QUIET {
			return Ok(None);
		}
		let wait = CLIPBOARD_QUIET.saturating_sub(quiet);
		if now.saturating_duration_since(self.start) + wait > QUIET_LIMIT {
			return Err(DesktopError::input_failed(
				"the clipboard kept changing, so another app may be writing it; nothing was written \
				 to it and nothing was sent",
			));
		}
		Ok(Some(wait))
	}
}

/// Pastes `text`: `send` posts ⌘V, calling its argument once the keys are
/// proven to reach the target and right before the first key goes out. That
/// argument writes the text, after the clipboard has been quiet, and refuses
/// the keys if another app writes the clipboard before they go. Every path
/// after the write puts the clipboard back, unless another app wrote it.
pub(super) fn paste(
	clipboard: &mut impl Clipboard,
	text: &str,
	send: impl FnOnce(&mut dyn FnMut() -> CoreResult<()>) -> CoreResult<()>,
) -> CoreResult<Pasted> {
	let mut quiet = Quiet::new(Instant::now(), clipboard.change_count());
	let mut attempted = false;
	let sent = send(&mut || {
		let ours = loop {
			while let Some(wait) = quiet.remaining(Instant::now(), clipboard.change_count())? {
				control::wait(wait)?;
			}
			attempted = true;
			match clipboard.write(text)? {
				Written::Text(ours) => break ours,
				Written::Changed => attempted = false,
			}
		};
		if clipboard.change_count() != ours {
			return Err(DesktopError::input_failed(
				"another app wrote the clipboard before ⌘V was sent, so nothing was pasted",
			));
		}
		Ok(())
	});
	if !attempted {
		sent?;
		return Err(DesktopError::internal("paste sent ⌘V without writing the text"));
	}
	let read = sent.and_then(|()| {
		let read = clipboard.await_read(READ_TIMEOUT)?;
		if read {
			control::wait(READ_SETTLE)?;
		}
		Ok(read)
	});
	let restore = control::cleanup(|| settle_clipboard(clipboard));
	match read {
		Ok(read) => Ok(Pasted { outcome: outcome(read, restore), read }),
		Err(error) => Err(with_clipboard(error, restore)),
	}
}

/// Puts the user's clipboard back. After a conflict it watches for
/// [`RECLAIM_WINDOW`] whether the conflicting app puts back a copy it saved of
/// the text, which leaves the agent's text on the user's clipboard unless the
/// saved clipboard goes back over it; a copy without the text's marker, such
/// as one the user makes from the pasted field, is never touched.
fn settle_clipboard(clipboard: &mut impl Clipboard) -> Restore {
	let restore = restore_verdict(clipboard.restore().as_ref());
	if restore != Restore::Conflict {
		return restore;
	}
	match restore_verdict(clipboard.reclaim(RECLAIM_WINDOW).as_ref()) {
		Restore::Back => Restore::Reclaimed,
		Restore::Unconfirmed => Restore::Unconfirmed,
		Restore::Conflict | Restore::Untouched | Restore::Reclaimed => Restore::Conflict,
	}
}

#[derive(Serialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Request<'a> {
	Write { text: &'a str },
	Restore,
	Reclaim { seconds: f64 },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Reply {
	Written {
		#[serde(rename = "changeCount")]
		change_count: isize,
	},
	Changed,
	Read,
	Restore(Restored),
	Error {
		error: String,
	},
}

/// Reader of the helper's replies, which runs until its output closes.
type ReplySender = flume::Sender<Result<Reply, String>>;

/// The paste worker process, started for one paste. Closing its input makes
/// it put the clipboard back if the text is still there, then exit; the
/// worker reaps it, killing it once [`TEARDOWN_GRACE`] passes.
pub(super) struct Worker {
	child:      Child,
	/// `None` once closed for teardown.
	input:      Option<BufWriter<ChildStdin>>,
	replies:    flume::Receiver<Result<Reply, String>>,
	read:       bool,
	_directory: HelperDirectory,
}

impl Worker {
	pub(super) fn start() -> CoreResult<Self> {
		let directory = HelperDirectory::create("omp-paste")?;
		let executable = directory.write("omp-paste-helper", HELPER, 0o700)?;
		Self::launch(Command::new(executable), directory, spawn_reader)
	}

	/// Starts `command` and has `start_reader` read its output into the
	/// worker's replies; when that fails, the process is killed and reaped.
	fn launch(
		mut command: Command,
		directory: HelperDirectory,
		start_reader: impl FnOnce(ChildStdout, ReplySender) -> io::Result<()>,
	) -> CoreResult<Self> {
		let mut child = command
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::null())
			.spawn()
			.map_err(|error| failed(&error))?;
		let (input, output) = (child.stdin.take().map(BufWriter::new), child.stdout.take());
		let (sender, replies) = flume::unbounded();
		let mut worker = Self { child, input, replies, read: false, _directory: directory };
		let started = match output {
			Some(output) => start_reader(output, sender).map_err(|error| failed(&error)),
			None => Err(failed(&"its output pipe is missing")),
		};
		if let Err(error) = started {
			// Nothing is on the clipboard yet, so nothing is lost by not waiting.
			worker.finish(Duration::ZERO);
			return Err(error);
		}
		Ok(worker)
	}

	/// Closes the helper's input, which makes it put the clipboard back if the
	/// text is still there and exit, then reaps it; a helper still running
	/// after `grace` is killed.
	fn finish(&mut self, grace: Duration) {
		drop(self.input.take());
		let deadline = Instant::now() + grace;
		loop {
			match self.child.try_wait() {
				Ok(Some(_)) => return,
				Ok(None) if Instant::now() < deadline => thread::sleep(POLL),
				_ => break,
			}
		}
		let _ = self.child.kill();
		let _ = self.child.wait();
	}

	fn send(&mut self, request: &Request<'_>) -> CoreResult<()> {
		let input = self
			.input
			.as_mut()
			.ok_or_else(|| failed(&"its input is closed"))?;
		serde_json::to_writer(&mut *input, request).map_err(|error| failed(&error))?;
		input
			.write_all(b"\n")
			.and_then(|()| input.flush())
			.map_err(|error| failed(&error))
	}

	/// The next reply, recording a read; `None` when `deadline` passes first.
	fn receive(&mut self, deadline: Instant) -> CoreResult<Option<Reply>> {
		loop {
			control::check()?;
			let now = Instant::now();
			if now >= deadline {
				return Ok(None);
			}
			match self.replies.recv_timeout(POLL.min(deadline - now)) {
				Ok(Ok(reply)) => {
					self.read |= matches!(reply, Reply::Read);
					return Ok(Some(reply));
				},
				Ok(Err(error)) => return Err(failed(&format!("invalid reply: {error}"))),
				Err(flume::RecvTimeoutError::Timeout) => {},
				Err(flume::RecvTimeoutError::Disconnected) => {
					return Err(failed(&"it exited"));
				},
			}
		}
	}

	/// The next reply other than a read.
	fn next(&mut self, deadline: Instant) -> CoreResult<Option<Reply>> {
		loop {
			match self.receive(deadline)? {
				Some(Reply::Read) => {},
				reply => return Ok(reply),
			}
		}
	}

	/// The next restore report, skipping a write's late answer; `None` when
	/// `deadline` passes first.
	fn restored(&mut self, deadline: Instant) -> Option<Restored> {
		loop {
			match self.next(deadline) {
				Ok(Some(Reply::Restore(reply))) => return Some(reply),
				Ok(Some(_)) => {},
				Ok(None) | Err(_) => return None,
			}
		}
	}
}

impl Clipboard for Worker {
	fn change_count(&self) -> isize {
		NSPasteboard::generalPasteboard().changeCount()
	}

	fn write(&mut self, text: &str) -> CoreResult<Written> {
		self.send(&Request::Write { text })?;
		match self.next(Instant::now() + REPLY_TIMEOUT)? {
			Some(Reply::Written { change_count }) => Ok(Written::Text(change_count)),
			Some(Reply::Changed) => Ok(Written::Changed),
			Some(Reply::Error { error }) => Err(failed(&error)),
			Some(_) => Err(failed(&"it answered a write out of turn")),
			None => Err(failed(&"it did not answer in time")),
		}
	}

	fn await_read(&mut self, timeout: Duration) -> CoreResult<bool> {
		let deadline = Instant::now() + timeout;
		while !self.read {
			match self.receive(deadline)? {
				None => break,
				Some(Reply::Read) => {},
				Some(_) => return Err(failed(&"it answered out of turn")),
			}
		}
		Ok(self.read)
	}

	fn restore(&mut self) -> Option<Restored> {
		self.send(&Request::Restore).ok()?;
		self.restored(Instant::now() + REPLY_TIMEOUT)
	}

	fn reclaim(&mut self, window: Duration) -> Option<Restored> {
		self
			.send(&Request::Reclaim { seconds: window.as_secs_f64() })
			.ok()?;
		self.restored(Instant::now() + window + REPLY_TIMEOUT)
	}
}

impl Drop for Worker {
	fn drop(&mut self) {
		self.finish(TEARDOWN_GRACE);
	}
}

/// Starts the thread that reads the helper's replies.
fn spawn_reader(output: ChildStdout, sender: ReplySender) -> io::Result<()> {
	thread::Builder::new()
		.name("omp-paste-worker".into())
		.spawn(move || read_replies(output, &sender))
		.map(drop)
}

/// Forwards each reply line until the helper's output closes.
fn read_replies(output: ChildStdout, sender: &ReplySender) {
	for line in BufReader::new(output).split(b'\n') {
		let Ok(line) = line else { break };
		let reply = serde_json::from_slice(&line).map_err(|error| error.to_string());
		if sender.send(reply).is_err() {
			break;
		}
	}
}

fn failed(error: &dyn std::fmt::Display) -> DesktopError {
	DesktopError::input_failed(format!("the clipboard paste worker failed: {error}"))
}

#[cfg(test)]
mod tests {
	use std::{cell::Cell, rc::Rc};

	use objc2::{msg_send, rc::Retained, runtime::ProtocolObject};
	use objc2_app_kit::{NSPasteboardItem, NSPasteboardTypeString, NSPasteboardWriting};
	use objc2_foundation::{NSArray, NSData, NSString};

	use super::*;
	use crate::desktop::error::ErrorCode;

	const SAVED: [&str; 3] = ["public.utf8-plain-text", "public.rtf", "com.example.custom"];

	/// A clipboard whose change count rises on each write: the text's, the
	/// restore's, and another app's, which a test makes through `count`.
	struct FakeClipboard {
		count:            Rc<Cell<isize>>,
		/// `Changed` replies the worker gives before it writes the text.
		changed:          usize,
		/// Another app writes right after the text, before the keys go out.
		copy_after_write: bool,
		read:             CoreResult<bool>,
		/// Whether the worker answers a restore.
		answers:          bool,
		ours:             Option<isize>,
		writes:           usize,
		restores:         usize,
		/// Whether a restore wrote the saved clipboard back.
		restored:         bool,
		/// After a conflict, the conflicting app puts back a copy it saved of
		/// the text.
		puts_text_back:   bool,
		reclaims:         usize,
	}

	impl FakeClipboard {
		fn new() -> Self {
			Self {
				count:            Rc::new(Cell::new(10)),
				changed:          0,
				copy_after_write: false,
				read:             Ok(true),
				answers:          true,
				ours:             None,
				writes:           0,
				restores:         0,
				restored:         false,
				puts_text_back:   false,
				reclaims:         0,
			}
		}
	}

	fn another_app_copies(count: &Cell<isize>) {
		count.set(count.get() + 1);
	}

	impl Clipboard for FakeClipboard {
		fn change_count(&self) -> isize {
			self.count.get()
		}

		fn write(&mut self, _text: &str) -> CoreResult<Written> {
			self.writes += 1;
			if self.changed > 0 {
				self.changed -= 1;
				return Ok(Written::Changed);
			}
			another_app_copies(&self.count);
			self.ours = Some(self.count.get());
			if self.copy_after_write {
				another_app_copies(&self.count);
			}
			Ok(Written::Text(self.ours.unwrap()))
		}

		fn await_read(&mut self, _timeout: Duration) -> CoreResult<bool> {
			self.read.clone()
		}

		fn restore(&mut self) -> Option<Restored> {
			self.restores += 1;
			if !self.answers {
				return None;
			}
			let before = self.count.get();
			let mut reply = self.restore_reply();
			if self.ours == Some(before) {
				self.count.set(before + 1);
				self.restored = true;
				reply.after = Some(before + 1);
				reply.now.clone_from(&reply.saved);
			}
			Some(reply)
		}

		fn reclaim(&mut self, _window: Duration) -> Option<Restored> {
			self.reclaims += 1;
			let mut reply = self.restore_reply();
			if self.puts_text_back {
				// The app's copy of the text gets the next count, and the saved
				// clipboard goes back over it.
				another_app_copies(&self.count);
				let theirs = self.count.get();
				self.count.set(theirs + 1);
				self.restored = true;
				reply = Restored {
					ours: Some(theirs),
					before: Some(theirs),
					after: Some(theirs + 1),
					now: reply.saved.clone(),
					..reply
				};
			}
			Some(reply)
		}
	}

	impl FakeClipboard {
		fn restore_reply(&self) -> Restored {
			let saved = vec![SAVED.map(str::to_owned).to_vec()];
			Restored { ours: self.ours, before: Some(self.count.get()), saved, ..Restored::default() }
		}
	}

	fn paste_with(
		clipboard: &mut FakeClipboard,
		send: impl FnOnce(&mut dyn FnMut() -> CoreResult<()>) -> CoreResult<()>,
	) -> CoreResult<Pasted> {
		paste(clipboard, "agent text", send)
	}

	fn types(items: &[&[&str]]) -> Vec<Vec<String>> {
		items
			.iter()
			.map(|item| item.iter().map(|&kind| kind.to_owned()).collect())
			.collect()
	}

	#[test]
	fn restore_verdict_trusts_only_a_restore_of_its_own_write_with_every_type_back() {
		let saved = types(&[&SAVED, &["public.file-url"]]);
		let back = Restored {
			ours:   Some(7),
			before: Some(7),
			after:  Some(8),
			saved:  saved.clone(),
			now:    saved.clone(),
		};
		assert_eq!(restore_verdict(Some(&back)), Restore::Back);
		// `AppKit` may list a derived conversion beside the saved types.
		let derived = Restored {
			now: types(&[
				&[
					"public.utf8-plain-text",
					"public.utf16-external-plain-text",
					"public.rtf",
					"com.example.custom",
				],
				&["public.file-url"],
			]),
			..back.clone()
		};
		assert_eq!(restore_verdict(Some(&derived)), Restore::Back);
		// Another app wrote after the text: the worker left its copy alone.
		let conflict = Restored { before: Some(8), after: None, now: Vec::new(), ..back.clone() };
		assert_eq!(restore_verdict(Some(&conflict)), Restore::Conflict);
		// A type the restore did not bring back, an item lost, or a count that
		// says another write slipped in cannot be confirmed.
		let lost_type = Restored { now: types(&[&SAVED[..2], &["public.file-url"]]), ..back.clone() };
		let lost_item = Restored { now: types(&[&SAVED]), ..back.clone() };
		let late = Restored { after: Some(9), ..back.clone() };
		for reply in [&lost_type, &lost_item, &late] {
			assert_eq!(restore_verdict(Some(reply)), Restore::Unconfirmed, "{reply:?}");
		}
		assert_eq!(restore_verdict(None), Restore::Unconfirmed);
		assert_eq!(restore_verdict(Some(&Restored::default())), Restore::Untouched);
	}

	#[test]
	fn outcome_puts_a_clipboard_left_changed_ahead_of_the_read() {
		for (read, restore, expected) in [
			(true, Restore::Back, PasteOutcome::Provided),
			(false, Restore::Back, PasteOutcome::NoReadSeen),
			(true, Restore::Conflict, PasteOutcome::ClipboardConflict),
			(false, Restore::Conflict, PasteOutcome::ClipboardConflict),
			(true, Restore::Unconfirmed, PasteOutcome::RestoreUnconfirmed),
			(false, Restore::Unconfirmed, PasteOutcome::RestoreUnconfirmed),
			(true, Restore::Reclaimed, PasteOutcome::Reclaimed),
			(false, Restore::Reclaimed, PasteOutcome::Reclaimed),
		] {
			assert_eq!(outcome(read, restore), expected, "read {read}, {restore:?}");
		}
	}

	#[test]
	fn quiet_waits_for_an_unchanged_clipboard_and_gives_up_on_a_busy_one() {
		let start = Instant::now();
		let at = |millis| start + Duration::from_millis(millis);
		let mut quiet = Quiet::new(start, 5);
		assert_eq!(quiet.remaining(at(50), 5).unwrap(), Some(Duration::from_millis(150)));
		// A change restarts the quiet period from the read that saw it.
		assert_eq!(quiet.remaining(at(150), 6).unwrap(), Some(CLIPBOARD_QUIET));
		assert_eq!(quiet.remaining(at(350), 6).unwrap(), None);

		let mut busy = Quiet::new(start, 5);
		assert!(busy.remaining(at(1_700), 6).unwrap().is_some());
		let error = busy.remaining(at(1_850), 7).unwrap_err();
		assert_eq!(error.code, ErrorCode::InputFailed);
		assert!(error.message.contains("nothing was written"), "{}", error.message);
	}

	#[test]
	fn a_paste_puts_the_clipboard_back_whether_or_not_the_text_was_read() {
		let mut clipboard = FakeClipboard::new();
		let pasted = paste_with(&mut clipboard, |ready| ready()).unwrap();
		assert_eq!((pasted.outcome, pasted.read), (PasteOutcome::Provided, true));
		assert_eq!((clipboard.writes, clipboard.restores, clipboard.restored), (1, 1, true));
		assert_eq!(clipboard.reclaims, 0);

		let mut clipboard = FakeClipboard { read: Ok(false), ..FakeClipboard::new() };
		let pasted = paste_with(&mut clipboard, |ready| ready()).unwrap();
		assert_eq!((pasted.outcome, pasted.read), (PasteOutcome::NoReadSeen, false));
		assert!(clipboard.restored);
	}

	#[test]
	fn a_refusal_before_the_keys_leaves_the_clipboard_untouched() {
		let mut clipboard = FakeClipboard::new();
		let refusal =
			DesktopError::background_unavailable("window 4 cannot take keys; nothing was sent");
		let error = paste_with(&mut clipboard, |_ready| Err(refusal.clone())).unwrap_err();
		assert_eq!((error.code, error.message), (refusal.code, refusal.message));
		assert_eq!((clipboard.writes, clipboard.restores), (0, 0));
	}

	#[test]
	fn keys_that_fail_after_the_write_still_put_the_clipboard_back() {
		let mut clipboard = FakeClipboard::new();
		let error = paste_with(&mut clipboard, |ready| {
			ready()?;
			Err(DesktopError::input_failed("window 4 stopped being key"))
		})
		.unwrap_err();
		assert_eq!(error.message, "window 4 stopped being key");
		assert!(clipboard.restored);

		// When another app wrote meanwhile, the error says the clipboard holds
		// that app's copy.
		let mut clipboard = FakeClipboard::new();
		let count = Rc::clone(&clipboard.count);
		let error = paste_with(&mut clipboard, |ready| {
			ready()?;
			another_app_copies(&count);
			Err(DesktopError::input_failed("window 4 stopped being key"))
		})
		.unwrap_err();
		assert!(
			error
				.message
				.ends_with("so the clipboard was left as that app set it"),
			"{}",
			error.message
		);
		assert_eq!((clipboard.restores, clipboard.restored), (1, false));
	}

	#[test]
	fn a_copy_before_the_keys_sends_nothing_and_keeps_that_copy() {
		let mut clipboard = FakeClipboard { copy_after_write: true, ..FakeClipboard::new() };
		let mut sent = false;
		let error = paste_with(&mut clipboard, |ready| {
			ready()?;
			sent = true;
			Ok(())
		})
		.unwrap_err();
		assert!(!sent);
		assert!(
			error
				.message
				.starts_with("another app wrote the clipboard before ⌘V was sent"),
			"{}",
			error.message
		);
		assert!(error.message.ends_with("left as that app set it"), "{}", error.message);
		assert_eq!((clipboard.restores, clipboard.restored), (1, false));
	}

	#[test]
	fn a_copy_after_the_keys_is_never_overwritten() {
		let mut clipboard = FakeClipboard::new();
		let count = Rc::clone(&clipboard.count);
		let pasted = paste_with(&mut clipboard, |ready| {
			ready()?;
			another_app_copies(&count);
			Ok(())
		})
		.unwrap();
		assert_eq!((pasted.outcome, pasted.read), (PasteOutcome::ClipboardConflict, true));
		assert_eq!((clipboard.restores, clipboard.reclaims, clipboard.restored), (1, 1, false));
	}

	#[test]
	fn the_clipboard_goes_back_over_a_copy_of_the_text_another_app_puts_back() {
		let mut clipboard = FakeClipboard { puts_text_back: true, ..FakeClipboard::new() };
		let count = Rc::clone(&clipboard.count);
		let pasted = paste_with(&mut clipboard, |ready| {
			ready()?;
			another_app_copies(&count);
			Ok(())
		})
		.unwrap();
		assert_eq!(pasted.outcome, PasteOutcome::Reclaimed);
		assert_eq!((clipboard.restores, clipboard.reclaims, clipboard.restored), (1, 1, true));
	}

	#[test]
	fn an_unanswered_restore_is_unconfirmed() {
		let mut clipboard = FakeClipboard { answers: false, ..FakeClipboard::new() };
		let pasted = paste_with(&mut clipboard, |ready| ready()).unwrap();
		assert_eq!(pasted.outcome, PasteOutcome::RestoreUnconfirmed);
	}

	#[test]
	fn a_clipboard_that_changes_while_saved_is_saved_again_once_quiet() {
		let mut clipboard = FakeClipboard { changed: 1, ..FakeClipboard::new() };
		let pasted = paste_with(&mut clipboard, |ready| ready()).unwrap();
		assert_eq!(pasted.outcome, PasteOutcome::Provided);
		assert_eq!((clipboard.writes, clipboard.restores), (2, 1));
	}

	#[test]
	fn a_cancelled_wait_for_the_read_still_puts_the_clipboard_back() {
		let cancelled = DesktopError::cancelled("desktop operation cancelled");
		let mut clipboard = FakeClipboard { read: Err(cancelled), ..FakeClipboard::new() };
		let error = paste_with(&mut clipboard, |ready| ready()).unwrap_err();
		assert_eq!(error.code, ErrorCode::Cancelled);
		assert!(clipboard.restored);
	}

	/// The embedded helper working on a pasteboard of its own, which first
	/// holds the user's text. With `stall` it pauses a second before each
	/// ownership check and says so, so a test can copy there meanwhile.
	struct HelperFixture {
		board:      Retained<NSPasteboard>,
		child:      Child,
		input:      ChildStdin,
		output:     BufReader<ChildStdout>,
		stall:      bool,
		_directory: HelperDirectory,
	}

	impl HelperFixture {
		fn start(test: &str, stall: bool) -> Self {
			let name = format!("omp-paste-test-{}-{test}", std::process::id());
			let board = NSPasteboard::pasteboardWithName(&NSString::from_str(&name));
			copy(&board, "the user's text");
			let directory = HelperDirectory::create("omp-paste-test").unwrap();
			let executable = directory.write("omp-paste-helper", HELPER, 0o700).unwrap();
			let mut child = Command::new(executable)
				.arg(&name)
				.args(stall.then_some("stall"))
				.stdin(Stdio::piped())
				.stdout(Stdio::piped())
				.stderr(Stdio::null())
				.spawn()
				.unwrap();
			let input = child.stdin.take().unwrap();
			let output = BufReader::new(child.stdout.take().unwrap());
			Self { board, child, input, output, stall, _directory: directory }
		}

		fn send(&mut self, request: &str) {
			writeln!(self.input, "{request}").unwrap();
		}

		/// The next reply other than a read of the text.
		fn reply(&mut self) -> serde_json::Value {
			loop {
				let mut line = String::new();
				self.output.read_line(&mut line).unwrap();
				let reply: serde_json::Value = serde_json::from_str(&line).unwrap();
				if reply["kind"] != "read" {
					return reply;
				}
			}
		}

		/// Writes the text, with no copy during the pause.
		fn write(&mut self) {
			self.send(r#"{"op":"write","text":"agent text"}"#);
			if self.stall {
				assert_eq!(self.reply()["at"], "write");
			}
			assert_eq!(self.reply()["kind"], "written");
		}

		fn text(&self) -> String {
			// SAFETY: `NSPasteboardTypeString` is an immutable AppKit string
			// constant.
			let kind = unsafe { NSPasteboardTypeString };
			self
				.board
				.stringForType(kind)
				.map(|text| text.to_string())
				.unwrap_or_default()
		}
	}

	impl Drop for HelperFixture {
		fn drop(&mut self) {
			let _ = self.child.kill();
			let _ = self.child.wait();
			// SAFETY: `releaseGlobally` takes no arguments and returns nothing.
			let () = unsafe { msg_send![&*self.board, releaseGlobally] };
		}
	}

	/// Another app's copy.
	fn copy(board: &NSPasteboard, text: &str) {
		board.clearContents();
		// SAFETY: `NSPasteboardTypeString` is an immutable AppKit string
		// constant.
		assert!(
			board.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString })
		);
	}

	#[test]
	fn the_helper_keeps_a_copy_made_while_it_saves_the_clipboard() {
		let mut helper = HelperFixture::start("save", true);
		helper.send(r#"{"op":"write","text":"agent text"}"#);
		assert_eq!(helper.reply()["at"], "write");
		copy(&helper.board, "a copy made meanwhile");
		assert_eq!(helper.reply()["kind"], "changed");
		assert_eq!(helper.text(), "a copy made meanwhile");
	}

	#[test]
	fn the_helper_keeps_a_copy_made_while_it_rebuilds_the_clipboard() {
		let mut helper = HelperFixture::start("rebuild", true);
		helper.write();
		helper.send(r#"{"op":"restore"}"#);
		assert_eq!(helper.reply()["at"], "restore");
		copy(&helper.board, "a copy made meanwhile");
		let reply: Restored = serde_json::from_value(helper.reply()).unwrap();
		assert_eq!(restore_verdict(Some(&reply)), Restore::Conflict);
		assert_eq!(helper.text(), "a copy made meanwhile");
	}

	#[test]
	fn the_helper_puts_back_a_clipboard_it_still_holds() {
		let mut helper = HelperFixture::start("restore", true);
		helper.write();
		helper.send(r#"{"op":"restore"}"#);
		assert_eq!(helper.reply()["at"], "restore");
		let reply: Restored = serde_json::from_value(helper.reply()).unwrap();
		assert_eq!(restore_verdict(Some(&reply)), Restore::Back);
		assert_eq!(helper.text(), "the user's text");
	}

	/// What a tool that saves the clipboard around its own paste keeps: every
	/// item's readable types and their data.
	type SavedClipboard = Vec<Vec<(Retained<NSString>, Retained<NSData>)>>;

	fn save_clipboard(board: &NSPasteboard) -> SavedClipboard {
		board
			.pasteboardItems()
			.unwrap()
			.iter()
			.map(|item| {
				item
					.types()
					.iter()
					.filter_map(|kind| item.dataForType(&kind).map(|data| (kind, data)))
					.collect()
			})
			.collect()
	}

	/// Clears `board` and, `gap` later, writes `saved` to it, the two steps
	/// every write takes.
	fn put_back(board: &NSPasteboard, saved: &SavedClipboard, gap: Duration) {
		let items: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = saved
			.iter()
			.map(|entries| {
				let item = NSPasteboardItem::new();
				for (kind, data) in entries {
					assert!(item.setData_forType(data, kind));
				}
				ProtocolObject::from_retained(item)
			})
			.collect();
		board.clearContents();
		thread::sleep(gap);
		assert!(board.writeObjects(&NSArray::from_retained_slice(&items)));
	}

	#[test]
	fn the_helper_puts_the_clipboard_back_over_its_text_another_app_puts_back() {
		// With a gap longer than the helper's poll, a poll finds the put-back's
		// change count before its items.
		for gap in [Duration::ZERO, Duration::from_millis(200)] {
			let mut helper = HelperFixture::start(&format!("dictation-{}", gap.as_millis()), false);
			helper.write();
			// A dictation tool saves the clipboard, the text included, and pastes
			// its own.
			let saved = save_clipboard(&helper.board);
			copy(&helper.board, "dictated text");
			helper.send(r#"{"op":"restore"}"#);
			let reply: Restored = serde_json::from_value(helper.reply()).unwrap();
			assert_eq!(restore_verdict(Some(&reply)), Restore::Conflict);
			helper.send(r#"{"op":"reclaim","seconds":3}"#);
			thread::sleep(Duration::from_millis(300));
			// It puts back what it saved: the agent's text.
			put_back(&helper.board, &saved, gap);
			let reply: Restored = serde_json::from_value(helper.reply()).unwrap();
			assert_eq!(restore_verdict(Some(&reply)), Restore::Back, "gap {gap:?}");
			assert_eq!(helper.text(), "the user's text");
		}
	}

	#[test]
	fn the_helper_leaves_a_copy_without_its_text_alone_after_a_conflict() {
		let mut helper = HelperFixture::start("later-copy", false);
		helper.write();
		copy(&helper.board, "dictated text");
		helper.send(r#"{"op":"restore"}"#);
		let reply: Restored = serde_json::from_value(helper.reply()).unwrap();
		assert_eq!(restore_verdict(Some(&reply)), Restore::Conflict);
		helper.send(r#"{"op":"reclaim","seconds":0.6}"#);
		thread::sleep(Duration::from_millis(100));
		// The user copies the pasted text from the field: same text, no marker.
		copy(&helper.board, "agent text");
		let reply: Restored = serde_json::from_value(helper.reply()).unwrap();
		assert_eq!(restore_verdict(Some(&reply)), Restore::Conflict);
		assert_eq!(helper.text(), "agent text");
	}

	/// Whether process `pid` exists, a zombie included.
	fn exists(pid: u32) -> bool {
		// SAFETY: signal 0 only checks that the process exists.
		unsafe { libc::kill(libc::pid_t::try_from(pid).unwrap(), 0) == 0 }
	}

	#[test]
	fn a_helper_whose_reader_cannot_start_is_reaped() {
		let directory = HelperDirectory::create("omp-paste-test").unwrap();
		let mut command = Command::new("/bin/sh");
		command.args(["-c", "echo $$; exec sleep 60"]);
		let pid = Cell::new(0);
		let started = Worker::launch(command, directory, |output, _| {
			let mut line = String::new();
			BufReader::new(output).read_line(&mut line)?;
			pid.set(line.trim().parse().unwrap());
			Err(io::Error::other("no thread"))
		});
		assert!(started.err().unwrap().message.ends_with("no thread"));
		assert!(!exists(pid.get()));
	}

	#[test]
	fn a_helper_that_outlives_its_closed_input_is_killed_and_reaped() {
		let directory = HelperDirectory::create("omp-paste-test").unwrap();
		let mut command = Command::new("/bin/sleep");
		command.arg("60");
		let mut worker = Worker::launch(command, directory, spawn_reader).unwrap();
		let pid = worker.child.id();
		worker.finish(Duration::from_millis(100));
		assert!(!exists(pid));
		// The reader thread ends with the helper's output.
		assert!(matches!(
			worker.replies.recv_timeout(Duration::from_secs(5)),
			Err(flume::RecvTimeoutError::Disconnected)
		));
	}
}
