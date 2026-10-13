import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession, type AsyncJobSnapshotItem } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { isNativeRendering, setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { JobsSheet } from "@oh-my-pi/pi-tui/overlays/jobs-panel";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

const WIDTH = 60;

/** `/jobs full` in text mode, as the report box above the editor shows it: its content rows, borders stripped. */
async function renderFullJobs(running: AsyncJobSnapshotItem[]): Promise<string[]> {
	const reportContainer = new Container();
	const ctx = {
		ui: { terminal: { columns: WIDTH, rows: 200 }, requestRender: () => {} },
		keybindings: { getKeys: () => ["escape"] },
		reportContainer,
		commandReportRows: () => 200,
		session: {
			getAsyncJobSnapshot: () => ({
				running,
				recent: [],
				delivery: { queued: 0, delivering: false, pendingJobIds: [] },
			}),
		},
	} as unknown as InteractiveModeContext;
	await new CommandController(ctx).handleJobsCommand({ full: true });
	return reportContainer
		.render(WIDTH)
		.map(line => Bun.stripANSI(line))
		.filter(line => line.startsWith("│"))
		.map(line => line.slice(2, -2).trimEnd());
}

describe("CommandController /jobs full", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("keeps every line of a multi-line or wrapped command indented under its job row", async () => {
		const longLine = `python /tmp/x.py ${"--flag ".repeat(12)}END`;
		const command = `cat <<'EOF' > /tmp/x.py\nimport sys\nEOF\n${longLine}`;
		const startTime = Date.now();
		const lines = await renderFullJobs([
			{ id: "bash-1", type: "bash", status: "running", label: "cat <<'EOF'...", command, startTime },
			{ id: "bash-2", type: "bash", status: "running", label: "sleep 5", startTime },
		]);

		const first = lines.findIndex(line => line.includes("bash-1"));
		const second = lines.findIndex(line => line.includes("bash-2"));
		const commandLines = lines.slice(first + 1, second);
		// Job rows start the report body; command lines sit two columns deeper.
		expect(lines[first]).toMatch(/^\S/);
		expect(commandLines.length).toBeGreaterThan(4);
		for (const line of commandLines) expect(line).toMatch(/^ {2}\S/);
		expect(commandLines.map(line => line.trim()).join(" ")).toContain("import sys EOF python /tmp/x.py --flag");
		expect(commandLines.at(-1)).toEndWith("END");
		expect(lines[second + 1]).toBe("  sleep 5");
	});
});

describe("/jobs opens the live jobs sheet", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let manager: AsyncJobManager;
	let session: AgentSession;
	let mode: InteractiveMode;
	let wasNative: boolean;

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-jobs-native-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
		manager = new AsyncJobManager({});
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
			asyncJobManager: manager,
			agentId: "main",
		});
		mode = new InteractiveMode(session, "test");
		mode.isInitialized = true;
		mode.ui.requestRender = vi.fn();
		wasNative = isNativeRendering();
		setNativeRendering(true);
	});

	afterEach(async () => {
		setNativeRendering(wasNative);
		mode?.stop();
		HistoryStorage.close();
		vi.restoreAllMocks();
		manager.cancelAll();
		await manager.dispose({ timeoutMs: 1_000 });
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("opens the live jobs sheet listing the running job, leaves the transcript alone, and Esc closes it", async () => {
		const gate = Promise.withResolvers<string>();
		manager.register("bash", "cargo test --workspace", () => gate.promise, { ownerId: "main" });
		const transcript = [...mode.chatContainer.children];

		await mode.handleJobsCommand();

		const sheet = mode.ui.overlayStack.at(-1)?.component;
		expect(sheet).toBeInstanceOf(JobsSheet);
		expect(mode.ui.getFocused()).toBe(sheet ?? null);
		expect(Bun.stripANSI(sheet?.render(100).join("\n") ?? "")).toContain("cargo test --workspace");
		expect(mode.chatContainer.children).toEqual(transcript);

		sheet?.handleInput?.("\x1b");
		expect(mode.ui.hasOverlay()).toBe(false);
		expect(mode.chatContainer.children).toEqual(transcript);
		gate.resolve("done");
	});

	it("`/jobs kill <id>` cancels the running job through the TUI dispatcher", async () => {
		const gate = Promise.withResolvers<string>();
		const id = manager.register("bash", "sleep 999", () => gate.promise, { ownerId: "main" });
		const showStatus = vi.spyOn(mode, "showStatus");

		const handled = await executeBuiltinSlashCommand(`/jobs kill ${id}`, { ctx: mode });

		expect(handled).toBe(true);
		expect(manager.getJob(id)?.status).toBe("cancelled");
		expect(session.getAsyncJobSnapshot()?.running).toEqual([]);
		expect(showStatus).toHaveBeenCalledWith(`Cancelled background job ${id}.`);
		gate.resolve("done");
	});

	it("`/jobs kill all` cancels every running job", async () => {
		const gates = [Promise.withResolvers<string>(), Promise.withResolvers<string>()];
		const ids = gates.map((gate, index) =>
			manager.register("bash", `job-${index}`, () => gate.promise, { ownerId: "main" }),
		);

		const handled = await executeBuiltinSlashCommand("/jobs kill all", { ctx: mode });

		expect(handled).toBe(true);
		for (const id of ids) expect(manager.getJob(id)?.status).toBe("cancelled");
		expect(session.getAsyncJobSnapshot()?.running).toEqual([]);
		for (const gate of gates) gate.resolve("done");
	});

	it("`/jobs kill <bogus>` reports the miss without cancelling", async () => {
		const gate = Promise.withResolvers<string>();
		const id = manager.register("bash", "sleep 999", () => gate.promise, { ownerId: "main" });
		const showStatus = vi.spyOn(mode, "showStatus");

		await executeBuiltinSlashCommand("/jobs kill nope", { ctx: mode });

		expect(manager.getJob(id)?.status).toBe("running");
		expect(showStatus).toHaveBeenCalledWith('No running background job with id "nope".');
		gate.resolve("done");
	});

	it("`/jobs kill all` leaves a job owned by another session running", async () => {
		const ownedGate = Promise.withResolvers<string>();
		const foreignGate = Promise.withResolvers<string>();
		const ownedId = manager.register("bash", "mine", () => ownedGate.promise, { ownerId: "main" });
		const foreignId = manager.register("bash", "theirs", () => foreignGate.promise, { ownerId: "other" });

		const handled = await executeBuiltinSlashCommand("/jobs kill all", { ctx: mode });

		expect(handled).toBe(true);
		expect(manager.getJob(ownedId)?.status).toBe("cancelled");
		expect(manager.getJob(foreignId)?.status).toBe("running");
		ownedGate.resolve("done");
		foreignGate.resolve("done");
	});

	it("`/jobs kill <id>` refuses a job owned by another session", async () => {
		const foreignGate = Promise.withResolvers<string>();
		const foreignId = manager.register("bash", "theirs", () => foreignGate.promise, { ownerId: "other" });
		const showStatus = vi.spyOn(mode, "showStatus");

		await executeBuiltinSlashCommand(`/jobs kill ${foreignId}`, { ctx: mode });

		expect(manager.getJob(foreignId)?.status).toBe("running");
		expect(showStatus).toHaveBeenCalledWith(`No running background job with id "${foreignId}".`);
		foreignGate.resolve("done");
	});
});

