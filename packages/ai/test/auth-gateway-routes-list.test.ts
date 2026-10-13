import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RouteRegistry, startAuthGateway } from "../src/auth-gateway";
import type { RouteDefinition } from "../src/auth-gateway";
import { AuthStorage } from "../src/auth-storage";
import { createMockModel } from "../src/providers/mock";

async function withListing(
	definitions: readonly RouteDefinition[],
	run: (url: string, registry: RouteRegistry, changeAlias: () => void) => Promise<void>,
): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-route-list-"));
	const storage = await AuthStorage.create(path.join(directory, "auth.db"), {
		usageProviderResolver: () => undefined,
	});
	const first = {
		...createMockModel({ provider: "fixture", id: "first" }),
		headers: { Authorization: "private-model-fixture-bearer" },
	};
	const second = createMockModel({ provider: "fixture", id: "second" });
	let alias = first;
	const registry = new RouteRegistry(id => (id === "alias" ? alias : id === "second" ? second : undefined));
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["listing-fixture-client"],
		storage,
		resolveModel: () => undefined,
		routeRegistry: registry,
		routes: definitions,
		listModels: () => [first, second],
	});
	try {
		await run(gateway.url, registry, () => {
			alias = { ...first, id: "changed", name: "Changed fixture" };
		});
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(directory, { recursive: true });
	}
}

const definitions: readonly RouteDefinition[] = [
	{
		id: "virtual-a",
		root: {
			type: "fallback",
			on: ["provider_unavailable"],
			children: [
				{ type: "target", model: "alias" },
				{ type: "target", model: "second" },
			],
		},
	},
	{ id: "virtual-b", root: { type: "target", model: "second" } },
];
const auth = { Authorization: "Bearer listing-fixture-client" };

it("lists canonical virtual routes without private model state", async () => {
	await withListing(definitions, async url => {
		const response = await fetch(`${url}/v1/routes`, { headers: auth });
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).not.toContain("private-model-fixture-bearer");
		expect(text).not.toContain("Authorization");
		expect(JSON.parse(text)).toEqual({
			object: "list",
			generation: 3,
			data: [
				{
					id: "virtual-a",
					generation: 2,
					targets: ["fixture/first", "fixture/second"],
					fallbacks: { provider_unavailable: ["fixture/second"] },
				},
				{ id: "virtual-b", generation: 3, targets: ["fixture/second"], fallbacks: {} },
			],
		});
	});
});

it("requires an authorized bearer for route listing", async () => {
	await withListing(definitions, async url => {
		for (const headers of [undefined, { Authorization: "Bearer wrong-fixture-client" }]) {
			const response = await fetch(`${url}/v1/routes`, { headers });
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({ error: "unauthorized" });
		}
	});
});

it("does not expose route writes or count concrete catalog models as virtual routes", async () => {
	await withListing([], async url => {
		const response = await fetch(`${url}/v1/routes`, { headers: auth });
		expect(await response.json()).toEqual({ object: "list", generation: 1, data: [] });
		for (const method of ["POST", "PUT", "DELETE"]) {
			const rejected = await fetch(`${url}/v1/routes`, { method, headers: auth });
			expect(rejected.status).toBe(404);
			await rejected.text();
		}
	});
});

it("lists the same current catalog snapshot that dispatch will resolve", async () => {
	await withListing(definitions, async (url, registry, changeAlias) => {
		changeAlias();
		const response = await fetch(`${url}/v1/routes`, { headers: auth });
		const body = (await response.json()) as { generation: number; data: Array<{ id: string; targets: string[] }> };
		expect(body.generation).toBe(3);
		const resolved = registry.resolve("virtual-a");
		if (!resolved) throw new Error("Expected a registered fixture route");
		expect(body.data[0]?.targets).toEqual([...resolved.targets]);
		expect(body.data[0]?.targets).toEqual(["fixture/changed", "fixture/second"]);
	});
});

it("gets a virtual route by its exact encoded ID without leaking model headers", async () => {
	const id = "virtual/雪 % +";
	await withListing([{ id, root: { type: "target", model: "alias" } }], async (url, _registry, changeAlias) => {
		changeAlias();
		const response = await fetch(`${url}/v1/routes/${encodeURIComponent(id)}`, { headers: auth });
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).not.toContain("private-model-fixture-bearer");
		expect(JSON.parse(text)).toEqual({ id, generation: 2, targets: ["fixture/changed"], fallbacks: {} });
	});
});

it("does not wrap missing or concrete IDs into virtual route lookup", async () => {
	await withListing(definitions, async url => {
		for (const id of ["no-such-route", "alias", "fixture/first"]) {
			const response = await fetch(`${url}/v1/routes/${encodeURIComponent(id)}`, { headers: auth });
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ error: `Unknown route: ${id}` });
		}
	});
});

it("requires a bearer and rejects malformed route-ID encoding", async () => {
	await withListing(definitions, async url => {
		const unauthorized = await fetch(`${url}/v1/routes/virtual-a`);
		expect(unauthorized.status).toBe(401);
		await unauthorized.text();
		const invalid = await fetch(`${url}/v1/routes/%GG`, { headers: auth });
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toEqual({ error: "invalid route id encoding" });
	});
});

it("keeps individual lookup and collection listing consistent", async () => {
	await withListing(definitions, async url => {
		const response = await fetch(`${url}/v1/routes/virtual-a`, { headers: auth });
		expect(response.status).toBe(200);
		const row = await response.json();
		const collection = await fetch(`${url}/v1/routes/`, { headers: auth });
		expect(collection.status).toBe(200);
		expect(await collection.json()).toMatchObject({ object: "list", data: expect.arrayContaining([row]) });
	});
});
