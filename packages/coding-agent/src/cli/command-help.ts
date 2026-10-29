import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import type { CommandMetadata } from "@oh-my-pi/pi-utils/cli";

export const acpHelp = {
	description: __ompTranslate("Run omp as an ACP (Agent Client Protocol) server over stdio"),
} satisfies CommandMetadata;

export const agentsHelp = { description: __ompTranslate("Manage bundled task agents") } satisfies CommandMetadata;

export const anonymizeHelp = {
	description: __ompTranslate(
		"Write a shareable copy of a session and its subagents: turn contents redacted, metadata kept, paths and literals replaced by consistent mock tokens",
	),
} satisfies CommandMetadata;

export const authHelp = {
	description: __ompTranslate("Export or import stored provider credentials (API keys and OAuth logins) as JSON"),
} satisfies CommandMetadata;

export const authBrokerHelp = {
	description: __ompTranslate("Manage the omp auth-broker (credential vault)"),
} satisfies CommandMetadata;

export const authGatewayHelp = {
	description: __ompTranslate(
		"Run an auth-gateway: an HTTP forward proxy backed by the configured broker, or JSON lines on stdio with your own credentials",
	),
} satisfies CommandMetadata;

export const benchHelp = {
	description: __ompTranslate(
		"Benchmark models: TTFT/prefill vs decode throughput with p50/p95, across chat, prefill, generation, and prompt-cache workloads, or single-user vs parallel load (--detailed)",
	),
} satisfies CommandMetadata;

export const browserRelayHelp = {
	description: __ompTranslate("Run the local CDP relay that lets the browser prelude drive your own Chrome tabs"),
} satisfies CommandMetadata;

export const cleanseHelp = {
	description: __ompTranslate("Detect and fix project diagnostics with weighted parallel subagents"),
} satisfies CommandMetadata;

export const collabHelp = {
	description: __ompTranslate(
		"List active local Collab host metadata without URLs; use collab link <instanceId|pid> to retrieve a control link (--view for view-only)",
	),
} satisfies CommandMetadata;

export const clipHelp = {
	description: __ompTranslate("Upload a /record recording to live.omp.sh as a public clip and print its URL"),
} satisfies CommandMetadata;

export const commitHelp = {
	description: __ompTranslate("Generate a commit message and update changelogs"),
} satisfies CommandMetadata;

export const completionsHelp = {
	description: __ompTranslate("Print a shell completion script (bash, zsh, or fish)"),
} satisfies CommandMetadata;

export const completeHelp = { hidden: true } satisfies CommandMetadata;

export const compressHelp = {
	description: __ompTranslate("Rewrite a text file into the dense prompt register, reporting what it drops"),
} satisfies CommandMetadata;

export const configHelp = { description: __ompTranslate("Manage configuration settings") } satisfies CommandMetadata;

export const dryBalanceHelp = {
	description: __ompTranslate("Dry-run OAuth account balancing across random session ids"),
} satisfies CommandMetadata;

export const galleryHelp = {
	description: __ompTranslate("Preview tool, composer, and status-line renderers in a deterministic visual gallery"),
} satisfies CommandMetadata;

export const gcHelp = { description: __ompTranslate("Run storage garbage collection") } satisfies CommandMetadata;
export const ifBenchHelp = {
	description: __ompTranslate(
		"Benchmark instruction following and working memory: one cached thread of glyph array actions with a moving cat-sound directive",
	),
} satisfies CommandMetadata;
export const gitHelp = {
	description: __ompTranslate(
		"Interactive fullscreen git UI: split diff viewer, staging sidebar, and commit composer",
	),
} satisfies CommandMetadata;

export const findHelp = {
	description: __ompTranslate("Semantic search: describe a behavior, get the files and line ranges that implement it"),
} satisfies CommandMetadata;

export const grepHelp = { description: __ompTranslate("Test grep tool") } satisfies CommandMetadata;

export const grievancesHelp = {
	description: __ompTranslate("View, clean, or push reported tool issues (auto-QA grievances)"),
} satisfies CommandMetadata;