const PLAIN_ROWS = 32;
const PLAIN_COLUMNS = 120;
const PLAIN_MULTILINE = "cat <<'EOF' > /tmp/x.py\nimport sys\nEOF\npython /tmp/x.py --flag";

/** The visible screen rows, ANSI stripped and right-trimmed. */
function plainScreen(term: VirtualTerminal): string[] {
	return term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
}

/**
 * `/jobs` on a terminal without the native surface: the composer's keystrokes
 * run through the real slash dispatcher and the sheet draws on the real screen.
 */
describe("/jobs on a plain terminal", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let manager: AsyncJobManager;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;
	let wasNative: boolean;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-jobs-plain-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
		manager = new AsyncJobManager({});
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
			asyncJobManager: manager,
			agentId: "main",
		});
		wasNative = isNativeRendering();
		setNativeRendering(false);
		term = new VirtualTerminal(PLAIN_COLUMNS, PLAIN_ROWS);
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: term }),
		);
	});

	afterEach(async () => {
		setNativeRendering(wasNative);
		mode?.stop();
		HistoryStorage.close();
		manager.cancelAll();
		await manager.dispose({ timeoutMs: 1_000 });
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/** Boot the composer, put `rows` transcript lines on screen, return the last one. */
	async function mount(rows: number): Promise<string> {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		for (let i = 0; i < rows; i++) mode.chatContainer.addChild(new Text(`TRANSCRIPT ${i}`, 0, 0));
		mode.ui.requestRender();
		const last = `TRANSCRIPT ${rows - 1}`;
		await term.waitForRender(() => plainScreen(term).includes(last));
		return last;
	}

	it("keyboard `/jobs` opens the interactive sheet, ↓ follows the selection, Esc closes it, and `/jobs full` still prints the report", async () => {
		const gates = [Promise.withResolvers<string>(), Promise.withResolvers<string>()];
		// Job A's output streams far more history lines than one screen holds, with
		// the newest line last: a pane that clips its content or draws past the
		// viewport loses `job-a-output`, an older-first one loses the history.
		const history = Array.from({ length: 60 }, (_v, i) => `job-a-history-${i}`);
		manager.register(
			"bash",
			"sleep 111",
			async ctx => {
				await ctx.reportProgress([...history, "job-a-output"].join("\n"));
				return gates[0].promise;
			},
			{ ownerId: "main", process: { command: PLAIN_MULTILINE, cwd: tempDir.path(), pids: () => [] } },
		);
		const idB = manager.register(
			"bash",
			"sleep 222",
			async ctx => {
				await ctx.reportProgress("job-b-output");
				return gates[1].promise;
			},
			{ ownerId: "main" },
		);
		const last = await mount(3);
		const transcript = [...mode.chatContainer.children];

		// The keystrokes a user types reach the sheet through the slash dispatcher.
		term.sendInput("/jobs");
		await term.waitForRender(() => plainScreen(term).some(row => row.includes("/jobs")));
		term.sendInput("\r");
		await term.waitForRender(() => plainScreen(term).some(row => row.includes("Background jobs")));

		const sheet = mode.ui.overlayStack.at(-1)?.component;
		expect(sheet).toBeInstanceOf(JobsSheet);
		expect(mode.ui.getFocused()).toBe(sheet ?? null);
		const opened = plainScreen(term);
		expect(opened.some(row => row.includes("sleep 111"))).toBe(true);
		expect(opened.some(row => row.includes("job-a-output"))).toBe(true);
		expect(opened.some(row => row.includes("job-b-output"))).toBe(false);
		// The composite screen carries the newest line of the long tail plus a
		// window of the history above it, not just the latest progress string.
		expect(opened.filter(row => row.includes("job-a-history-")).length).toBeGreaterThan(8);
		expect(mode.chatContainer.children).toEqual(transcript);

		// Shrink to a short, narrow viewport while `job-a` is selected: the sheet
		// sizes its pane to the live height, so the newest line must still survive
		// composition. A pane laid out for the old 120x32 frame (or an unbounded
		// one) overflows the 10 rows the overlay can draw and loses it at the cut.
		term.resize(40, 12);
		let narrow: string[] = [];
		await term.waitForRender(() => {
			const rows = plainScreen(term);
			if (!rows.some(row => row.includes("job-a-output"))) return false;
			if (rows.filter(row => row.includes("job-a-history-")).length >= 8) return false;
			if (!rows.every(row => row.length <= 40)) return false;
			narrow = rows;
			return true;
		});
		expect(narrow.some(row => row.includes("job-a-output"))).toBe(true);
		// The short viewport holds a window of the tail, not the whole history: the
		// rows came from the frame composed for 12 rows, not the stale 32-row one.
		expect(narrow.filter(row => row.includes("job-a-history-")).length).toBeLessThan(8);
		expect(narrow.every(row => row.length <= 40)).toBe(true);
		expect(mode.chatContainer.children).toEqual(transcript);

		// Growing back restores the taller window: the older tail rows come back
		// with the newest line still last above the legend.
		term.resize(PLAIN_COLUMNS, PLAIN_ROWS);
		let restored: string[] = [];
		await term.waitForRender(() => {
			const rows = plainScreen(term);
			if (rows.filter(row => row.includes("job-a-history-")).length <= 8) return false;
			if (!rows.some(row => row.includes("job-a-output"))) return false;
			restored = rows;
			return true;
		});
		expect(restored.filter(row => row.includes("job-a-history-")).length).toBeGreaterThan(8);
		expect(restored.some(row => row.includes("job-a-output"))).toBe(true);
		expect(mode.chatContainer.children).toEqual(transcript);

		// ↓ moves the selection, so the detail follows the other running job's output.
		term.sendInput("\x1b[B");
		await term.waitForRender(() => plainScreen(term).some(row => row.includes("job-b-output")));
		const moved = plainScreen(term);
		expect(moved.some(row => row.includes("job-b-output"))).toBe(true);
		expect(moved.some(row => row.includes("job-a-output"))).toBe(false);
		expect(mode.chatContainer.children).toEqual(transcript);

		// X cancels the selected running job, the same owner-scoped cancel `/jobs kill` uses.
		term.sendInput("x");
		await term.waitForRender(() => manager.getJob(idB)?.status === "cancelled");
		expect(manager.getJob(idB)?.status).toBe("cancelled");
		expect(mode.chatContainer.children).toEqual(transcript);

		// Esc closes it, and nothing of the sheet reached the transcript or the scrollback.
		term.sendInput("\x1b");
		await term.waitForRender(() => !plainScreen(term).some(row => row.includes("Background jobs")));
		expect(mode.ui.hasOverlay()).toBe(false);
		expect(plainScreen(term)).toContain(last);
		expect(mode.chatContainer.children).toEqual(transcript);
		expect(term.getScrollBuffer().some(row => Bun.stripANSI(row).includes("Background jobs"))).toBe(false);

		// `/jobs full` keeps the static report, multiline command and all.
		term.sendInput("/jobs full");
		await term.waitForRender(() => plainScreen(term).some(row => row.includes("/jobs full")));
		term.sendInput("\r");
		await term.waitForRender(() => plainScreen(term).some(row => row.includes("Background Jobs")));
		const report = plainScreen(term);
		expect(report.some(row => row.includes("Running: 1"))).toBe(true);
		expect(report.some(row => row.includes("sleep 222"))).toBe(true);
		expect(report.some(row => row.includes("import sys"))).toBe(true);
		expect(mode.chatContainer.children).toEqual(transcript);

		gates[0].resolve("done");
		gates[1].resolve("done");
	});
});
