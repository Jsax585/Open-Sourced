/**
 * Protocol handler for skill:// URLs.
 *
 * Resolves skill names to their SKILL.md files or relative paths within skill directories.
 *
 * URL forms:
 * - skill://<name> - Reads SKILL.md
 * - skill://<name>/<path> - Reads relative path within skill's baseDir
 * - skill://<namespace>/<name>[/<path>] - Same, for a collision-namespaced skill
 * - Any skill:// URI an MCP server advertises, when no loaded skill owns it - Reads that MCP resource
 */
import type * as fsTypes from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger, withTimeout } from "@oh-my-pi/pi-utils";
import { resolveContainedPath } from "../discovery/contained-path";
import { getActiveSkills, type Skill } from "../extensibility/skills";
import { MCPManager } from "../mcp/manager";
import skillDoc from "../prompts/internal-urls/skill.md" with { type: "text" };
import {
	buildDirectoryResource,
	contentTypeForPath,
	ensureCreatableWithinRoot,
	UrlContainmentError,
	validateRelativePath,
} from "./filesystem-resource";
import { readMcpResource } from "./mcp-protocol";
import type {
	InternalResource,
	InternalUrl,
	LocateOptions,
	ProtocolHandler,
	ResolveContext,
	SchemeHost,
	SchemeSpec,
	UrlCompletion,
} from "./types";

/** No loaded skill owns the URL's name; the only miss an MCP server may fill. */
class UnknownSkillError extends Error {}

/**
 * The skill a URL addresses is missing from disk. Also the case where the
 * snapshot is merely stale, so it earns one re-discovery retry — a missing
 * sub-path inside an existing skill does not, and stays a plain {@link Error}.
 */
class MissingSkillFileError extends Error {}

/**
 * Most an unknown `skill://` name waits for MCP (deferred startup included) to advertise it: long
 * enough for a healthy handshake, short enough that a hung server or its reconnect ladder cannot
 * hold a read of a typo'd or disabled skill name for the rest of the turn.
 */
const UNKNOWN_SKILL_MCP_WAIT_MS = 5_000;

/** A lookup miss explained by a stale snapshot rather than a genuine absence. */
function isStaleSkillLookup(error: unknown): boolean {
	return error instanceof UnknownSkillError || error instanceof MissingSkillFileError;
}

/** Missing target: retryable when the skill itself is addressed, fatal for a sub-path. */
function missingSkillFile(skillRoot: boolean, targetPath: string): Error {
	return skillRoot
		? new MissingSkillFileError(`File not found: ${targetPath}`)
		: new Error(`File not found: ${targetPath}`);
}

/**
 * Runs `attempt` against `context`'s skill snapshot (else the process one) and,
 * when it reports a stale-snapshot miss, re-discovers skills through the
 * caller's own {@link ResolveContext.reloadSkills} and runs it once more.
 *
 * The refresher travels on the context, never through process-global state, so
 * a lookup in one session can only ever retry against that session's skills —
 * a concurrently constructed helper or subagent session cannot swap the
 * snapshot underneath it. Without a refresher the miss stays fatal, and a
 * reload that returns the snapshot it was given (non-reloadable session) skips
 * the retry instead of repeating the same failure.
 */
async function withFreshSkills<T>(
	context: ResolveContext | undefined,
	attempt: (skills: readonly Skill[]) => Promise<T>,
): Promise<T> {
	const snapshot = context?.skills ?? getActiveSkills();
	try {
		return await attempt(snapshot);
	} catch (error) {
		const reload = context?.reloadSkills;
		if (!reload || !isStaleSkillLookup(error)) throw error;
		let fresh: readonly Skill[];
		try {
			fresh = await reload();
		} catch (reloadError) {
			logger.warn("skill:// rediscovery failed", { error: reloadError });
			throw error;
		}
		if (fresh === snapshot) throw error;
		return await attempt(fresh);
	}
}

/** Where a skill:// URL points, and whether it addressed the skill itself. */
interface SkillTarget {
	targetPath: string;
	/**
	 * The URL resolved to the skill's own instruction file or base directory
	 * (no relative sub-path), including a collision-namespaced
	 * `skill://<namespace>/<name>`. Only these misses mean the skill itself is
	 * gone, so only these earn a re-discovery retry.
	 */
	skillRoot: boolean;
	/**
	 * The snapshot's instruction file for the skill. A directory lookup stats
	 * {@link targetPath}, which can outlive a moved `SKILL.md`; checking this
	 * file proves the snapshot still describes a skill.
	 */
	instructionFile: string;
}

