import { describe, expect, it } from "bun:test";
import { loadBundledAgents } from "../../src/task/agents";

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

	it("declares a removals output with ground and evidence", async () => {
		const agent = await getFilterAgent();
		const output = agent.output as {
			properties?: { removals?: { elements?: { properties?: Record<string, unknown> } } };
		};
		const element = output.properties?.removals?.elements?.properties;
		expect(element).toBeDefined();
		expect(Object.keys(element ?? {}).sort()).toEqual(["evidence", "finding_id", "ground"]);
	});

	it("requires evidence rather than making it optional", async () => {
		const agent = await getFilterAgent();
		const output = agent.output as {
			properties?: { removals?: { elements?: { optionalProperties?: Record<string, unknown> } } };
		};
		// Evidence being optional would let the model remove findings on vibes.
		const optional = output.properties?.removals?.elements?.optionalProperties ?? {};
		expect(Object.keys(optional)).not.toContain("evidence");
	});

	it("keeps the asymmetric-cost framing and protected-subject veto", async () => {
		const agent = await getFilterAgent();
		// These two are what stop the pass from deleting real findings.
		expect(agent.systemPrompt).toContain("Removing a correct finding silently destroys it");
		expect(agent.systemPrompt).toContain("Protected-subject veto");
		expect(agent.systemPrompt).toContain("approve");
	});
});
