/**
 * GitHub source adapter: spec parsing, ref resolution, tree listing, file reads.
 *
 * Only the provider side lives here. Caching and version pinning belong to
 * `store.ts`, so this module stays usable from the CLI and from tests with an
 * injected `fetch`.
 */
import { fetchWithRetry, isRecord } from "@oh-my-pi/pi-utils";
import { readBodyCapped } from "../../web/response-body";
import { RemoteSkillError } from "./types";

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Per-attempt deadline; a stalled provider fails the attempt instead of hanging the read. */
export const REMOTE_REQUEST_TIMEOUT_MS = 15_000;
/** Retries beyond the first attempt. */
export const REMOTE_MAX_RETRIES = 2;
/** `SKILL.md` cap, applied before the document is parsed. */
export const MAX_SKILL_DOCUMENT_BYTES = 256 * 1024;
/** Single resource cap. */
export const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;

const REPOSITORY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

export interface RemoteSourceSpec {
	readonly repository: string;
	readonly ref: string;
	/** Skill root inside the repository; empty means the repository root. */
	readonly directory: string;
}

/** `owner/repo` with provider-safe characters; shared by source parsing and index validation. */
export function isValidRepositoryName(repository: string): boolean {
	return REPOSITORY_RE.test(repository);
}

/**
 * Parse `owner/repo[@ref][#directory]`.
 *
 * Ref and directory are optional; `ref` defaults to the repository's default
 * branch (`HEAD` via the commits API). Only GitHub is accepted: a URL scheme is
 * rejected so the model can never turn a skill into an arbitrary fetch.
 */
export function parseRemoteSourceSpec(spec: string): RemoteSourceSpec {
	const raw = spec.trim();
	if (!raw) throw new RemoteSkillError("INVALID_SOURCE", "empty skill source");
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
		throw new RemoteSkillError("INVALID_SOURCE", `expected owner/repo, got a URL: ${raw}`);
	}
	// `#` first: a ref may itself contain `/` (branch names) but not `#`.
	const hash = raw.indexOf("#");
	const directory = hash === -1 ? "" : raw.slice(hash + 1);
	const rest = hash === -1 ? raw : raw.slice(0, hash);
	const at = rest.indexOf("@");
	const repository = (at === -1 ? rest : rest.slice(0, at)).trim();
	const ref = at === -1 ? "" : rest.slice(at + 1).trim();
	if (!isValidRepositoryName(repository)) {
		throw new RemoteSkillError("INVALID_SOURCE", `expected owner/repo, got "${repository}"`);
	}
	return { repository, ref, directory: normalizeRelativeDirectory(directory) };
}

/** Validate and normalize a POSIX directory relative to the repository root. */
export function normalizeRelativeDirectory(raw: string): string {
	const normalized = raw.replace(/^\/+|\/+$/g, "").replace(/\\/g, "/");
	if (normalized === "") return "";
	for (const segment of normalized.split("/")) {
		if (segment === "" || segment === "." || segment === "..") {
			throw new RemoteSkillError("INVALID_SOURCE", `unsafe directory segment in "${raw}"`);
		}
	}
	return normalized;
}

/** Validate a POSIX path relative to a skill root. */
export function assertSkillRelativePath(raw: string): string {
	const normalized = raw.replace(/\\/g, "/");
	if (normalized.startsWith("/") || normalized === "" || normalized.split("/").includes("..")) {
		throw new RemoteSkillError("PATH_DENIED", `path escapes the skill root: ${raw}`);
	}
	return normalized;
}

/** True when `value` is already an immutable commit id. */
export function isCommitId(value: string): boolean {
	return COMMIT_RE.test(value);
}

/**
 * Resolve a mutable ref (or the default branch) to a commit id.
 *
 * A 40-hex input is returned unchanged: an explicit commit needs no network and
 * must never be re-resolved into a different revision.
 */
