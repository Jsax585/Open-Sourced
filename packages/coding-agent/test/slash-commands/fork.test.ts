import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TerminalLaunchRequest, TerminalLaunchResult } from "@oh-my-pi/pi-coding-agent/subprocess/terminal-launch";
import {
	BUILTIN_SLASH_COMMANDS,
	executeBuiltinSlashCommand,
	type BuiltinSlashCommandRuntime,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";

function createRuntime() {
	const handleForkCommand = vi.fn(async (_placement?: "pane" | "window") => undefined);
	const setText = vi.fn();
	const showError = vi.fn();
	const runtime = {
		ctx: {
			handleForkCommand,
			editor: { setText },
			showError,
		} as unknown as InteractiveModeContext,
	} as BuiltinSlashCommandRuntime;
	return { handleForkCommand, setText, showError, runtime };
}

let fixture: { session: AgentSession; authStorage: AuthStorage; tempDir: TempDir } | undefined;

beforeAll(async () => {
	await initTheme(false);
});

afterEach(async () => {
	await fixture?.session.dispose();
	fixture?.authStorage.close();
	fixture?.tempDir.removeSync();
	fixture = undefined;
	vi.restoreAllMocks();
});

async function createSessionRuntime(persistent = true) {
	const tempDir = TempDir.createSync("@omp-named-fork-");
	const authStorage = createInMemoryAuthStorage();
	const sessionManager = persistent
		? SessionManager.create(tempDir.path(), tempDir.join("sessions"))
		: SessionManager.inMemory(tempDir.path());
	const settings = Settings.isolated({ "compaction.enabled": false });
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: new ModelRegistry(authStorage),
		autoTitle: false,
	});
	fixture = { session, authStorage, tempDir };
	const messages = [
		{ role: "user" as const, content: "Keep the original conversation", timestamp: 1 },
		createAssistantMessage("The original response"),
	];
	for (const message of messages) {
		agent.appendMessage(message);
		sessionManager.appendMessage(message);
	}
	await sessionManager.setSessionName("Original branch", "user");
	await sessionManager.flush();
	const showError = vi.fn();
	const ctx = createInteractiveModeContext({ session, sessionManager, settings, showError });
	const launchTerminal = vi.fn(async (request: TerminalLaunchRequest): Promise<TerminalLaunchResult> => ({
		multiplexer: request.multiplexer,
		placement: request.placement,
	}));
	const controller = new CommandController(ctx, {
		environment: () => ({ TMUX: "server,1,0", TMUX_PANE: "%1" }),
		launchTerminal,
		resolveCliEntryCmd: () => ["omp-entry"],
		getActiveProfile: () => undefined,
		argv: () => [],
	});
	ctx.handleForkCommand = controller.handleForkCommand.bind(controller);
	return { session, sessionManager, showError, launchTerminal, runtime: { ctx } as BuiltinSlashCommandRuntime };
}

function createForkEditor(): Editor {
	const editor = new Editor({
		...getEditorTheme(),
		hintStyle: text => `\x1b[2m${text}\x1b[0m`,
	});
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...BUILTIN_SLASH_COMMANDS], process.cwd()));
	return editor;
}

async function untilRendered(editor: Editor, predicate: (frame: string) => boolean): Promise<string> {
	while (true) {
		const frame = editor.render(80).join("\n");
		if (predicate(frame)) return frame;
		await nextAutocompleteUpdate(editor);
	}
}

function nextAutocompleteUpdate(editor: Editor): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const previous = editor.onAutocompleteUpdate;
	editor.onAutocompleteUpdate = () => {
		editor.onAutocompleteUpdate = previous;
		previous?.();
		resolve();
	};
	return promise;
}

function captureSubmissions(editor: Editor): string[] {
	const submitted: string[] = [];
	editor.onSubmit = text => {
		submitted.push(text.trim());
	};
	return submitted;
}

