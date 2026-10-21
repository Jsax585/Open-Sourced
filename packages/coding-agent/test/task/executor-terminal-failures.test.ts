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

	it("fails nonzero empty stderr with a committed yield and no verified internal cause", () => {
		const result = finalize({ exitCode: 1, stderr: "" });
		expect(result.exitCode).not.toBe(0);
		expect(result.structuredOutput?.status).not.toBe("valid");
	});

	it("preserves a completed yield through verified internal abort cleanup", () => {
		const result = finalize({
			exitCode: 1,
			stderr: "",
			terminalContext: {
				terminalYieldAccepted: true,
				finalYieldForced: false,
				yieldInvalidatedByAsync: false,
				abortKind: "terminate",
			},
		});
		expect(result.exitCode).toBe(0);
		expect(result.structuredOutput?.status).toBe("valid");
	});

	it("invalidates valid structured metadata on a final nonzero exit while preserving data", () => {
		const result = finalize({
			exitCode: 1,
			stderr: "child crashed",
			terminalContext: {
				terminalYieldAccepted: true,
				finalYieldForced: false,
				yieldInvalidatedByAsync: false,
				abortKind: "terminate",
			},
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.structuredOutput?.status).not.toBe("valid");
		expect(result.structuredOutput?.data).toEqual({ ok: true });
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

	it("does not mask external signalAborted with a committed success", () => {
		const result = finalize({
			signalAborted: true,
			exitCode: 1,
			stderr: "",
			terminalContext: {
				terminalYieldAccepted: true,
				finalYieldForced: false,
				yieldInvalidatedByAsync: false,
				abortKind: "signal",
			},
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.structuredOutput?.status).not.toBe("valid");
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

	it("does not treat a stale terminal yield invalidated by async delivery as committed", () => {
		const result = finalize({
			doneAborted: true,
			yieldItems: [
				{ status: "success", data: { ok: true } },
				{ status: "success", type: ["later"], data: { partial: true } },
			],
			outputSchema: undefined,
			outputSchemaSource: undefined,
			terminalContext: {
				terminalYieldAccepted: false,
				finalYieldForced: false,
				yieldInvalidatedByAsync: true,
				abortKind: "terminate",
			},
		});
		expect(result.exitCode).not.toBe(0);
	});

	it("treats a forced-final incremental yield as terminal when accepted", () => {
		const result = finalize({
			doneAborted: true,
			yieldItems: [{ status: "success", type: ["final"], data: { final: true } }],
			outputSchema: undefined,
			outputSchemaSource: undefined,
			terminalContext: {
				terminalYieldAccepted: true,
				finalYieldForced: true,
				yieldInvalidatedByAsync: false,
				abortKind: "terminate",
			},
		});
		expect(result.exitCode).toBe(0);
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
