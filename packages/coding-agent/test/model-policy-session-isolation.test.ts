import { expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { bindModelPolicyScope, ModelPolicyScope, streamSimple, withModelPolicyScope } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import {
	bindPreparedExtensions,
	preventSharedRuntimeModelPolicyRegistration,
} from "../src/extensibility/extensions/loader";
import type { ExtensionAPI } from "../src/extensibility/extensions/types";
import { AgentSession } from "../src/session/agent-session";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { writeFileWithFallback, deleteFileWithFallback } from "../src/tools/file-write-fallback";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

async function fixture() {
	const temp = TempDir.createSync("@policy-isolation-");
	const requests: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			requests.push(((await request.json()) as { model: string }).model);
			return new Response(
				'data: {"id":"r","object":"chat.completion.chunk","created":1,"model":"outside","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	const auth = await AuthStorage.create(temp.join("auth.db"));
	auth.keys.setRuntime("isolation-test", "test");
	const registry = new ModelRegistry(auth, temp.join("models.yml"));
	registry.registerProvider("isolation-test", {
		apiKey: "test",
		api: "openai-completions",
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		models: ["inside", "outside"].map(id => ({
			id,
			name: id,
			reasoning: false,
			input: ["text"],
			contextWindow: 32000,
			maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
	});
	return {
		temp,
		registry,
		requests,
		dispose() {
			server.stop(true);
			auth.close();
			temp.removeSync();
		},
	};
}

test("policy replacement exhaustion never invokes an authenticated model outside enabledModels", async () => {
	const f = await fixture();
	const settings = Settings.isolated({ enabledModels: ["isolation-test/inside"], "retry.usageAwareFallback": false });
	const manager = SessionManager.inMemory();
	const scope = new ModelPolicyScope();
	scope.register({ id: "outside-only", allowedEfforts: model => (model.id === "outside" ? ["off"] : []) });
	bindModelPolicyScope(settings, scope, manager.getSessionId());
	const agent = new Agent({
		sessionId: manager.getSessionId(),
		getApiKey: model => f.registry.getApiKey(model, manager.getSessionId()),
		initialState: { model: f.registry.find("isolation-test", "inside")!, tools: [], systemPrompt: ["Reply ok"] },
	});
	const session = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry: f.registry });
	try {
		await expect(session.prompt("hello")).rejects.toThrow("exhausted authenticated native candidates");
		expect(f.requests).toEqual([]);
	} finally {
		await session.dispose();
		f.dispose();
	}
});

test("an initially empty unrebindable preload rejects late registration without changing requests", async () => {
	const f = await fixture();
	let api!: ExtensionAPI;
	const loaded = await bindPreparedExtensions(
		[
			{
				path: "<inline-isolation>",
				resolvedPath: "<inline-isolation>",
				factory: value => {
					api = value;
				},
				error: null,
			},
		],
		f.temp.path(),
	);
	try {
		preventSharedRuntimeModelPolicyRegistration(loaded.runtime);
		expect(() => api.registerModelPolicy({ id: "late", allowedEfforts: () => [] })).toThrow("rebindable factories");
		await withModelPolicyScope(loaded.runtime.modelPolicyScope, () =>
			streamSimple(
				f.registry.find("isolation-test", "outside")!,
				{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
				{ apiKey: "test" },
			).result(),
		);
		expect(f.requests).toEqual(["outside"]);
	} finally {
		f.dispose();
	}
});

test("fresh bindings of an initially empty preload isolate late policies across concurrent requests", async () => {
	const f = await fixture();
	const apis: ExtensionAPI[] = [];
	const prepared = [
		{
			path: "<inline-late>",
			resolvedPath: "<inline-late>",
			factory: (api: ExtensionAPI) => {
				apis.push(api);
			},
			error: null,
		},
	];
	const a = await bindPreparedExtensions(prepared, f.temp.path());
	const b = await bindPreparedExtensions(prepared, f.temp.path());
	try {
		apis[0]!.registerModelPolicy({ id: "late-deny", allowedEfforts: () => [] });
		const results = await Promise.allSettled(
			[a, b].map(binding =>
				withModelPolicyScope(
					binding.runtime.modelPolicyScope,
					async () =>
						await streamSimple(
							f.registry.find("isolation-test", "outside")!,
							{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
							{ apiKey: "test" },
						).result(),
				),
			),
		);
		expect(results.map(result => result.status)).toEqual(["rejected", "fulfilled"]);
		expect(f.requests).toEqual(["outside"]);
	} finally {
		f.dispose();
	}
});

test("process-wide file fallbacks invoke inference under the owner's policy, not the caller's", async () => {
	const f = await fixture();
	const loaded = await bindPreparedExtensions(
		[
			{
				path: "<inline-owner>",
				resolvedPath: "<inline-owner>",
				factory: api => {
					api.registerModelPolicy({
						id: "owner",
						allowedEfforts: model => (model.id === "outside" ? ["off"] : []),
					});
					const infer = async () => {
						await streamSimple(
							f.registry.find("isolation-test", "outside")!,
							{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
							{ apiKey: "test" },
						).result();
						return true;
					};
					api.registerFileWriteFallback(infer);
					api.registerFileDeleteFallback(infer);
				},
				error: null,
			},
		],
		f.temp.path(),
	);
	const runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		f.temp.path(),
		SessionManager.inMemory(),
		f.registry,
	);
	runner.initialize(
		{
			sendMessage() {},
			sendUserMessage() {},
			appendEntry() {},
			setLabel() {},
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: async () => {},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => undefined,
			setThinkingLevel() {},
			getSessionName: () => undefined,
			setSessionName: async () => {},
		},
		{
			getModel: () => undefined,
			isIdle: () => true,
			abort() {},
			hasPendingMessages: () => false,
			shutdown() {},
			getContextUsage: () => undefined,
			compact: async () => {},
			getSystemPrompt: () => [],
		},
	);
	const caller = new ModelPolicyScope();
	caller.register({ id: "caller-deny", allowedEfforts: () => [] });
	const denied = Object.assign(new Error("denied"), { code: "EACCES" });
	const file = {
		write: async () => {
			throw denied;
		},
		unlink: async () => {
			throw denied;
		},
	} as unknown as Bun.BunFile;
	try {
		const target = f.temp.join("target");
		await Bun.write(target, "original");
		for (const scope of [caller, undefined]) {
			await withModelPolicyScope(scope, () => writeFileWithFallback(target, "replacement", file));
			await withModelPolicyScope(scope, () => deleteFileWithFallback(target, file));
		}
		expect(f.requests).toEqual(["outside", "outside", "outside", "outside"]);
	} finally {
		runner.disposeFileFallbacks();
		f.dispose();
	}
});
