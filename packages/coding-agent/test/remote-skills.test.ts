import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { buildSkillPromptMessage } from "../src/extensibility/skills";
import { parseInternalUrl } from "../src/internal-urls";
import { SkillProtocolHandler } from "../src/internal-urls/skill-protocol";
import {
	assertSkillRelativePath,
	listRemoteSkillFiles,
	parseRemoteSourceSpec,
	type FetchFn,
} from "../src/skills/remote/source";
import {
	__setRemoteSkillFetchForTests,
	ensureRemoteSkillResource,
	loadRemoteSkillDescriptors,
	readRemoteSkillIndex,
	remoteSkillCachePath,
} from "../src/skills/remote/store";
import { addRemoteSkills, removeRemoteSkills, syncRemoteSkills } from "../src/skills/remote/sync";
import { RemoteSkillError, type RemoteSkillDescriptor } from "../src/skills/remote/types";

const REPO = "acme/skills";
const COMMIT = "a".repeat(40);
const NEXT_COMMIT = "b".repeat(40);

const TREE = {
	tree: [
		{ path: "README.md", type: "blob" },
		{ path: "skills/pdf/SKILL.md", type: "blob" },
		{ path: "skills/pdf/REFERENCE.md", type: "blob" },
		{ path: "skills/writing/SKILL.md", type: "blob" },
	],
};

function skillDoc(name: string, description: string): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

interface Stub {
	fetch: FetchFn;
	calls: string[];
}

/** Route by URL substring; unmatched requests are a 404. */
function stubFetch(routes: Record<string, () => Response | Promise<Response>>): Stub {
	const calls: string[] = [];
	const fetch: FetchFn = async input => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push(url);
		for (const [needle, respond] of Object.entries(routes)) {
			if (url.includes(needle)) return await respond();
		}
		return new Response("not found", { status: 404 });
	};
	return { fetch, calls };
}

