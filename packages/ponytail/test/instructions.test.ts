import { describe, expect, it } from "bun:test";
import { getPonytailInstructions, isDeactivationCommand, type PonytailMode } from "../src/extension";

describe("getPonytailInstructions", () => {
	it("returns empty string when off", () => {
		expect(getPonytailInstructions("off")).toBe("");
	});

	const active: PonytailMode[] = ["lite", "full", "ultra"];
	for (const mode of active) {
		it(`includes header and ladder for ${mode}`, () => {
			const out = getPonytailInstructions(mode);
			expect(out).toContain(`PONYTAIL MODE ACTIVE -- level: ${mode}`);
			// The ladder must survive intact, not be collapsed away.
			expect(out).toContain("Does this need to exist at all?");
			expect(out).toContain("The shortest path to done is the right path.");
			// Per-level guidance line present.
			expect(out).toContain(`Level ${mode}:`);
		});
	}
});

describe("before_agent_start injection contract", () => {
	// Mirrors the handler body: it MUST return a string[] (base + 1), never a string.
	const inject = (systemPrompt: string[], mode: PonytailMode): { systemPrompt: string[] } | undefined => {
		if (mode === "off") return undefined;
		return { systemPrompt: [...systemPrompt, getPonytailInstructions(mode)] };
	};

	it("appends exactly one entry and keeps an array", () => {
		const base = ["a", "b"];
		const result = inject(base, "full");
		expect(result).toBeDefined();
		const sp = result!.systemPrompt;
		expect(Array.isArray(sp)).toBe(true);
		expect(sp.length).toBe(base.length + 1);
		expect(typeof sp[sp.length - 1]).toBe("string");
		expect(sp[sp.length - 1]).toContain("PONYTAIL MODE ACTIVE");
	});

	it("no-ops when off", () => {
		expect(inject(["a"], "off")).toBeUndefined();
	});
});

describe("vendored ruleset text", () => {
	// Vendoring regression pin: upstream #120 narrowed the `ponytail:` marker rule
	// so only simplifications that cut a real corner get a comment. A future
	// re-sync that restores the unconditional wording over-comments trivial code,
	// and dropping the `ponytail:` prefix breaks /ponytail-debt's grep.
	it("keeps the marker rule narrowed and its prefix grep-able", () => {
		const body = getPonytailInstructions("full");
		const markerRule = body.split("\n").find(line => line.includes("`ponytail:` comment"));
		expect(markerRule).toBeDefined();
		expect(markerRule).toMatch(/real corner/);
		expect(markerRule).toMatch(/known ceiling/);
		expect(body).toContain("ponytail: global lock");
	});
});

describe("isDeactivationCommand", () => {
	// The phrase must be the whole message: text that merely mentions it is a
	// question about the feature, not a request to turn it off.
	it("matches standalone deactivation phrases only", () => {
		expect(isDeactivationCommand("stop ponytail")).toBe(true);
		expect(isDeactivationCommand("Stop Ponytail.")).toBe(true);
		expect(isDeactivationCommand("  normal mode  ")).toBe(true);
		expect(isDeactivationCommand("how do I stop ponytail now")).toBe(false);
		expect(isDeactivationCommand("stop ponytail and explain the diff")).toBe(false);
	});
});
