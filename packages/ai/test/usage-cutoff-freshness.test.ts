/**
 * Regression for the freshness-of-retained-limits review finding on the
 * early-quota-reset-recovery PR: a report merged from an older full snapshot
 * plus a newer header overlay stamps the report-wide `fetchedAt` with the
 * newest time, but limits retained from the old snapshot were fetched earlier.
 * `reportPassesUsageCutoff` must not treat those retained limits as fresh —
 * otherwise a stale healthy row can reconcile a credential block whose quota
 * never reset.
 */

import { describe, expect, it } from "bun:test";
import { reportPassesUsageCutoff } from "../src/auth/usage";
import type { UsageReport } from "../src/usage";

function report(overrides: Partial<UsageReport>): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "anthropic/session",
				label: "Session",
				scope: { provider: "anthropic" },
				amount: { unit: "percent" },
			},
		],
		...overrides,
	};
}

describe("reportPassesUsageCutoff", () => {
	const now = 1_000_000;

	it("passes a fully fresh report past the cutoff", () => {
		expect(reportPassesUsageCutoff(report({ fetchedAt: now + 100 }), now)).toBe(true);
	});

	it("fails a report older than the cutoff", () => {
		expect(reportPassesUsageCutoff(report({ fetchedAt: now - 1 }), now)).toBe(false);
	});

	it("passes when usageAfter is undefined", () => {
		expect(reportPassesUsageCutoff(report({ fetchedAt: now - 10_000 }), undefined)).toBe(true);
	});

	it("fails when a retained limit predates the cutoff even if the report stamp is fresh", () => {
		const merged = report({
			fetchedAt: now + 100,
			limits: [
				{
					id: "anthropic/session",
					label: "Session",
					scope: { provider: "anthropic" },
					amount: { unit: "percent" },
					fetchedAt: now - 500,
				},
				{
					id: "anthropic/window",
					label: "Window",
					scope: { provider: "anthropic" },
					amount: { unit: "percent" },
					fetchedAt: now + 100,
				},
			],
		});
		expect(reportPassesUsageCutoff(merged, now)).toBe(false);
	});

	it("passes when all stamped limits are newer than the cutoff", () => {
		const merged = report({
			fetchedAt: now + 100,
			limits: [
				{
					id: "anthropic/session",
					label: "Session",
					scope: { provider: "anthropic" },
					amount: { unit: "percent" },
					fetchedAt: now + 100,
				},
			],
		});
		expect(reportPassesUsageCutoff(merged, now)).toBe(true);
	});

	it("ignores limits without a stamped fetchedAt", () => {
		const legacy = report({ fetchedAt: now + 100 });
		expect(reportPassesUsageCutoff(legacy, now)).toBe(true);
	});
});