describe("/fork slash command", () => {
	it("submits bare /fork on Enter after a typed trailing space", async () => {
		const editor = createForkEditor();
		const submitted = captureSubmissions(editor);
		for (const character of "/fork ") editor.handleInput(character);
		await nextAutocompleteUpdate(editor);

		editor.handleInput("\r");
		expect(submitted).toEqual(["/fork"]);
	});

	it("submits bare /fork on Enter after Tab accepts the command name", async () => {
		const editor = createForkEditor();
		const submitted = captureSubmissions(editor);
		for (const character of "/fork") editor.handleInput(character);
		await untilRendered(editor, () => editor.isShowingAutocomplete());

		editor.handleInput("\t");
		expect(editor.getText()).toBe("/fork ");
		// Accepting a command name chains an argument-completion request; let it settle.
		await nextAutocompleteUpdate(editor);

		editor.handleInput("\r");
		expect(submitted).toEqual(["/fork"]);
	});

	it("renders the remaining window suffix for a partial prefix and accepts it with Tab", async () => {
		const editor = createForkEditor();
		for (const character of "/fork w") editor.handleInput(character);

		await untilRendered(editor, value => editor.isShowingAutocomplete() && value.includes("\x1b[2mindow\x1b[0m"));
		expect(editor.getText()).toBe("/fork w");

		editor.handleInput("\t");
		expect(editor.getText()).toBe("/fork window ");
	});

	it("persists an explicitly named fork without renaming or changing the original conversation", async () => {
		const harness = await createSessionRuntime();
		const sourceFile = harness.sessionManager.getSessionFile()!;
		const sourceId = harness.sessionManager.getSessionId();
		const sourceBytes = await Bun.file(sourceFile).text();
		const sourceMessages = [...harness.session.messages];

		await executeBuiltinSlashCommand('/fork --name "排查 fork 命名"', harness.runtime);

		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.sessionManager.getSessionId()).not.toBe(sourceId);
		expect(harness.sessionManager.getHeader()?.parentSession).toBe(sourceId);
		expect(harness.session.messages).toEqual(sourceMessages);
		expect(await Bun.file(sourceFile).text()).toBe(sourceBytes);
		const childFile = harness.sessionManager.getSessionFile()!;
		expect(childFile).not.toBe(sourceFile);
		expect(await harness.sessionManager.setSessionName("A later generated title", "auto")).toBe(false);
		expect(harness.sessionManager.getSessionName()).toBe("排查 fork 命名");
		await harness.sessionManager.close();
		const reopened = await SessionManager.open(childFile, undefined, undefined, {
			suppressBreadcrumb: true,
			throwIfMissing: true,
		});
		try {
			expect(reopened.getSessionName()).toBe("排查 fork 命名");
			expect(reopened.titleSource).toBe("user");
		} finally {
			await reopened.close();
		}
	});

	it("keeps the inherited title when forking without an explicit name", async () => {
		const harness = await createSessionRuntime();
		const sourceId = harness.sessionManager.getSessionId();

		await executeBuiltinSlashCommand("/fork", harness.runtime);

		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.sessionManager.getSessionId()).not.toBe(sourceId);
		expect(harness.sessionManager.getSessionName()).toBe("Original branch");
	});

	it("does not rename the original session when the fork cannot create a persistent file", async () => {
		const harness = await createSessionRuntime(false);
		const sourceId = harness.sessionManager.getSessionId();

		await executeBuiltinSlashCommand('/fork --name "Must not rename the parent"', harness.runtime);

		expect(harness.showError).toHaveBeenCalledTimes(1);
		expect(harness.sessionManager.getSessionId()).toBe(sourceId);
		expect(harness.sessionManager.getSessionFile()).toBeUndefined();
		expect(harness.sessionManager.getSessionName()).toBe("Original branch");
	});

	it.each([
		["pane", "pane"],
		["window", "window"],
		["tab", "window"],
	] as const)(
		"opens /fork %s from the original transcript in a %s without switching the parent",
		async (argument, placement) => {
			const harness = await createSessionRuntime();
			const sourceId = harness.sessionManager.getSessionId();
			const sourceFile = harness.sessionManager.getSessionFile();

			await executeBuiltinSlashCommand(`/fork ${argument}`, harness.runtime);

			expect(harness.showError).not.toHaveBeenCalled();
			expect(harness.sessionManager.getSessionId()).toBe(sourceId);
			expect(harness.sessionManager.getSessionName()).toBe("Original branch");
			expect(harness.launchTerminal).toHaveBeenCalledTimes(1);
			const request = harness.launchTerminal.mock.calls[0]![0];
			expect(request.placement).toBe(placement);
			const childArgs = parseArgs(request.command.slice(request.command.indexOf("omp-entry") + 1));
			expect(childArgs.fork).toBe(sourceFile);
		},
	);

	it.each(["/fork --name", '/fork --name ""', '/fork --name "unfinished', '/fork --name "\u0085"'])(
		"rejects a missing, empty, unfinished, or normalization-empty title before forking: %s",
		async command => {
			const harness = createRuntime();

			await executeBuiltinSlashCommand(command, harness.runtime);

			expect(harness.handleForkCommand).not.toHaveBeenCalled();
			expect(harness.showError).toHaveBeenCalledTimes(1);
			expect(harness.setText).toHaveBeenCalledWith("");
		},
	);

	it("does not create or switch to a fork when the title normalizes to empty", async () => {
		const harness = await createSessionRuntime();
		const sourceId = harness.sessionManager.getSessionId();
		const sourceFile = harness.sessionManager.getSessionFile();

		await executeBuiltinSlashCommand('/fork --name "\u0085"', harness.runtime);

		expect(harness.showError).toHaveBeenCalledTimes(1);
		expect(harness.sessionManager.getSessionId()).toBe(sourceId);
		expect(harness.sessionManager.getSessionFile()).toBe(sourceFile);
		expect(harness.sessionManager.getSessionName()).toBe("Original branch");
	});

	it("stores the normalized title when a control character separates words", async () => {
		const harness = await createSessionRuntime();

		await executeBuiltinSlashCommand('/fork --name "A\u0085B"', harness.runtime);

		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.sessionManager.getSessionName()).toBe("A B");
	});

	it("consumes invalid placement without submitting it as a prompt", async () => {
		const harness = createRuntime();
		expect(await executeBuiltinSlashCommand("/fork pane extra", harness.runtime)).toBe(true);
		expect(harness.handleForkCommand).not.toHaveBeenCalled();
		expect(harness.showError).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});
