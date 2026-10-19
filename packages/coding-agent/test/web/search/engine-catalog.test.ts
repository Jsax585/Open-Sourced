import { describe, expect, it } from "bun:test";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { isRegisteredSearchEngine } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { SEARCH_PROVIDER_LABELS } from "@oh-my-pi/pi-coding-agent/web/search/types";

describe("web search engine catalog", () => {
	it("seeds a web/<id> model in the compiled KDL rules for every registered engine", () => {
		const seeded = new Set(seedModels("web").map(model => model.id));
		const engines = Object.keys(SEARCH_PROVIDER_LABELS).filter(isRegisteredSearchEngine);

		expect(engines.length).toBeGreaterThan(0);
		for (const id of engines) {
			expect({ id, seeded: seeded.has(id) }).toEqual({ id, seeded: true });
		}
	});
});
