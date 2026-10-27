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
	readRemoteFile,
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

const SUBTREE = "c".repeat(40);
const SUBTREE_PDF = "e".repeat(40);

function rootListing(docs: Record<string, string>): unknown {
	return { tree: Object.keys(docs).map(name => ({ path: `skills/${name}/SKILL.md`, type: "blob" })) };
}

function subtreeListing(docs: Record<string, string>): unknown {
	return { tree: Object.keys(docs).map(name => ({ path: `${name}/SKILL.md`, type: "blob" })) };
}

/**
 * Routes the source adapter's three listing calls: the root recursive tree, the
 * non-recursive root used to resolve `skills/`, and that subtree's recursive tree.
 * Longer prefixes are registered first, matching how `stubFetch` scans.
 */
function githubTreeStub(commit: string, docs: Record<string, string>, tree?: unknown): Stub {
	const routes: Record<string, () => Response | Promise<Response>> = {
		[`/git/trees/${commit}?recursive=1`]: () => json(tree ?? rootListing(docs)),
		[`/git/trees/${SUBTREE_PDF}?recursive=1`]: () => json({ tree: [{ path: "SKILL.md", type: "blob" }] }),
		[`/git/trees/${SUBTREE}?recursive=1`]: () => json(subtreeListing(docs)),
		[`/git/trees/${SUBTREE}`]: () =>
			json({ tree: Object.keys(docs).map(name => ({ path: name, type: "tree", sha: SUBTREE_PDF })) }),
		[`/git/trees/${commit}`]: () => json({ tree: [{ path: "skills", type: "tree", sha: SUBTREE }] }),
		"/commits/": () => json({ sha: commit }),
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
			...(descriptor.files ? { files: descriptor.files } : {}),
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

	test("lists only SKILL.md files, resolving a subdirectory to its own tree", async () => {
		const stub = stubFetch({
			[`/git/trees/${COMMIT}?recursive=1`]: () => json(TREE),
			[`/git/trees/${SUBTREE}?recursive=1`]: () =>
				json({
					tree: [
						{ path: "pdf/SKILL.md", type: "blob" },
						{ path: "writing/SKILL.md", type: "blob" },
					],
				}),
			[`/git/trees/${COMMIT}`]: () => json({ tree: [{ path: "skills", type: "tree", sha: SUBTREE }] }),
		});
		expect(await listRemoteSkillFiles(REPO, COMMIT, "skills", { fetch: stub.fetch })).toEqual([
			"skills/pdf/SKILL.md",
			"skills/writing/SKILL.md",
		]);
		expect(await listRemoteSkillFiles(REPO, COMMIT, "", { fetch: stub.fetch })).toEqual([
			"skills/pdf/SKILL.md",
			"skills/writing/SKILL.md",
		]);
		expect(stub.calls.some(url => url.includes(`/git/trees/${SUBTREE}?recursive=1`))).toBe(true);
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
			[`/git/trees/${SUBTREE}?recursive=1`]: () => json({ tree: [], truncated: true }),
			[`/git/trees/${COMMIT}`]: () => json({ tree: [{ path: "skills", type: "tree", sha: SUBTREE }] }),
			"/commits/": () => json({ sha: COMMIT }),
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

	test("percent-encodes resource path segments", async () => {
		const stub = githubTreeStub(COMMIT, { pdf: skillDoc("pdf", "Use for PDF work.") });
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch });
		const { entries } = await loadRemoteSkillDescriptors(cwd, agentDir);

		const fetches = stubFetch({
			[`/${COMMIT}/skills/pdf/references/plan%23draft.md`]: () => text("# draft\n"),
		});
		const file = await ensureRemoteSkillResource(entries[0]!.descriptor, "references/plan#draft.md", {
			fetch: fetches.fetch,
			agentDir,
		});
		expect(await Bun.file(file).text()).toBe("# draft\n");
		expect(fetches.calls[0]).toContain("plan%23draft.md");
	});

	test("classifies a rate-limited 403 before access denial", async () => {
		const tree = githubTreeStub(COMMIT, { pdf: skillDoc("pdf", "Use for PDF work.") });
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: tree.fetch });

		const limited = stubFetch({
			"/skills/pdf/SKILL.md": () =>
				new Response("rate limit", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
		});
		await expect(readRemoteFile(REPO, COMMIT, "skills/pdf/SKILL.md", { fetch: limited.fetch })).rejects.toMatchObject(
			{ code: "RATE_LIMITED" },
		);

		const denied = stubFetch({
			"/skills/pdf/SKILL.md": () => new Response("forbidden", { status: 403 }),
		});
		await expect(readRemoteFile(REPO, COMMIT, "skills/pdf/SKILL.md", { fetch: denied.fetch })).rejects.toMatchObject({
			code: "ACCESS_DENIED",
		});
	});

	test("caps a streamed body that omits content-length", async () => {
		const stub = githubTreeStub(COMMIT, { pdf: skillDoc("pdf", "Use for PDF work.") });
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch });
		const { entries } = await loadRemoteSkillDescriptors(cwd, agentDir);

		const chunked = stubFetch({
			"/skills/pdf/big.bin": () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(4096).fill(120));
							controller.close();
						},
					}),
				),
		});
		await expect(
			ensureRemoteSkillResource(entries[0]!.descriptor, "big.bin", {
				fetch: chunked.fetch,
				agentDir,
				maxBytes: 1024,
			}),
		).rejects.toMatchObject({ code: "RESOURCE_LIMIT_EXCEEDED" });
	});

	test("persists the validated skill name, not the raw frontmatter scalar", async () => {
		const stub = githubTreeStub(COMMIT, {
			pdf: '---\nname: " pdf "\ndescription: Padded name.\n---\n\n# pdf\n',
		});
		const result = await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch });
		expect(result.added).toEqual(["pdf"]);
		const index = await readRemoteSkillIndex(path.join(cwd, ".omp", "remote-skills.json"));
		expect(Object.keys(index.skills)).toEqual(["pdf"]);
		const { entries } = await loadRemoteSkillDescriptors(cwd, agentDir);
		expect(entries.map(entry => entry.descriptor.name)).toEqual(["pdf"]);
	});

	test("a skill named constructor does not collide with Object.prototype", async () => {
		const stub = githubTreeStub(COMMIT, { constructor: skillDoc("constructor", "Named like a prototype key.") });
		const result = await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch });
		expect(result.added).toEqual(["constructor"]);
		const index = await readRemoteSkillIndex(path.join(cwd, ".omp", "remote-skills.json"));
		expect(Object.hasOwn(index.skills, "constructor")).toBe(true);
	});

	test("sync resolves one commit per repository and ref", async () => {
		const first = githubTreeStub(COMMIT, {
			pdf: skillDoc("pdf", "Old."),
			writing: skillDoc("writing", "Old."),
		});
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: first.fetch });

		const moved = githubTreeStub(NEXT_COMMIT, {
			pdf: skillDoc("pdf", "New."),
			writing: skillDoc("writing", "New."),
		});
		const before = moved.calls.filter(url => url.includes("/commits/")).length;
		const synced = await syncRemoteSkills({ cwd, agentDir, fetch: moved.fetch });
		expect(synced.changes).toHaveLength(2);
		expect(moved.calls.filter(url => url.includes("/commits/")).length - before).toBe(1);
	});

	test("sync rejects names that are not registered", async () => {
		const stub = githubTreeStub(COMMIT, { pdf: skillDoc("pdf", "Use for PDF work.") });
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch });
		await expect(syncRemoteSkills({ cwd, agentDir, names: ["typo"], fetch: stub.fetch })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	test("invocation materializes the recorded file manifest", async () => {
		const tree = {
			tree: [
				{ path: "skills/pdf/SKILL.md", type: "blob" },
				{ path: "skills/pdf/scripts/run.py", type: "blob" },
			],
		};
		const stub = stubFetch({
			[`/git/trees/${COMMIT}?recursive=1`]: () => json(tree),
			[`/git/trees/${SUBTREE}?recursive=1`]: () =>
				json({
					tree: [
						{ path: "pdf/SKILL.md", type: "blob" },
						{ path: "pdf/scripts/run.py", type: "blob" },
					],
				}),
			[`/git/trees/${COMMIT}`]: () => json({ tree: [{ path: "skills", type: "tree", sha: SUBTREE }] }),
			"/commits/": () => json({ sha: COMMIT }),
			"/skills/pdf/SKILL.md": () => text(skillDoc("pdf", "Runs a script.")),
			[`/${COMMIT}/skills/pdf/scripts/run.py`]: () => text("print(1)\n"),
		});
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch });
		const { entries } = await loadRemoteSkillDescriptors(cwd, agentDir);
		expect(entries[0]!.descriptor.files).toEqual(["SKILL.md", "scripts/run.py"]);

		const skill = remoteSkillFixture(entries[0]!.descriptor, agentDir);
		__setRemoteSkillFetchForTests(stub.fetch);
		await buildSkillPromptMessage(skill, { args: "" }, "user");
		const script = path.join(path.dirname(skill.filePath), "scripts", "run.py");
		expect(await Bun.file(script).text()).toBe("print(1)\n");
	});

	test("read-through enforces the SKILL.md cap without a prior add", async () => {
		const descriptor = {
			origin: "github" as const,
			repository: REPO,
			directory: "skills/pdf",
			commit: COMMIT,
		};
		const oversized = stubFetch({ "/skills/pdf/SKILL.md": () => text("x".repeat(300 * 1024)) });
		await expect(
			ensureRemoteSkillResource(descriptor, "SKILL.md", { fetch: oversized.fetch, agentDir }),
		).rejects.toMatchObject({ code: "RESOURCE_LIMIT_EXCEEDED" });
	});

	test("an oversized cached SKILL.md is rejected instead of used", async () => {
		const descriptor = {
			origin: "github" as const,
			repository: REPO,
			directory: "skills/pdf",
			commit: COMMIT,
		};
		const target = remoteSkillCachePath(descriptor, "SKILL.md", agentDir);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, "x".repeat(300 * 1024));
		await expect(ensureRemoteSkillResource(descriptor, "SKILL.md", { agentDir })).rejects.toMatchObject({
			code: "RESOURCE_LIMIT_EXCEEDED",
		});
	});

	test("a body-stream failure stays inside the network boundary", async () => {
		const descriptor = {
			origin: "github" as const,
			repository: REPO,
			directory: "skills/pdf",
			commit: COMMIT,
		};
		const broken = stubFetch({
			"/skills/pdf/SKILL.md": () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(8));
							controller.error(new Error("connection reset"));
						},
					}),
				),
		});
		await expect(readRemoteFile(REPO, COMMIT, "skills/pdf/SKILL.md", { fetch: broken.fetch })).rejects.toMatchObject({
			code: "NETWORK",
		});
		await expect(
			ensureRemoteSkillResource(descriptor, "SKILL.md", { fetch: broken.fetch, agentDir }),
		).rejects.toMatchObject({ code: "OFFLINE_RESOURCE_MISSING" });
	});

	test("a descriptor with a decomposed directory still matches its normalized name", async () => {
		const indexFile = path.join(cwd, ".omp", "remote-skills.json");
		fs.mkdirSync(path.dirname(indexFile), { recursive: true });
		fs.writeFileSync(
			indexFile,
			JSON.stringify({
				version: 1,
				skills: {
					"caf\u00e9": {
						name: "caf\u00e9",
						description: "Normalized name.",
						origin: "github",
						repository: REPO,
						directory: "skills/cafe\u0301",
						ref: "main",
						commit: COMMIT,
					},
				},
			}),
		);
		const { entries, warnings } = await loadRemoteSkillDescriptors(cwd, agentDir);
		expect(warnings.join("\n")).not.toContain("does not match");
		expect(entries.map(entry => entry.descriptor.name)).toEqual(["caf\u00e9"]);
	});

	test("repinning refreshes the file manifest from the new commit", async () => {
		const first = githubTreeStub(COMMIT, { pdf: skillDoc("pdf", "Old tree.") });
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: first.fetch });
		let { entries } = await loadRemoteSkillDescriptors(cwd, agentDir);
		expect(entries[0]!.descriptor.files).toEqual(["SKILL.md"]);

		const moved = stubFetch({
			[`/git/trees/${NEXT_COMMIT}?recursive=1`]: () =>
				json({
					tree: [
						{ path: "skills/pdf/SKILL.md", type: "blob" },
						{ path: "skills/pdf/scripts/new.py", type: "blob" },
					],
				}),
			[`/git/trees/${SUBTREE_PDF}?recursive=1`]: () =>
				json({
					tree: [
						{ path: "SKILL.md", type: "blob" },
						{ path: "scripts/new.py", type: "blob" },
					],
				}),
			[`/git/trees/${SUBTREE}`]: () => json({ tree: [{ path: "pdf", type: "tree", sha: SUBTREE_PDF }] }),
			[`/git/trees/${NEXT_COMMIT}`]: () => json({ tree: [{ path: "skills", type: "tree", sha: SUBTREE }] }),
			"/commits/": () => json({ sha: NEXT_COMMIT }),
			[`/${NEXT_COMMIT}/skills/pdf/SKILL.md`]: () => text(skillDoc("pdf", "Moved ref.")),
		});
		await syncRemoteSkills({ cwd, agentDir, fetch: moved.fetch });
		({ entries } = await loadRemoteSkillDescriptors(cwd, agentDir));
		expect(entries[0]!.descriptor.files).toEqual(["SKILL.md", "scripts/new.py"]);
	});

	test("a project-scoped add lands at the active project root", async () => {
		const repo = path.join(root, "repo");
		const subdir = path.join(repo, "packages", "foo");
		fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
		fs.mkdirSync(subdir, { recursive: true });
		const stub = githubTreeStub(COMMIT, { pdf: skillDoc("pdf", "Use for PDF work.") });
		await addRemoteSkills(`${REPO}#skills`, { cwd: subdir, global: false, fetch: stub.fetch });
		expect(await Bun.file(path.join(repo, ".omp", "remote-skills.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(subdir, ".omp", "remote-skills.json")).exists()).toBe(false);
	});

	test("records and applies the executable bit", async () => {
		const stub = stubFetch({
			[`/git/trees/${COMMIT}?recursive=1`]: () =>
				json({
					tree: [
						{ path: "skills/pdf/SKILL.md", type: "blob" },
						{ path: "skills/pdf/scripts/run.sh", type: "blob", mode: "100755" },
					],
				}),
			[`/git/trees/${SUBTREE}?recursive=1`]: () =>
				json({
					tree: [
						{ path: "pdf/SKILL.md", type: "blob" },
						{ path: "pdf/scripts/run.sh", type: "blob", mode: "100755" },
					],
				}),
			[`/git/trees/${COMMIT}`]: () => json({ tree: [{ path: "skills", type: "tree", sha: SUBTREE }] }),
			"/commits/": () => json({ sha: COMMIT }),
			"/skills/pdf/SKILL.md": () => text(skillDoc("pdf", "Run the script.")),
			[`/${COMMIT}/skills/pdf/scripts/run.sh`]: () => text("#!/bin/sh\necho ok\n"),
		});
		await addRemoteSkills(`${REPO}#skills`, { cwd, global: false, fetch: stub.fetch });
		const { entries } = await loadRemoteSkillDescriptors(cwd, agentDir);
		expect(entries[0]!.descriptor.executables).toEqual(["scripts/run.sh"]);

		const skill = remoteSkillFixture(entries[0]!.descriptor, agentDir);
		__setRemoteSkillFetchForTests(stub.fetch);
		await buildSkillPromptMessage(skill, { args: "" }, "user");
		if (process.platform !== "win32") {
			const mode = (await fs.promises.stat(path.join(skill.baseDir, "scripts", "run.sh"))).mode;
			expect(mode & 0o111).not.toBe(0);
		}
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
