import { describe, expect, it } from "bun:test";
import Ajv from "ajv";
import { loadBundledAgents } from "../../src/task/agents";
import { jtdToJsonSchema, normalizeSchema } from "../../src/tools/jtd-to-json-schema";

async function getFilterAgent() {
	const agents = await loadBundledAgents();
	const agent = agents.find(a => a.name === "review_filter");
	if (!agent) throw new Error("review_filter agent not registered in EMBEDDED_AGENT_DEFS");
	return agent;
}

describe("review_filter agent", () => {
	it("is registered as a bundled agent", async () => {
		const agent = await getFilterAgent();
		expect(agent.name).toBe("review_filter");
		expect(agent.blocking).toBe(true);
	});

	it("cannot report findings, only remove them", async () => {
		const agent = await getFilterAgent();
		// The filter's entire safety property is that it can subtract but never add.
		expect(agent.tools).not.toContain("report_finding");
	});

	it("runs on a cheap model", async () => {
		const agent = await getFilterAgent();
		// pi/fast does not exist; valid roles are in config/model-registry.ts.
		expect(agent.model).toContain("pi/smol");
	});

	it("enforces the removal shape through the real output validator", async () => {
		const agent = await getFilterAgent();
		const { normalized, error } = normalizeSchema(agent.output);
		expect(error).toBeUndefined();
		const validate = new Ajv({ strict: false }).compile(jtdToJsonSchema(normalized) as object);

		expect(validate({ removals: [] })).toBe(true);
		expect(validate({ removals: [{ finding_id: "1.1", ground: "A", evidence: "+ foo()" }] })).toBe(true);

		// Evidence being droppable would let the model remove findings on vibes.
		expect(validate({ removals: [{ finding_id: "1.1", ground: "A" }] })).toBe(false);
		// Grounds are a closed set; an invented one is not a licence to remove.
		expect(validate({ removals: [{ finding_id: "1.1", ground: "C", evidence: "x" }] })).toBe(false);
	});

	it("keeps the asymmetric-cost framing and protected-subject veto", async () => {
		const agent = await getFilterAgent();
		// These two are what stop the pass from deleting real findings.
		expect(agent.systemPrompt).toContain("Removing a correct finding silently destroys it");
		expect(agent.systemPrompt).toContain("Protected-subject veto");
		expect(agent.systemPrompt).toContain("approve");
	});
});
