/**
 * Remote skill index and content cache.
 *
 * - Index: discovery descriptors (`name`, `description`, pinned `commit`).
 * - Cache: read-through content at an immutable commit, so the body and every
 *   resource of one task come from the same revision.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, isRecord, logger } from "@oh-my-pi/pi-utils";
import { resolveOrDefaultProjectRegistryPath } from "../../discovery/helpers";
import { writeFileAtomically } from "../../utils/atomic-file";
import {
	assertSkillRelativePath,
	isValidRepositoryName,
	MAX_RESOURCE_BYTES,
	MAX_SKILL_DOCUMENT_BYTES,
	MAX_SKILL_FILES,
	MAX_SKILL_TREE_BYTES,
	normalizeRelativeDirectory,
	readRemoteFile,
	type FetchFn,
} from "./source";
import {
	EMPTY_REMOTE_SKILL_INDEX,
	RemoteSkillError,
	type RemoteSkillDescriptor,
	type RemoteSkillIndex,
	type RemoteSkillSource,
} from "./types";

export const REMOTE_SKILL_INDEX_FILE = "remote-skills.json";
export const REMOTE_SKILL_INDEX_VERSION = 1;
export const REMOTE_SKILL_PROVIDER_ID = "remote";

const SKILL_NAME_RE = /^[\p{L}\p{N}-]+$/u;

/** In-flight fetches keyed by cache path: concurrent reads share one download. */
const inFlight = new Map<string, Promise<string>>();

/** Test seam: a fetch used when a caller supplies none (the protocol handler does not). */
let testFetch: FetchFn | undefined;

export function __setRemoteSkillFetchForTests(fetch: FetchFn | undefined): void {
	testFetch = fetch;
}

/** Project index path: nearest `<dir>/.omp/remote-skills.json` walking up from `cwd`. */
export async function findProjectRemoteSkillIndex(cwd: string): Promise<string | undefined> {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, ".omp", REMOTE_SKILL_INDEX_FILE);
		if (await fileExists(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/** User index path (`<agentDir>/remote-skills.json`). */
export function userRemoteSkillIndexPath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, REMOTE_SKILL_INDEX_FILE);
}

/**
 * Project index path used when creating one, anchored at the active project root
 * (nearest `.omp/`, else the git root) so a registration from a subdirectory is
 * found by a session started at the repository root.
 */
export async function projectRemoteSkillIndexPath(cwd: string): Promise<string> {
	const registry = await resolveOrDefaultProjectRegistryPath(cwd);
	if (!registry) {
		throw new RemoteSkillError(
			"INVALID_SOURCE",
			"this directory is not a project root; pass -g to register the skill for your user",
		);
	}
	// `<root>/.omp/plugins/installed_plugins.json` → `<root>/.omp`
	return path.join(path.dirname(path.dirname(registry)), REMOTE_SKILL_INDEX_FILE);
}

