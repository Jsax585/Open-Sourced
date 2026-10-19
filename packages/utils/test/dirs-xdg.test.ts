import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetProfileSnapshotForTests,
	getAgentDir,
	getDaemonRuntimeDir,
	getGlobalDaemonRuntimeDir,
	getPredictStateDir,
	getSkillDescriptionsDbPath,
	setAgentDir,
	setProfile,
} from "@oh-my-pi/pi-utils/dirs";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";

const ENV_KEYS = [
	"OMP_DAEMON_NAMESPACE",
	"OMP_PROFILE",
	"PI_PROFILE",
	"PI_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
] as const;
const xdgPlatform = process.platform === "linux" || process.platform === "darwin";

describe("XDG-aware runtime paths", () => {
	let tempRoot = "";
	let configDir = "";
	let defaultAgentDir = "";
	let originalAgentDir = "";
	let originalProfile: string | undefined;
	let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		originalProfile = process.env.OMP_PROFILE ?? process.env.PI_PROFILE;
		originalEnv = {};
		for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
		tempRoot = path.join(os.tmpdir(), "pi-utils-dirs-xdg", Snowflake.next());
		configDir = `.omp-dirs-xdg-${Snowflake.next()}`;
		defaultAgentDir = path.join(os.homedir(), configDir, "agent");
		await fs.mkdir(tempRoot, { recursive: true });
		process.env.PI_CONFIG_DIR = configDir;
		delete process.env.OMP_DAEMON_NAMESPACE;
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.XDG_DATA_HOME;
		delete process.env.XDG_STATE_HOME;
		delete process.env.XDG_CACHE_HOME;
		__resetProfileSnapshotForTests();
	});

	afterEach(async () => {
		setProfile(undefined);
		for (const key of ENV_KEYS) {
			const value = originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		if (originalProfile) setProfile(originalProfile);
		setAgentDir(originalAgentDir);
		await fs.rm(tempRoot, { recursive: true, force: true });
		await fs.rm(path.join(os.homedir(), configDir), { recursive: true, force: true });
	});

	it.skipIf(!xdgPlatform)(
		"routes skill descriptions db and predict state under an initialized $XDG_DATA_HOME/omp",
		async () => {
			const xdgData = path.join(tempRoot, "data");
			await fs.mkdir(path.join(xdgData, "omp"), { recursive: true });
			process.env.XDG_DATA_HOME = xdgData;
			setAgentDir(defaultAgentDir);

			expect(getSkillDescriptionsDbPath()).toBe(path.join(xdgData, "omp", "skill-descriptions.db"));
			expect(getPredictStateDir(undefined, "ngram")).toBe(path.join(xdgData, "omp", "predict", "ngram"));
			// The daemon passes its agent dir explicitly; the default dir still resolves to XDG.
			expect(getPredictStateDir(defaultAgentDir, "ngram")).toBe(path.join(xdgData, "omp", "predict", "ngram"));
		},
	);

	it.skipIf(!xdgPlatform)("adopts legacy predict state once when XDG relocates it", async () => {
		const legacy = path.join(defaultAgentDir, "predict", "ngram");
		await fs.mkdir(legacy, { recursive: true });
		await Bun.write(path.join(legacy, "cursor.json"), JSON.stringify({ historyId: 42 }));
		const xdgData = path.join(tempRoot, "data");
		await fs.mkdir(path.join(xdgData, "omp"), { recursive: true });
		process.env.XDG_DATA_HOME = xdgData;
		setAgentDir(defaultAgentDir);

		const stateDir = getPredictStateDir(defaultAgentDir, "ngram");
		expect(await Bun.file(path.join(stateDir, "cursor.json")).json()).toEqual({ historyId: 42 });

		// Once adopted, XDG state is authoritative: later legacy writes by older versions are not re-copied.
		await Bun.write(path.join(legacy, "cursor.json"), JSON.stringify({ historyId: 7 }));
		getPredictStateDir(defaultAgentDir, "ngram");
		expect(await Bun.file(path.join(stateDir, "cursor.json")).json()).toEqual({ historyId: 42 });
	});

	it.skipIf(!xdgPlatform)("shares the global daemon runtime dir across profiles and custom agent dirs", async () => {
		const xdgState = path.join(tempRoot, "state");
		await fs.mkdir(path.join(xdgState, "omp"), { recursive: true });
		process.env.XDG_STATE_HOME = xdgState;
		const shared = path.join(xdgState, "omp", "run", "daemons", "global", "text-predict");

		setAgentDir(defaultAgentDir);
		expect(getGlobalDaemonRuntimeDir("text-predict")).toBe(shared);
		setProfile("profile-a");
		expect(getGlobalDaemonRuntimeDir("text-predict")).toBe(shared);
		setProfile(undefined);
		setAgentDir(path.join(tempRoot, "custom-agent"));
		expect(getGlobalDaemonRuntimeDir("text-predict")).toBe(shared);
	});

	it("isolates project and global brokers by namespace without moving agent data", () => {
		setAgentDir(defaultAgentDir);
		const project = path.join(tempRoot, "project");
		const projectDefault = getDaemonRuntimeDir(project);
		const globalDefault = getGlobalDaemonRuntimeDir("text-predict");
		const dataDefault = getPredictStateDir(undefined, "ngram");
		process.env.OMP_DAEMON_NAMESPACE = "";
		expect(getDaemonRuntimeDir(project)).toBe(projectDefault);
		expect(getGlobalDaemonRuntimeDir("text-predict")).toBe(globalDefault);

		process.env.OMP_DAEMON_NAMESPACE = "seat/a";
		const projectA = getDaemonRuntimeDir(project);
		const globalA = getGlobalDaemonRuntimeDir("text-predict");
		expect(projectA).not.toBe(projectDefault);
		expect(globalA).not.toBe(globalDefault);
		expect(path.relative(path.dirname(path.dirname(projectA)), projectA)).toMatch(
			/^ns-[0-9a-f]{16}[/\\][0-9a-f]{16}$/,
		);
		expect(getPredictStateDir(undefined, "ngram")).toBe(dataDefault);
		expect(getAgentDir()).toBe(defaultAgentDir);

		process.env.OMP_DAEMON_NAMESPACE = "seat-a";
		expect(getDaemonRuntimeDir(project)).not.toBe(projectA);
		expect(getGlobalDaemonRuntimeDir("text-predict")).not.toBe(globalA);
		process.env.OMP_DAEMON_NAMESPACE = "seat/a";
		expect(getDaemonRuntimeDir(project)).toBe(projectA);
		expect(getGlobalDaemonRuntimeDir("text-predict")).toBe(globalA);
		delete process.env.OMP_DAEMON_NAMESPACE;
		expect(getDaemonRuntimeDir(project)).toBe(projectDefault);
		expect(getGlobalDaemonRuntimeDir("text-predict")).toBe(globalDefault);
	});

	it("keeps paths under an explicit custom agent dir, ignoring XDG", async () => {
		const custom = path.join(tempRoot, "custom-agent");
		await fs.mkdir(custom, { recursive: true });
		const xdgData = path.join(tempRoot, "data");
		await fs.mkdir(path.join(xdgData, "omp"), { recursive: true });
		process.env.XDG_DATA_HOME = xdgData;
		setAgentDir(custom);

		expect(getSkillDescriptionsDbPath()).toBe(path.join(custom, "skill-descriptions.db"));
		expect(getPredictStateDir(custom, "ngram")).toBe(path.join(custom, "predict", "ngram"));
	});
});
