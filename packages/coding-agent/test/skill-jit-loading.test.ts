import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	cfgSkillsCustomDirectories,
	cfgSkillsEnableAgentsProject,
	cfgSkillsEnableAgentsUser,
	cfgSkillsEnableClaudeProject,
	cfgSkillsEnableClaudeUser,
	cfgSkillsEnableCodexUser,
	cfgSkillsEnablePiProject,
	cfgSkillsEnablePiUser,
} from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import {
	getActiveSkills,
	resetActiveSkillsForTests,
	setActiveSkills,
	type Skill,
} from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { SkillProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol";
import type { ResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionTools, type SessionToolsHost } from "@oh-my-pi/pi-coding-agent/session/session-tools";

function makeSkillMd(name: string, dir: string) {
	return `---\nname: ${name}\ndescription: ${name} skill.\n---\n\n# ${name} from ${dir}\n`;
}

/**
 * Host stub: a `main` session whose only interesting capability is skill
 * discovery. `onDiscover` runs once per discovery pass — `effectiveExtensionRoots`
 * is read exactly once inside it, so it counts passes without mocking modules.
 */
function hostFor(cwd: string, settings: Settings, onDiscover: () => void = () => {}): SessionToolsHost {
	return {
		agent: new Agent(),
		sessionManager: SessionManager.inMemory(cwd),
		settings,
		effectiveExtensionRoots: () => {
			onDiscover();
			return {} as never;
		},
		modelRegistry: {} as never,
		extensionRunner: () => undefined,
		clientBridge: () => undefined,
		agentKind: () => "main",
		isDisposed: () => false,
		isStreaming: () => false,
		steeringArrivalSignal: () => new AbortController().signal,
		steeringArrivalSeq: () => 0,
		steeringArrivalAdmitted: () => undefined,
		steeringArrivalRelease: () => {},
		queuedMessageCount: () => 0,
		planModeEnabled: () => false,
		model: () => undefined,
		memoryBackendSession: () => ({}) as never,
		clearInheritedProviderPromptCacheKey: () => {},
		clearMemoryPromotionSnapshot: () => {},
		captureMemoryPromotionSnapshot: () => {},
		emitNotice: () => {},
		notifyCommandMetadataChanged: () => {},
		localProtocolOptions: () => ({}),
		evalPreludes: () => [],
		sessionAgents: () => [],
		waitForUser: dialog => dialog(),
	};
}

describe("skill:// just-in-time discovery", () => {
	const tempDirs: string[] = [];
	const handler = new SkillProtocolHandler();

	async function tempRoot(): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-jit-skills-"));
		tempDirs.push(dir);
		return dir;
	}

	async function writeSkill(root: string, name: string): Promise<string> {
		const dir = path.join(root, name);
		await fs.mkdir(dir, { recursive: true });
		const filePath = path.join(dir, "SKILL.md");
		await Bun.write(filePath, makeSkillMd(name, root));
		return filePath;
	}

	/** A session that discovers skills from `root` only, seeded with its start-up snapshot. */
	async function sessionFor(root: string) {
		const settings = Settings.isolated();
		// Only the test root contributes: a developer's own user skills must not
		// leak into these assertions.
		for (const flag of [
			cfgSkillsEnableCodexUser,
			cfgSkillsEnableClaudeUser,
			cfgSkillsEnableClaudeProject,
			cfgSkillsEnablePiUser,
			cfgSkillsEnablePiProject,
			cfgSkillsEnableAgentsUser,
			cfgSkillsEnableAgentsProject,
		]) {
			flag.set(settings, false);
		}
		cfgSkillsCustomDirectories.set(settings, [root]);
		let discoveries = 0;
		const tools = new SessionTools(
			hostFor(root, settings, () => discoveries++),
			{
				baseSystemPrompt: [],
				rebuildSystemPrompt: async toolNames => ({ systemPrompt: [toolNames.join(",")] }),
			},
		);
		const initial = await tools.reloadSkills();
		const context = (): ResolveContext => ({
			cwd: root,
			settings,
			skills: tools.skills,
			reloadSkills: () => tools.reloadSkills(),
		});
		return { tools, initial, context, discoveries: () => discoveries };
	}

	afterEach(async () => {
		resetActiveSkillsForTests();
		for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
		tempDirs.length = 0;
	});

	it("resolves a skill created after the session snapshot", async () => {
		const root = await tempRoot();
		await writeSkill(root, "first-skill");
		const session = await sessionFor(root);
		expect(session.initial.map(s => s.name)).toContain("first-skill");

		const addedPath = await writeSkill(root, "added-skill");

		const resource = await handler.resolve(parseInternalUrl("skill://added-skill"), session.context());
		expect(resource.sourcePath).toBe(addedPath);
		expect(resource.content).toContain(`from ${root}`);
	});

	it("resolves a skill whose instruction file moved after the snapshot", async () => {
		const root = await tempRoot();
		const originalPath = await writeSkill(root, "packed-skill");
		const session = await sessionFor(root);

		const movedPath = path.join(root, "relocated-skill", "SKILL.md");
		await fs.mkdir(path.dirname(movedPath), { recursive: true });
		await fs.rename(originalPath, movedPath);

		// The snapshot still maps `packed-skill` to the vanished path; the
		// re-discovery must re-read the directory, not serve the stale mapping.
		const resource = await handler.resolve(parseInternalUrl("skill://packed-skill"), session.context());
		expect(resource.sourcePath).toBe(movedPath);
		expect(resource.content).toContain(`from ${root}`);
	});

	it("finds a moved skill through locate as well as resolve", async () => {
		const root = await tempRoot();
		const originalPath = await writeSkill(root, "locate-skill");
		const session = await sessionFor(root);

		const movedPath = path.join(root, "moved-locate-skill", "SKILL.md");
		await fs.mkdir(path.dirname(movedPath), { recursive: true });
		await fs.rename(originalPath, movedPath);

		const located = await handler.locate(parseInternalUrl("skill://locate-skill"), session.context());
		expect(located).toBe(movedPath);
	});

	it("reports a deleted skill as unknown rather than as a vanished file", async () => {
		const root = await tempRoot();
		await writeSkill(root, "doomed-skill");
		const session = await sessionFor(root);

		await fs.rm(path.join(root, "doomed-skill"), { recursive: true, force: true });

		await expect(handler.resolve(parseInternalUrl("skill://doomed-skill"), session.context())).rejects.toThrow(
			/Unknown skill: doomed-skill/,
		);
	});

	it("keeps the miss fatal when no session-specific reload is supplied", async () => {
		const root = await tempRoot();
		await writeSkill(root, "solo-skill");
		const session = await sessionFor(root);

		await fs.rm(path.join(root, "solo-skill"), { recursive: true, force: true });

		// No reload hook: the stale mapping surfaces as a missing file.
		await expect(
			handler.resolve(parseInternalUrl("skill://solo-skill"), { cwd: root, skills: session.initial }),
		).rejects.toThrow(/File not found/);
	});

	it("does not re-discover for a missing sub-path inside an existing skill", async () => {
		const root = await tempRoot();
		const skillPath = await writeSkill(root, "subpath-skill");
		let reloads = 0;
		const skills: Skill[] = [
			{
				name: "subpath-skill",
				description: "subpath-skill skill.",
				filePath: skillPath,
				baseDir: path.dirname(skillPath),
				source: "custom",
			},
		];
		const context: ResolveContext = {
			cwd: root,
			skills,
			reloadSkills: async () => {
				reloads++;
				return await Promise.resolve(skills);
			},
		};

		await expect(handler.resolve(parseInternalUrl("skill://subpath-skill/absent.md"), context)).rejects.toThrow(
			/File not found/,
		);
		expect(reloads).toBe(0);
	});

	it("re-discovering a namespaced skill whose file moved", async () => {
		const root = await tempRoot();
		const staleDir = path.join(root, "stale");
		await fs.mkdir(staleDir, { recursive: true });
		const freshDir = path.join(root, "fresh");
		await fs.mkdir(freshDir, { recursive: true });
		const freshPath = path.join(freshDir, "SKILL.md");
		await Bun.write(freshPath, makeSkillMd("namespaced-skill", root));

		const namespaced = "plugin/namespaced-skill";
		const stale: Skill[] = [
			{
				name: namespaced,
				description: "namespaced-skill skill.",
				filePath: path.join(staleDir, "SKILL.md"),
				baseDir: staleDir,
				source: "custom",
			},
		];
		const fresh: Skill[] = [{ ...stale[0]!, filePath: freshPath, baseDir: freshDir }];
		let reloads = 0;
		const context: ResolveContext = {
			cwd: root,
			skills: stale,
			reloadSkills: async () => {
				reloads++;
				return await Promise.resolve(fresh);
			},
		};

		// `skill://plugin/namespaced-skill` consumes the namespace segment: the
		// bare skill is gone from the stale path, so the miss is retryable.
		const resource = await handler.resolve(parseInternalUrl("skill://plugin/namespaced-skill"), context);
		expect(resource.sourcePath).toBe(freshPath);
		expect(reloads).toBe(1);
	});

	it("never retries a miss against another session's skills", async () => {
		const rootA = await tempRoot();
		const rootB = await tempRoot();
		await writeSkill(rootA, "shared-skill");
		await writeSkill(rootB, "shared-skill");
		const sessionA = await sessionFor(rootA);
		const sessionB = await sessionFor(rootB);
		const addedInA = await writeSkill(rootA, "only-in-a");

		// B is constructed after A: A's lookups must still re-discover A's roots.
		const resource = await handler.resolve(parseInternalUrl("skill://only-in-a"), sessionA.context());
		expect(resource.sourcePath).toBe(addedInA);

		// And a name B alone owns stays unknown to A.
		await writeSkill(rootB, "only-in-b");
		await expect(handler.resolve(parseInternalUrl("skill://only-in-b"), sessionA.context())).rejects.toThrow(
			/Unknown skill: only-in-b/,
		);
		expect(sessionB.tools.skills.some(s => s.name === "only-in-b")).toBe(false);
	});

	it("logs a failed rediscovery and still reports the original miss", async () => {
		const root = await tempRoot();
		const skillPath = await writeSkill(root, "warn-skill");
		const skills: Skill[] = [
			{
				name: "warn-skill",
				description: "warn-skill skill.",
				filePath: skillPath,
				baseDir: path.dirname(skillPath),
				source: "custom",
			},
		];
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const context: ResolveContext = {
				cwd: root,
				skills,
				reloadSkills: async () => {
					throw new Error("disk on fire");
				},
			};

			// A failed rediscovery must not mask the miss the caller asked about,
			// and must not be silent: the warning names the failed attempt.
			await expect(handler.resolve(parseInternalUrl("skill://absent-skill"), context)).rejects.toThrow(
				/Unknown skill: absent-skill/,
			);
			expect(warn).toHaveBeenCalledWith("skill:// rediscovery failed", { error: expect.any(Error) });
		} finally {
			warn.mockRestore();
		}
	});

	it("shares one discovery pass across concurrent misses", async () => {
		const root = await tempRoot();
		await writeSkill(root, "single-flight-skill");
		const session = await sessionFor(root);
		await writeSkill(root, "second-skill");
		const before = session.discoveries();

		const [first, second] = await Promise.all([session.tools.reloadSkills(), session.tools.reloadSkills()]);

		// The discovery rewrites shared session state, so racing callers must not
		// each run one: exactly one pass, and both see its result.
		expect(session.discoveries() - before).toBe(1);
		for (const skills of [first, second]) {
			expect(skills.map(s => s.name)).toEqual(expect.arrayContaining(["second-skill", "single-flight-skill"]));
		}
	});

	it("runs a fresh discovery for an explicit refresh that starts during a miss", async () => {
		const root = await tempRoot();
		await writeSkill(root, "refresh-skill");
		const session = await sessionFor(root);
		const before = session.discoveries();

		// A miss starts a pass; an explicit refresh (post-mutation, settings) must
		// not adopt it — it may have scanned before the caller's change.
		const miss = session.tools.reloadSkills();
		const refresh = session.tools.refreshSkills();
		await Promise.all([miss, refresh]);

		expect(session.discoveries() - before).toBe(2);
	});

	it("does not treat a moved skill directory as its stale base directory", async () => {
		const root = await tempRoot();
		const staleDir = path.join(root, "stale-dir");
		await fs.mkdir(staleDir, { recursive: true });
		const movedDir = path.join(root, "moved-dir");
		await fs.mkdir(movedDir, { recursive: true });
		const movedPath = path.join(movedDir, "SKILL.md");
		await Bun.write(movedPath, makeSkillMd("directory-skill", root));

		const stale: Skill[] = [
			{
				name: "directory-skill",
				description: "directory-skill skill.",
				filePath: path.join(staleDir, "SKILL.md"),
				baseDir: staleDir,
				source: "custom",
			},
		];
		const fresh: Skill[] = [{ ...stale[0]!, filePath: movedPath, baseDir: movedDir }];
		const context: ResolveContext = {
			cwd: root,
			skills: stale,
			reloadSkills: async () => await Promise.resolve(fresh),
		};

		// The stale directory still exists, so only the instruction file proves the
		// snapshot moved — otherwise bash/eval keep exposing the old directory.
		const located = await handler.locate(parseInternalUrl("skill://directory-skill"), context, {
			directory: true,
		});
		expect(located).toBe(movedDir);
	});

	it("keeps an older session's JIT reload out of the active snapshot", async () => {
		const rootA = await tempRoot();
		const rootB = await tempRoot();
		await writeSkill(rootA, "shared-skill");
		await writeSkill(rootB, "shared-skill");
		const sessionA = await sessionFor(rootA);
		const sessionB = await sessionFor(rootB);
		// Start-up publication order: A installed its snapshot, then newer B did.
		setActiveSkills(sessionA.tools.skills);
		setActiveSkills(sessionB.tools.skills);

		await writeSkill(rootA, "only-in-a");
		const resource = await handler.resolve(parseInternalUrl("skill://only-in-a"), sessionA.context());
		expect(resource.content).toContain(`from ${rootA}`);

		// A's refresh is caller-bound; the process-wide snapshot stays B's, so
		// contextless consumers keep answering for the active session.
		expect(getActiveSkills()).toBe(sessionB.tools.skills);
		expect((await handler.complete()).some(entry => entry.value === "only-in-a")).toBe(false);
	});
});
