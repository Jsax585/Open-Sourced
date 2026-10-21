import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ApiKey, ResetCreditAccountStatus, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { parseClaudeUsagePayload } from "@oh-my-pi/pi-ai/usage/claude";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { createCodexAutoRedeemCoordinator } from "@oh-my-pi/pi-coding-agent/session/codex-auto-reset";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const ANTHROPIC = "anthropic" as const;
const PRIMARY_MODEL_ID = "claude-sonnet-4-5";
const FALLBACK_MODEL_ID = "gpt-4o-mini";
const PAID_LIMIT = 10;
const PAID_FLOOR = 3;
const PAID_CHARGE = 4;
const HOUR_MS = 60 * 60_000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const TEST_ACCOUNT_PREFIX = "tiered-s7";

type AccountId = "a" | "b" | "c";

type LedgerEntry = {
	allowanceUsedPct: number;
	paidUsed: number;
	resetAvailable: boolean;
};

type RequestTrace = {
	selector: string;
	bearer: string;
};

type Charge = {
	accountId: AccountId;
	kind: "allowance" | "paid";
	allowanceWasAvailable: boolean;
	remainingBefore?: number;
};

type TieredHarness = {
	session: AgentSession;
	authStorage: AuthStorage;
	primarySelector: string;
	fallbackSelector: string;
	ledger: Record<AccountId, LedgerEntry>;
	requests: RequestTrace[];
	charges: Charge[];
	events: string[];
	redemptions: string[];
	prompt(count: number): Promise<void>;
	dispose(): Promise<void>;
};

function money(amount: number): { amount_minor: number; currency: "USD"; exponent: 2 } {
	return { amount_minor: Math.round(amount * 100), currency: "USD", exponent: 2 };
}

function resolveInitialApiKey(apiKey: ApiKey | undefined): string {
	const resolved = typeof apiKey === "function" ? apiKey({ lastChance: false, error: undefined }) : apiKey;
	const bearer =
		typeof resolved === "string" ? resolved : resolved && "apiKey" in resolved ? resolved.apiKey : undefined;
	if (typeof bearer !== "string") throw new Error("Expected API key to be resolved before streaming");
	return bearer;
}

function oauthCredential(accountId: AccountId): OAuthCredentials {
	return {
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + WEEK_MS,
		accountId: `${TEST_ACCOUNT_PREFIX}-${accountId}`,
		email: `${TEST_ACCOUNT_PREFIX}-${accountId}@example.test`,
		orgId: `${TEST_ACCOUNT_PREFIX}-org-${accountId}`,
	};
}

function claudePayload(entry: LedgerEntry): Record<string, unknown> {
	const resetsAt = new Date(Date.now() + 2 * HOUR_MS).toISOString();
	return {
		five_hour: { utilization: 0, resets_at: resetsAt },
		seven_day: { utilization: entry.allowanceUsedPct, resets_at: resetsAt },
		spend: {
			enabled: true,
			used: money(entry.paidUsed),
			limit: money(PAID_LIMIT),
		},
	};
}

function resetInventory(accountId: AccountId) {
	return {
		availableCount: 1,
		redeemableCount: 1,
		eligible: true,
		nextCreditId: `cedar-${accountId}`,
		credits: [
			{
				id: `cedar-${accountId}`,
				title: "Saved Claude reset",
				program: "cedar_ember",
				remainingCount: 1,
				usable: true,
				requiresLimit: true,
				clears: ["anthropic:7d"],
				blocking: ["anthropic:7d"],
				usedFractions: { "anthropic:7d": 1 },
				expiresAt: new Date(Date.now() + WEEK_MS).toISOString(),
				status: "available" as const,
			},
		],
	};
}

function accountIdFromBearer(bearer: string): AccountId | undefined {
	return bearer === "a" || bearer === "b" || bearer === "c" ? bearer : undefined;
}

function chargedBearers(harness: TieredHarness): string[] {
	return harness.requests.filter(request => request.selector === harness.primarySelector).map(request => request.bearer);
}

