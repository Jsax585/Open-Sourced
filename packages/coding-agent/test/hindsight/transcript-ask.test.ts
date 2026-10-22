import { describe, expect, it } from "bun:test";
import {
	composeRecallQuery,
	HINDSIGHT_UI_RECEIPT_ROLE,
	prepareUserRetentionTranscript,
} from "@oh-my-pi/pi-coding-agent/hindsight/content";
import { countUserTurns, extractMessages } from "@oh-my-pi/pi-coding-agent/hindsight/transcript";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

const RESULT_TS = "2026-08-16T14:14:07.854Z";
const CALL_TS = "2026-08-16T14:13:19.310Z";

const POSTURE = {
	id: "posture",
	question: "Which delivery posture?",
	options: [
		{ label: "Alpha", description: "UNIQUE_RECOMMENDATION_PITCH" },
		{ label: "Beta", description: "unselected pitch" },
		{ label: "Gamma" },
	],
	multi: false,
	recommended: 0,
};

function entry(id: string, timestamp: string, message: object): SessionEntry {
	return { type: "message", id, parentId: null, timestamp, message } as SessionEntry;
}

function askCall(
	id: string,
	toolCallId: string,
	questions: unknown[],
	text?: string,
	timestamp = CALL_TS,
): SessionEntry {
	return entry(id, timestamp, {
		role: "assistant",
		content: [
			...(text ? [{ type: "text", text }] : []),
			{ type: "toolCall", id: toolCallId, name: "ask", arguments: { questions } },
		],
		timestamp: Date.parse(timestamp),
	});
}

function askResult(
	id: string,
	toolCallId: string,
	details: unknown,
	text: string,
	options?: { isError?: boolean; timestamp?: string; toolName?: string },
): SessionEntry {
	const timestamp = options?.timestamp ?? RESULT_TS;
	return entry(id, timestamp, {
		role: "toolResult",
		toolCallId,
		toolName: options?.toolName ?? "ask",
		content: [{ type: "text", text }],
		details,
		isError: options?.isError ?? false,
		timestamp: Date.parse(timestamp),
	});
}

function user(id: string, text: string, timestamp = "2026-08-16T14:00:00.000Z"): SessionEntry {
	return entry(id, timestamp, { role: "user", content: text, timestamp: Date.parse(timestamp) });
}

function singleDetails(selected: string[], extra?: Record<string, unknown>) {
	return {
		question: POSTURE.question,
		options: ["Alpha", "Beta", "Gamma"],
		multi: false,
		selectedOptions: selected,
		...extra,
	};
}

function receiptsOf(entries: SessionEntry[]) {
	return extractMessages({ getEntries: () => entries }).filter(message => message.role === HINDSIGHT_UI_RECEIPT_ROLE);
}