/**
 * Path a skill:// URL addresses, after traversal and plugin-root containment
 * checks. A bare URL addresses the skill's instruction file, or its base
 * directory when `directory` is set. The path may not exist; with `create`, a
 * missing plugin-skill target is only returned when writing it stays in the plugin root.
 */
async function skillTargetPath(
	url: InternalUrl,
	skills: readonly Skill[],
	directory: boolean,
	create = false,
): Promise<SkillTarget> {
	const skillName = url.rawHost || url.hostname;
	if (!skillName) {
		throw new Error("skill:// URL requires a skill name: skill://<name>");
	}

	let urlPath = url.pathname;
	let skill: Skill | undefined;
	if (urlPath.length > 1) {
		// A namespaced skill (`<plugin>/<name>`) spans the host and the first
		// path segment. Skill names never contain `/`, so an exact match here
		// is unambiguous and wins over reading `<name>` as a path relative to
		// a bare skill that happens to share the namespace's name.
		const slash = urlPath.indexOf("/", 1);
		const namespaced = `${skillName}/${decodeURIComponent(slash === -1 ? urlPath.slice(1) : urlPath.slice(1, slash))}`;
		skill = skills.find(s => s.name === namespaced);
		if (skill) urlPath = slash === -1 ? "" : urlPath.slice(slash);
	}
	skill ??= skills.find(s => s.name === skillName);
	if (!skill) {
		const available = skills.map(s => s.name);
		const availableStr = available.length > 0 ? available.join(", ") : "none";
		throw new UnknownSkillError(`Unknown skill: ${skillName}\nAvailable: ${availableStr}`);
	}

	const skillRoot = !urlPath || urlPath === "/";
	let resolvedPath: string;
	if (skillRoot) {
		resolvedPath = path.resolve(directory ? skill.baseDir : skill.filePath);
	} else {
		const relativePath = decodeURIComponent(urlPath.slice(1));
		validateRelativePath(relativePath, "skill");
		resolvedPath = path.resolve(skill.baseDir, relativePath);
		const resolvedBaseDir = path.resolve(skill.baseDir);
		if (!resolvedPath.startsWith(resolvedBaseDir + path.sep) && resolvedPath !== resolvedBaseDir) {
			throw new Error("Path traversal is not allowed");
		}
	}
	// Agent Plugin skills (§4.1): every target, including the bare instruction
	// file and base directory, must canonically resolve within the plugin root.
	// Symlinks may target other files inside the same package.
	const instructionFile = skill.filePath;
	if (!skill.containRoot) return { targetPath: resolvedPath, skillRoot, instructionFile };
	const escape = `skill:// path resolves outside the plugin root: ${url.href}`;
	const contained = await resolveContainedPath(skill.containRoot, resolvedPath);
	if (contained.status === "outside") throw new UrlContainmentError(escape);
	if (contained.status === "ok") return { targetPath: contained.realPath, skillRoot, instructionFile };
	if (create) {
		try {
			await ensureCreatableWithinRoot(resolvedPath, skill.containRoot, "skill", url.href);
		} catch (error) {
			// Same wording as the read path: the plugin root, not a per-skill root, bounds the package.
			throw error instanceof UrlContainmentError ? new UrlContainmentError(escape) : error;
		}
	}
	return { targetPath: resolvedPath, skillRoot, instructionFile };
}

/**
 * Handler for skill:// URLs.
 */
export class SkillProtocolHandler implements ProtocolHandler {
	readonly scheme = "skill";
	readonly spec: SchemeSpec = {
		backing: "file",
		selectors: "lines",
		immutable: true,
		unbounded: true,
		linkable: true,
	};