async function createTieredHarness(options: {
	withFallbackChain: boolean;
	extraUsageBelowFloor?: boolean;
	withSavedReset?: boolean;
}): Promise<TieredHarness> {
	const primaryModel = getBundledModel(ANTHROPIC, PRIMARY_MODEL_ID);
	const fallbackModel = getBundledModel("openai", FALLBACK_MODEL_ID);
	if (!primaryModel || !fallbackModel) throw new Error("Expected bundled Anthropic and OpenAI test models");

	const primarySelector = `${primaryModel.provider}/${primaryModel.id}`;
	const fallbackSelector = `${fallbackModel.provider}/${fallbackModel.id}`;
	const ledger: Record<AccountId, LedgerEntry> = {
		a: { allowanceUsedPct: 0, paidUsed: 0, resetAvailable: options.withSavedReset === true },
		b: { allowanceUsedPct: 0, paidUsed: 0, resetAvailable: false },
		c: { allowanceUsedPct: 0, paidUsed: 0, resetAvailable: false },
	};
	const reportFor = (accountId: AccountId): UsageReport => {
		const entry = ledger[accountId];
		if (!entry) throw new Error(`Expected ledger entry for ${accountId}`);
		const report = parseClaudeUsagePayload(claudePayload(entry), {
			accountId: `${TEST_ACCOUNT_PREFIX}-${accountId}`,
			email: `${TEST_ACCOUNT_PREFIX}-${accountId}@example.test`,
			orgId: `${TEST_ACCOUNT_PREFIX}-org-${accountId}`,
		});
		if (!report) throw new Error("Expected fake Claude ledger to produce a usage report");
		return entry.resetAvailable ? { ...report, resetCredits: resetInventory(accountId) } : report;
	};
	const usageProvider: UsageProvider = {
		id: ANTHROPIC,
		async fetchUsage({ credential }) {
			const accountId = credential.accountId?.replace(`${TEST_ACCOUNT_PREFIX}-`, "");
			return accountId === "a" || accountId === "b" || accountId === "c" ? reportFor(accountId) : null;
		},
	};
	const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
		usageProviderResolver: provider => (provider === ANTHROPIC ? usageProvider : undefined),
		accountPolicies: [
			{ provider: ANTHROPIC, account: { accountId: `${TEST_ACCOUNT_PREFIX}-a` }, priority: 3, extraUsageFloor: PAID_FLOOR },
			{ provider: ANTHROPIC, account: { accountId: `${TEST_ACCOUNT_PREFIX}-b` }, priority: 2, extraUsageFloor: PAID_FLOOR },
			{ provider: ANTHROPIC, account: { accountId: `${TEST_ACCOUNT_PREFIX}-c` }, priority: 1, extraUsageFloor: PAID_FLOOR },
		],
	});
	const requests: RequestTrace[] = [];
	const charges: Charge[] = [];
	const events: string[] = [];
	const redemptions: string[] = [];

	vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
		if (provider !== ANTHROPIC) return null;
		const credential = credentials[provider] as OAuthCredentials | undefined;
		const bearer = credential?.accountId?.replace(`${TEST_ACCOUNT_PREFIX}-`, "");
		if (!credential || (bearer !== "a" && bearer !== "b" && bearer !== "c")) return null;
		return { apiKey: bearer, newCredentials: credential };
	});

	await authStorage.credentials.reload();
	await authStorage.credentials.set(ANTHROPIC, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")].map(credential => ({
		type: "oauth" as const,
		...credential,
	})));
	authStorage.keys.setRuntime("openai", "fallback-key");

	const accounts = authStorage.oauth.accounts(ANTHROPIC);
	const resetAccount = accounts.find(candidate => candidate.accountId === `${TEST_ACCOUNT_PREFIX}-a`);
	if (!resetAccount) throw new Error("Expected reset account in the OAuth pool");
	vi.spyOn(authStorage.resets, "list").mockImplementation(async request => {
		if (request?.provider !== ANTHROPIC || !ledger.a.resetAvailable) return [];
		return [
			{
				provider: ANTHROPIC,
				credentialId: resetAccount.credentialId,
				report: reportFor("a"),
				accountId: `${TEST_ACCOUNT_PREFIX}-a`,
				email: `${TEST_ACCOUNT_PREFIX}-a@example.test`,
				orgId: `${TEST_ACCOUNT_PREFIX}-org-a`,
				active: true,
				...resetInventory("a"),
			} satisfies ResetCreditAccountStatus,
		];
	});
	vi.spyOn(authStorage.resets, "redeem").mockImplementation(async request => {
		if (
			request.target.credentialId !== resetAccount.credentialId ||
			request.target.creditId !== "cedar-a" ||
			!ledger.a.resetAvailable
		) {
			return { ok: false, code: "no_credit", provider: ANTHROPIC };
		}
		const entry = ledger.a;
		entry.allowanceUsedPct = 0;
		entry.resetAvailable = false;
		redemptions.push("a");
		events.push("redeem:a");
		await authStorage.usage.invalidate(ANTHROPIC);
		return {
			ok: true,
			code: "reset",
			provider: ANTHROPIC,
			accountId: `${TEST_ACCOUNT_PREFIX}-a`,
			email: `${TEST_ACCOUNT_PREFIX}-a@example.test`,
			orgId: `${TEST_ACCOUNT_PREFIX}-org-a`,
			creditId: "cedar-a",
			cleared: ["anthropic:7d"],
		};
	});

	const modelRegistry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	const mock = createMockModel();
	const agent = new Agent({
		getApiKey: model =>
			modelRegistry.resolver(model, {
				sessionId: agent.sessionId,
				...session.apiKeyResolverOptions(model),
			}),
		initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: async (model, context, streamOptions) => {
			const selector = `${model.provider}/${model.id}`;
			const bearer = resolveInitialApiKey(streamOptions?.apiKey);
			requests.push({ selector, bearer });
			events.push(`request:${bearer}`);
			if (selector === primarySelector) {
				const accountId = accountIdFromBearer(bearer);
				if (!accountId) throw new Error(`Expected an OAuth bearer, got ${bearer}`);
				const entry = ledger[accountId];
				if (!entry) throw new Error(`Expected ledger entry for ${accountId}`);
				const allowanceWasAvailable = Object.values(ledger).some(candidate => candidate.allowanceUsedPct < 100);
				if (entry.allowanceUsedPct < 100) {
					charges.push({ accountId, kind: "allowance", allowanceWasAvailable });
					entry.allowanceUsedPct = Math.min(100, entry.allowanceUsedPct + 50);
				} else {
					const remainingBefore = PAID_LIMIT - entry.paidUsed;
					charges.push({ accountId, kind: "paid", allowanceWasAvailable, remainingBefore });
					entry.paidUsed += PAID_CHARGE;
				}
				await authStorage.usage.invalidate(ANTHROPIC);
			}
			mock.push({ content: [`ok:${selector}`], stopReason: "stop" });
			return mock.stream(model, context, streamOptions);
		},
	});
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.accountOrder": "tiered",
		"retry.usageAwareFallback": true,
		"retry.fallbackOn": "usage-limit",
		"retry.fallbackChains": options.withFallbackChain ? { [primarySelector]: [fallbackSelector] } : {},
		"retry.extraUsageBelowFloor": options.extraUsageBelowFloor === true,
		"retry.baseDelayMs": 1,
		"retry.maxDelayMs": 100,
		"retry.maxRetries": 1,
		"claudeResets.autoRedeem": "yes",
		"claudeResets.keepCredits": 0,
		"claudeResets.minBlockedMinutes": 60,
	});
	settings.setModelRole("default", primarySelector);
	const sessionManager = SessionManager.inMemory();
	const resetCoordinator = createCodexAutoRedeemCoordinator();
	const tempDir = TempDir.createSync("@pi-tiered-account-order-");
	resetCoordinator.resetLockPath = `${tempDir.path()}/auth.db`;
	const session = new AgentSession({ agent, sessionManager, settings, modelRegistry, codexResetCoordinator: resetCoordinator });

	return {
		session,
		authStorage,
		primarySelector,
		fallbackSelector,
		ledger,
		requests,
		charges,
		events,
		redemptions,
		async prompt(count) {
			for (let index = 0; index < count; index++) {
				await session.prompt(`Tiered account order request ${index + 1}`);
				await session.waitForIdle();
			}
		},
		async dispose() {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("AgentSession tiered same-provider account order", () => {
	it("uses every plan allowance before paid usage, preserves each floor, then falls back", async () => {
		const harness = await createTieredHarness({ withFallbackChain: true });
		try {
			await harness.prompt(13);

			expect(harness.requests).toEqual([
				{ selector: harness.primarySelector, bearer: "a" },
				{ selector: harness.primarySelector, bearer: "a" },
				{ selector: harness.primarySelector, bearer: "b" },
				{ selector: harness.primarySelector, bearer: "b" },
				{ selector: harness.primarySelector, bearer: "c" },
				{ selector: harness.primarySelector, bearer: "c" },
				{ selector: harness.primarySelector, bearer: "a" },
				{ selector: harness.primarySelector, bearer: "a" },
				{ selector: harness.primarySelector, bearer: "b" },
				{ selector: harness.primarySelector, bearer: "b" },
				{ selector: harness.primarySelector, bearer: "c" },
				{ selector: harness.primarySelector, bearer: "c" },
				{ selector: harness.fallbackSelector, bearer: "fallback-key" },
			]);
			const paidCharges = harness.charges.filter((charge): charge is Charge & { kind: "paid"; remainingBefore: number } =>
				charge.kind === "paid" && charge.remainingBefore !== undefined,
			);
			expect(paidCharges.map(charge => [charge.accountId, charge.remainingBefore])).toEqual([
				["a", 10],
				["a", 6],
				["b", 10],
				["b", 6],
				["c", 10],
				["c", 6],
			]);
			expect(paidCharges.every(charge => !charge.allowanceWasAvailable && charge.remainingBefore > PAID_FLOOR)).toBe(true);
			expect(Object.values(harness.ledger).map(entry => PAID_LIMIT - entry.paidUsed)).toEqual([2, 2, 2]);
		} finally {
			await harness.dispose();
		}
	});

	it("redeems A's saved reset before sending the next request to B", async () => {
		const harness = await createTieredHarness({ withFallbackChain: true, withSavedReset: true });
		try {
			await harness.prompt(6);

			expect(chargedBearers(harness)).toEqual(["a", "a", "a", "a", "b", "b"]);
			expect(harness.events).toEqual([
				"request:a",
				"request:a",
				"redeem:a",
				"request:a",
				"request:a",
				"request:b",
				"request:b",
			]);
			expect(harness.redemptions).toEqual(["a"]);
		} finally {
			await harness.dispose();
		}
	});

	it("permits below-floor paid usage only when the primary has no successor", async () => {
		const terminal = await createTieredHarness({ withFallbackChain: false, extraUsageBelowFloor: true });
		try {
			await terminal.prompt(7);
			expect(chargedBearers(terminal)).toEqual(["a", "a", "b", "b", "c", "c", "a"]);
			expect(terminal.requests.some(request => request.selector === terminal.fallbackSelector)).toBe(false);
			expect(terminal.charges.at(-1)).toMatchObject({ accountId: "a", kind: "paid", remainingBefore: 10 });
		} finally {
			await terminal.dispose();
		}

		const withSuccessor = await createTieredHarness({ withFallbackChain: true, extraUsageBelowFloor: true });
		try {
			await withSuccessor.prompt(13);
			expect(withSuccessor.requests.at(-1)).toEqual({
				selector: withSuccessor.fallbackSelector,
				bearer: "fallback-key",
			});
			expect(withSuccessor.charges.filter(charge => charge.kind === "paid").every(charge => charge.remainingBefore! > PAID_FLOOR)).toBe(true);
		} finally {
			await withSuccessor.dispose();
		}
	});
});
