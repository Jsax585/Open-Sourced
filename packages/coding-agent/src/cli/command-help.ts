import { t } from "@oh-my-pi/pi-utils/i18n";
import type { CommandMetadata } from "@oh-my-pi/pi-utils/cli";

export const acpHelp = {
	description: t("Run omp as an ACP (Agent Client Protocol) server over stdio"),
} satisfies CommandMetadata;

export const agentsHelp = { description: t("Manage bundled task agents") } satisfies CommandMetadata;

export const anonymizeHelp = {
	description:
		t("Write a shareable copy of a session and its subagents: turn contents redacted, metadata kept, paths and literals replaced by consistent mock tokens"),
} satisfies CommandMetadata;

export const authHelp = {
	description: t("Export or import stored provider credentials (API keys and OAuth logins) as JSON"),
} satisfies CommandMetadata;

export const authBrokerHelp = {
	description: t("Manage the omp auth-broker (credential vault)"),
} satisfies CommandMetadata;

export const authGatewayHelp = {
	description:
		t("Run an auth-gateway: an HTTP forward proxy backed by the configured broker, or JSON lines on stdio with your own credentials"),
} satisfies CommandMetadata;

export const benchHelp = {
	description:
		t("Benchmark models: TTFT/prefill vs decode throughput with p50/p95, across chat, prefill, generation, and prompt-cache workloads, or single-user vs parallel load (--detailed)"),
} satisfies CommandMetadata;

export const browserRelayHelp = {
	description: t("Run the local CDP relay that lets the browser prelude drive your own Chrome tabs"),
} satisfies CommandMetadata;

export const cleanseHelp = {
	description: t("Detect and fix project diagnostics with weighted parallel subagents"),
} satisfies CommandMetadata;

export const collabHelp = {
	description:
		t("List active local Collab host metadata without URLs; use collab link <instanceId|pid> to retrieve a control link (--view for view-only)"),
} satisfies CommandMetadata;

export const clipHelp = {
	description: t("Upload a /record recording to live.omp.sh as a public clip and print its URL"),
} satisfies CommandMetadata;

export const commitHelp = { description: t("Generate a commit message and update changelogs") } satisfies CommandMetadata;

export const completionsHelp = {
	description: t("Print a shell completion script (bash, zsh, or fish)"),
} satisfies CommandMetadata;

export const completeHelp = { hidden: true } satisfies CommandMetadata;

export const compressHelp = {
	description: t("Rewrite a text file into the dense prompt register, reporting what it drops"),
} satisfies CommandMetadata;

export const configHelp = { description: t("Manage configuration settings") } satisfies CommandMetadata;

export const dryBalanceHelp = {
	description: t("Dry-run OAuth account balancing across random session ids"),
} satisfies CommandMetadata;

export const galleryHelp = {
	description: t("Preview tool, composer, and status-line renderers in a deterministic visual gallery"),
} satisfies CommandMetadata;

export const gcHelp = { description: t("Run storage garbage collection") } satisfies CommandMetadata;
export const ifBenchHelp = {
	description:
		t("Benchmark instruction following and working memory: one cached thread of glyph array actions with a moving cat-sound directive"),
} satisfies CommandMetadata;
export const gitHelp = {
	description: t("Interactive fullscreen git UI: split diff viewer, staging sidebar, and commit composer"),
} satisfies CommandMetadata;

export const findHelp = {
	description: t("Semantic search: describe a behavior, get the files and line ranges that implement it"),
} satisfies CommandMetadata;

export const grepHelp = { description: t("Test grep tool") } satisfies CommandMetadata;

export const grievancesHelp = {
	description: t("View, clean, or push reported tool issues (auto-QA grievances)"),
} satisfies CommandMetadata;

export const loginHelp = {
	description: t("Log in to a model provider (terminal counterpart of /login)"),
} satisfies CommandMetadata;

export const imagesHelp = {
	description: t("Inspect, diagnose, probe, and purge image publication backends"),
} satisfies CommandMetadata;

export const installHelp = {
	description: t("Install or link an extension package (alias of `plugin install`/`plugin link`)"),
} satisfies CommandMetadata;

export const joinHelp = { description: t("Join a shared collab session (same as /join)") } satisfies CommandMetadata;

export const modelsHelp = { description: t("List, search, and refresh available models") } satisfies CommandMetadata;

export const pluginHelp = { description: t("Manage plugins (install, uninstall, list, etc.)") } satisfies CommandMetadata;

export const playHelp = {
	description: t("Replay a /record session recording in the terminal (space pauses, q quits)"),
} satisfies CommandMetadata;

export const predictHelp = {
	description: t("Type a prompt and compare every word-completion engine's ghost text live"),
} satisfies CommandMetadata;

export const psHelp = {
	description: t("List and control daemon-supervised background processes (logs, stop, kill, restart)"),
} satisfies CommandMetadata;

export const readHelp = {
	description: t("Show what the read tool will return for a path, URL, or internal URI"),
} satisfies CommandMetadata;
export const renderHelp = {
	description: t("Draw a session's entire thread through the production transcript pipeline (with repaint timing)"),
} satisfies CommandMetadata;

export const sayHelp = {
	description: t("Synthesize text with the local TTS engine and play it through the speakers"),
} satisfies CommandMetadata;

export const searchHelp = { description: t("Test web search providers") } satisfies CommandMetadata;

export const sessionHelp = {
	description: t("Hand a session to another machine: pack it, unpack it, or mark the local copy moved"),
} satisfies CommandMetadata;

export const shareHelp = {
	description: t("Share a saved session via an encrypted link (same as /share)"),
} satisfies CommandMetadata;

export const setupHelp = {
	description: t("Run onboarding setup or install dependencies for optional features"),
} satisfies CommandMetadata;

export const shellHelp = { description: t("Interactive shell console") } satisfies CommandMetadata;

export const skillHelp = {
	description: t("Install, search, publish, and manage skills on the Skillshare registry (skills.omp.sh)"),
} satisfies CommandMetadata;

export const sshHelp = { description: t("Manage SSH host configurations") } satisfies CommandMetadata;

export const statsHelp = { description: t("View usage statistics") } satisfies CommandMetadata;

export const streamHelp = {
	description: t("Broadcast local omp session screens and chat to your public live channel"),
} satisfies CommandMetadata;

export const tinyModelsHelp = {
	description: t("Download tiny local models (session titles, memory, word completion)"),
} satisfies CommandMetadata;

export const tokenHelp = { description: t("Get the API key or OAuth token for a provider") } satisfies CommandMetadata;

export const toksHelp = {
	description: t("Count a file or text with every embedded offline tokenizer (OpenAI, Claude, Qwen, …)"),
} satisfies CommandMetadata;

export const ttsrHelp = {
	description: t("Inspect and test Time-Traveling Stream Rules (TTSR)"),
} satisfies CommandMetadata;

export const updateHelp = { description: t("Check for and install updates") } satisfies CommandMetadata;

export const usageHelp = {
	description: t("Show provider usage limits for every authenticated account"),
} satisfies CommandMetadata;

export const worktreeHelp = {
	description: t("Add, list, or clear git worktrees (clone-first when enabled)"),
} satisfies CommandMetadata;
