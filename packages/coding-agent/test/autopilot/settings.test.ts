import { describe, expect, it } from "bun:test";
import { cfgAutopilotMaxCycles } from "../../src/autopilot/settings";
import { Settings } from "../../src/config/settings";

describe("autopilot settings", () => {
	it("defaults to unlimited cycles", () => {
		expect(cfgAutopilotMaxCycles.get(Settings.isolated({}))).toBe(0);
	});
});