export const loginHelp = {
	description: __ompTranslate("Log in to a model provider (terminal counterpart of /login)"),
} satisfies CommandMetadata;

export const imagesHelp = {
	description: __ompTranslate("Inspect, diagnose, probe, and purge image publication backends"),
} satisfies CommandMetadata;

export const installHelp = {
	description: __ompTranslate("Install or link an extension package (alias of `plugin install`/`plugin link`)"),
} satisfies CommandMetadata;

export const joinHelp = {
	description: __ompTranslate("Join a shared collab session (same as /join)"),
} satisfies CommandMetadata;

export const modelsHelp = {
	description: __ompTranslate("List, search, and refresh available models"),
} satisfies CommandMetadata;

export const pluginHelp = {
	description: __ompTranslate("Manage plugins (install, uninstall, list, etc.)"),
} satisfies CommandMetadata;

export const playHelp = {
	description: __ompTranslate("Replay a /record session recording in the terminal (space pauses, q quits)"),
} satisfies CommandMetadata;

export const predictHelp = {
	description: __ompTranslate("Type a prompt and compare every word-completion engine's ghost text live"),
} satisfies CommandMetadata;

export const psHelp = {
	description: __ompTranslate("List and control daemon-supervised background processes (logs, stop, kill, restart)"),
} satisfies CommandMetadata;

export const readHelp = {
	description: __ompTranslate("Show what the read tool will return for a path, URL, or internal URI"),
} satisfies CommandMetadata;
export const renderHelp = {
	description: __ompTranslate(
		"Draw a session's entire thread through the production transcript pipeline (with repaint timing)",
	),
} satisfies CommandMetadata;

export const sayHelp = {
	description: __ompTranslate("Synthesize text with the local TTS engine and play it through the speakers"),
} satisfies CommandMetadata;

export const searchHelp = { description: __ompTranslate("Test web search providers") } satisfies CommandMetadata;

export const sessionHelp = {
	description: __ompTranslate("Hand a session to another machine: pack it, unpack it, or mark the local copy moved"),
} satisfies CommandMetadata;

export const shareHelp = {
	description: __ompTranslate("Share a saved session via an encrypted link (same as /share)"),
} satisfies CommandMetadata;

export const setupHelp = {
	description: __ompTranslate("Run onboarding setup or install dependencies for optional features"),
} satisfies CommandMetadata;

export const shellHelp = { description: __ompTranslate("Interactive shell console") } satisfies CommandMetadata;

export const skillHelp = {
	description: __ompTranslate(
		"Install, search, publish, and manage skills on the Skillshare registry (skills.omp.sh)",
	),
} satisfies CommandMetadata;

export const sshHelp = { description: __ompTranslate("Manage SSH host configurations") } satisfies CommandMetadata;

export const statsHelp = { description: __ompTranslate("View usage statistics") } satisfies CommandMetadata;

export const streamHelp = {
	description: __ompTranslate("Broadcast local omp session screens and chat to your public live channel"),
} satisfies CommandMetadata;

export const tinyModelsHelp = {
	description: __ompTranslate("Download tiny local models (session titles, memory, word completion)"),
} satisfies CommandMetadata;

export const tokenHelp = {
	description: __ompTranslate("Get the API key or OAuth token for a provider"),
} satisfies CommandMetadata;

export const toksHelp = {
	description: __ompTranslate("Count a file or text with every embedded offline tokenizer (OpenAI, Claude, Qwen, …)"),
} satisfies CommandMetadata;

export const ttsrHelp = {
	description: __ompTranslate("Inspect and test Time-Traveling Stream Rules (TTSR)"),
} satisfies CommandMetadata;

export const updateHelp = { description: __ompTranslate("Check for and install updates") } satisfies CommandMetadata;

export const usageHelp = {
	description: __ompTranslate("Show provider usage limits for every authenticated account"),
} satisfies CommandMetadata;

export const worktreeHelp = {
	description: __ompTranslate("Add, list, or clear git worktrees (clone-first when enabled)"),
} satisfies CommandMetadata;
