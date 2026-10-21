import { describe, expect, it } from "bun:test";
import { finalizeSubprocessOutput } from "../../src/task/executor";

const okSchema = {
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
		outputSchema: okSchema,
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

	it("preserves a genuine nonzero exit with empty stderr when no result was committed", () => {
		const result = finalize({ exitCode: 1, stderr: "", yieldItems: [] });
		expect(result.exitCode).not.toBe(0);
	});

	it("preserves a completed yield through expected internal abort cleanup with empty stderr", () => {
		const result = finalize({ exitCode: 1, stderr: "" });
		expect(result.exitCode).toBe(0);
		expect(result.structuredOutput?.status).toBe("valid");
	});

	it("preserves a genuine nonzero exit with stderr", () => {
		const result = finalize({ exitCode: 1, stderr: "child crashed" });
		expect(result.exitCode).not.toBe(0);
		expect(result.structuredOutput?.status).not.toBe("valid");
	});

	it("lets a committed success survive expected internal doneAborted termination", () => {
		const result = finalize({ doneAborted: true, exitCode: 1, stderr: "" });
		expect(result.exitCode).toBe(0);
		expect(result.structuredOutput?.status).toBe("valid");
	});

	it("lets a committed success survive expected internal signalAborted termination", () => {
		const result = finalize({ signalAborted: true, exitCode: 1, stderr: "" });
		expect(result.exitCode).toBe(0);
		expect(result.structuredOutput?.status).toBe("valid");
	});

	it("fails a genuine cancellation with no committed terminal yield", () => {
		const result = finalize({
			doneAborted: true,
			yieldItems: [{ status: "success", type: ["section"], data: { ok: true } }],
			outputSchema: undefined,
			outputSchemaSource: undefined,
		});
		expect(result.exitCode).not.toBe(0);
	});

	it("preserves a legitimate payload containing error", () => {
		const result = finalize({
			yieldItems: [{ status: "success", data: { error: "existing validation issue" } }],
			outputSchema: {
				type: "object",
				additionalProperties: false,
				properties: { error: { type: "string" } },
				required: ["error"],
			},
		});
		expect(result.exitCode).toBe(0);
		expect(result.structuredOutput?.status).toBe("valid");
	});

	it("preserves a legitimate payload containing success:false", () => {
		const result = finalize({
			yieldItems: [{ status: "success", data: { success: false } }],
			outputSchema: {
				type: "object",
				additionalProperties: false,
				properties: { success: { type: "boolean" } },
				required: ["success"],
			},
		});
		expect(result.exitCode).toBe(0);
		expect(result.structuredOutput?.status).toBe("valid");
	});

	it("retains explicit aborted-yield failure metadata", () => {
		const result = finalize({
			yieldItems: [{ status: "aborted", error: "blocked by permissions" }],
			outputSchema: undefined,
		});
		expect(result.abortedViaYield).toBe(true);
		expect(result.rawOutput).toContain('"aborted": true');
	});

	it("keeps a terminal success after incremental sections successful", () => {
		const result = finalize({
			yieldItems: [
				{ status: "success", type: ["section"], data: { partial: true } },
				{ status: "success", data: { ok: true } },
			],
			outputSchema: undefined,
		});
		expect(result.exitCode).toBe(0);
	});

	it("does not fail a no-schema unstructured success", () => {
		const result = finalize({ outputSchema: undefined });
		expect(result.exitCode).toBe(0);
	});
});