export async function resolveRemoteCommit(
	repository: string,
	ref: string,
	options: { fetch?: FetchFn; signal?: AbortSignal } = {},
): Promise<string> {
	if (isCommitId(ref)) return ref;
	const endpoint = `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref || "HEAD")}`;
	const payload = await githubJson(endpoint, options);
	const commit = isRecord(payload) && typeof payload.sha === "string" ? payload.sha : "";
	if (!isCommitId(commit)) {
		throw new RemoteSkillError("NETWORK", `commits API returned no commit id for ${repository}@${ref || "HEAD"}`);
	}
	return commit;
}

/**
 * List `SKILL.md` files under `directory` at `commit`.
 *
 * A skill is a directory containing `SKILL.md`; the spec requires the
 * frontmatter name to equal the directory name, so no repository-side manifest
 * is needed. A repository-root `SKILL.md` is accepted when `directory` is empty.
 */
export async function listRemoteSkillFiles(
	repository: string,
	commit: string,
	directory: string,
	options: { fetch?: FetchFn; signal?: AbortSignal } = {},
): Promise<string[]> {
	// List the requested subdirectory's own tree: a repository-wide recursive listing
	// can be truncated, and narrowing the source could then never help.
	const treeSha = directory === "" ? commit : await resolveSubtree(repository, commit, directory, options);
	const endpoint = `https://api.github.com/repos/${repository}/git/trees/${treeSha}?recursive=1`;
	const payload = await githubJson(endpoint, options);
	if (!isRecord(payload) || !Array.isArray(payload.tree)) {
		throw new RemoteSkillError("NETWORK", `tree API returned no tree for ${repository}@${commit}`);
	}
	if (payload.truncated === true) {
		throw new RemoteSkillError(
			"RESOURCE_LIMIT_EXCEEDED",
			`${repository}@${commit} has a truncated tree listing under "${directory}"; register a narrower source with #<directory>`,
		);
	}
	const files: string[] = [];
	for (const entry of payload.tree) {
		if (!isRecord(entry) || typeof entry.path !== "string" || entry.type !== "blob") continue;
		const isRootSkill = directory === "" && entry.path === "SKILL.md";
		if (!isRootSkill && !entry.path.endsWith("/SKILL.md")) continue;
		files.push(directory === "" ? entry.path : `${directory}/${entry.path}`);
	}
	return files.sort();
}

/** Walk to a subdirectory's tree SHA, one non-recursive level per path segment. */
async function resolveSubtree(
	repository: string,
	commit: string,
	directory: string,
	options: { fetch?: FetchFn; signal?: AbortSignal },
): Promise<string> {
	let sha = commit;
	for (const segment of directory.split("/")) {
		const endpoint = `https://api.github.com/repos/${repository}/git/trees/${sha}`;
		const payload = await githubJson(endpoint, options);
		const tree = isRecord(payload) && Array.isArray(payload.tree) ? payload.tree : undefined;
		const entry = tree?.find(item => isRecord(item) && item.path === segment && item.type === "tree");
		const next = isRecord(entry) && typeof entry.sha === "string" ? entry.sha : "";
		if (!next) {
			throw new RemoteSkillError(
				"NOT_FOUND",
				`${repository}@${commit}: "${directory}" does not exist in this revision`,
			);
		}
		sha = next;
	}
	return sha;
}

/** Percent-encode each path segment, keeping `/` separators. */
function encodePathSegments(file: string): string {
	return file.split("/").map(encodeURIComponent).join("/");
}

/** Path of a skill's instruction file inside its repository. */
export function repositorySkillPath(source: { repository: string; directory: string }): string {
	return source.directory === "" ? "SKILL.md" : `${source.directory}/SKILL.md`;
}

