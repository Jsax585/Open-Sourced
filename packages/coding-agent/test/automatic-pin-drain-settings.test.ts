import { expect, test } from "bun:test";
import { createAuthGatewayStorageOptions } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-cli";
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

test("gateway storage receives the same live drain settings as SDK discovery", async () => {
	const settings = Settings.isolated({});
	const options = await createAuthGatewayStorageOptions(settings, "test broker");
	expect(options.automaticPinEviction?.()).toEqual({ secondaryDrainFactor: 0, maxResetHours: 12 });
	cfgAuthSecondaryDrainFactor.set(settings, 2);
	cfgAuthMaxResetHours.set(settings, 6);
	expect(options.automaticPinEviction?.()).toEqual({ secondaryDrainFactor: 2, maxResetHours: 6 });
	expect(options.sourceLabel).toBe("test broker");
});
