/**
 * Managed-skills primitives for the experimental auto-learn feature.
 *
 * Managed skills are auto-generated/enhanced `SKILL.md` files kept in isolated
 * omp-owned directories separate from user-authored skills
 * (`~/.omp/agent/skills`, `<repo>/.omp/skills`). Two scopes exist:
 * - global: `~/.omp/agent/managed-skills`, discovered in every session;
 * - project: `~/.omp/agent/project-managed-skills/<project-key>`, discovered
 *   only for sessions in that project. The store lives under the agent dir,
 *   never inside the repository.
 * They are discovered and surfaced like normal skills, but every write here is
 * confined to {@link getManagedSkillsRoot} — auto-management can never touch
 * authored skills.
 */
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { encodeProjectStateKey, getAgentDir, isEnoent, resolveEquivalentPath } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

/** Provider id stamped on discovered managed skills (distinguishes them from authored). */
export const MANAGED_SKILLS_PROVIDER_ID = "omp-managed";

/** Hard cap on a managed SKILL.md body to keep generated skills bounded. */
export const MAX_MANAGED_SKILL_BYTES = 64_000;

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Where a managed skill lives: every session (`global`) or one project's store (`project`). */
export type ManagedSkillScope = "global" | "project";

/** A resolved managed-skill store. A project store is keyed by the session cwd's project. */
export type ManagedSkillLocation = { readonly scope: "global" } | { readonly scope: "project"; readonly cwd: string };

export const GLOBAL_MANAGED_SKILLS: ManagedSkillLocation = { scope: "global" };

/** Build the store for a tool call: `project` binds the session cwd, anything else is global. */
export function managedSkillLocation(scope: ManagedSkillScope | undefined, cwd: string): ManagedSkillLocation {
	return scope === "project" ? { scope, cwd } : GLOBAL_MANAGED_SKILLS;
}

/**
 * Scope a mutation targets. An explicit scope wins; `create` defaults to
 * global. An unscoped `update`/`delete` targets the copy discovery shows: the
 * project store when it holds a real skill directory with a `SKILL.md` file
 * (it shadows a same-named global one), else global. Skill listings omit
 * scope, so this keeps an edit from landing on a hidden global copy. A stray
 * empty or symlinked project directory is not a skill and does not redirect.
 */
export async function resolveManagedSkillScope(
	action: "create" | "update" | "delete",
	name: string,
	scope: ManagedSkillScope | undefined,
	cwd: string,
): Promise<ManagedSkillScope> {
	if (scope) return scope;
	const normalized = name.trim().toLowerCase();
	if (action === "create" || !isValidManagedSkillName(normalized)) return "global";
	const skillDir = path.join(getProjectManagedSkillsDir(cwd), normalized);
	const lstatOrNull = (p: string) =>
		fs.lstat(p).catch(err => {
			if (isEnoent(err) || (err instanceof Error && "code" in err && err.code === "ENOTDIR")) return null;
			throw err;
		});
	const dirStat = await lstatOrNull(skillDir);
	if (!dirStat?.isDirectory()) return "global";
	const fileStat = await lstatOrNull(path.join(skillDir, "SKILL.md"));
	return fileStat?.isFile() ? "project" : "global";
}

/** Resolve the isolated global managed-skills directory (`~/.omp/agent/managed-skills`). */
export function getManagedSkillsDir(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "managed-skills");
}

/** Parent of every project store (`~/.omp/agent/project-managed-skills`). */
export function getProjectManagedSkillsBaseDir(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "project-managed-skills");
}

/**
 * Canonical directory that identifies the project of `cwd`: the primary
 * checkout of its repository (linked worktrees share it), else `cwd` itself.
 * Same key as the Hindsight project bank, so a `learn` lesson and its paired
 * skill land in the same project, and skills learned in omp's ephemeral
 * session/task worktrees still load in the primary checkout and later worktrees.
 */
export function resolveManagedSkillsProjectRoot(cwd: string): string {
	const resolved = path.resolve(cwd);
	return resolveEquivalentPath(vcs.repo(resolved)?.primaryRoot() ?? resolved);
}

/** Project store for `cwd` (`~/.omp/agent/project-managed-skills/<project-key>`). */
export function getProjectManagedSkillsDir(cwd: string, agentDir: string = getAgentDir()): string {
	return path.join(
		getProjectManagedSkillsBaseDir(agentDir),
		encodeProjectStateKey(resolveManagedSkillsProjectRoot(cwd)),
	);
}

/** Directory that holds the skills of `location`. */
export function getManagedSkillsRoot(location: ManagedSkillLocation): string {
	return location.scope === "project" ? getProjectManagedSkillsDir(location.cwd) : getManagedSkillsDir();
}

