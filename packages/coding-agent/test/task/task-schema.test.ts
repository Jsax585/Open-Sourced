import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool, taskSchema } from "@oh-my-pi/pi-coding-agent/task";
import { loadBundledAgents, parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { getTaskSchema } from "@oh-my-pi/pi-coding-agent/task/types";
import { isBundledSeance, seanceTaskSchemaFields } from "@oh-my-pi/pi-coding-agent/task/seance";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

let taskSchemaSessionIndex = 0;

function createSession(
	options: { parentSpawns?: string; disabledAgents?: string[]; planMode?: boolean } = {},
): ToolSession {
	return {
		cwd: `/tmp/task-schema-${taskSchemaSessionIndex++}`,
		hasUI: false,
		settings: Settings.isolated({
			"task.isolation.enabled": false,
			"task.batch": false,
			"task.disabledAgents": options.disabledAgents ?? [],
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => options.parentSpawns ?? "*",
		getPlanModeState: () => (options.planMode ? { enabled: true } : undefined),
	} as unknown as ToolSession;
}

const bundledSeance = loadBundledAgents().find(agent => agent.name === "seance")!;
// Contract: the single-spawn schema (`task.batch: false`; the exported
// `taskSchema` instance) carries no batch fields while accepting a caller
// `model`, `outputSchema`, and its validation mode. The batch shape (`tasks[]` + shared
// `context`) is gated by the `task.batch` setting (default on, covered by
// test/task/task-batch.test.ts).

describe("task schema (single-spawn)", () => {
	it("requires task", () => {
		const parsed = taskSchema({ agent: "scout", solutionSpace: "c" });
		expect(parsed instanceof type.errors).toBe(true);
	});

	it("removes eval tool names from the wire shape when eval.tools.enabled is off", () => {
		const schema = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: false,
			evalToolsEnabled: false,
		});
		const parsed = schema({
			agent: "scout",
			task: "Map the auth module.",
			solutionSpace: "c",
			tools: ["word_count"],
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (parsed && typeof parsed === "object" && !(parsed instanceof type.errors)) {
			expect("tools" in parsed).toBe(false);
		}
	});

	it("retains caller outputSchema, schemaMode, and eval tool names while stripping stale keys", () => {
		const outputSchema = { type: "object", properties: { answer: { type: "string" } } };
		const parsed = taskSchema({
			agent: "scout",
			task: "Map the auth module.",
			solutionSpace: "c",
			outputSchema,
			schemaMode: "strict",
			tools: ["word_count"],
			context: "shared background",
			tasks: [{ name: "A", task: "..." }],
			schema: '{"properties":{}}',
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.outputSchema).toEqual(outputSchema);
			expect(parsed.schemaMode).toBe("strict");
			expect(parsed.tools).toEqual(["word_count"]);
			expect("tasks" in parsed).toBe(false);
			expect("context" in parsed).toBe(false);
			expect("schema" in parsed).toBe(false);
		}
	});
});

describe("task schema seance fields", () => {
	it("accepts source and model selectors in every flat/batch isolation mode", () => {
		for (const batchEnabled of [false, true]) {
			for (const isolationEnabled of [false, true]) {
				const schema = getTaskSchema({
					batchEnabled,
					isolationEnabled,
					evalToolsEnabled: false,
					seanceFields: seanceTaskSchemaFields,
				});
				const modelSelector = batchEnabled
					? ["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-5"]
					: "anthropic/claude-sonnet-4-5";
				const item = {
					agent: "seance",
					task: "Read historical context.",
					solutionSpace: "focused read-only inspection",
					sourceSession: "/sessions/source.jsonl",
					model: modelSelector,
					...(isolationEnabled ? { isolated: false } : {}),
				};
				const parsed = schema(batchEnabled ? { context: "shared context", tasks: [item] } : { ...item });
				expect(parsed instanceof type.errors).toBe(false);
				if (parsed instanceof type.errors) continue;
				if (!parsed || typeof parsed !== "object") {
					expect(parsed).toBeTruthy();
					continue;
				}
				let parsedItem: unknown = parsed;
				if (batchEnabled) {
					if (!("tasks" in parsed) || !Array.isArray(parsed.tasks)) {
						expect(parsed).toHaveProperty("tasks");
						continue;
					}
					parsedItem = parsed.tasks[0];
				}
				expect(parsedItem).toMatchObject({
					sourceSession: "/sessions/source.jsonl",
					model: modelSelector,
				});
			}
		}
	});
	it("omits seance fields when they are not enabled", () => {
		for (const batchEnabled of [false, true]) {
			for (const isolationEnabled of [false, true]) {
				const schema = getTaskSchema({ batchEnabled, isolationEnabled });
				const wireSchema = JSON.stringify(schema.toJsonSchema());
				expect(wireSchema).not.toContain('"sourceSession"');
				expect(wireSchema).not.toContain('"model"');
			}
		}
	});

	it("advertises fields only when bundled seance is spawnable", async () => {
		const discovery = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValue({ agents: [bundledSeance], projectAgentsDir: null });

		const allowed = await TaskTool.create(createSession({ parentSpawns: "task,seance" }));
		expect(JSON.stringify(allowed.parameters.toJsonSchema())).toContain('"sourceSession"');

		const policyDenied = await TaskTool.create(createSession({ parentSpawns: "task" }));
		expect(JSON.stringify(policyDenied.parameters.toJsonSchema())).not.toContain('"sourceSession"');

		const agentDisabled = await TaskTool.create(
			createSession({ parentSpawns: "task,seance", disabledAgents: ["seance"] }),
		);
		expect(JSON.stringify(agentDisabled.parameters.toJsonSchema())).not.toContain('"sourceSession"');

		discovery.mockResolvedValue({ agents: [], projectAgentsDir: null });
		const absentFromCatalogue = await TaskTool.create(createSession({ parentSpawns: "task,seance" }));
		expect(JSON.stringify(absentFromCatalogue.parameters.toJsonSchema())).not.toContain('"sourceSession"');

		const customSeance = parseAgent(
			"project-seance.md",
			`---
name: seance
description: Custom historical agent.
---
Custom prompt.`,
			"project",
		);
		expect(isBundledSeance(customSeance)).toBe(false);
		discovery.mockResolvedValue({ agents: [customSeance], projectAgentsDir: null });
		const overridden = await TaskTool.create(createSession({ parentSpawns: "task,seance" }));
		expect(JSON.stringify(overridden.parameters.toJsonSchema())).not.toContain('"sourceSession"');
	});

	it("hides seance fields, listing, and guidance in plan mode", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [bundledSeance],
			projectAgentsDir: null,
		});
		const planMode = await TaskTool.create(createSession({ parentSpawns: "task,seance", planMode: true }));
		const planSchema = JSON.stringify(planMode.parameters.toJsonSchema());
		expect(planSchema).not.toContain('"sourceSession"');
		expect(planSchema).not.toContain("seance");
		expect(planSchema).not.toContain('"model"');
		expect(planMode.description).not.toContain("seance");
		expect(planMode.description).not.toContain("Historical consults");

		const ordinary = await TaskTool.create(createSession({ parentSpawns: "task,seance" }));
		const ordinarySchema = JSON.stringify(ordinary.parameters.toJsonSchema());
		expect(ordinarySchema).toContain('"sourceSession"');
		expect(ordinarySchema).toContain('"model"');
		expect(ordinary.description).toContain("`seance`");
		expect(ordinary.description).toContain("Historical consults");
	});
	afterEach(() => vi.restoreAllMocks());
});

