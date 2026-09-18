import { describe, expect, it } from "bun:test";
import Ajv from "ajv";
import { loadBundledAgents } from "../../src/task/agents";
import { jtdToJsonSchema, normalizeSchema } from "../../src/tools/jtd-to-json-schema";

async function getReviewerValidator() {
	const agents = await loadBundledAgents();
	const agent = agents.find(a => a.name === "reviewer");
	if (!agent) throw new Error("reviewer agent not registered");
	const { normalized, error } = normalizeSchema(agent.output);
	if (error) throw new Error(`reviewer output schema invalid: ${error}`);
	return { agent, validate: new Ajv({ strict: false }).compile(jtdToJsonSchema(normalized) as object) };
}

const verdict = { overall_correctness: "correct", explanation: "Looks fine.", confidence: 0.9 };

describe("reviewer coverage reporting", () => {
	it("accepts a verdict with coverage", async () => {
		const { validate } = await getReviewerValidator();
		expect(
			validate({
				...verdict,
				coverage: { reviewed: ["src/a.ts"], skipped: [{ path: "src/b.ts", reason: "generated file" }] },
			}),
		).toBe(true);
	});

	it("still accepts a verdict without coverage", async () => {
		const { validate } = await getReviewerValidator();
		// Coverage is additive. A model that omits it must not have its whole review rejected.
		expect(validate(verdict)).toBe(true);
	});

	it("rejects a skipped file with no reason", async () => {
		const { validate } = await getReviewerValidator();
		// A skip without a reason is how silent non-coverage sneaks back in.
		expect(validate({ ...verdict, coverage: { reviewed: [], skipped: [{ path: "src/b.ts" }] } })).toBe(false);
	});

	it("tells the reviewer that one file does not cover its counterpart", async () => {
		const { agent } = await getReviewerValidator();
		expect(agent.systemPrompt).toContain("does not cover its header, interface, schema, or config counterpart");
	});
});