/**
 * Validate + normalize a managed-skill name. Throws on anything outside the
 * strict allowlist so a bad name can never escape its managed root
 * (blocks `..`, slashes, empty, and uppercase).
 */
export function sanitizeSkillName(raw: string): string {
	const name = raw.trim().toLowerCase();
	if (!SKILL_NAME_PATTERN.test(name)) {
		throw new Error(
			`Invalid skill name "${raw}". Use lowercase letters, digits, and hyphens (1-64 chars, starting with a letter or digit).`,
		);
	}
	return name;
}

/**
 * Whether `name` is a safe managed-skill name (the exact post-sanitize shape).
 * Used to validate names read from disk at discovery time — a managed
 * `SKILL.md` whose `frontmatter.name` was not produced by `sanitizeSkillName`
 * (e.g. hand-placed) must not render unescaped into the system prompt.
 */
export function isValidManagedSkillName(name: string): boolean {
	return SKILL_NAME_PATTERN.test(name);
}

/**
 * Neutralize a machine-generated managed-skill description so it cannot break
 * out of the system prompt's `<skills>` listing. Managed descriptions are
 * generated from prior task content and persist across sessions, so this is a
 * trust boundary: strip control/format chars, angle brackets (`<system-directive>`
 * / `</skills>`), and Markdown fence delimiters (backticks, `~~~`), then collapse
 * to a single line. Applied on BOTH write and read so existing files are safe too.
 */
