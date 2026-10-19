import { getProjectPromptsDir, getPromptsDir, isEnoent } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type PromptTemplate, promptTemplateCommandName, templateUsesInlineArgPlaceholders } from "./prompt-templates";

export type SnippetScope = "user" | "project";

/** Letter, then letters/digits/_/-. Doubles as the path-traversal guard. */
export const SNIPPET_NAME_PATTERN = /^[a-zA-Z][\w-]*$/;
export const NO_SNIPPETS_MESSAGE = "No snippets saved. Use /snippets save <name> [text] to create one.";
export const SNIPPETS_USAGE =
	"Usage: /snippets [save <name> [--scope user|project] [--force] [text] | delete <name> [--scope user|project]]";

const SAVE_USAGE = "Usage: /snippets save <name> [--scope user|project] [--force] [text]";
const DELETE_USAGE = "Usage: /snippets delete <name> [--scope user|project]";
const SCOPE_ERROR = "--scope must be user or project";
const DESCRIPTION_LIMIT = 80;
const PREVIEW_LIMIT = 400;

export function isValidSnippetName(name: string): boolean {
	return SNIPPET_NAME_PATTERN.test(name);
}

export function snippetsDir(scope: SnippetScope, cwd: string): string {
	return scope === "user" ? getPromptsDir() : getProjectPromptsDir(cwd);
}

export function snippetPath(dir: string, name: string): string {
	if (!isValidSnippetName(name)) throw new Error(`Invalid snippet name "${name}"`);
	return path.join(dir, `${name}.md`);
}

const INVALID_NAME_HINT = "use a letter, then letters, digits, - or _";

export type SaveArgs = { name: string; scope: SnippetScope; force: boolean; text: string } | { error: string };

export function parseSaveArgs(rest: string): SaveArgs {
	const tokenPattern = /\s*(\S+)/y;
	let position = 0;
	const next = (): string | undefined => {
		tokenPattern.lastIndex = position;
		const match = tokenPattern.exec(rest);
		if (!match) return undefined;
		position = tokenPattern.lastIndex;
		return match[1];
	};

	const name = next();
	if (!name) return { error: SAVE_USAGE };
	if (!isValidSnippetName(name)) return { error: `Invalid snippet name "${name}": ${INVALID_NAME_HINT}` };

	let scope: SnippetScope = "user";
	let force = false;
	for (;;) {
		const before = position;
		const token = next();
		if (token === "--force") {
			force = true;
		} else if (token === "--scope") {
			const value = next();
			if (value !== "user" && value !== "project") return { error: SCOPE_ERROR };
			scope = value;
		} else {
			position = before;
			break;
		}
	}
	return { name, scope, force, text: rest.slice(position).trim() };
}

export type DeleteArgs = { name: string; scope?: SnippetScope } | { error: string };

export function parseDeleteArgs(rest: string): DeleteArgs {
	const tokens = rest.split(/\s+/).filter(Boolean);
	const name = tokens[0];
	if (!name) return { error: DELETE_USAGE };
	if (!isValidSnippetName(name)) return { error: `Invalid snippet name "${name}": ${INVALID_NAME_HINT}` };

	let scope: SnippetScope | undefined;
	for (let i = 1; i < tokens.length;) {
		const token = tokens[i]!;
		if (token !== "--scope") return { error: `Unknown option: ${token}` };
		const value = tokens[i + 1];
		if (value !== "user" && value !== "project") return { error: SCOPE_ERROR };
		scope = value;
		i += 2;
	}
	return scope ? { name, scope } : { name };
}

export function resolveSnippetText(inline: string, userMessages: ReadonlyArray<{ text: string }>): string | undefined {
	const trimmed = inline.trim();
	if (trimmed) return trimmed;
	const last = userMessages.at(-1)?.text.trim();
	return last ? last : undefined;
}

function truncate(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function deriveDescription(text: string): string {
	const firstLine = text.split("\n").find(line => line.trim()) ?? "";
	return truncate(firstLine.replace(/\s+/g, " ").trim(), DESCRIPTION_LIMIT);
}

export type SaveResult = { kind: "saved"; path: string } | { kind: "exists"; path: string };

export async function saveSnippet(options: {
	dir: string;
	name: string;
	text: string;
	force: boolean;
}): Promise<SaveResult> {
	const file = snippetPath(options.dir, options.name);
	const body = options.text.trim();
	// Frontmatter is always written: a body that itself starts with `---` would otherwise be parsed as frontmatter.
	const content = `---\ndescription: ${JSON.stringify(deriveDescription(body))}\n---\n${body}\n`;
	await fs.mkdir(options.dir, { recursive: true });
	try {
		await fs.writeFile(file, content, { flag: options.force ? "w" : "wx" });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return { kind: "exists", path: file };
		throw err;
	}
	return { kind: "saved", path: file };
}

export async function deleteSnippet(dir: string, name: string): Promise<"deleted" | "missing"> {
	try {
		await fs.rm(snippetPath(dir, name));
		return "deleted";
	} catch (err) {
		if (isEnoent(err)) return "missing";
		throw err;
	}
}

export interface SnippetChoice {
	label: string;
	description: string;
	insertText: string;
}

export function buildSnippetChoices(templates: readonly PromptTemplate[]): SnippetChoice[] {
	const counts = new Map<string, number>();
	for (const template of templates) counts.set(template.name, (counts.get(template.name) ?? 0) + 1);

	const sorted = [...templates].sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
	return sorted.map(template => {
		const { name, source, content } = template;
		const duplicated = (counts.get(name) ?? 0) > 1;
		const invocation = !duplicated && templateUsesInlineArgPlaceholders(content);
		const command = `/${promptTemplateCommandName(template)}`;
		const preview = truncate(content.replace(/\s+/g, " ").trim(), PREVIEW_LIMIT);
		const hint = invocation ? `takes arguments, inserts ${command} · ` : "";
		return {
			label: duplicated ? `${name} ${source}` : name,
			description: `${source} · ${hint}${preview}`,
			insertText: invocation ? `${command} ` : content,
		};
	});
}
