import { isRecord } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "../types";

/** Persisted conversion snapshot; replay requires no source-provider packages. */
export interface ImportedContext {
	version: 1;
	messages: AgentMessage[];
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validBlock(block: unknown, assistant: boolean): boolean {
	if (!isRecord(block)) return false;
	switch (block.type) {
		case "text":
			return typeof block.text === "string";
		case "image":
			return typeof block.data === "string" && typeof block.mimeType === "string";
		case "thinking":
			return assistant && typeof block.thinking === "string";
		case "toolCall":
			return (
				assistant &&
				typeof block.id === "string" &&
				block.id.length > 0 &&
				typeof block.name === "string" &&
				block.name.length > 0 &&
				isRecord(block.arguments)
			);
		default:
			return false;
	}
}

function validMessage(message: unknown): message is AgentMessage {
	if (!isRecord(message) || !finite(message.timestamp)) return false;
	if (message.role === "user") {
		return (
			typeof message.content === "string" ||
			(Array.isArray(message.content) && message.content.every(block => validBlock(block, false)))
		);
	}
	if (
		!Array.isArray(message.content) ||
		!message.content.every(block => validBlock(block, message.role === "assistant"))
	) {
		return false;
	}
	if (message.role === "toolResult") {
		return (
			typeof message.toolCallId === "string" &&
			message.toolCallId.length > 0 &&
			typeof message.toolName === "string" &&
			message.toolName.length > 0 &&
			typeof message.isError === "boolean"
		);
	}
	if (
		message.role !== "assistant" ||
		typeof message.api !== "string" ||
		typeof message.provider !== "string" ||
		typeof message.model !== "string" ||
		!isRecord(message.usage) ||
		!isRecord(message.usage.cost) ||
		!["stop", "length", "toolUse", "error", "aborted"].includes(String(message.stopReason))
	)
		return false;
	const usage = message.usage;
	const cost = usage.cost;
	if (!isRecord(cost)) return false;
	return (
		["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(key => finite(usage[key])) &&
		["input", "output", "cacheRead", "cacheWrite", "total"].every(key => finite(cost[key]))
	);
}

/** Reject malformed or future snapshots instead of falling back to obsolete transcript history. */
export function getImportedContext(preserveData?: Record<string, unknown>): ImportedContext | undefined {
	if (!preserveData || !Object.hasOwn(preserveData, "importedContext")) return undefined;
	const context = preserveData.importedContext;
	if (
		!isRecord(context) ||
		context.version !== 1 ||
		!Array.isArray(context.messages) ||
		!context.messages.every(validMessage)
	) {
		throw new Error("Invalid or unsupported imported context (expected version 1 native messages)");
	}
	return context as unknown as ImportedContext;
}

/** A successful successor replaces the import snapshot; never mutate the original on failure. */
export function stripImportedContext(preserveData?: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!preserveData || !Object.hasOwn(preserveData, "importedContext")) return preserveData;
	const { importedContext: _context, ...rest } = preserveData;
	return Object.keys(rest).length > 0 ? rest : undefined;
}
