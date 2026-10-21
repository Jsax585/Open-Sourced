import { describe, expect, it } from "bun:test";
import { finalizeSubprocessOutput } from "../../src/task/executor";

const schema = {
	type: "object",
	additionalProperties: false,
	properties: { ok: { const: true } },
	required: ["ok"],
} as const;

const successYield = [{ status: "success" as const, data: { ok: true } }];

function finalize(overrides: Record<string, unknown>) {
	return finalizeSubprocessOutput({
		rawOutput: "",
		exitCode: 0,
		stderr: "",
		doneAborted: false,
		signalAborted: false,
		yieldItems: successYield,
		outputSchema: schema,
		outputSchemaMode: "strict",
		outputSchemaSource: "caller",
		...overrides,
	} as Parameters<typeof finalizeSubprocessOutput>[0]);
}

describe("terminal task failure classification", () => {
	it("keeps a valid successful yield successful", () => {
		const result = finalize({});
		expect(result.exitCode).toBe(0);
		expect(result.structuredOutput?.status).toBe("valid");
	});

	it("lets a committed success yield survive internal doneAborted termination", () => {
		const result = finalize({ doneAborted: true });
		expect(result.exitCode).toBe(0);
		expect(result.structuredOutput?.status).toBe("valid");
	});

	it("lets a committed success yield survive internal signalAborted termination", () => {
		const result = finalize({ signalAborted: true });
		expect(result.exitCode).toBe(0);
		expect(result.structuredOutput?.status).toBe("valid");
	});

	it("fails closed on a genuine doneAborted with no committed yield", () => {
		const result = finalize({ doneAborted: true, yieldItems: [] });
		expect(result.exitCode).not.toBe(0);
	});

	it("never exposes a valid structured result for a nonzero child exit", () => {
		const result = finalize({ exitCode: 1, stderr: "child crashed" });
		expect(result.exitCode).not.toBe(0);
		expect(result.structuredOutput?.status).not.toBe("valid");
	});

	it("never exposes a valid structured result for an explicit error envelope", () => {
		const result = finalize({
			yieldItems: [{ status: "success", data: { error: "provider failed" } }],
			outputSchema: {
				type: "object",
				additionalProperties: false,
				properties: { error: { type: "string" } },
				required: ["error"],
			},
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.structuredOutput?.status).not.toBe("valid");
	});
});
