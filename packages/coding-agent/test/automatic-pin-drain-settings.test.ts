import { expect, test } from "bun:test";
import { cfgAuthMaxResetHours, cfgAuthSecondaryDrainFactor } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

test("automatic pin drain eviction is disabled by default", () => {
	const settings = Settings.isolated({});
	expect(cfgAuthSecondaryDrainFactor.get(settings)).toBe(0);
	expect(cfgAuthMaxResetHours.get(settings)).toBe(12);
});

test("automatic pin drain settings read live overrides", () => {
	const settings = Settings.isolated({});
	cfgAuthSecondaryDrainFactor.set(settings, 2);
	cfgAuthMaxResetHours.set(settings, 6);
	expect(cfgAuthSecondaryDrainFactor.get(settings)).toBe(2);
	expect(cfgAuthMaxResetHours.get(settings)).toBe(6);
	cfgAuthSecondaryDrainFactor.set(settings, 0);
	expect(cfgAuthSecondaryDrainFactor.get(settings)).toBe(0);
});
