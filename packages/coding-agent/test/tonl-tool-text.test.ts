import { describe, expect, it } from "bun:test";
import { formatModelData, formatModelText } from "../src/utils/tonl-tool-text";

const issues = [
	{ number: 1, title: "Startup probe", state: "open" },
	{ number: 2, title: "Tool result size", state: "closed" },
	{ number: 3, title: "Comma, quoted", state: "open" },
];

describe("formatModelData", () => {
	it("renders a uniform record array as a TONL table", () => {
		const text = formatModelData(issues);
		expect(text).toBe(
			[
				"rows[3]{number,title,state}:",
				'  1, "Startup probe", open',
				'  2, "Tool result size", closed',
				'  3, "Comma, quoted", open',
			].join("\n"),
		);
		expect(Buffer.byteLength(text)).toBeLessThan(Buffer.byteLength(JSON.stringify(issues, null, 2)));
	});

	it("renders an object whose large field is a table and keeps scalar siblings", () => {
		const text = formatModelData({ total: 2, items: issues.slice(0, 2) });
		expect(text).toContain("total: 2");
		expect(text).toContain("items[2]{number,title,state}:");
	});

	it("keeps nested records as JSON", () => {
		const value = [
			{ id: 1, meta: { a: 1 } },
			{ id: 2, meta: { a: 2 } },
		];
		expect(formatModelData(value)).toBe(JSON.stringify(value, null, 2));
	});

	it("keeps a single object as JSON", () => {
		const value = { lease_token: "abc123", expires_in: 900 };
		expect(formatModelData(value)).toBe(JSON.stringify(value, null, 2));
	});
});

describe("formatModelText", () => {
	it("rewrites JSON tool text that shrinks", () => {
		const text = formatModelText(JSON.stringify(issues, null, 2));
		expect(text.startsWith("rows[3]{")).toBe(true);
	});

	it("leaves prose and non-tabular JSON alone", () => {
		expect(formatModelText("plain result")).toBe("plain result");
		const payload = JSON.stringify({ lease_token: "abc123" }, null, 2);
		expect(formatModelText(payload)).toBe(payload);
	});
});
