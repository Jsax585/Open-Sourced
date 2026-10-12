import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "../src/build";
import { seedModels } from "../src/compat/providers";
import { Effort } from "../src/effort";
import { resolveProviderModels } from "../src/model-manager";
import type { Model } from "../src/types";

const tempDirs: string[] = [];
afterEach(() => {
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

/**
 * Isolated cache DB for resolution tests: the shared agent cache may hold
 * runtime discovery rows written by a real CLI session, and those must not
 * leak into the bundled-catalog assertions.
 */
function isolatedCachePath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friendli-seed-"));
	tempDirs.push(dir);
	return path.join(dir, "models.db");
}

describe("Friendli provider bundle", () => {
	it("resolves the bundled provider catalog with the default model present", async () => {
		const result = await resolveProviderModels(
			{ providerId: "friendli", cacheDbPath: isolatedCachePath() },
			"offline",
		);
		expect(result.source).toBe("bundled");
		expect(result.models.map(model => model.id)).toContain("zai-org/GLM-5.3");
	});

	it("derives the wire reasoning surface from identity, not a seed thinking block", () => {
		const model = buildModel(seedModels<"openai-completions">("friendli")[0]) as Model<"openai-completions">;
		// GLM-5.3+ exposes a uniform low/high/max ladder with thinking always on;
		// the effort tiers must reach the wire as distinct `reasoning_effort` values.
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(model.thinking?.defaultLevel).toBe(Effort.Max);
		expect(model.compat.supportsReasoningEffort).toBe(true);
		expect(model.compat.thinkingFormat).toBe("openai");
	});
});
