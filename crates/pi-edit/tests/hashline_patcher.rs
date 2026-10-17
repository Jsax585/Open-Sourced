mod common;

use pi_edit::{
	EditMode, ModeEngine,
	modes::hashline::{
		HashlineEngine,
		patcher::{no_change_diagnostic, no_change_loop_diagnostic},
	},
	stream_json::ArgSnapshot,
};
use serde_json::json;

#[tokio::test]
async fn patcher_apply_cases() {
	common::run_fixture("hashline/patcher.json", EditMode::Hashline).await;
}

#[tokio::test]
async fn missing_bare_path_names_unique_tag_match_outside_workspace() {
	let mut workspace = common::Workspace::new(EditMode::Hashline);
	let outside = workspace.write("skills/flow.mjs", "a\n");
	let tag = workspace.snapshot("skills/flow.mjs", "a\n", None);
	let work = workspace
		.write("work/.keep", "")
		.parent()
		.unwrap()
		.to_path_buf();
	workspace.config.policy.cwd = work;
	let error = workspace
		.apply_json(
			&json!({ "input": format!("[flow.mjs#{tag}]\nPUT 1.=1:\n+b") }),
			&common::DiskWriter::default(),
		)
		.await
		.expect_err("outside-workspace match must not be rebound");
	let message = error.to_string();
	assert!(message.contains(&format!("[{}#{tag}]", outside.display())), "{message}");
	assert!(!message.contains("write tool"), "{message}");
	assert_eq!(std::fs::read_to_string(&outside).unwrap(), "a\n");
}

#[tokio::test]
async fn missing_bare_path_with_ambiguous_tag_match_names_no_path() {
	let mut workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("x/flow.mjs", "a\n");
	workspace.write("y/flow.mjs", "a\n");
	let tag = workspace.snapshot("x/flow.mjs", "a\n", None);
	workspace.snapshot("y/flow.mjs", "a\n", None);
	let work = workspace
		.write("work/.keep", "")
		.parent()
		.unwrap()
		.to_path_buf();
	workspace.config.policy.cwd = work;
	let error = workspace
		.apply_json(
			&json!({ "input": format!("[flow.mjs#{tag}]\nPUT 1.=1:\n+b") }),
			&common::DiskWriter::default(),
		)
		.await
		.expect_err("ambiguous match must fail");
	assert_eq!(
		error.to_string(),
		"File not found: flow.mjs. Use the write tool to create new files."
	);
}

#[test]
fn matcher_paths_accept_partial_sections_and_header_noise() {
	let engine = HashlineEngine { enforce_seen_lines: false };
	let inspected = engine.inspect(&ArgSnapshot {
		input: Some(
			"[one.ts#ABCD]\nPUT 1.=1:\n+one\n[*** Update File: dir with spaces/two.ts#1234]\nPUT \
			 2.=2:\n+two"
				.into(),
		),
		..ArgSnapshot::default()
	});
	assert_eq!(inspected.paths, ["one.ts", "dir with spaces/two.ts"]);
	assert_eq!(inspected.entries, [
		("one.ts".into(), "one".into()),
		("dir with spaces/two.ts".into(), "two".into())
	]);
}

#[test]
fn no_op_diagnostics_preserve_model_guidance() {
	assert_eq!(
		no_change_diagnostic("a.ts"),
		"Edits to a.ts parsed and applied cleanly, but produced no change: your body row(s) are \
		 byte-identical to the file at the targeted lines. The bug is somewhere else — re-read the \
		 file before issuing another edit. Do NOT widen the payload or add lines; verify the anchor \
		 first."
	);
	assert!(
		no_change_loop_diagnostic("a.ts", 3)
			.starts_with("STOP. Edits to a.ts have been a byte-identical no-op 3 times in a row")
	);
}

