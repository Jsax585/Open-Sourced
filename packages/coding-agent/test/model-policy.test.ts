import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelPolicyScope, bindModelPolicyScope, streamSimple, withModelPolicyScope } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "../src/config/model-registry";
import { resolveRoleChain } from "../src/config/model-resolver";
import { Settings } from "../src/config/settings";
import { bindPreparedExtensions, loadExtensions } from "../src/extensibility/extensions/loader";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionMaintenance, type SessionMaintenanceHost } from "../src/session/session-maintenance";
import { SessionManager } from "../src/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

async function fixture() {
	const temp = TempDir.createSync("@model-policy-");
	const requests: Record<string, unknown>[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			requests.push((await request.json()) as Record<string, unknown>);
			return new Response(
				'data: {"id":"r","object":"chat.completion.chunk","created":1,"model":"good","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"r","object":"chat.completion.chunk","created":1,"model":"good","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n',
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	const auth = await AuthStorage.create(temp.join("auth.db"));
	auth.keys.setRuntime("policy-test", "test");
	const registry = new ModelRegistry(auth, temp.join("models.yml"));
	registry.registerProvider("policy-test", {
		apiKey: "test",
		api: "openai-completions",
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		models: ["bad", "good", "largest-denied"].map(id => ({
			id,
			name: id,
			reasoning: false,
			input: ["text"],
			contextWindow: id === "largest-denied" ? 1000000 : id === "good" ? 64000 : 32000,
			maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
	});
	const settings = Settings.isolated({
		"retry.usageAwareFallback": false,
		"retry.fallbackChains": { slow: ["policy-test/bad"] },
		"compaction.methodOrder": ["soft"],
	});
	settings.setModelRole("slow", "policy-test/bad");
	settings.setModelRole("default", "policy-test/bad");
	const scope = new ModelPolicyScope();
	scope.register({
		id: "floor",
		allowedEfforts: model => (model.provider === "policy-test" && model.id === "good" ? ["off"] : []),
	});
	bindModelPolicyScope(settings, scope);
	return {
		temp,
		server,
		auth,
		registry,
		settings,
		scope,
		requests,
		dispose() {
			server.stop(true);
			auth.close();
			temp.removeSync();
		},
	};
}

describe("native model policy selection", () => {
	test("initial below-floor choice uses native fallback despite an inherited below-floor chain", async () => {
		const f = await fixture();
		const manager = SessionManager.inMemory();
		bindModelPolicyScope(f.settings, f.scope, manager.getSessionId());
		const agent = new Agent({
			sessionId: manager.getSessionId(),
			getApiKey: model => f.registry.getApiKey(model, manager.getSessionId()),
			initialState: { model: f.registry.find("policy-test", "bad")!, tools: [], systemPrompt: ["Reply ok"] },
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: f.settings,
			modelRegistry: f.registry,
		});
		try {
			await session.prompt("hello");
			expect(f.requests).toHaveLength(1);
			expect(f.requests[0]?.model).toBe("good");
			expect(session.servingModel?.selector).toContain("policy-test/good");
		} finally {
			await session.dispose();
			f.dispose();
		}
	});

	test("native candidate exhaustion raises an error and makes no request", async () => {
		const f = await fixture();
		const deny = new ModelPolicyScope();
		deny.register({ id: "deny", allowedEfforts: () => [] });
		const manager = SessionManager.inMemory();
		bindModelPolicyScope(f.settings, deny, manager.getSessionId());
		const agent = new Agent({
			sessionId: manager.getSessionId(),
			getApiKey: model => f.registry.getApiKey(model, manager.getSessionId()),
			initialState: { model: f.registry.find("policy-test", "bad")!, tools: [], systemPrompt: ["Reply ok"] },
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: f.settings,
			modelRegistry: f.registry,
		});
		try {
			await expect(session.prompt("hello")).rejects.toThrow("exhausted authenticated native candidates");
			expect(f.requests).toHaveLength(0);
		} finally {
			await session.dispose();
			f.dispose();
		}
	});

	test("helper role chains replace inherited disallowed choices without marking generated choices explicit", async () => {
		const f = await fixture();
		try {
			const chain = resolveRoleChain("slow", f.settings, f.registry.getAvailable());
			expect(chain).toHaveLength(1);
			expect(chain[0]?.explicit).toBe(false);
			await withModelPolicyScope(f.scope, () =>
				streamSimple(
					chain[0]!.model,
					{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
					{ apiKey: "test" },
				).result(),
			);
			expect(f.requests.map(request => request.model)).toEqual(["good"]);
		} finally {
			f.dispose();
		}
	});

	test("compaction filters before largest-window selection, including caller filters", async () => {
		const f = await fixture();
		try {
			const maintenance = new SessionMaintenance({
				modelRegistry: f.registry,
				settings: f.settings,
				sessionId: () => "compaction-policy-test",
			} as SessionMaintenanceHost);
			const models = f.registry.getAvailable();
			const candidates = maintenance.resolveCompactionModelCandidates(f.registry.find("policy-test", "bad"), models);
			expect(candidates.map(model => model.id)).toEqual(["good"]);
			await withModelPolicyScope(f.scope, () =>
				streamSimple(
					candidates[0]!,
					{ messages: [{ role: "user", content: "summarize", timestamp: 1 }] },
					{ apiKey: "test" },
				).result(),
			);
			expect(f.requests.map(request => request.model)).toEqual(["good"]);
			expect(maintenance.resolveCompactionModelCandidates(undefined, models, () => false)).toEqual([]);
		} finally {
			f.dispose();
		}
	});

	test("required policy declarations survive failed import, failed factory, and prepared child rebinding", async () => {
		const f = await fixture();
		try {
			await fs.writeFile(
				f.temp.join("package.json"),
				JSON.stringify({ type: "module", omp: { requiredModelPolicies: ["required"] } }),
			);
			for (const [name, source] of [
				["import", 'throw new Error("import failed"); export default () => {};'],
				[
					"factory",
					'export default api => { api.registerModelPolicy({id:"required", allowedEfforts:()=>["off"]}); throw new Error("factory failed"); };',
				],
				["missing", "export default () => {};"],
			] as const) {
				const file = f.temp.join(`${name}.ts`);
				await fs.writeFile(file, source);
				const loaded = await loadExtensions([file], f.temp.path());
				expect(loaded.errors).toHaveLength(1);
				for (const runtime of [
					loaded.runtime,
					(await bindPreparedExtensions(loaded.preparedExtensions!, f.temp.path())).runtime,
				]) {
					expect(() =>
						withModelPolicyScope(runtime.modelPolicyScope, () =>
							streamSimple(f.registry.find("policy-test", "good")!, { messages: [] }, { apiKey: "test" }),
						),
					).toThrow();
				}
			}
			expect(f.requests).toHaveLength(0);
		} finally {
			f.dispose();
		}
	});
});
