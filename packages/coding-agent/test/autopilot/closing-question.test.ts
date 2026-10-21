import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	assistantText,
	closingAsk,
	closingQuestion,
	isAwaitingUserAnswer,
	normalizeQuestion,
} from "../../src/session/closing-question";

type Content = AssistantMessage["content"];

function text(value: string): Content[number] {
	return { type: "text", text: value };
}

function message(content: Content): Pick<AssistantMessage, "content"> {
	return { content };
}

/** Autopilot asks for the penultimate-sentence rule; the todo reminder does not. */
function autopilotQuestion(value: string) {
	return closingQuestion(message([text(value)]), { includePenultimateQuestion: true });
}

describe("assistantText", () => {
	it("keeps text blocks, ignores thinking and tool calls, and strips code", () => {
		const visible = assistantText(
			message([
				{ type: "thinking", thinking: "Should I ask?" },
				text("Here is the script:\n```sh\necho '?'\n```\nDone."),
				{ type: "toolCall", id: "1", name: "bash", arguments: { command: "echo ?" } },
			]),
		);
		expect(visible).toBe("Here is the script:\nDone.");
	});
});

describe("closingQuestion", () => {
	it("detects a question that ends the final paragraph", () => {
		const question = autopilotQuestion("I finished the refactor and the tests are green. Shall I run the e2e suite?");
		expect(question).not.toBeNull();
		expect(question!.key).toBe("shall i run the e2e suite");
		expect(question!.ask).toBe("question");
	});

	it("detects a question in the penultimate sentence when autopilot asks for it", () => {
		const value = "Should I proceed? The build is already green.";
		const question = autopilotQuestion(value);
		expect(question).not.toBeNull();
		expect(question!.key).toBe("should i proceed");
		// The todo reminder stays conservative: that final sentence may be a self-answer.
		expect(isAwaitingUserAnswer(message([text(value)]))).toBe(false);
	});

	it("ignores a question more than two sentences from the end", () => {
		expect(autopilotQuestion("Should I proceed? First, the tests pass. Second, the build is clean.")).toBeNull();
	});

	it("ignores question marks inside fenced code", () => {
		expect(autopilotQuestion("Here is the script:\n\n```sh\necho '?'\n```")).toBeNull();
	});

	it("ignores question marks inside inline code", () => {
		expect(autopilotQuestion("Use `isReady?` before continuing.")).toBeNull();
	});

	it("ignores a bare URL with a query string", () => {
		expect(autopilotQuestion("The trace is at https://example.com/run?a=1")).toBeNull();
	});

	it("ignores thinking-only messages", () => {
		expect(
			closingQuestion(message([{ type: "thinking", thinking: "Should I stop?" }]), {
				includePenultimateQuestion: true,
			}),
		).toBeNull();
	});

	it("does not treat a decimal point as a sentence boundary", () => {
		const question = autopilotQuestion("Version 1.5 is out. Should I upgrade?");
		expect(question).not.toBeNull();
		expect(question!.key).toBe("should i upgrade");
	});

	it("detects ASCII Portuguese and Spanish closing questions", () => {
		expect(autopilotQuestion("Terminei a refatoração. Posso continuar?")?.key).toBe("posso continuar");
		expect(autopilotQuestion("Los tests pasan. Puedo continuar?")?.key).toBe("puedo continuar");
		expect(autopilotQuestion("Quer que eu faça o commit?")?.ask).toBe("request");
	});

	it("treats an options list as an open request", () => {
		const value = [
			"Next question, which decides the sandbox: **do your prototypes need network access?**",
			"",
			"1. **Fully offline.** Inline CSS and JS only.",
			"2. **Read-only CDN access.** Load scripts, styles, fonts and images over HTTPS.",
			"",
			"I'd recommend 2. Offline mode would break mocks that use CDN assets.",
		].join("\n");
		const question = autopilotQuestion(value);
		expect(question).not.toBeNull();
		expect(question!.ask).toBe("request");
	});

	it("accepts a question one sentence from the end for autopilot only", () => {
		const value = "Which configuration should this use?\nUse the existing default; the todo items still need work.";
		expect(autopilotQuestion(value)).not.toBeNull();
		expect(isAwaitingUserAnswer(message([text(value)]))).toBe(false);
	});

	it("returns null for empty content", () => {
		expect(closingQuestion(message([]))).toBeNull();
		expect(closingQuestion(message([text("   ")]))).toBeNull();
	});
});

describe("closingAsk", () => {
	it("ranks cues above requests above question-shaped prose", () => {
		expect(closingAsk("If you confirm, I'll hand the tickets to subagents.")).toBe("cue");
		expect(closingAsk("Do you want me to commit?")).toBe("request");
		expect(closingAsk("What's next?")).toBe("question");
	});
});

describe("normalizeQuestion", () => {
	it("folds case, punctuation and whitespace", () => {
		expect(normalizeQuestion("Shall I run the tests?")).toBe(normalizeQuestion("shall  i run the TESTS"));
		expect(normalizeQuestion("Quer que eu faça o commit?")).toBe(normalizeQuestion("quer  que eu FAÇA o commit"));
	});
});