function json(value: unknown): Response {
	return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function text(value: string): Response {
	return new Response(value);
}

function githubTreeStub(commit: string, docs: Record<string, string>, tree?: unknown): Stub {
	const listing = tree ?? {
		tree: Object.keys(docs).map(name => ({ path: `skills/${name}/SKILL.md`, type: "blob" })),
	};
	const routes: Record<string, () => Response | Promise<Response>> = {
		"/commits/": () => json({ sha: commit }),
		"/git/trees/": () => json(listing),
	};
	for (const [name, body] of Object.entries(docs)) {
		routes[`/skills/${name}/SKILL.md`] = () => text(body);
	}
	return stubFetch(routes);
}

/** The object the loader publishes: cache path plus the pinned source. */
function remoteSkillFixture(descriptor: RemoteSkillDescriptor, agentDir: string) {
	const filePath = remoteSkillCachePath(descriptor, "SKILL.md", agentDir);
	return {
		name: descriptor.name,
		description: descriptor.description,
		filePath,
		baseDir: path.dirname(filePath),
		source: "remote:project",
		remote: {
			origin: descriptor.origin,
			repository: descriptor.repository,
			directory: descriptor.directory,
			commit: descriptor.commit,
		},
	};
}

describe("remote skill sources", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-remote-skill-"));
		cwd = path.join(root, "project");
		agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		__setRemoteSkillFetchForTests(undefined);
		removeSyncWithRetries(root);
	});

	test("parses owner/repo with optional ref and directory", () => {
		expect(parseRemoteSourceSpec("anthropics/skills")).toEqual({
			repository: "anthropics/skills",
			ref: "",
			directory: "",
		});
		expect(parseRemoteSourceSpec("anthropics/skills@v1.0.0#skills/pdf")).toEqual({
			repository: "anthropics/skills",
			ref: "v1.0.0",
			directory: "skills/pdf",
		});
		expect(parseRemoteSourceSpec("acme/skills#/skills/").directory).toBe("skills");
	});

	test("rejects URL sources and escaping paths", () => {
		expect(() => parseRemoteSourceSpec("https://example.com/skills")).toThrow(RemoteSkillError);
		expect(() => parseRemoteSourceSpec("acme/skills#skills/../secrets")).toThrow(RemoteSkillError);
		expect(() => assertSkillRelativePath("../../etc/passwd")).toThrow(RemoteSkillError);
	});

	test("lists only SKILL.md files under the requested directory", async () => {
		const stub = stubFetch({ "/git/trees/": () => json(TREE) });
		expect(await listRemoteSkillFiles(REPO, COMMIT, "skills", { fetch: stub.fetch })).toEqual([
			"skills/pdf/SKILL.md",
			"skills/writing/SKILL.md",
		]);
		expect(await listRemoteSkillFiles(REPO, COMMIT, "", { fetch: stub.fetch })).toEqual([
			"skills/pdf/SKILL.md",
			"skills/writing/SKILL.md",
		]);
	});

	test("accepts a repository-root SKILL.md when no directory is given", async () => {
		const rootTree = { tree: [{ path: "SKILL.md", type: "blob" }] };
		const stub = githubTreeStub(COMMIT, {}, rootTree);
		stub.fetch = stubFetch({
			"/commits/": () => json({ sha: COMMIT }),
			"/git/trees/": () => json(rootTree),
			[`/${COMMIT}/SKILL.md`]: () => text(skillDoc("skills", "Root-level skill.")),
		}).fetch;
		const result = await addRemoteSkills(REPO, { cwd, global: false, fetch: stub.fetch });
		expect(result.added).toEqual(["skills"]);
		const index = await readRemoteSkillIndex(path.join(cwd, ".omp", "remote-skills.json"));
		expect(index.skills.skills).toMatchObject({ directory: "", name: "skills" });
		expect(remoteSkillCachePath(index.skills.skills!, "SKILL.md", agentDir)).toContain(
			path.join("acme", "skills", COMMIT, "SKILL.md"),
		);
	});

	test("fails loudly on a truncated tree listing", async () => {
		const stub = stubFetch({
			"/commits/": () => json({ sha: COMMIT }),
			"/git/trees/": () => json({ tree: [], truncated: true }),
		});
		await expect(addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch })).rejects.toMatchObject({
			code: "RESOURCE_LIMIT_EXCEEDED",
		});
	});

	test("add pins the resolved commit and records frontmatter descriptions", async () => {
		const stub = githubTreeStub(COMMIT, {
			pdf: skillDoc("pdf", "Use for PDF work."),
			writing: skillDoc("writing", "Use for prose."),
		});
		const result = await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch });
		expect(result.added.sort()).toEqual(["pdf", "writing"]);
		expect(result.commit).toBe(COMMIT);

		const index = await readRemoteSkillIndex(path.join(cwd, ".omp", "remote-skills.json"));
		expect(index.skills.pdf?.commit).toBe(COMMIT);
		expect(index.skills.pdf?.directory).toBe("skills/pdf");
		expect(index.skills.pdf?.description).toBe("Use for PDF work.");
	});

	test("add rejects skill documents that violate the spec", async () => {
		const stub = githubTreeStub(COMMIT, {
			pdf: "---\nname: other\ndescription: Mismatched directory.\n---\n",
			writing: skillDoc("writing", "Use for prose."),
		});
		await expect(addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch })).rejects.toThrow(
			/does not match directory/,
		);
	});

	test("a hostile checked-in index cannot escape the cache root", async () => {
		const indexFile = path.join(cwd, ".omp", "remote-skills.json");
		fs.mkdirSync(path.dirname(indexFile), { recursive: true });
		fs.writeFileSync(
			indexFile,
			JSON.stringify({
				version: 1,
				skills: {
					pdf: {
						name: "pdf",
						description: "Escape.",
						origin: "github",
						repository: "acme/skills",
						directory: "../../../../escaped",
						ref: "main",
						commit: COMMIT,
					},
				},
			}),
		);

		// Strict readers reject; discovery skips the descriptor with a warning.
		await expect(readRemoteSkillIndex(indexFile)).rejects.toMatchObject({ code: "INVALID_SKILL" });
		const { entries, warnings } = await loadRemoteSkillDescriptors(cwd, agentDir);
		expect(entries).toEqual([]);
		expect(warnings.join("\n")).toContain("unsafe directory");
		expect(() =>
			remoteSkillCachePath(
				{ origin: "github", repository: "acme/skills", directory: "../../../../escaped", commit: COMMIT },
				"SKILL.md",
				agentDir,
			),
		).toThrow(RemoteSkillError);
	});

	test("one invalid descriptor does not hide valid ones from the other scope", async () => {
		const userFile = path.join(agentDir, "remote-skills.json");
		fs.writeFileSync(
			userFile,
			JSON.stringify({
				version: 1,
				skills: {
					broken: {
						name: "broken",
						description: "x",
						origin: "github",
						repository: "acme/skills",
						directory: "..",
						ref: "main",
						commit: COMMIT,
					},
				},
			}),
		);
		const project = githubTreeStub(COMMIT, { pdf: skillDoc("pdf", "Project copy.") });
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: project.fetch });

		const { entries, warnings } = await loadRemoteSkillDescriptors(cwd, agentDir);
		expect(entries.map(entry => entry.descriptor.name)).toEqual(["pdf"]);
		expect(warnings.length).toBeGreaterThan(0);
	});

	test("skill:// materializes a remote skill through the protocol handler", async () => {
		const doc = skillDoc("pdf", "Use for PDF work.");
		const stub = githubTreeStub(COMMIT, { pdf: doc });
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch });
		const { entries } = await loadRemoteSkillDescriptors(cwd, agentDir);
		const skill = remoteSkillFixture(entries[0]!.descriptor, agentDir);

		const fetches = stubFetch({
			[`/${COMMIT}/skills/pdf/SKILL.md`]: () => text(doc),
			[`/${COMMIT}/skills/pdf/REFERENCE.md`]: () => text("# Reference\n"),
		});
		__setRemoteSkillFetchForTests(fetches.fetch);

		const handler = new SkillProtocolHandler();
		const bare = await handler.resolve(parseInternalUrl("skill://pdf"), { skills: [skill] });
		expect(bare.content).toContain("Use for PDF work.");

		const nested = await handler.resolve(parseInternalUrl("skill://pdf/REFERENCE.md"), { skills: [skill] });
		expect(nested.content).toBe("# Reference\n");

		const cached = await handler.resolve(parseInternalUrl("skill://pdf/REFERENCE.md"), { skills: [skill] });
		expect(cached.content).toBe("# Reference\n");
		expect(fetches.calls.length).toBe(2);
	});

	test("building a /skill: prompt materializes the body first", async () => {
		const doc = skillDoc("pdf", "Use for PDF work.");
		const stub = githubTreeStub(COMMIT, { pdf: doc });
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch });
		const { entries } = await loadRemoteSkillDescriptors(cwd, agentDir);
		const skill = remoteSkillFixture(entries[0]!.descriptor, agentDir);

		const fetches = stubFetch({ [`/${COMMIT}/skills/pdf/SKILL.md`]: () => text(doc) });
		__setRemoteSkillFetchForTests(fetches.fetch);

		const built = await buildSkillPromptMessage(skill, { args: "" }, "user");
		expect(built.message).toContain("# pdf");
		expect(built.details.path).toBe(skill.filePath);
		expect(await Bun.file(skill.filePath).text()).toContain("name: pdf");
		expect(fetches.calls.length).toBe(1);
	});

	test("sync repins a moving ref and keeps an explicit commit untouched", async () => {
		const first = githubTreeStub(COMMIT, {
			pdf: skillDoc("pdf", "Old description."),
			writing: skillDoc("writing", "Use for prose."),
		});
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: first.fetch });

		const moved = githubTreeStub(NEXT_COMMIT, {
			pdf: skillDoc("pdf", "New description."),
			writing: skillDoc("writing", "Use for prose."),
		});
		// An empty selection means every skill (CLI `remote sync` without names).
		const synced = await syncRemoteSkills({ cwd, agentDir, names: [], fetch: moved.fetch });
		expect(synced.changes.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
			{ name: "pdf", from: COMMIT, to: NEXT_COMMIT },
			{ name: "writing", from: COMMIT, to: NEXT_COMMIT },
		]);
		const index = await readRemoteSkillIndex(path.join(cwd, ".omp", "remote-skills.json"));
		expect(index.skills.pdf).toMatchObject({ commit: NEXT_COMMIT, description: "New description." });

		const pinned = githubTreeStub(COMMIT, { pinned: skillDoc("pinned", "Fixed.") });
		await addRemoteSkills(`${REPO}@${COMMIT}#skills`, {
			cwd: path.join(root, "pinned"),
			global: false,
			fetch: pinned.fetch,
		});
		const callsBefore = pinned.calls.length;
		const pinnedSync = await syncRemoteSkills({
			cwd: path.join(root, "pinned"),
			agentDir,
			fetch: pinned.fetch,
		});
		expect(pinnedSync.changes).toEqual([]);
		expect(pinned.calls.slice(callsBefore).some(url => url.includes("/commits/"))).toBe(false);
	});

	test("resources are fetched once and cached at the pinned commit", async () => {
		const stub = githubTreeStub(COMMIT, {
			pdf: skillDoc("pdf", "Use for PDF work."),
			writing: skillDoc("writing", "Use for prose."),
		});
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch });
		const { entries } = await loadRemoteSkillDescriptors(cwd, agentDir);
		expect(entries[0]?.descriptor.name).toBe("pdf");

		const withResource = stubFetch({
			"/skills/pdf/REFERENCE.md": () => text("# Reference\n"),
		});
		const file = await ensureRemoteSkillResource(entries[0]!.descriptor, "REFERENCE.md", {
			fetch: withResource.fetch,
			agentDir,
		});
		expect(await Bun.file(file).text()).toBe("# Reference\n");
		expect(file).toBe(remoteSkillCachePath(entries[0]!.descriptor, "REFERENCE.md", agentDir));

		const again = await ensureRemoteSkillResource(entries[0]!.descriptor, "REFERENCE.md", {
			fetch: withResource.fetch,
			agentDir,
		});
		expect(again).toBe(file);
		expect(withResource.calls.length).toBe(1);
	});

	test("one cancelled reader does not cancel the shared download", async () => {
		const stub = githubTreeStub(COMMIT, { pdf: skillDoc("pdf", "Use for PDF work.") });
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch });
		const { entries } = await loadRemoteSkillDescriptors(cwd, agentDir);
		const descriptor = entries[0]!.descriptor;

		const gate = Promise.withResolvers<void>();
		const slow = stubFetch({
			"/skills/pdf/REFERENCE.md": async () => {
				await gate.promise;
				return text("# Shared\n");
			},
		});
		const controller = new AbortController();
		const cancelled = ensureRemoteSkillResource(descriptor, "REFERENCE.md", {
			fetch: slow.fetch,
			agentDir,
			signal: controller.signal,
		});
		controller.abort();
		await expect(cancelled).rejects.toBeDefined();

		gate.resolve();
		const file = await ensureRemoteSkillResource(descriptor, "REFERENCE.md", { fetch: slow.fetch, agentDir });
		expect(await Bun.file(file).text()).toBe("# Shared\n");
		expect(slow.calls.length).toBe(1);
	});

	test("a moved ref does not change where an already-bound task reads from", async () => {
		const stub = githubTreeStub(COMMIT, { pdf: skillDoc("pdf", "Use for PDF work.") });
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch });
		const { entries } = await loadRemoteSkillDescriptors(cwd, agentDir);
		const bound = entries[0]!.descriptor;

		const moved = githubTreeStub(NEXT_COMMIT, { pdf: skillDoc("pdf", "Use for PDF work.") });
		await syncRemoteSkills({ cwd, agentDir, fetch: moved.fetch });

		const resource = stubFetch({ [`/${COMMIT}/`]: () => text("# old\n") });
		const file = await ensureRemoteSkillResource(bound, "SKILL.md", { fetch: resource.fetch, agentDir });
		expect(file).toContain(COMMIT);
	});

	test("a missing resource and an unreachable source surface distinct errors", async () => {
		const stub = githubTreeStub(COMMIT, { pdf: skillDoc("pdf", "Use for PDF work.") });
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch });
		const { entries } = await loadRemoteSkillDescriptors(cwd, agentDir);

		await expect(
			ensureRemoteSkillResource(entries[0]!.descriptor, "MISSING.md", { fetch: stub.fetch, agentDir }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		const offline: FetchFn = async () => {
			throw new TypeError("fetch failed");
		};
		const error = await ensureRemoteSkillResource(entries[0]!.descriptor, "REFERENCE.md", {
			fetch: offline,
			agentDir,
		}).catch(err => err);
		expect(error).toBeInstanceOf(RemoteSkillError);
		expect(error.code).toBe("OFFLINE_RESOURCE_MISSING");
		expect(error.message).toContain("REFERENCE.md");
	});

	test("oversized resources are rejected before reaching the cache", async () => {
		const stub = githubTreeStub(COMMIT, { pdf: skillDoc("pdf", "Use for PDF work.") });
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch });
		const { entries } = await loadRemoteSkillDescriptors(cwd, agentDir);

		const big = stubFetch({ "/skills/pdf/big.bin": () => text("x".repeat(2048)) });
		await expect(
			ensureRemoteSkillResource(entries[0]!.descriptor, "big.bin", {
				fetch: big.fetch,
				agentDir,
				maxBytes: 1024,
			}),
		).rejects.toMatchObject({ code: "RESOURCE_LIMIT_EXCEEDED" });
	});

	test("remove unregisters only the requested scope", async () => {
		const stub = githubTreeStub(COMMIT, {
			pdf: skillDoc("pdf", "Use for PDF work."),
			writing: skillDoc("writing", "Use for prose."),
		});
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch });
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: true, agentDir, fetch: stub.fetch });

		const projectRemoved = await removeRemoteSkills({ cwd, agentDir, names: ["pdf"] });
		expect(projectRemoved.removed).toEqual(["pdf"]);
		const projectIndex = await readRemoteSkillIndex(path.join(cwd, ".omp", "remote-skills.json"));
		expect(Object.keys(projectIndex.skills)).toEqual(["writing"]);
		// The user copy is untouched by a project scoped removal.
		const userIndex = await readRemoteSkillIndex(path.join(agentDir, "remote-skills.json"));
		expect(Object.keys(userIndex.skills).sort()).toEqual(["pdf", "writing"]);

		const userRemoved = await removeRemoteSkills({ cwd, agentDir, names: ["pdf"], global: true });
		expect(userRemoved.removed).toEqual(["pdf"]);
		await expect(removeRemoteSkills({ cwd, agentDir, names: ["pdf"] })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	test("project descriptors shadow a same-named user descriptor", async () => {
		const project = githubTreeStub(COMMIT, { pdf: skillDoc("pdf", "Project copy.") });
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: project.fetch });
		const user = githubTreeStub(NEXT_COMMIT, { pdf: skillDoc("pdf", "User copy.") });
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: true, agentDir, fetch: user.fetch });

		const { entries } = await loadRemoteSkillDescriptors(cwd, agentDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ level: "project", descriptor: { description: "Project copy." } });
	});
});
