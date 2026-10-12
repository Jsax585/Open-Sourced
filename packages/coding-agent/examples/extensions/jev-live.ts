/**
 * Optional Jev lane for a few bounded OMP live-voice commands.
 * No audio capture, Stage Manager, shell execution, or additional agent runtime.
 * Install alongside jev-live-questions.json; enable for each session with /jev-live on.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import questions from "./jev-live-questions.json" with { type: "json" };

export type JevLiveAction = "status" | "model" | "cancel";

const MAX_UTTERANCE_LENGTH = 120;
const MIN_CONFIDENCE = 0.85;
const JEV_TIMEOUT_MS = 600;
// A positive, direct cancel order is required even if the classifier says "cancel".
const CANCEL_COMMAND = /^(?:please\s+)?(?:stop|cancel|abort|interrupt)(?:\s+(?:the|my|current|running|ongoing|agent|task|work)){0,6}[.!?]?$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Avoid network calls for general coding requests and transcript-sized payloads. */
export function isJevLiveCandidate(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_UTTERANCE_LENGTH &&
    trimmed.split(/\s+/).length <= 14 &&
    !/[\r\n]/.test(trimmed) &&
    /^[\p{L}\p{N}\s.,?!'\-]+$/u.test(trimmed) &&
    /\b(model|status|working|running|task|cancel|stop|abort|interrupt)\b/i.test(trimmed)
  );
}

export function isSafeCancelRequest(text: string): boolean {
  return CANCEL_COMMAND.test(text.trim());
}

/** Require an explicit calibrated probability; missing/low scores fail open. */
export function parseJevLiveDecision(payload: unknown): JevLiveAction | undefined {
  if (!isRecord(payload) || !isRecord(payload.answers)) return undefined;
  const answer = payload.answers.action;
  if (!isRecord(answer)) return undefined;
  const action = answer.choice;
  if (action !== "status" && action !== "model" && action !== "cancel") return undefined;
  if (!isRecord(answer.probabilities)) return undefined;
  const score = answer.probabilities[action];
  return typeof score === "number" && Number.isFinite(score) && score >= MIN_CONFIDENCE && score <= 1
    ? action
    : undefined;
}

async function classify(text: string, key: string): Promise<JevLiveAction | undefined> {
  try {
    const response = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: "jev-latest",
        state: { utterance: text },
        questions,
      }),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    return parseJevLiveDecision(body);
  } catch {
    return undefined;
  }
}

export default function jevLive(pi: ExtensionAPI): void {
  let enabled = false;

  pi.registerCommand("jev-live", {
    description: "Opt into bounded Jev live-voice commands: on | off | status",
    handler: async (args, ctx) => {
      const choice = args.trim().toLowerCase();
      if (choice === "on") {
        if (!process.env.TYPESAFE_API_KEY?.trim()) {
          ctx.ui.notify("Set TYPESAFE_API_KEY before enabling Jev voice shortcuts.", "warning");
          return;
        }
        enabled = true;
      } else if (choice === "off") {
        enabled = false;
      } else if (choice !== "status" && choice !== "") {
        ctx.ui.notify("Usage: /jev-live on | off | status", "warning");
        return;
      }
      ctx.ui.notify(`Jev live shortcuts: ${enabled ? "on" : "off"}`, "info");
    },
  });

  // Consent is per session, never persisted or automatically restored.
  pi.on("session_start", () => { enabled = false; });
  pi.on("session_switch", () => { enabled = false; });
  pi.on("session_shutdown", () => { enabled = false; });

  pi.on("live_delegation", async (event, ctx) => {
    if (!enabled || !isJevLiveCandidate(event.text)) return;
    const key = process.env.TYPESAFE_API_KEY?.trim();
    if (!key) return;
    const action = await classify(event.text, key);
    if (!action) return;

    if (action === "model") {
      const model = ctx.models.current();
      return { reply: model ? `Current coding model: ${model.name || model.id}.` : "No coding model selected." };
    }
    if (action === "status") {
      const status = ctx.isIdle() ? "idle" : "working";
      return { reply: `The coding agent is ${status}.` };
    }
    if (action === "cancel" && isSafeCancelRequest(event.text)) {
      if (ctx.isIdle()) return { reply: "No agent task is running." };
      ctx.abort();
      return { reply: "Stopped the current coding task." };
    }
    // Anything ambiguous or unsupported goes to OMP's existing coding agent.
  });
}
