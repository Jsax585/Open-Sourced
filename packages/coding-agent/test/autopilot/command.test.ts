import { describe, expect, it } from "bun:test";
import { parseAutopilotCommand } from "../../src/autopilot/command";
import { lookupBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "../../src/slash-commands/types";

const autopilot = lookupBuiltinSlashCommand("autopilot");

function runtimeFor(calls: (string | undefined)[]): TuiSlashCommandRuntime {
	return {
		draftDetached: true,
		ctx: {
			handleAutopilotCommand: async (args?: string) => {
				calls.push(args);
				return false;
			},
		} as never,
	};
}

describe("/autopilot command", () => {
	it("is a registered mode command with on/off/status subcommands", () => {
		expect(autopilot).toBeDefined();
		expect(autopilot!.allowArgs).toBe(true);
		expect(autopilot!.subcommands?.map(subcommand => subcommand.name)).toEqual([
			"on",
			"off",
			"status",
			"prompt",
			"max",
		]);
	});

	it("forwards explicit arguments to the mode handler", async () => {
		const calls: (string | undefined)[] = [];
		await autopilot!.handleTui!({ name: "autopilot", args: "on", text: "/autopilot on" }, runtimeFor(calls));
		expect(calls).toEqual(["on"]);
	});

	it("toggles when invoked without arguments", async () => {
		const calls: (string | undefined)[] = [];
		await autopilot!.handleTui!({ name: "autopilot", args: "", text: "/autopilot" }, runtimeFor(calls));
		expect(calls).toEqual([undefined]);
	});

	it("reports the current state in the autocomplete description", () => {
		const describe = autopilot!.getTuiAutocompleteDescription!;
		expect(describe({ ctx: { autopilotEnabled: true } } as never)).toBe("Autopilot: on");
		expect(describe({ ctx: { autopilotEnabled: false } } as never)).toBe("Autopilot: off");
	});
});

describe("parseAutopilotCommand", () => {
	it("parses the toggle and mode keywords", () => {
		expect(parseAutopilotCommand(undefined)).toEqual({ action: "toggle" });
		expect(parseAutopilotCommand("  ")).toEqual({ action: "toggle" });
		expect(parseAutopilotCommand("on")).toEqual({ action: "on" });
		expect(parseAutopilotCommand("off")).toEqual({ action: "off" });
		expect(parseAutopilotCommand("STATUS")).toEqual({ action: "status" });
		expect(parseAutopilotCommand("toggle")).toEqual({ action: "toggle" });
	});

	it("attaches a directive to on and prompt", () => {
		expect(parseAutopilotCommand("on always run the unit tests")).toEqual({
			action: "on",
			prompt: "always run the unit tests",
		});
		expect(parseAutopilotCommand('prompt "prefer tests over docs"')).toEqual({
			action: "prompt",
			prompt: "prefer tests over docs",
		});
		expect(parseAutopilotCommand("prompt")).toEqual({ action: "prompt" });
		expect(parseAutopilotCommand("prompt clear")).toEqual({ action: "prompt", clear: true });
		expect(parseAutopilotCommand("prompt CLEAR")).toEqual({ action: "prompt", clear: true });
	});

	it("parses the cycle-limit command", () => {
		expect(parseAutopilotCommand("max")).toEqual({ action: "max" });
		expect(parseAutopilotCommand("max 0")).toEqual({ action: "max", maxCycles: 0 });
		expect(parseAutopilotCommand("max 12")).toEqual({ action: "max", maxCycles: 12 });
		expect(parseAutopilotCommand("cycles unlimited")).toEqual({ action: "max", maxCycles: 0 });
		expect(parseAutopilotCommand("max -1").action).toBe("invalid");
		expect(parseAutopilotCommand("max abc").action).toBe("invalid");
	});

	it("treats a bare multi-word or quoted argument as a directive", () => {
		expect(parseAutopilotCommand("always prefer the conservative fix")).toEqual({
			action: "on",
			prompt: "always prefer the conservative fix",
		});
		expect(parseAutopilotCommand('"keep going"')).toEqual({ action: "on", prompt: "keep going" });
	});

	it("rejects unknown single words and trailing arguments", () => {
		expect(parseAutopilotCommand("nope").action).toBe("invalid");
		expect(parseAutopilotCommand("off now").action).toBe("invalid");
		expect(parseAutopilotCommand("status please").action).toBe("invalid");
	});
});
