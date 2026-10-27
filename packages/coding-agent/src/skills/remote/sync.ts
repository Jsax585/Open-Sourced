/**
 * Index mutation for remote skills: `add`, `sync`, `remove`, `list`.
 *
 * These are the only operations that touch the network during setup. Discovery
 * reads the index they produce and never fetches.
 */
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { validateAgentSkillFrontmatter } from "../../discovery/agent-plugin-format";
import {
	MAX_SKILL_DOCUMENT_BYTES,
	MAX_SKILL_FILES,
	listRemoteTree,
	parseRemoteSourceSpec,
	readRemoteFile,
	repositorySkillPath,
	resolveRemoteCommit,
	type FetchFn,
} from "./source";
import {
	fileExists,
	findProjectRemoteSkillIndex,
	loadRemoteSkillDescriptors,
	projectRemoteSkillIndexPath,
	readRemoteSkillIndex,
	userRemoteSkillIndexPath,
	writeRemoteSkillIndex,
	type RemoteSkillIndexEntry,
} from "./store";
import { RemoteSkillError, type RemoteSkillDescriptor } from "./types";

export interface RemoteIndexTarget {
	/** Index file to mutate. */
	file: string;
	/** Level stored on descriptors (informational; the provider derives it from the file). */
	level: "user" | "project";
}

/** Resolve the index file for `--global` / project scope. Project is created on demand. */
export async function resolveRemoteIndexTarget(options: {
	cwd: string;
	global: boolean;
	agentDir?: string;
}): Promise<RemoteIndexTarget> {
	if (options.global) return { file: userRemoteSkillIndexPath(options.agentDir), level: "user" };
	return {
		file: (await findProjectRemoteSkillIndex(options.cwd)) ?? projectRemoteSkillIndexPath(options.cwd),
		level: "project",
	};
}

export interface RemoteAddOptions {
	cwd: string;
	global: boolean;
	agentDir?: string;
	fetch?: FetchFn;
	signal?: AbortSignal;
}

export interface RemoteAddResult {
	file: string;
	added: string[];
	updated: string[];
	/** Commit that every added/updated skill was pinned to. */
	commit: string;
}

/** Directory the spec compares a skill's `name` against: its own dir, or the repository at the root. */
function expectedDirName(repository: string, directory: string): string {
	return directory === "" ? repository.split("/")[1]! : path.posix.basename(directory);
}

/** Repository directory of a listed `SKILL.md`; `""` for a root-level skill. */
function skillDirectory(file: string): string {
	const dir = path.posix.dirname(file);
	return dir === "." ? "" : dir;
}

/**
 * Register every skill in one GitHub subdirectory.
 *
 * One tree listing enumerates the skills, then one `SKILL.md` per skill is read
 * for its description. Each descriptor stores the resolved commit, so later
 * task reads are independent of branch movement.
 */
