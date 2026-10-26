import { expect, it } from "bun:test";
import { snapshotJobs } from "../src/async/job-control";
import { AsyncJobManager } from "../src/async/job-manager";
import type { ToolSession } from "../src/tools";

it("snapshots keep live task progress for a running task job and drop malformed entries", async () => {
	const gate = Promise.withResolvers<string>();
	const manager = new AsyncJobManager({ onJobComplete: () => {} });
	const id = manager.register("task", "worker", async () => gate.promise, { id: "Worker-2", agentId: "Worker" });
	const job = manager.getJob(id)!;
	const progress = {
		index: 0,
		id: "Worker",
		agent: "task",
		status: "running",
		task: "inspect",
		recentTools: [],
		recentOutput: ["line one"],
		toolCount: 0,
		tokens: 0,
		cost: 1.25,
		requests: 7,
		contextTokens: 100,
		contextWindow: 1000,
		durationMs: 1,
	};
	job.latestDetails = { progress: [{ id: "Other", requests: 99 }, progress, { id: "broken" }] };
	const session = { asyncJobManager: manager } as unknown as ToolSession;
	try {
		const [snapshot] = snapshotJobs(session, [job]);
		expect(snapshot?.status).toBe("running");
		expect(snapshot?.progress).toEqual([progress as never]);
		expect(snapshot).toMatchObject({ agentUrlId: "Worker", requests: 7, cost: 1.25, contextTokens: 100, contextWindow: 1000 });
		job.resultText = "final body";
		job.latestDetails.meta = { route: "worker" };
		expect(snapshotJobs(session, [job], { includeResults: false })[0]?.resultText).toBeUndefined();
		expect(snapshotJobs(session, [job], { includeResults: false })[0]?.meta).toEqual({ route: "worker" });
		job.status = "completed";
		manager.consumeJobResults([id]);
		expect(snapshotJobs(session, [job])[0]?.resultText).toBeUndefined();
		expect(snapshotJobs(session, [job])[0]?.meta).toBeUndefined();
		expect(snapshotJobs(session, [job], { includeResults: false })[0]?.meta).toEqual({ route: "worker" });

		// Negative control: a non-task job never carries progress.
		const bashId = manager.register("bash", "sleep", async () => gate.promise, { id: "Shell" });
		const bash = manager.getJob(bashId)!;
		bash.latestDetails = { progress: [progress] };
		expect(snapshotJobs(session, [bash])[0]?.progress).toBeUndefined();
	} finally {
		gate.resolve("done");
		await manager.dispose({ timeoutMs: 1_000 });
	}
});