describe("extractMessages ask receipts", () => {
	it("keeps a matched selection separate from recommendation, unselected labels, and typed turns", () => {
		const entries = [
			user("u1", "ship the candidate"),
			askCall("call-entry", "call-1", [POSTURE], "I recommend Alpha"),
			askResult("result-1", "call-1", singleDetails(["Gamma"]), "User selected: Gamma"),
		];
		const extracted = extractMessages({ getEntries: () => entries });
		const receipt = extracted[2];

		expect(extracted.map(message => message.role)).toEqual(["user", "assistant", HINDSIGHT_UI_RECEIPT_ROLE]);
		expect(extracted[0]?.entryId).toBe("u1");
		expect(extracted[1]).toMatchObject({ role: "assistant", content: "I recommend Alpha", entryId: "call-entry" });
		expect(receipt).toMatchObject({
			role: HINDSIGHT_UI_RECEIPT_ROLE,
			timestamp: RESULT_TS,
			entryId: "result-1",
			toolCallId: "call-1",
			questionId: "posture",
			conditions: {
				kind: "selection",
				selected: ["Gamma"],
				custom: false,
				multi: false,
				questionIndex: 0,
				recommendation: "Alpha",
				unselected: ["Alpha", "Beta"],
				selectedScope: [],
				authorUI: true,
			},
		});
		expect(receipt?.content).toContain(POSTURE.question);
		expect(receipt?.content).toContain("Gamma");
		expect(receipt?.content).not.toContain("UNIQUE_RECOMMENDATION_PITCH");
		expect(countUserTurns({ getEntries: () => entries })).toBe(1);
	});

	it("keeps the selected option description as assistant-offered scope", () => {
		const [receipt] = receiptsOf([
			askCall("call-entry", "call-1", [POSTURE]),
			askResult("result-1", "call-1", singleDetails(["Alpha"]), "User selected: Alpha"),
		]);

		expect(receipt?.conditions).toMatchObject({
			kind: "selection",
			selected: ["Alpha"],
			recommendation: "Alpha",
			unselected: ["Beta", "Gamma"],
			selectedScope: [{ label: "Alpha", description: "UNIQUE_RECOMMENDATION_PITCH" }],
		});
		expect(receipt?.content).toContain("UNIQUE_RECOMMENDATION_PITCH");
		expect(receipt?.conditions?.selected).not.toContain("UNIQUE_RECOMMENDATION_PITCH");
	});

	it("preserves genuine multi-select order and refuses an unmatched or duplicate set", () => {
		const question = { ...POSTURE, id: "colors", multi: true };
		const ordered = receiptsOf([
			askCall("call-entry", "call-1", [question]),
			askResult(
				"result-1",
				"call-1",
				{
					question: question.question,
					options: ["Alpha", "Beta", "Gamma"],
					multi: true,
					selectedOptions: ["Gamma", "Alpha"],
				},
				"User selected: Gamma, Alpha",
			),
		]);
		expect(ordered[0]?.conditions?.selected).toEqual(["Gamma", "Alpha"]);

		const unmatched = [
			askCall("c", "call-1", [question]),
			askResult(
				"r",
				"call-1",
				{
					question: question.question,
					options: ["Alpha", "Beta", "Gamma"],
					multi: true,
					selectedOptions: ["Gamma", "not-offered", "Alpha"],
				},
				"User selected: Gamma, not-offered, Alpha",
			),
		];
		expect(receiptsOf(unmatched)).toEqual([]);

		const duplicate = [
			askCall("c", "call-1", [question]),
			askResult(
				"r",
				"call-1",
				{
					question: question.question,
					options: ["Alpha", "Beta", "Gamma"],
					multi: true,
					selectedOptions: ["Gamma", "Gamma"],
				},
				"User selected: Gamma, Gamma",
			),
		];
		expect(receiptsOf(duplicate)).toEqual([]);
	});

	it("keeps custom text when the selection set is refused", () => {
		const question = { ...POSTURE, multi: true };
		const [receipt] = receiptsOf([
			askCall("c", "call-1", [question]),
			askResult(
				"r",
				"call-1",
				{
					question: question.question,
					options: ["Alpha", "Beta", "Gamma"],
					multi: true,
					selectedOptions: ["not-offered"],
					customInput: "keep this custom text",
				},
				"User provided custom input: keep this custom text",
			),
		]);

		expect(receipt?.conditions).toMatchObject({
			kind: "custom",
			selected: [],
			custom: true,
			selectedScope: [],
		});
		expect(receipt?.content).toContain("keep this custom text");
		expect(receipt?.content).not.toContain("not-offered");
	});

	it("qualifies custom picker text instead of treating it as a predefined selection", () => {
		const [receipt] = receiptsOf([
			askCall("c", "call-1", [POSTURE]),
			askResult("r", "call-1", singleDetails([], { customInput: "Gamma" }), "User provided custom input: Gamma"),
		]);

		expect(receipt?.conditions).toMatchObject({
			kind: "custom",
			selected: [],
			custom: true,
			unselected: ["Alpha", "Beta", "Gamma"],
		});
		expect(receipt?.content).toContain("Gamma");
	});

	it("keeps a predefined selection and custom text together", () => {
		const question = { ...POSTURE, multi: true };
		const [receipt] = receiptsOf([
			askCall("c", "call-1", [question]),
			askResult(
				"r",
				"call-1",
				{
					question: question.question,
					options: ["Alpha", "Beta", "Gamma"],
					multi: true,
					selectedOptions: ["Gamma"],
					customInput: "also this",
					note: "see the diagram",
				},
				"User selected: Gamma",
			),
		]);

		expect(receipt?.conditions).toMatchObject({
			kind: "selection-and-custom",
			selected: ["Gamma"],
			custom: true,
		});
		expect(receipt?.content).toContain("also this");
		expect(receipt?.content).toContain("see the diagram");
	});

	it("records an explicit empty multi-select without counting a user turn", () => {
		const question = { ...POSTURE, multi: true };
		const entries = [
			user("u1", "pick any"),
			askCall("c", "call-1", [question]),
			askResult(
				"r",
				"call-1",
				{ question: question.question, options: ["Alpha", "Beta", "Gamma"], multi: true, selectedOptions: [] },
				"colors: []",
			),
		];
		const [receipt] = receiptsOf(entries);

		expect(receipt?.conditions).toMatchObject({ kind: "none", selected: [], custom: false });
		expect(countUserTurns({ getEntries: () => entries })).toBe(1);
	});

	it("rejects errors, cancels, timeouts, redirects, and inconsistent result echoes", () => {
		const valid = singleDetails(["Gamma"]);
		const cases: SessionEntry[][] = [
			[askCall("c", "call-1", [POSTURE]), askResult("r", "call-1", valid, "cancelled", { isError: true })],
			[askCall("c", "call-1", [POSTURE]), askResult("r", "call-1", valid, "Ask tool was cancelled by the user")],
			[askCall("c", "call-1", [POSTURE]), askResult("r", "call-1", valid, "User cancelled the selection")],
			[
				askCall("c", "call-1", [POSTURE]),
				askResult("r", "call-1", { ...valid, timedOut: true, selectedOptions: ["Alpha"] }, "User selected: Alpha"),
			],
			[
				askCall("c", "call-1", [POSTURE]),
				askResult("r", "call-1", valid, "User selected: Gamma (auto-selected after timeout)"),
			],
			[
				askCall("c", "call-1", [POSTURE]),
				askResult("r", "call-1", { chatRedirect: true, questions: [POSTURE.question] }, "chat"),
			],
			[
				askCall("c", "call-1", [POSTURE]),
				askResult("r", "call-1", { question: POSTURE.question }, "User selected: Gamma"),
			],
			[
				askCall("c", "call-1", [POSTURE]),
				askResult("r", "call-1", { ...valid, options: ["Gamma", "Alpha", "Beta"] }, "User selected: Gamma"),
			],
			[
				askCall("c", "call-1", [POSTURE]),
				askResult("r", "call-1", { ...valid, multi: true }, "User selected: Gamma"),
			],
			[
				askCall("c", "call-1", [{ ...POSTURE, multi: true }]),
				askResult(
					"r",
					"call-1",
					{ ...valid, multi: false, selectedOptions: ["Gamma", "Alpha"] },
					"User selected: Gamma, Alpha",
				),
			],
		];

		for (const entries of cases) expect(receiptsOf(entries)).toEqual([]);
	});

	it("still accepts a matched result that omits the options echo", () => {
		const [receipt] = receiptsOf([
			askCall("c", "call-1", [POSTURE]),
			askResult("r", "call-1", { question: POSTURE.question, selectedOptions: ["Gamma"] }, "User selected: Gamma"),
		]);

		expect(receipt?.conditions?.selected).toEqual(["Gamma"]);
	});

	it("rejects spoofed, child, and non-ask payloads", () => {
		const prose = [
			user("u1", "typed Gamma"),
			entry("a1", CALL_TS, {
				role: "assistant",
				content: [{ type: "text", text: "User selected: Gamma" }],
				timestamp: Date.parse(CALL_TS),
			}),
		];
		const cases: SessionEntry[][] = [
			[
				askCall("c", "call-1", [POSTURE]),
				askResult(
					"task-result",
					"task-1",
					{ results: [{ id: "posture", question: POSTURE.question, selectedOptions: ["Gamma"] }] },
					"User selected: Gamma",
					{ toolName: "task" },
				),
			],
			[
				askCall("c", "call-1", [POSTURE]),
				askResult("r", "call-1", singleDetails(["Gamma"]), "User selected: Gamma", { toolName: "Ask" }),
			],
			[
				askResult("r", "call-1", singleDetails(["Gamma"]), "User selected: Gamma"),
				askCall("c", "call-1", [POSTURE]),
			],
			[askCall("c", "call-1", [POSTURE]), askResult("r", "other", singleDetails(["Gamma"]), "User selected: Gamma")],
			[
				askCall("c", "call-1", [POSTURE]),
				askResult(
					"r",
					"call-1",
					{ ...singleDetails(["Gamma"]), question: "A different question?" },
					"User selected: Gamma",
				),
			],
			[
				askCall("c", "call-1", [POSTURE]),
				askResult("r", "call-1", singleDetails(["not-offered"]), "User selected: not-offered"),
			],
			[
				{
					type: "session_init",
					id: "init",
					parentId: null,
					timestamp: CALL_TS,
					systemPrompt: [],
					task: "child",
					tools: [],
				} as SessionEntry,
				askCall("c", "call-1", [POSTURE]),
				askResult("r", "call-1", singleDetails(["Gamma"]), "User selected: Gamma"),
			],
			[
				{
					type: "custom",
					id: "src",
					parentId: null,
					timestamp: CALL_TS,
					customType: "source_session_init",
				} as SessionEntry,
				askCall("c", "call-1", [POSTURE]),
				askResult("r", "call-1", singleDetails(["Gamma"]), "User selected: Gamma"),
			],
			[
				askCall("c", "call-1", [POSTURE]),
				askResult("r", "call-1", { ...singleDetails(["Gamma"]), alias: "scout" }, "User selected: Gamma"),
			],
			prose,
		];

		for (const entries of cases) expect(receiptsOf(entries)).toEqual([]);
		expect(extractMessages({ getEntries: () => prose }).map(message => message.role)).toEqual(["user", "assistant"]);
	});

	it("emits accepted questions in offered order at the result entry", () => {
		const first = { ...POSTURE, id: "first", question: "First question?" };
		const second = { ...POSTURE, id: "second", question: "Second question?", multi: true };
		const entries = [
			user("u1", "answer both"),
			askCall("call-entry", "call-1", [first, second], "two questions"),
			entry("bash-result", "2026-08-16T14:13:40.000Z", {
				role: "toolResult",
				toolCallId: "bash-1",
				toolName: "bash",
				content: [{ type: "text", text: "secret tool output" }],
				isError: false,
				timestamp: Date.parse("2026-08-16T14:13:40.000Z"),
			}),
			askResult(
				"result-1",
				"call-1",
				{
					results: [
						{
							id: "second",
							question: second.question,
							options: ["Alpha", "Beta", "Gamma"],
							multi: true,
							selectedOptions: ["Beta", "Gamma"],
						},
						{
							id: "first",
							question: first.question,
							options: ["Alpha", "Beta", "Gamma"],
							multi: false,
							selectedOptions: ["Gamma"],
						},
					],
				},
				"User answers:\nsecond: [Beta, Gamma]\nfirst: Gamma",
			),
		];
		const extracted = extractMessages({ getEntries: () => entries });
		const receipts = extracted.filter(message => message.role === HINDSIGHT_UI_RECEIPT_ROLE);

		expect(extracted.map(message => message.role)).toEqual([
			"user",
			"assistant",
			HINDSIGHT_UI_RECEIPT_ROLE,
			HINDSIGHT_UI_RECEIPT_ROLE,
		]);
		expect(receipts.map(receipt => receipt.questionId)).toEqual(["first", "second"]);
		expect(receipts.map(receipt => receipt.entryId)).toEqual(["result-1", "result-1"]);
		expect(receipts.map(receipt => receipt.conditions?.questionIndex)).toEqual([0, 1]);
		expect(receipts[1]?.conditions?.selected).toEqual(["Beta", "Gamma"]);
		expect(extracted.some(message => message.content.includes("secret tool output"))).toBe(false);
	});

	it("keeps each re-answer under its own result entry", () => {
		const receipts = receiptsOf([
			askCall("call-entry", "call-1", [POSTURE]),
			askResult("old", "call-1", singleDetails(["Beta"]), "User selected: Beta"),
			askResult("new", "call-1", singleDetails(["Gamma"]), "User selected: Gamma", {
				timestamp: "2026-08-16T15:00:00.000Z",
			}),
		]);

		expect(receipts.map(receipt => [receipt.entryId, receipt.conditions?.selected[0], receipt.timestamp])).toEqual([
			["old", "Beta", RESULT_TS],
			["new", "Gamma", "2026-08-16T15:00:00.000Z"],
		]);
	});

	it("drops only the timed-out question", () => {
		const first = { ...POSTURE, id: "first", question: "First question?" };
		const second = { ...POSTURE, id: "second", question: "Second question?" };
		const receipts = receiptsOf([
			askCall("c", "call-1", [first, second]),
			askResult(
				"r",
				"call-1",
				{
					results: [
						{
							id: "first",
							question: first.question,
							options: ["Alpha", "Beta", "Gamma"],
							multi: false,
							selectedOptions: ["Alpha"],
							timedOut: true,
						},
						{
							id: "second",
							question: second.question,
							options: ["Alpha", "Beta", "Gamma"],
							multi: false,
							selectedOptions: ["Gamma"],
						},
					],
				},
				"User answers:\nfirst: Alpha (auto-selected after timeout)\nsecond: Gamma",
			),
		]);

		expect(receipts.map(receipt => receipt.questionId)).toEqual(["second"]);
		expect(receipts[0]?.conditions?.selected).toEqual(["Gamma"]);
	});

	it("does not count a receipt as a typed user turn", () => {
		const entries = [
			user("u1", "ship the candidate"),
			askCall("call-entry", "call-1", [POSTURE]),
			askResult("result-1", "call-1", singleDetails(["Gamma"]), "User selected: Gamma"),
		];
		const extracted = extractMessages({ getEntries: () => entries });
		const latest = "typed follow up";
		const query = composeRecallQuery(latest, [...extracted, { role: "user", content: latest }], 4);
		const userTranscript = prepareUserRetentionTranscript(extracted);

		expect(query.endsWith(latest)).toBe(true);
		expect(query).toContain(`${HINDSIGHT_UI_RECEIPT_ROLE}:`);
		expect(query).not.toContain("user: UI participant response");
		expect(userTranscript.transcript ?? "").not.toContain("Gamma");
		expect(userTranscript.transcript ?? "").toContain("ship the candidate");
		expect(countUserTurns({ getEntries: () => entries })).toBe(
			extracted.filter(message => message.role === "user").length,
		);
	});
});