/** Read one file at an exact commit. Returns `null` when the path does not exist. */
export async function readRemoteFile(
	repository: string,
	commit: string,
	file: string,
	options: { fetch?: FetchFn; signal?: AbortSignal; maxBytes?: number } = {},
): Promise<Uint8Array | null> {
	if (!isCommitId(commit)) throw new RemoteSkillError("INVALID_SOURCE", `not a commit id: ${commit}`);
	const maxBytes = options.maxBytes ?? MAX_RESOURCE_BYTES;
	const raw = `https://raw.githubusercontent.com/${repository}/${commit}/${encodePathSegments(file)}`;
	let response: Response;
	try {
		response = await requestWithRetry(raw, options.fetch ?? fetch, options.signal);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new RemoteSkillError("NETWORK", `${repository}@${commit}:${file} failed: ${detail}`, { cause: error });
	}
	if (response.status === 404) return null;
	assertStatus(response, `${repository}@${commit}:${file}`);
	const declared = Number(response.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new RemoteSkillError("RESOURCE_LIMIT_EXCEEDED", `${file} is ${declared} bytes; the limit is ${maxBytes}`);
	}
	const body = await readBodyCapped(response, maxBytes);
	if (body === null) {
		throw new RemoteSkillError("NETWORK", `${file}: response carries no readable body`);
	}
	if (body.truncated) {
		throw new RemoteSkillError(
			"RESOURCE_LIMIT_EXCEEDED",
			`${file} exceeds the ${maxBytes}-byte limit; the transfer was cancelled`,
		);
	}
	return new Uint8Array(body.bytes);
}

// ─── HTTP plumbing ──────────────────────────────────────────────────────────

async function githubJson(endpoint: string, options: { fetch?: FetchFn; signal?: AbortSignal }): Promise<unknown> {
	let response: Response;
	try {
		response = await requestWithRetry(endpoint, options.fetch ?? fetch, options.signal, {
			Accept: "application/vnd.github+json",
		});
	} catch (error) {
		if (options.signal?.aborted) throw error;
		const detail = error instanceof Error ? error.message : String(error);
		throw new RemoteSkillError("NETWORK", `${endpoint} failed: ${detail}`, { cause: error });
	}
	assertStatus(response, endpoint);
	return await response.json();
}

/**
 * Shared retry policy for every provider call: three attempts, 15 s each,
 * abortable backoff, and `Retry-After` hints capped so one throttled request
 * cannot stall a read for a minute.
 */
function requestWithRetry(
	url: string,
	run: FetchFn,
	signal: AbortSignal | undefined,
	extraHeaders: Record<string, string> = {},
): Promise<Response> {
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	return fetchWithRetry(url, {
		maxAttempts: REMOTE_MAX_RETRIES + 1,
		maxDelayMs: 5_000,
		defaultDelayMs: attempt => Math.min(2_000, 250 * 2 ** attempt),
		timeout: REMOTE_REQUEST_TIMEOUT_MS,
		fetch: run,
		...(signal ? { signal } : {}),
		headers: {
			"User-Agent": "oh-my-pi",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...extraHeaders,
		},
	});
}

function assertStatus(response: Response, what: string): void {
	if (response.ok) return;
	if (response.status === 401) {
		throw new RemoteSkillError("AUTH_REQUIRED", `${what}: GitHub credentials are required`);
	}
	if (response.status === 403) {
		const remaining = response.headers.get("x-ratelimit-remaining");
		const retryAfter = response.headers.get("retry-after");
		if (remaining === "0" || retryAfter !== null) {
			throw new RemoteSkillError("RATE_LIMITED", `${what}: GitHub rate limit exhausted`);
		}
		throw new RemoteSkillError("ACCESS_DENIED", `${what}: GitHub denied access`);
	}
	if (response.status === 404) {
		throw new RemoteSkillError("NOT_FOUND", `${what}: not found`);
	}
	if (response.status === 429) {
		throw new RemoteSkillError("RATE_LIMITED", `${what}: GitHub rate limit exceeded`);
	}
	throw new RemoteSkillError("NETWORK", `${what}: HTTP ${response.status}`);
}
