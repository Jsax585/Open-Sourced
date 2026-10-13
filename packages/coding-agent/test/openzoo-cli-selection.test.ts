import { expect, spyOn, test } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

for (const args of [
	["--provider", "openzoo", "--model", "auto"],
	["--model", "openzoo/auto"],
]) {
	test(`cold CLI discovery resolves ${args.join(" ")}`, async () => {
		const tmp = await TempDir.create("@openzoo-cli-");
		const authStorage = createInMemoryAuthStorage();
		const settings = Settings.isolated({});
		const urls: string[] = [];
		const registry = new ModelRegistry(authStorage, tmp.join("models.yml"), {
			settings,
			fetch: async input => {
				urls.push(String(input));
				return Response.json({ data: [{ id: "openzoo/auto", owned_by: "openzoo" }] });
			},
		});
		const exit = spyOn(process, "exit").mockImplementation(code => {
			throw new Error(`CLI exited before discovering models: ${code}`);
		});
		try {
			expect(registry.getAvailable().filter(model => model.provider === "openzoo")).toEqual([]);
			const options = await buildSessionOptions(parseArgs(args), [], undefined, registry, settings);
			expect(options.model?.provider).toBe("openzoo");
			expect(options.model?.id).toBe("auto");
			expect(urls).toHaveLength(1);
			expect(urls[0]).toEndWith("/v1/models");
		} finally {
			exit.mockRestore();
			authStorage.close();
			await tmp.remove();
		}
	});
}

test("a public tunnel 401 is an authentication failure, not a missing catalog", async () => {
	// models.yml scopes the tunnel so this does not touch OPENZOO_BASE_URL.
	// A cold cache used to record the provider unavailable and an explicit
	// openzoo/auto selection reported a missing model instead of /login.
	const tmp = await TempDir.create("@openzoo-tunnel-auth-");
	await Bun.write(
		tmp.join("models.yml"),
		["providers:", "  openzoo:", "    baseUrl: https://tunnel.example/v1", ""].join("\n"),
	);
	const authStorage = createInMemoryAuthStorage();
	const settings = Settings.isolated({});
	const registry = new ModelRegistry(authStorage, tmp.join("models.yml"), {
		settings,
		fetch: async () => new Response("unauthorized", { status: 401 }),
	});
	try {
		await registry.refreshProvider("openzoo", "online");
		expect(registry.getProviderDiscoveryState("openzoo")).toMatchObject({
			status: "unauthenticated",
			error: "HTTP 401 from https://tunnel.example/v1/models",
		});
		expect(registry.find("openzoo", "auto")).toBeUndefined();
	} finally {
		authStorage.close();
		await tmp.remove();
	}
});