export async function fileExists(file: string): Promise<boolean> {
	try {
		await fs.stat(file);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

/** Directory name the spec requires `name` to match: the skill dir, or the repository at the root. */
function expectedSkillDirName(descriptor: Pick<RemoteSkillDescriptor, "repository" | "directory">): string {
	return descriptor.directory === ""
		? descriptor.repository.split("/")[1]!
		: path.posix.basename(descriptor.directory);
}

/**
 * Validate one persisted descriptor.
 *
 * The index is committed to a repository and therefore untrusted input: the
 * same traversal and shape rules as `omp skill remote add` apply, because
 * `remoteSkillCachePath` turns these strings into filesystem paths.
 */
function validateDescriptor(name: string, value: unknown, file: string): RemoteSkillDescriptor {
	const fail = (reason: string): never => {
		throw new RemoteSkillError("INVALID_SKILL", `${file}: "${name}" ${reason}`);
	};
	if (!isRecord(value)) return fail("is not an object");
	const { origin, repository, directory, commit, ref, description } = value;
	if (origin !== "github") return fail("has an unknown origin");
	if (typeof repository !== "string" || !isValidRepositoryName(repository)) return fail("has an invalid repository");
	if (typeof directory !== "string") return fail("has no directory");
	let normalizedDirectory: string;
	try {
		normalizedDirectory = normalizeRelativeDirectory(directory);
	} catch {
		return fail(`has an unsafe directory "${directory}"`);
	}
	if (normalizedDirectory !== directory) return fail(`has a non-canonical directory "${directory}"`);
	if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) return fail("has no pinned commit");
	if (typeof ref !== "string") return fail("has no ref");
	if (typeof description !== "string") return fail("has no description");
	let manifest: string[] | undefined;
	if (value.files !== undefined) {
		if (!Array.isArray(value.files) || value.files.length > MAX_SKILL_FILES) {
			return fail(`has an invalid file manifest (limit ${MAX_SKILL_FILES})`);
		}
		manifest = [];
		for (const entry of value.files) {
			if (typeof entry !== "string") return fail("has a non-string file entry");
			try {
				manifest.push(assertSkillRelativePath(entry));
			} catch {
				return fail(`has an unsafe file entry "${entry}"`);
			}
		}
	}
	let executables: string[] | undefined;
	if (value.executables !== undefined) {
		if (!Array.isArray(value.executables) || value.executables.length > MAX_SKILL_FILES) {
			return fail(`has an invalid executable list (limit ${MAX_SKILL_FILES})`);
		}
		executables = [];
		for (const entry of value.executables) {
			if (typeof entry !== "string") return fail("has a non-string executable entry");
			try {
				executables.push(assertSkillRelativePath(entry));
			} catch {
				return fail(`has an unsafe executable entry "${entry}"`);
			}
		}
	}
	const descriptor: RemoteSkillDescriptor = {
		name,
		origin: "github",
		repository,
		directory,
		commit,
		ref,
		description,
		...(manifest ? { files: manifest.sort() } : {}),
		...(executables && executables.length > 0 ? { executables: executables.sort() } : {}),
	};
	for (const executable of descriptor.executables ?? []) {
		if (!descriptor.files?.includes(executable)) {
			return fail(`lists executable "${executable}" outside its file manifest`);
		}
	}
	const normalized = name.normalize("NFKC");
	if (normalized !== name) return fail("is not NFKC-normalized");
	if (
		normalized.length === 0 ||
		normalized.length > 64 ||
		normalized !== normalized.toLowerCase() ||
		!SKILL_NAME_RE.test(normalized)
	) {
		return fail("is not a lowercase skill name");
	}
	// Registration stores the normalized name; compare against a directory that may
	// itself arrive decomposed (`e` + combining accent).
	const expected = expectedSkillDirName(descriptor).normalize("NFKC");
	if (normalized !== expected) {
		return fail(`does not match its directory (${expected})`);
	}
	return descriptor;
}

interface ParsedIndex {
	index: RemoteSkillIndex;
	warnings: string[];
}

/** Parse an index body, collecting per-descriptor violations instead of dropping the file. */
function parseRemoteSkillIndex(text: string, file: string): ParsedIndex {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new RemoteSkillError("INVALID_SKILL", `${file}: invalid JSON (${String(error)})`);
	}
	if (!isRecord(parsed) || parsed.version !== REMOTE_SKILL_INDEX_VERSION || !isRecord(parsed.skills)) {
		throw new RemoteSkillError("INVALID_SKILL", `${file}: unsupported remote skill index`);
	}
	const skills: Record<string, RemoteSkillDescriptor> = {};
	const warnings: string[] = [];
	for (const [name, value] of Object.entries(parsed.skills)) {
		try {
			skills[name] = validateDescriptor(name, value, file);
		} catch (error) {
			warnings.push(error instanceof Error ? error.message : String(error));
		}
	}
	return { index: { version: REMOTE_SKILL_INDEX_VERSION, skills }, warnings };
}

/** Read an index file strictly. A missing file is an empty index; anything invalid throws. */
export async function readRemoteSkillIndex(file: string): Promise<RemoteSkillIndex> {
	let text: string;
	try {
		text = await Bun.file(file).text();
	} catch (error) {
		if (isEnoent(error)) return EMPTY_REMOTE_SKILL_INDEX;
		throw error;
	}
	const { index, warnings } = parseRemoteSkillIndex(text, file);
	if (warnings.length > 0) throw new RemoteSkillError("INVALID_SKILL", warnings[0]!);
	return index;
}

/** Read an index leniently: a bad file or descriptor is skipped and reported. */
async function readRemoteSkillIndexLenient(file: string): Promise<ParsedIndex> {
	let text: string;
	try {
		text = await Bun.file(file).text();
	} catch (error) {
		if (isEnoent(error)) return { index: EMPTY_REMOTE_SKILL_INDEX, warnings: [] };
		return { index: EMPTY_REMOTE_SKILL_INDEX, warnings: [`${file}: ${String(error)}`] };
	}
	try {
		return parseRemoteSkillIndex(text, file);
	} catch (error) {
		return { index: EMPTY_REMOTE_SKILL_INDEX, warnings: [error instanceof Error ? error.message : String(error)] };
	}
}

