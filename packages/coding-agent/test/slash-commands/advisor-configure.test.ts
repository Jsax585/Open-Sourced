import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { loadWatchdogConfigFile, saveWatchdogConfigFile } from "../../src/advisor/config";
import { Settings } from "../../src/config/settings";
import { lookupBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function fixture(cancelAt?: number) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "advisor-command-"));
	directories.push(cwd);
	const file = path.join(cwd, "WATCHDOG.yaml");
	const original = {
		instructions: "shared",
		advisors: [
			{ name: "First", model: "existing/model", enabled: false, instructions: "@rules.md", tools: [] },
			{ name: "Second", model: "other/model", reviewInterval: 3 },
		],
	};
	await saveWatchdogConfigFile(file, original);
	const models = getBundledModels("anthropic").slice(0, 1);
	expect(models.length).toBe(1);
	const mainModel = models[0];
	let refreshed = false;
	let step = 0;
	const output: string[] = [];
	const runtime = {
		cwd,
		settings: await Settings.loadReadOnly({ cwd, agentDir: path.join(cwd, "user-config") }),
		session: {
			model: mainModel,
			modelRegistry: { getAvailable: () => models },
			applyAdvisorConfigs: () => {
				refreshed = true;
			},
		},
		ui: {
			select: async (_title: string, choices: string[]) => {
				const current = step++;
				if (current === cancelAt) return undefined;
				return choices[0];
			},
		},
		output: (text: string) => {
			output.push(text);
		},
	} as unknown as SlashCommandRuntime;
	return { runtime, file, original, mainModel, models, output, refreshed: () => refreshed };
}

async function configure(runtime: SlashCommandRuntime) {
	await lookupBuiltinSlashCommand("advisor")!.handle!(
		{ name: "advisor", args: "configure", text: "/advisor configure" },
		runtime,
	);
}

it("persists only the selected advisor model, preserving the main model, disabled advisor and other fields", async () => {
	const test = await fixture();
	await configure(test.runtime);
	const persisted = await loadWatchdogConfigFile(test.file);
	expect(persisted).toEqual({
		...test.original,
		advisors: [
			{ ...test.original.advisors[0], model: `${test.models[0].provider}/${test.models[0].id}` },
			test.original.advisors[1],
		],
	});
	expect(test.runtime.session.model).toBe(test.mainModel);
	expect(test.refreshed()).toBe(true);
	expect(await Bun.file(path.join(test.runtime.cwd, "WATCHDOG.yml")).exists()).toBe(false);
});

for (const step of [0, 1, 2]) {
	it(`cancelling selector ${step + 1} leaves configuration bytes and runtime unchanged`, async () => {
		const test = await fixture(step);
		const before = await Bun.file(test.file).text();
		await configure(test.runtime);
		expect(await Bun.file(test.file).text()).toBe(before);
		expect(test.refreshed()).toBe(false);
	});
}

it("reports missing form support without changing configuration", async () => {
	const test = await fixture();
	delete test.runtime.ui;
	await configure(test.runtime);
	expect(test.output.join(" ")).toContain("form elicitation");
	expect(await loadWatchdogConfigFile(test.file)).toEqual(test.original);
	expect(test.refreshed()).toBe(false);
});

it("selects a second advisor without altering the first", async () => {
	const test = await fixture();
	let step = 0;
	test.runtime.ui!.select = async (_title, choices) => {
		const index = step++ === 1 ? 1 : 0;
		const choice = choices[index];
		return typeof choice === "string" ? choice : choice.label;
	};
	await configure(test.runtime);
	const persisted = await loadWatchdogConfigFile(test.file);
	expect(persisted.advisors[0]).toEqual(test.original.advisors[0]);
	expect(persisted.advisors[1].model).toBe(`${test.models[0].provider}/${test.models[0].id}`);
});

it("rejects a model outside the available catalog without saving", async () => {
	const test = await fixture();
	let step = 0;
	test.runtime.ui!.select = async (_title, choices) => {
		if (step++ === 2) return "unavailable/model";
		const choice = choices[0];
		return typeof choice === "string" ? choice : choice.label;
	};
	const before = await Bun.file(test.file).text();
	await configure(test.runtime);
	expect(await Bun.file(test.file).text()).toBe(before);
	expect(test.refreshed()).toBe(false);
});

it("saves user scope in the session settings directory without changing the project config", async () => {
	const test = await fixture();
	const projectBefore = await Bun.file(test.file).text();
	let step = 0;
	test.runtime.ui!.select = async (_title, choices) => {
		const choice = choices[step++ === 0 ? 1 : 0];
		return typeof choice === "string" ? choice : choice.label;
	};
	await configure(test.runtime);
	const saved = await loadWatchdogConfigFile(path.join(test.runtime.settings.getAgentDir(), "WATCHDOG.yml"));
	expect(saved.advisors).toEqual([{ name: "default", model: `${test.models[0].provider}/${test.models[0].id}` }]);
	expect(await Bun.file(test.file).text()).toBe(projectBefore);
	expect(test.runtime.session.model).toBe(test.mainModel);
	expect(test.refreshed()).toBe(true);
});

it("refuses malformed configuration rather than discarding entries", async () => {
	const test = await fixture();
	await Bun.write(test.file, "advisors:\n  - name: invalid\n    model: 42\n");
	const before = await Bun.file(test.file).text();
	await configure(test.runtime);
	expect(await Bun.file(test.file).text()).toBe(before);
	expect(test.refreshed()).toBe(false);
	expect(test.output.join(" ")).toContain("model");
});
