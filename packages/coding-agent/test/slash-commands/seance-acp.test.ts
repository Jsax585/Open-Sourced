import { expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import { CURRENT_SESSION_VERSION } from "../../src/session/session-entries";
import { SEANCE_SLASH_COMMAND } from "../../src/slash-commands/seance";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";

async function fixture(cwd: string) {
	const file = `${cwd}/saved.jsonl`;
	await Bun.write(
		file,
		JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "saved-consultation",
			timestamp: "2026-10-01T00:00:00.000Z",
			cwd,
		}) + "\n",
	);
	const calls: { params: TaskParams; signal?: AbortSignal }[] = [];
	const output: string[] = [];
	const context: AgentMessage[] = [{ role: "user", content: "current conversation", timestamp: 1 }];
	const mainModel = getBundledModels("anthropic")[0];
	const runtime = {
		cwd,
		sessionManager: { getSessionDir: () => cwd },
		session: {
			effectiveExtensionRoots: undefined,
			model: mainModel,
			messages: context,
			agent: {
				state: {
					tools: [
						{
							name: "task",
							execute: async (_id: string, params: TaskParams, signal?: AbortSignal) => {
								calls.push({ params, signal });
								return {
									content: [
										{ type: "text", text: "Saved session contains an unresolved migration decision." },
									],
									details: { async: { state: "completed", jobId: "consultation", type: "task" } },
								};
							},
						},
					],
				},
			},
			modelRegistry: { getAvailable: () => [{ provider: "catalog", id: "consultant" }] },
		},
		output: (text: string) => {
			output.push(text);
		},
	} as unknown as SlashCommandRuntime;
	return { runtime, calls, output, file, context, mainModel };
}

async function run(runtime: SlashCommandRuntime, args: string) {
	return SEANCE_SLASH_COMMAND.handle!({ name: "seance", args, text: `/seance ${args}` }, runtime);
}

test("consults a saved transcript through the bundled task policy without resuming or changing the main model", async () => {
	using temp = TempDir.createSync("@seance-acp-");
	const f = await fixture(temp.path());
	const before = await Bun.file(f.file).text();
	const abort = new AbortController();
	f.runtime.signal = abort.signal;
	expect(await run(f.runtime, `"${f.file}" --model catalog/consultant`)).toEqual({ consumed: true });
	expect(f.calls).toHaveLength(1);
	expect(f.calls[0].params.agent).toBe("seance");
	expect(f.calls[0].params.sourceSession).toBe(f.file);
	expect(f.calls[0].params.model).toBe("catalog/consultant");
	expect(f.calls[0].params.tools).toBeUndefined();
	expect(f.calls[0].signal).toBe(abort.signal);
	expect(f.output.join("\n")).toContain("unresolved migration decision");
	expect(await Bun.file(f.file).text()).toBe(before);
	expect(f.runtime.session.model).toBe(f.mainModel);
	expect(f.runtime.session.messages).toEqual(f.context);
});

test("selects a one-off catalog model through forms and cancellation never starts a task", async () => {
	using temp = TempDir.createSync("@seance-acp-form-");
	const f = await fixture(temp.path());
	f.runtime.ui = {
		input: async () => f.file,
		select: async (_title, choices) => {
			const first = choices[0];
			return typeof first === "string" ? first : first.label;
		},
		confirm: async () => false,
		editor: async () => undefined,
	};
	await run(f.runtime, "");
	expect(f.calls).toHaveLength(1);
	expect(f.calls[0].params.model).toBe("catalog/consultant");
	f.calls.length = 0;
	f.runtime.ui.select = async () => undefined;
	await run(f.runtime, f.file);
	expect(f.calls).toHaveLength(0);
});

test("invalid saved files and unavailable task tools fail before starting a consultation", async () => {
	using temp = TempDir.createSync("@seance-acp-invalid-");
	const f = await fixture(temp.path());
	await Bun.write(f.file, "{}\n");
	expect(await run(f.runtime, `${f.file} --model catalog/consultant`)).toMatchObject({ failed: true });
	expect(f.calls).toHaveLength(0);
	const valid = await fixture(temp.path());
	valid.runtime.session.agent.state.tools = [];
	expect(await run(valid.runtime, `${valid.file} --model catalog/consultant`)).toMatchObject({ failed: true });
	expect(valid.calls).toHaveLength(0);
	expect(valid.output.join("\n")).toContain("task tool is not available");
});

test("a cancelled request does not launch after source resolution", async () => {
	using temp = TempDir.createSync("@seance-acp-cancel-");
	const f = await fixture(temp.path());
	f.runtime.signal = AbortSignal.abort();
	await run(f.runtime, `${f.file} --model catalog/consultant`);
	expect(f.calls).toHaveLength(0);
});
