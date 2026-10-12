import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("buildSystemPrompt context files", () => {
	it("reports the AGENTS.md of an additional workspace root among the files the prompt was built from", async () => {
		using tmp = TempDir.createSync("@omp-prompt-ctx-");
		const primary = fs.realpathSync(tmp.path());
		const extra = path.join(primary, "..", `${path.basename(primary)}-extra`);
		fs.mkdirSync(extra);
		try {
			fs.writeFileSync(path.join(extra, "AGENTS.md"), "extra root rules");
			const result = await buildSystemPrompt({
				cwd: primary,
				additionalWorkspaceRoots: [extra],
				contextFiles: [{ path: path.join(primary, "AGENTS.md"), content: "primary rules" }],
			});
			const tracked = result.contextFiles?.map(file => path.resolve(file.path)) ?? [];
			expect(tracked).toContain(path.join(primary, "AGENTS.md"));
			expect(tracked).toContain(path.join(fs.realpathSync(extra), "AGENTS.md"));
			expect(result.systemPrompt.join("\n")).toContain("extra root rules");
		} finally {
			fs.rmSync(extra, { recursive: true, force: true });
		}
	});
});