export async function addRemoteSkills(spec: string, options: RemoteAddOptions): Promise<RemoteAddResult> {
	const parsed = parseRemoteSourceSpec(spec);
	const commit = await resolveRemoteCommit(parsed.repository, parsed.ref, {
		fetch: options.fetch,
		signal: options.signal,
	});
	const tree = await listRemoteTree(parsed.repository, commit, parsed.directory, {
		fetch: options.fetch,
		signal: options.signal,
	});
	const files = tree.filter(file => file === "SKILL.md" || file.endsWith("/SKILL.md"));
	if (files.length === 0) {
		const where = parsed.directory === "" ? "the repository root" : `"${parsed.directory}"`;
		throw new RemoteSkillError("INVALID_SOURCE", `no SKILL.md under ${where} of ${parsed.repository}@${commit}`);
	}
	const target = await resolveRemoteIndexTarget(options);
	const index = await readRemoteSkillIndex(target.file);
	const skills: Record<string, RemoteSkillDescriptor> = { ...index.skills };
	const added: string[] = [];
	const updated: string[] = [];
	for (const file of files) {
		const directory = skillDirectory(file);
		const bytes = await readRemoteFile(parsed.repository, commit, file, {
			fetch: options.fetch,
			signal: options.signal,
			maxBytes: MAX_SKILL_DOCUMENT_BYTES,
		});
		if (bytes === null) {
			throw new RemoteSkillError("NOT_FOUND", `${parsed.repository}@${commit}:${file}`);
		}
		const text = new TextDecoder().decode(bytes);
		let frontmatter: Record<string, unknown>;
		try {
			frontmatter = parseFrontmatter(text, {
				source: `${parsed.repository}:${file}`,
				level: "fatal",
				repair: false,
				rawKeys: true,
			}).frontmatter;
		} catch (error) {
			throw new RemoteSkillError("INVALID_SKILL", `${file}: malformed YAML frontmatter (${String(error)})`);
		}
		const violation = validateAgentSkillFrontmatter(frontmatter, expectedDirName(parsed.repository, directory));
		if (violation !== null) throw new RemoteSkillError("INVALID_SKILL", `${file}: ${violation}`);
		// Persist the identity the validator checked (trimmed, NFKC-normalized), not the
		// raw scalar: `name: " pdf "` passes validation for directory `pdf`.
		const name = String(frontmatter.name).trim().normalize("NFKC");
		const prefix = directory === "" ? "" : `${directory}/`;
		const manifest = tree.filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length));
		if (manifest.length > MAX_SKILL_FILES) {
			throw new RemoteSkillError(
				"RESOURCE_LIMIT_EXCEEDED",
				`${file}: ${manifest.length} files exceed the ${MAX_SKILL_FILES}-file manifest limit`,
			);
		}
		const existing = Object.hasOwn(skills, name) ? skills[name] : undefined;
		if (existing && (existing.repository !== parsed.repository || existing.directory !== directory)) {
			throw new RemoteSkillError(
				"INVALID_SOURCE",
				`${name} is already registered from ${existing.repository}#${existing.directory}; remove it first`,
			);
		}
		skills[name] = {
			name,
			description: (frontmatter.description as string).trim(),
			origin: "github",
			repository: parsed.repository,
			directory,
			ref: parsed.ref,
			commit,
			files: manifest.sort(),
		};
		(existing ? updated : added).push(name);
	}
	await writeRemoteSkillIndex(target.file, { version: 1, skills });
	return { file: target.file, added, updated, commit };
}

export interface RemoteSkillChange {
	name: string;
	from: string;
	to: string;
}

/**
 * Re-resolve the configured ref of each registered skill and repin it.
 *
 * An empty `names` list means every skill, matching the CLI's `remote sync
 * [name...]`. A skill whose `ref` is already a commit is skipped: an explicit
 * commit is a request for that exact revision, not a pointer to follow.
 */
