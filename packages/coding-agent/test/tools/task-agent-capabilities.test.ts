import { describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { runAgentsCommand } from "@oh-my-pi/pi-coding-agent/cli/agents-cli";
import { isReadOnlyAgent } from "@oh-my-pi/pi-coding-agent/task";
import { loadBundledAgents, parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { TempDir } from "@oh-my-pi/pi-utils";

function agentByName(agents: AgentDefinition[], name: string): AgentDefinition {
	const agent = agents.find(candidate => candidate.name === name);
	expect(agent).toBeDefined();
	return agent as AgentDefinition;
}

describe("task agent capability descriptions", () => {
	it("classifies bundled scout as the only read-only delegated agent", () => {
		const agents = loadBundledAgents();

		expect(isReadOnlyAgent(agentByName(agents, "scout"))).toBe(true);
		for (const name of ["task", "sonic", "reviewer"]) {
			expect(isReadOnlyAgent(agentByName(agents, name))).toBe(false);
		}
	});

	it("keeps `wait` read-only while any exec-tier tool disqualifies the agent", () => {
		const scout = agentByName(loadBundledAgents(), "scout");

		expect(isReadOnlyAgent({ ...scout, tools: ["read", "grep", "wait", "yield"] })).toBe(true);
		expect(isReadOnlyAgent({ ...scout, tools: ["read", "grep", "wait", "bash"] })).toBe(false);
	});

	it("keeps the bundled request budget of scout and sonic when the agents are unpacked", async () => {
		using tmp = TempDir.createSync("@omp-agents-unpack-");
		const dir = tmp.path();
		const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			await runAgentsCommand({ action: "unpack", flags: { dir, json: true } });
			for (const name of ["scout", "sonic"]) {
				const file = path.join(dir, `${name}.md`);
				const unpacked = parseAgent(file, await Bun.file(file).text(), "user");
				expect(unpacked.steps).toBe(100);
			}
			const task = path.join(dir, "task.md");
			expect(parseAgent(task, await Bun.file(task).text(), "user").steps).toBeUndefined();
		} finally {
			stdout.mockRestore();
		}
	});
});