// A session that itself runs inside an isolation worktree. The nested gate
// keys off the first-class `isIsolated` marker (set by the executor from
// `worktree !== undefined`), not path heuristics.
function nestedSession(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "task.isolation.enabled": true, "task.batch": false }),
		taskDepth: 1,
		isIsolated: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionAgents: () => [],
		advertisedSessionAgents: () => [],
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

function mockAgents(agents: AgentDefinition[] = []): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
}

describe("task spawn validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function executeText(params: unknown, agents: AgentDefinition[] = []): Promise<string> {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tool-call", params);
		return result.content.find(part => part.type === "text")?.text ?? "";
	}

	it("defaults a missing agent to `task`", async () => {
		// With no `agent`, execute() normalizes to the `task` default, so the
		// failure is unknown-agent (none discovered), not missing-agent.
		const text = await executeText({ task: "..." });
		expect(text).toContain('Unknown agent "task"');
	});

	it("rejects a missing task", async () => {
		const text = await executeText({ agent: "scout" });
		expect(text).toContain("Missing `task`");
	});
	it("rejects a model override for an ordinary task after the enabled schema accepts it", async () => {
		const schema = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: false,
			seanceFields: seanceTaskSchemaFields,
		});
		const params = {
			agent: "scout",
			task: "Map the auth module.",
			solutionSpace: "focused inspection",
			model: "anthropic/claude-sonnet-4-5",
		};
		expect(schema(params) instanceof type.errors).toBe(false);
		expect(await executeText(params, [bundledSeance])).toContain("`model` is only accepted for the `seance` agent.");
	});
});