export function sanitizeManagedDescription(raw: string): string {
	return raw
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/[<>`]/g, "")
		.replace(/~{2,}/g, "~")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Serialize the minimal `name`/`description` frontmatter block via the repo's
 * YAML helper (round-trips through `parseFrontmatter`).
 */
export function toSkillFrontmatter(name: string, description: string): string {
	const frontmatter = YAML.stringify(
		{ name, description: sanitizeManagedDescription(description) },
		null,
		2,
	).trimEnd();
	return `---\n${frontmatter}\n---\n`;
}

export interface WriteManagedSkillInput {
	action: "create" | "update";
	name: string;
	description: string;
	body: string;
}

/**
 * Serialize create/update/delete on the same skill. Both tools are
 * non-exclusive, so a parallel tool batch in one turn can run two mutations on
 * the same skill at once (e.g. an update observing the file mid-delete). This
 * per-skill-directory promise chain runs same-skill mutations in submission
 * order while different skills (other names or other scopes) still proceed in
 * parallel. In-process only; cross-process races are out of scope.
 */
const skillMutationChains = new Map<string, Promise<unknown>>();
function serializeSkillMutation<T>(skillDir: string, op: () => Promise<T>): Promise<T> {
	const prev = skillMutationChains.get(skillDir) ?? Promise.resolve();
	const run = prev.then(op, op);
	const guarded = run.catch(() => {});
	skillMutationChains.set(skillDir, guarded);
	void guarded.finally(() => {
		if (skillMutationChains.get(skillDir) === guarded) skillMutationChains.delete(skillDir);
	});
	return run;
}

/**
 * Reject when a managed-skills root (or, for a project store, its parent) is a
 * symlink. lstat on a child follows intermediate components, so a symlinked
 * root would let an otherwise valid name write/delete outside the isolated
 * directory (e.g. onto authored skills). Checked before composing any child
 * path.
 */
async function assertManagedRootSafe(location: ManagedSkillLocation, root: string): Promise<void> {
	const guarded = location.scope === "project" ? [getProjectManagedSkillsBaseDir(), root] : [root];
	for (const dir of guarded) {
		const dirStat = await fs.lstat(dir).catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (dirStat?.isSymbolicLink()) {
			throw new Error("The managed-skills root is a symlink; refusing to operate outside the managed directory.");
		}
	}
}

const UPDATE_FILE_OPEN_FLAGS = fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW;

function assertManagedSkillFileSafeForUpdate(name: string, fileStat: Stats): void {
	if (!fileStat.isFile()) {
		throw new Error(`Managed skill "${name}" SKILL.md is not a regular file; refusing to overwrite it.`);
	}
	if (fileStat.nlink > 1) {
		throw new Error(
			`Managed skill "${name}" SKILL.md has ${fileStat.nlink} hard links; refusing to overwrite a file that may be user-authored elsewhere.`,
		);
	}
}

async function openManagedSkillFileForUpdate(name: string, file: string) {
	try {
		return await fs.open(file, UPDATE_FILE_OPEN_FLAGS);
	} catch (err) {
		if ((err as { code?: string }).code === "ELOOP") {
			throw new Error(`Managed skill "${name}" SKILL.md is a symlink; refusing to overwrite it.`);
		}
		throw err;
	}
}

/** Create or update a managed `SKILL.md` in `location` (default: global). Returns the resolved file path. */
export async function writeManagedSkill(
	input: WriteManagedSkillInput,
	location: ManagedSkillLocation = GLOBAL_MANAGED_SKILLS,
): Promise<{ path: string }> {
	const name = sanitizeSkillName(input.name);
	const description = sanitizeManagedDescription(input.description);
	const body = input.body.trim();
	// Reject empty content: an all-whitespace/control description sanitizes to ""
	// and the `requireDescription` discovery scan then silently drops the skill,
	// so the tool would report success for a skill that never appears.
	if (!description) {
		throw new Error(`Managed skill "${name}" needs a non-empty description.`);
	}
	if (!body) {
		throw new Error(`Managed skill "${name}" needs a non-empty body.`);
	}
	const content = `${toSkillFrontmatter(name, description)}\n${body}\n`;
	// Cap the UTF-8 byte size of the FINAL file (body + description + frontmatter),
	// not the UTF-16 code-unit length of the body alone.
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > MAX_MANAGED_SKILL_BYTES) {
		throw new Error(
			`Managed skill is ${bytes} bytes; the limit is ${MAX_MANAGED_SKILL_BYTES}. Trim the body or description.`,
		);
	}
	const root = getManagedSkillsRoot(location);
	const dir = path.join(root, name);
	const file = path.join(dir, "SKILL.md");
	return serializeSkillMutation(dir, async () => {
		await assertManagedRootSafe(location, root);
		// Reject a symlinked skill directory: an intermediate symlink would let the
		// write escape the isolated managed root. lstat does not follow the final
		// component, so a symlinked `dir` is caught here.
		const dirStat = await fs.lstat(dir).catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (dirStat?.isSymbolicLink()) {
			throw new Error(
				`Managed skill "${name}" resolves through a symlink; refusing to write outside the managed directory.`,
			);
		}
		if (input.action === "create") {
			await fs.mkdir(dir, { recursive: true });
			// O_CREAT|O_EXCL ("wx"): atomic create that fails if the file already
			// exists (closing the check-then-write race) and refuses a symlinked SKILL.md.
			try {
				await fs.writeFile(file, content, { flag: "wx" });
			} catch (err) {
				if ((err as { code?: string }).code === "EEXIST") {
					throw new Error(
						`Managed skill "${name}" already exists in the ${location.scope} scope. Use action "update" to change it.`,
					);
				}
				throw err;
			}
			return { path: file };
		}
		// update: the file must already exist, be a plain managed file, and must
		// not share an inode with a user-authored file via hard link. Open the
		// checked file handle before truncating so a path swap after lstat cannot
		// redirect the write into a symlink or newly hard-linked target.
		const fileStat = await fs.lstat(file).catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (fileStat === null) {
			throw new Error(
				`Managed skill "${name}" does not exist in the ${location.scope} scope. Use action "create" to add it.`,
			);
		}
		if (fileStat.isSymbolicLink()) {
			throw new Error(`Managed skill "${name}" SKILL.md is a symlink; refusing to overwrite it.`);
		}
		assertManagedSkillFileSafeForUpdate(name, fileStat);
		const handle = await openManagedSkillFileForUpdate(name, file);
		try {
			const openStat = await handle.stat();
			assertManagedSkillFileSafeForUpdate(name, openStat);
			await handle.truncate(0);
			await handle.writeFile(content);
		} finally {
			await handle.close();
		}
		return { path: file };
	});
}

/** Delete a managed skill directory from `location` (default: global). Throws when it does not exist. */
export async function deleteManagedSkill(
	name: string,
	location: ManagedSkillLocation = GLOBAL_MANAGED_SKILLS,
): Promise<void> {
	const safe = sanitizeSkillName(name);
	const root = getManagedSkillsRoot(location);
	const dir = path.join(root, safe);
	await serializeSkillMutation(dir, async () => {
		await assertManagedRootSafe(location, root);
		// Refuse to follow a symlinked skill directory (rm would delete the target).
		const dirStat = await fs.lstat(dir).catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (dirStat?.isSymbolicLink()) {
			throw new Error(`Managed skill "${safe}" is a symlink; refusing to delete outside the managed directory.`);
		}
		try {
			await fs.rm(dir, { recursive: true });
		} catch (err) {
			if (isEnoent(err)) {
				throw new Error(`Managed skill "${safe}" does not exist in the ${location.scope} scope.`);
			}
			throw err;
		}
	});
}