/** Write an index atomically; sorted keys keep diffs stable. */
export async function writeRemoteSkillIndex(file: string, index: RemoteSkillIndex): Promise<void> {
	const skills: Record<string, RemoteSkillDescriptor> = {};
	for (const name of Object.keys(index.skills).sort()) skills[name] = index.skills[name]!;
	const body = `${JSON.stringify({ version: REMOTE_SKILL_INDEX_VERSION, skills }, null, "\t")}\n`;
	await fs.mkdir(path.dirname(file), { recursive: true });
	// Shared helper: private temp name and Windows replacement retries.
	await writeFileAtomically(file, body, 0o644);
}

/** Bytes are not `string`; stage through a private temp name and publish by rename. */
async function writeBytesAtomically(file: string, body: Uint8Array): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await Bun.write(tmp, body);
		await fs.rename(tmp, file);
	} catch (error) {
		// Windows refuses a rename onto an existing file in some AV/indexer states.
		const code = (error as { code?: string }).code;
		if (code === "EPERM" || code === "EEXIST") {
			await fs.rm(file, { force: true });
			await fs.rename(tmp, file);
		} else {
			await fs.rm(tmp, { force: true }).catch(() => {});
			throw error;
		}
	}
}

/** Root of the remote skill content cache. */
export function remoteSkillCacheRoot(agentDir: string = getAgentDir()): string {
	return path.join(path.dirname(agentDir), "cache", "remote-skills");
}

/**
 * Cached path of one resource. The commit segment makes a task's reads
 * independent of later `sync` runs. Refuses a result outside the cache root,
 * so a hostile descriptor cannot address another file even if it slipped past
 * validation.
 */
export function remoteSkillCachePath(
	source: RemoteSkillSource,
	relativePath: string,
	agentDir: string = getAgentDir(),
): string {
	const safeRelative = assertSkillRelativePath(relativePath);
	const root = remoteSkillCacheRoot(agentDir);
	const target = path.join(
		root,
		...source.repository.split("/"),
		source.commit,
		...source.directory.split("/").filter(Boolean),
		...safeRelative.split("/"),
	);
	const relative = path.relative(root, target);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new RemoteSkillError("PATH_DENIED", `cache path escapes the cache root: ${source.repository}`);
	}
	return target;
}

export interface EnsureRemoteResourceOptions {
	fetch?: FetchFn;
	signal?: AbortSignal;
	agentDir?: string;
	maxBytes?: number;
}

/** Reject like the caller's abort as soon as its signal fires, without touching the shared download. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	const aborted = Promise.withResolvers<never>();
	const onAbort = () => aborted.reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([promise, aborted.promise]).finally(() => signal.removeEventListener("abort", onAbort));
}

/**
 * Return a local path for one resource of a remote skill, fetching it on first
 * use. Concurrent requests for the same revision/path share one download, and
 * a failed download never leaves a cache hit behind.
 *
 * The shared download is independent of any single caller: one cancelled reader
 * only cancels its own wait.
 */
export function ensureRemoteSkillResource(
	source: RemoteSkillSource,
	relativePath: string,
	options: EnsureRemoteResourceOptions = {},
): Promise<string> {
	return ensureRemoteSkillFileAt(
		source,
		remoteSkillCachePath(source, relativePath, options.agentDir),
		relativePath,
		options,
	);
}

/**
 * Materialize one resource at a caller-chosen cache path.
 *
 * Used when the target is already known — `Skill.filePath` was computed by the
 * provider against that session's agent dir, which the prompt builder does not
 * see — so both sides agree on one location.
 */