#[tokio::test]
async fn identical_noop_escalates_on_third_attempt() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "same\n");
	let tag = workspace.snapshot("a.txt", "same\n", None);
	let args = json!({ "input": format!("[a.txt#{tag}]\nPUT 1.=1:\n+same") });
	for _ in 0..2 {
		let outcome = workspace
			.apply_json(&args, &common::DiskWriter::default())
			.await
			.expect("soft no-op");
		assert!(outcome.text.contains("produced no change"));
	}
	let error = workspace
		.apply_json(&args, &common::DiskWriter::default())
		.await
		.expect_err("third no-op must fail");
	assert!(
		error
			.to_string()
			.starts_with("STOP. Edits to a.txt have been a byte-identical no-op 3 times in a row")
	);
}

#[test]
fn streaming_preview_keeps_completed_section_when_trailing_header_arrives() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "a\n");
	workspace.write("b.txt", "b\n");
	let tag_a = workspace.snapshot("a.txt", "a\n", None);
	let tag_b = workspace.snapshot("b.txt", "b\n", None);
	let input = format!("[a.txt#{tag_a}]\nPUT 1.=1:\n+A\n[b.txt#{tag_b}]");
	let mut session = workspace.session();
	session.set_args_json(&json!({ "input": input }).to_string());
	let batch = session.preview();
	assert!(batch.streaming);
	assert_eq!(batch.files.len(), 1);
	assert_eq!(batch.files[0].display, "a.txt");
	assert!(
		batch.files[0]
			.diff
			.as_deref()
			.is_some_and(|diff| diff.contains("+1|A"))
	);
}

#[tokio::test]
async fn rejection_names_the_path_a_foreign_tag_was_issued_for() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	let worktree = workspace.write("wt/crates/a/mcp.rs", "worktree\n");
	workspace.write("crates/a/mcp.rs", "parent\n");
	let tag = workspace.snapshot("wt/crates/a/mcp.rs", "worktree\n", None);
	let writer = common::DiskWriter::default();
	let input = format!("[crates/a/mcp.rs#{tag}]\nPUT 1.=1:\n+changed\n");
	let error = workspace
		.apply_json(&json!({ "input": input }), &writer)
		.await
		.expect_err("foreign tag must be rejected")
		.to_string();
	let origin = pi_edit::path_policy::canonical_key(&worktree);
	assert!(
		error.contains(&format!("Hash #{tag} was issued in this session for {}.", origin.display())),
		"{error}"
	);
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("crates/a/mcp.rs").as_deref(), Some("parent\n"));
	assert_eq!(workspace.read("wt/crates/a/mcp.rs").as_deref(), Some("worktree\n"));
}

#[tokio::test]
async fn recovered_rem_reports_authored_and_deleted_paths() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	let target = workspace.write("correct/target.ts", "const value = 1;\n");
	let tag = workspace.snapshot("correct/target.ts", "const value = 1;\n", None);
	let input = format!("[wrong/target.ts#{tag}]\nREM\n");
	let outcome = workspace
		.apply_json(&json!({ "input": input }), &common::DiskWriter::default())
		.await
		.expect("recovered delete");

	assert!(!target.exists());
	let deleted = pi_edit::path_policy::canonical_key(&target);
	assert!(
		outcome
			.text
			.contains(&format!("Deleted {}", deleted.display())),
		"{}",
		outcome.text
	);
	assert!(
		outcome.text.contains(&format!(
			"Warnings:\nPath \"wrong/target.ts\" does not exist; matched its filename and snapshot \
			 tag #{tag} to {}",
			deleted.display()
		)),
		"{}",
		outcome.text
	);
}

#[test]
fn completed_preview_surfaces_stale_hash_error() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "a\n");
	let mut session = workspace.session();
	session.set_args_json(&json!({ "input": "[a.txt#FFFF]\nPUT 1.=1:\n+A\n" }).to_string());
	session.finish();
	let batch = session.preview();
	assert!(!batch.streaming);
	assert!(
		batch.files[0]
			.error
			.as_deref()
			.is_some_and(|error| error.contains("not from this session"))
	);
}
