import { describe, expect, it } from "bun:test";

describe("review request prompt", () => {
	it("renders the additional instructions block from the template", async () => {
		const template = await Bun.file(new URL("../../src/prompts/review-request.md", import.meta.url)).text();

		expect(template).toContain("{{#if additionalInstructions}}");
		expect(template).toContain("### Additional Instructions");
		expect(template).toContain("{{additionalInstructions}}");
		expect(template).toContain("{{/if}}");
	});

	it("keeps the additional instructions suffix out of TypeScript", async () => {
		const source = await Bun.file(
			new URL("../../src/extensibility/custom-commands/bundled/review/index.ts", import.meta.url),
		).text();

		expect(source).not.toContain("### Additional Instructions");
		expect(source).not.toContain("appendInstructions(");
	});

	it("instructs the orchestrator to run the fact-check filter pass", async () => {
		const template = await Bun.file(new URL("../../src/prompts/review-request.md", import.meta.url)).text();

		expect(template).toContain("### After Reviews Return");
		expect(template).toContain('agent: "review_filter"');
		// The threshold must stay in the prompt, not migrate into TypeScript.
		expect(template).toContain("3 or more findings");
	});

	it("makes the filter pass removal-only and fail-open", async () => {
		const template = await Bun.file(new URL("../../src/prompts/review-request.md", import.meta.url)).text();

		// Losing either of these turns the filter from a precision tool into a finding shredder.
		expect(template).toContain("keep all of its findings");
		expect(template).toContain("MUST NOT** drop findings silently");
	});

	it("requires every changed file to be accounted for", async () => {
		const template = await Bun.file(new URL("../../src/prompts/review-request.md", import.meta.url)).text();

		expect(template).toContain("### Coverage");
		expect(template).toContain("N/M files reviewed");
		// The denominator has to come from the rendered file list, not a model guess.
		expect(template).toContain("{{len files}} files above");
	});

	it("blocks the 'covered by a related file' shortcut", async () => {
		const template = await Bun.file(new URL("../../src/prompts/review-request.md", import.meta.url)).text();

		expect(template).toContain("does not cover its");
		expect(template).toContain("is not a reason to skip it");
	});
});