	/** Advertised only when loaded skills are readable through an active tool. */
	promptDoc(host: SchemeHost): string | undefined {
		return host.skillUriAccess ? skillDoc.trim() : undefined;
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		try {
			return await withFreshSkills(context, skills => this.#resolveAgainst(url, skills));
		} catch (error) {
			if (!(error instanceof UnknownSkillError)) throw error;
			// Loaded skills always win; otherwise serve the resource an MCP server advertises under
			// exactly this URI (Figma's `skill://figma/figma-use/SKILL.md`). Templates stay behind `mcp://`.
			// A deferred MCP startup that fails cannot change the diagnosis: the skill is still unknown.
			// Most such names are not MCP resources at all, so one budget caps deferred startup (which
			// never returns while a handshake hangs and the startup window is 0) plus the catalog wait.
			const deadline = Date.now() + UNKNOWN_SKILL_MCP_WAIT_MS;
			let mcpManager: MCPManager | undefined;
			try {
				mcpManager = await withTimeout(
					MCPManager.load(),
					UNKNOWN_SKILL_MCP_WAIT_MS,
					"MCP startup outlasted the unknown-skill wait",
					context?.signal,
				);
			} catch (loadError) {
				if (context?.signal?.aborted) throw loadError;
				logger.debug("MCP startup failed while resolving an unknown skill", { url: url.href, error: loadError });
				throw error;
			}
			const resource =
				mcpManager &&
				(await readMcpResource(mcpManager, url, {
					exact: true,
					waitMs: Math.max(0, deadline - Date.now()),
					signal: context?.signal,
				}));
			if (!resource) throw error;
			// The server, not a loaded skill, sizes this text: keep `read`'s normal result limits.
			return { ...resource, unbounded: false };
		}
	}

	/** Read the skill file or directory `url` addresses from one skill snapshot. */
	async #resolveAgainst(url: InternalUrl, skills: readonly Skill[]): Promise<InternalResource> {
		const { targetPath, skillRoot } = await skillTargetPath(url, skills, false);

		let stats: fsTypes.Stats;
		try {
			stats = await fs.stat(targetPath);
		} catch (error) {
			if (isEnoent(error)) throw missingSkillFile(skillRoot, targetPath);
			throw error;
		}

		if (stats.isDirectory()) {
			return buildDirectoryResource(url.href, targetPath);
		}
		if (!stats.isFile()) {
			throw new Error(`skill:// URL must resolve to a file or directory: ${url.href}`);
		}

		const content = await Bun.file(targetPath).text();
		return {
			url: url.href,
			content,
			contentType: contentTypeForPath(targetPath),
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: targetPath,
			notes: [],
		};
	}

	/**
	 * Skill file or directory; `options.directory` maps a bare `skill://<name>` to the skill base dir.
	 * Null for a missing entry (or dangling symlink) without `create`, plugin skill or not, and for a
	 * name no loaded skill owns while MCP is available unless `options.localOnly`: an MCP server may
	 * advertise the URL, which {@link resolve} settles (its servers may still be connecting).
	 * A miss on the skill itself re-discovers skills from disk once through the caller's
	 * {@link ResolveContext.reloadSkills}, so a skill added or moved mid-session is found without a restart.
	 */
	async locate(url: InternalUrl, context?: ResolveContext, options?: LocateOptions): Promise<string | null> {
		try {
			return await withFreshSkills(context, skills => this.#locateAgainst(url, skills, options));
		} catch (error) {
			// Exhausted the retry: the addressed skill really is gone.
			if (error instanceof MissingSkillFileError) return null;
			if (error instanceof UnknownSkillError && !options?.localOnly && MCPManager.available()) return null;
			throw error;
		}
	}

	/** Locate `url` against one skill snapshot; a miss on the skill itself throws to trigger the retry. */
	async #locateAgainst(url: InternalUrl, skills: readonly Skill[], options?: LocateOptions): Promise<string | null> {
		const { targetPath, skillRoot, instructionFile } = await skillTargetPath(
			url,
			skills,
			options?.directory === true,
			options?.create === true,
		);
		if (options?.create) return targetPath;
		if (skillRoot && options?.directory === true) {
			// A base directory outlives a moved `SKILL.md`: statting it alone would
			// keep serving a directory the snapshot no longer describes. Missing
			// instruction file means the skill moved, so the lookup must retry.
			try {
				await fs.stat(instructionFile);
			} catch (error) {
				if (!isEnoent(error)) throw error;
				throw missingSkillFile(true, instructionFile);
			}
		}
		try {
			await fs.stat(targetPath);
			return targetPath;
		} catch (error) {
			if (!isEnoent(error)) throw error;
			if (skillRoot) throw missingSkillFile(true, targetPath);
			return null;
		}
	}

	async complete(): Promise<UrlCompletion[]> {
		return getActiveSkills().map(skill => ({
			value: skill.name,
			...(skill.description ? { description: skill.description } : {}),
		}));
	}
}