export function ensureRemoteSkillFileAt(
	source: RemoteSkillSource,
	target: string,
	relativePath: string,
	options: EnsureRemoteResourceOptions = {},
): Promise<string> {
	// An instruction document is capped far below a generic resource, including on the
	// read-through path a checked-in descriptor can reach without a prior `remote add`.
	const maxBytes = options.maxBytes ?? (relativePath === "SKILL.md" ? MAX_SKILL_DOCUMENT_BYTES : MAX_RESOURCE_BYTES);
	let shared = inFlight.get(target);
	if (!shared) {
		shared = (async () => {
			if (await fileExists(target)) {
				const { size } = await fs.stat(target);
				if (size > maxBytes) {
					throw new RemoteSkillError(
						"RESOURCE_LIMIT_EXCEEDED",
						`cached ${relativePath} is ${size} bytes; the limit is ${maxBytes}`,
					);
				}
				if (source.executables?.includes(relativePath)) await fs.chmod(target, 0o755);
				return target;
			}
			const repositoryPath = source.directory === "" ? relativePath : `${source.directory}/${relativePath}`;
			let bytes: Uint8Array | null;
			try {
				bytes = await readRemoteFile(source.repository, source.commit, repositoryPath, {
					fetch: options.fetch ?? testFetch,
					maxBytes,
				});
			} catch (error) {
				if (error instanceof RemoteSkillError && (error.code === "NETWORK" || error.code === "RATE_LIMITED")) {
					throw new RemoteSkillError(
						"OFFLINE_RESOURCE_MISSING",
						`${source.repository}@${source.commit}:${repositoryPath} is not cached and the source is unreachable (${error.message})`,
						{ cause: error },
					);
				}
				throw error;
			}
			if (bytes === null) {
				throw new RemoteSkillError("NOT_FOUND", `${source.repository}@${source.commit}:${repositoryPath}`);
			}
			await writeBytesAtomically(target, bytes);
			if (source.executables?.includes(relativePath)) await fs.chmod(target, 0o755);
			return target;
		})().finally(() => {
			if (inFlight.get(target) === shared) inFlight.delete(target);
		});
		// A caller that aborts leaves this reference unobserved; keep it handled.
		shared.catch(() => {});
		inFlight.set(target, shared);
	}
	return options.signal ? raceAbort(shared, options.signal) : shared;
}

/**
 * Materialize every file recorded for a skill, so an invocation that resolves
 * `scripts/…` against the skill directory finds a complete tree. Per-file caps
 * apply, and the total is bounded by {@link MAX_SKILL_TREE_BYTES}.
 */
export async function ensureRemoteSkillTree(
	source: RemoteSkillSource,
	skillDir: string,
	options: EnsureRemoteResourceOptions = {},
): Promise<void> {
	const files = source.files;
	if (!files || files.length === 0) return;
	let total = 0;
	for (const file of files) {
		const target = await ensureRemoteSkillFileAt(source, path.join(skillDir, ...file.split("/")), file, options);
		const { size } = await fs.stat(target);
		total += size;
		if (total > MAX_SKILL_TREE_BYTES) {
			throw new RemoteSkillError(
				"RESOURCE_LIMIT_EXCEEDED",
				`${source.repository}#${source.directory} exceeds the ${MAX_SKILL_TREE_BYTES}-byte materialization budget`,
			);
		}
	}
}

/** One registered descriptor plus the scope it came from. */
export interface RemoteSkillIndexEntry {
	descriptor: RemoteSkillDescriptor;
	level: "user" | "project";
	indexFile: string;
}

export interface RemoteSkillDescriptorLoad {
	entries: RemoteSkillIndexEntry[];
	warnings: string[];
}

/**
 * Merge project and user indexes; the project entry wins a name collision.
 *
 * A broken file or descriptor is skipped with a warning instead of hiding every
 * valid skill from the other scope.
 */
export async function loadRemoteSkillDescriptors(
	cwd: string,
	agentDir: string = getAgentDir(),
): Promise<RemoteSkillDescriptorLoad> {
	const entries: RemoteSkillIndexEntry[] = [];
	const warnings: string[] = [];
	const projectFile = await findProjectRemoteSkillIndex(cwd);
	const userFile = userRemoteSkillIndexPath(agentDir);
	const [project, user] = await Promise.all([
		projectFile ? readRemoteSkillIndexLenient(projectFile) : { index: EMPTY_REMOTE_SKILL_INDEX, warnings: [] },
		readRemoteSkillIndexLenient(userFile),
	]);
	warnings.push(...project.warnings, ...user.warnings);
	for (const descriptor of Object.values(user.index.skills)) {
		entries.push({ descriptor, level: "user", indexFile: userFile });
	}
	if (projectFile) {
		for (const descriptor of Object.values(project.index.skills)) {
			const existing = entries.findIndex(entry => entry.descriptor.name === descriptor.name);
			const entry = { descriptor, level: "project" as const, indexFile: projectFile };
			if (existing === -1) entries.push(entry);
			else entries[existing] = entry;
		}
	}
	if (warnings.length > 0) {
		logger.warn("remote skill index entries were skipped", { warnings: warnings.join("; ") });
	}
	return { entries, warnings };
}