export async function syncRemoteSkills(options: {
	cwd: string;
	global?: boolean;
	names?: string[];
	agentDir?: string;
	fetch?: FetchFn;
	signal?: AbortSignal;
}): Promise<{ file: string; changes: RemoteSkillChange[] }> {
	const targets: RemoteIndexTarget[] = [];
	if (options.global === true) {
		targets.push({ file: userRemoteSkillIndexPath(options.agentDir), level: "user" });
	} else {
		const projectFile = await findProjectRemoteSkillIndex(options.cwd);
		if (projectFile) targets.push({ file: projectFile, level: "project" });
		if (options.global !== false) {
			const userFile = userRemoteSkillIndexPath(options.agentDir);
			if (await fileExists(userFile)) targets.push({ file: userFile, level: "user" });
		}
	}
	if (targets.length === 0) throw new RemoteSkillError("NOT_FOUND", "no remote skill index found");

	const selected = options.names && options.names.length > 0 ? new Set(options.names) : undefined;
	const indexes = await Promise.all(targets.map(target => readRemoteSkillIndex(target.file)));
	if (selected) {
		const available = new Set(indexes.flatMap(index => Object.keys(index.skills)));
		const missing = options.names!.filter(name => !available.has(name));
		if (missing.length > 0) throw new RemoteSkillError("NOT_FOUND", `not registered: ${missing.join(", ")}`);
	}
	// One commit resolution per repository/ref: a collection shares both, and each
	// lookup costs a GitHub quota unit.
	const commits = new Map<string, Promise<string>>();
	const resolveCommit = (repository: string, ref: string): Promise<string> => {
		const key = `${repository}\u0000${ref}`;
		let pending = commits.get(key);
		if (!pending) {
			pending = resolveRemoteCommit(repository, ref, { fetch: options.fetch, signal: options.signal });
			commits.set(key, pending);
		}
		return pending;
	};
	const changes: RemoteSkillChange[] = [];
	for (const [targetIndex, target] of targets.entries()) {
		const index = indexes[targetIndex]!;
		const skills: Record<string, RemoteSkillDescriptor> = { ...index.skills };
		let targetChanges = 0;
		for (const [name, descriptor] of Object.entries(index.skills)) {
			if (selected && !selected.has(name)) continue;
			const commit = await resolveCommit(descriptor.repository, descriptor.ref);
			if (commit === descriptor.commit) continue;
			const bytes = await readRemoteFile(descriptor.repository, commit, repositorySkillPath(descriptor), {
				fetch: options.fetch,
				signal: options.signal,
				maxBytes: MAX_SKILL_DOCUMENT_BYTES,
			});
			if (bytes === null) {
				throw new RemoteSkillError(
					"NOT_FOUND",
					`${descriptor.repository}@${commit}:${repositorySkillPath(descriptor)}`,
				);
			}
			const { frontmatter } = parseFrontmatter(new TextDecoder().decode(bytes), {
				source: `${descriptor.repository}:${repositorySkillPath(descriptor)}`,
				level: "fatal",
				repair: false,
				rawKeys: true,
			});
			const violation = validateAgentSkillFrontmatter(
				frontmatter,
				expectedDirName(descriptor.repository, descriptor.directory),
			);
			if (violation !== null) throw new RemoteSkillError("INVALID_SKILL", `${name}: ${violation}`);
			skills[name] = {
				...descriptor,
				commit,
				description: (frontmatter.description as string).trim(),
			};
			changes.push({ name, from: descriptor.commit, to: commit });
			targetChanges++;
		}
		if (targetChanges > 0) await writeRemoteSkillIndex(target.file, { version: 1, skills });
	}
	return { file: targets[targets.length - 1]!.file, changes };
}

/**
 * Remove skills from one index by name; returns the names actually removed.
 *
 * Scope matches the CLI flag: `-g` addresses the user index only, otherwise the
 * project index only, so a project removal never unregisters a user copy.
 */
export async function removeRemoteSkills(options: {
	cwd: string;
	global?: boolean;
	names: string[];
	agentDir?: string;
}): Promise<{ removed: string[]; files: string[] }> {
	if (options.names.length === 0) throw new RemoteSkillError("INVALID_SOURCE", "no skill names given");
	const file =
		options.global === true
			? userRemoteSkillIndexPath(options.agentDir)
			: await findProjectRemoteSkillIndex(options.cwd);
	if (!file) throw new RemoteSkillError("NOT_FOUND", "no project remote skill index found");
	const index = await readRemoteSkillIndex(file);
	const wanted = new Set(options.names);
	const skills: Record<string, RemoteSkillDescriptor> = {};
	const removed: string[] = [];
	for (const [name, descriptor] of Object.entries(index.skills)) {
		if (wanted.has(name)) {
			removed.push(name);
			continue;
		}
		skills[name] = descriptor;
	}
	const missing = options.names.filter(name => !removed.includes(name));
	if (missing.length > 0) throw new RemoteSkillError("NOT_FOUND", `not registered: ${missing.join(", ")}`);
	await writeRemoteSkillIndex(file, { version: 1, skills });
	return { removed, files: [file] };
}

/** Registered descriptors, project shadowing user, plus warnings for skipped entries. */
export async function listRemoteSkills(options: {
	cwd: string;
	agentDir?: string;
}): Promise<{ entries: RemoteSkillIndexEntry[]; warnings: string[] }> {
	return await loadRemoteSkillDescriptors(options.cwd, options.agentDir ?? getAgentDir());
}