describe("nested isolation gating", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const taskDefinition = {
		name: "task",
		description: "Task agent",
		systemPrompt: "Run the task.",
		source: "bundled",
		spawns: "*",
		model: ["@task"],
	} satisfies AgentDefinition;

	// Build a TaskTool against a session that itself runs inside an isolation
	// worktree (`isIsolated` is set by the executor from `worktree !==
	// undefined`). Agent discovery is mocked so create() does not touch the
	// real filesystem.
	async function nestedTool(allowNested: boolean): Promise<TaskTool> {
		mockAgents([taskDefinition]);
		const session = allowNested
			? {
					...nestedSession(),
					settings: Settings.isolated({
						"task.isolation.enabled": true,
						"task.batch": false,
						"task.isolation.allowNested": true,
					}),
				}
			: nestedSession();
		return TaskTool.create(session);
	}

	it("rejects an explicit `isolated` at the schema inside an isolated session and restores the field with task.isolation.allowNested", async () => {
		// A nested session exposes the no-isolation schema, which REJECTS an
		// explicit `isolated` instead of silently stripping it — `"+": "delete"`
		// would otherwise drop the key during argument validation and run the
		// child non-isolated with no error. The rejection forces the agent
		// loop's lenient raw-args fallthrough, which then surfaces the
		// preflight error in execute().
		const hiddenTool = await nestedTool(false);
		const hidden = hiddenTool.parameters({ agent: "task", task: "x", solutionSpace: "probe", isolated: true });
		expect(hidden instanceof type.errors).toBe(true);

		// With `task.isolation.allowNested` the isolated schema is exposed and
		// accepts the field.
		const visibleTool = await nestedTool(true);
		const visible = visibleTool.parameters({ agent: "task", task: "x", solutionSpace: "probe", isolated: true });
		expect(visible instanceof type.errors).toBe(false);
		if (!(visible instanceof type.errors)) {
			expect((visible as { isolated?: boolean }).isolated).toBe(true);
		}
	});

	it("rejects an explicit nested isolated:true in execute() unless task.isolation.allowNested is enabled", async () => {
		const tool = await nestedTool(false);
		const result = await tool.execute("tool-call", {
			agent: "task",
			task: "x",
			solutionSpace: "probe",
			isolated: true,
		});
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain(
			"Subagent isolated execution inside an already-isolated agent requires task.isolation.allowNested to be enabled.",
		);
	});

	it("passes the nested preflight when task.isolation.allowNested is enabled", async () => {
		const tool = await nestedTool(true);
		const result = await tool.execute("tool-call", {
			agent: "task",
			task: "x",
			solutionSpace: "probe",
			isolated: true,
		});
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		// The nested-isolation preflight passes; execution then fails later on
		// worktree setup (`/tmp` is not a git repository) rather than on the gate.
		expect(text).toContain("Git");
	});

	it("rejects a top-level `isolated` on the batch wrapper inside an isolated session", async () => {
		// Same guard as the flat schema, on the batch wrapper: with `task.batch`
		// enabled the model-facing shape is `{ context, tasks[] }`, and a
		// top-level `isolated` must reject validation rather than be stripped by
		// `"+": "delete"` and run the batch non-isolated. Rejection routes the
		// raw args to execute(), where runtime validation rejects the stale
		// flat-form key with an actionable shape error.
		const session = {
			...nestedSession(),
			settings: Settings.isolated({
				"task.isolation.enabled": true,
				"task.batch": true,
			}),
		} as unknown as ToolSession;
		mockAgents([taskDefinition]);
		const tool = await TaskTool.create(session);

		const parsed = tool.parameters({
			context: "ctx",
			tasks: [{ task: "x", solutionSpace: "probe" }],
			isolated: true,
		});
		expect(parsed instanceof type.errors).toBe(true);

		const result = await tool.execute("tool-call", {
			context: "ctx",
			tasks: [{ task: "x", solutionSpace: "probe" }],
			isolated: true,
		});
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain("Top-level `isolated` is not part of the batch shape.");
	});

	it("rejects a top-level `isolated` even when batch items carry isolated: false", async () => {
		// A raw/lenient-fallback payload mixing the flat-form key into the batch
		// shape must not let the item-level `false` silently downgrade the
		// top-level request: spawnParamsFor would otherwise let the item win
		// and the child would run non-isolated with no preflight error.
		const session = {
			...nestedSession(),
			settings: Settings.isolated({
				"task.isolation.enabled": true,
				"task.batch": true,
			}),
		} as unknown as ToolSession;
		mockAgents([taskDefinition]);
		const tool = await TaskTool.create(session);

		const result = await tool.execute("tool-call", {
			context: "ctx",
			tasks: [{ task: "x", solutionSpace: "probe", isolated: false }],
			isolated: true,
		});
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain("Top-level `isolated` is not part of the batch shape.");
	});

	it("allows a top-level `isolated: false` on the batch wrapper (schema-aware no-op)", async () => {
		// The no-isolation wire schema accepts `isolated: false` (const:false,
		// provider-safe) so schema-aware callers that materialize optional
		// booleans pass validation. Runtime must treat the literal `false` as
		// the default-behavior no-op, not a shape violation — only an
		// affirmative `true` is rejected (see validateSpawnParams).
		const session = {
			...nestedSession(),
			settings: Settings.isolated({
				"task.isolation.enabled": true,
				"task.batch": true,
			}),
		} as unknown as ToolSession;
		// No agents discovered: validation still runs first, then preflight
		// fails fast on the unknown agent — proving the payload passed the
		// shape gate instead of hanging on a real spawn.
		mockAgents([]);
		const tool = await TaskTool.create(session);

		const parsed = tool.parameters({
			context: "ctx",
			tasks: [{ task: "x", solutionSpace: "probe" }],
			isolated: false,
		});
		expect(parsed instanceof type.errors).toBe(false);

		const result = await tool.execute("tool-call", {
			context: "ctx",
			tasks: [{ task: "x", solutionSpace: "probe" }],
			isolated: false,
		});
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).not.toContain("Top-level `isolated` is not part of the batch shape.");
		expect(text).toContain("Unknown agent");
	});
	it("rejects a malformed top-level `isolated` on the batch wrapper even when items carry isolated: false", async () => {
		// A type-invalid but affirmative top-level value (e.g. `isolated:
		// "true"`) slips through the lenient raw-args fallthrough. Runtime must
		// reject any top-level value other than the literal `false` so
		// `spawnParamsFor` cannot let an item's `false` silently downgrade the
		// malformed request before the nested-isolation preflight sees it.
		const session = {
			...nestedSession(),
			settings: Settings.isolated({
				"task.isolation.enabled": true,
				"task.batch": true,
			}),
		} as unknown as ToolSession;
		mockAgents([taskDefinition]);
		const tool = await TaskTool.create(session);

		const result = await tool.execute("tool-call", {
			context: "ctx",
			tasks: [{ task: "x", solutionSpace: "probe", isolated: false }],
			isolated: "true",
		});
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain("Top-level `isolated` is not part of the batch shape.");
	});
	it("rejects a top-level `isolated` on the batch wrapper even with task.isolation.allowNested", async () => {
		// The with-isolation batch schema must reject a stray flat-form
		// top-level `isolated` too: with `"+": "delete"` alone, arktype strips
		// the key before execute() and the batch spawns quietly non-isolated —
		// exactly in the allowNested=true configuration where a nested spawn
		// would actually be honored. Rejection routes the raw args to the
		// runtime shape error.
		const session = {
			...nestedSession(),
			settings: Settings.isolated({
				"task.isolation.enabled": true,
				"task.batch": true,
				"task.isolation.allowNested": true,
			}),
		} as unknown as ToolSession;
		mockAgents([taskDefinition]);
		const tool = await TaskTool.create(session);

		const parsed = tool.parameters({
			context: "ctx",
			tasks: [{ task: "x", solutionSpace: "probe" }],
			isolated: true,
		});
		expect(parsed instanceof type.errors).toBe(true);

		const result = await tool.execute("tool-call", {
			context: "ctx",
			tasks: [{ task: "x", solutionSpace: "probe" }],
			isolated: true,
		});
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain("Top-level `isolated` is not part of the batch shape.");
	});

	it("allows top-level batch items to set isolated while rejecting the flat-form key on allowNested sessions", async () => {
		// A top-level non-boolean `isolated` (e.g. the string "true") must
		// reject the with-isolation batch schema (const:false) instead of
		// being stripped: the lenient raw-args fallthrough then surfaces the
		// runtime shape error, and the malformed value can never reach
		// spawnParamsFor's item-override.
		const session = {
			...nestedSession(),
			settings: Settings.isolated({
				"task.isolation.enabled": true,
				"task.batch": true,
				"task.isolation.allowNested": true,
			}),
		} as unknown as ToolSession;
		mockAgents([taskDefinition]);
		const tool = await TaskTool.create(session);

		const result = await tool.execute("tool-call", {
			context: "ctx",
			tasks: [{ task: "x", solutionSpace: "probe", isolated: true }],
			isolated: "true",
		});
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain("Top-level `isolated` is not part of the batch shape.");
	});

	it("rejects per-item isolated:true in batch execute() inside an isolated session unless task.isolation.allowNested", async () => {
		const batchArgs = {
			context: "ctx",
			tasks: [{ task: "x", solutionSpace: "probe", isolated: true }],
		};
		const batchSession = (allowNested: boolean) =>
			({
				...nestedSession(),
				settings: Settings.isolated({
					"task.isolation.enabled": true,
					"task.batch": true,
					"task.isolation.allowNested": allowNested,
				}),
			}) as unknown as ToolSession;

		mockAgents([taskDefinition]);
		const gated = await TaskTool.create(batchSession(false));
		const gatedText = gated
			.execute("tool-call", batchArgs)
			.then(result => result.content.find(part => part.type === "text")?.text ?? "");
		expect(await gatedText).toContain(
			"Subagent isolated execution inside an already-isolated agent requires task.isolation.allowNested to be enabled.",
		);

		mockAgents([taskDefinition]);
		const open = await TaskTool.create(batchSession(true));
		const openResult = await open.execute("tool-call", batchArgs);
		const openText = openResult.content.find(part => part.type === "text")?.text ?? "";
		// The nested-isolation preflight passes; execution then fails later on
		// worktree setup (`/tmp` is not a git repository) rather than on the gate.
		expect(openText).toContain("Git");
	});
});
