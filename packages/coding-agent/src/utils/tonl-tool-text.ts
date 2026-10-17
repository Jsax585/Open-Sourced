/**
 * Render uniform records as TONL tabular text when that is shorter than JSON.
 *
 * TONL (https://tonl.dev) collapses an array of same-shaped objects to a header
 * plus one row per record. Tool results are the only place this is applied:
 * the model re-reads that text on later turns. Nested values, prose, and
 * payloads that do not shrink stay JSON.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Scalar = string | number | boolean | null;

function isScalar(value: unknown): value is Scalar {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function plainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quoteScalar(value: Scalar): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : JSON.stringify(value);
	if (value === "" || /[\s,"\\:#]/.test(value) || value.startsWith("&") || value.startsWith("*")) {
		return JSON.stringify(value);
	}
	return value;
}

function tabular(name: string, rows: readonly Record<string, unknown>[]): string | null {
	if (rows.length < 2 || !IDENT.test(name)) return null;
	const keys = Object.keys(rows[0] ?? {});
	if (keys.length === 0 || keys.length > 32 || !keys.every(key => IDENT.test(key))) return null;
	for (const row of rows) {
		const rowKeys = Object.keys(row);
		if (rowKeys.length !== keys.length || rowKeys.some((key, index) => key !== keys[index])) return null;
		for (const key of keys) {
			if (!isScalar(row[key])) return null;
		}
	}
	const body = rows.map(row => `  ${keys.map(key => quoteScalar(row[key] as Scalar)).join(", ")}`).join("\n");
	return `${name}[${rows.length}]{${keys.join(",")}}:\n${body}`;
}

function valueToTonl(value: unknown, name = "rows"): string | null {
	if (Array.isArray(value)) {
		if (!value.every(plainObject)) return null;
		return tabular(name, value);
	}
	if (!plainObject(value)) return null;
	const lines: string[] = [];
	let sawTable = false;
	for (const [key, field] of Object.entries(value)) {
		if (Array.isArray(field) && field.length >= 2 && field.every(plainObject)) {
			const table = tabular(key, field);
			if (!table) return null;
			lines.push(table);
			sawTable = true;
			continue;
		}
		if (isScalar(field) && IDENT.test(key)) {
			lines.push(`${key}: ${quoteScalar(field)}`);
			continue;
		}
		return null;
	}
	return sawTable ? lines.join("\n") : null;
}

function prettyJson(value: unknown): string | null {
	try {
		return JSON.stringify(value, null, 2) ?? "null";
	} catch {
		return null;
	}
}

/** Model-facing rendering. Returns TONL only when it is shorter than pretty JSON. */
export function formatModelData(value: unknown): string {
	const json = prettyJson(value);
	if (json === null) return String(value);
	const tonl = valueToTonl(value);
	if (tonl && Buffer.byteLength(tonl) < Buffer.byteLength(json)) return tonl;
	return json;
}

/**
 * Rewrite a tool-result text block when it is JSON that shrinks as TONL.
 * Non-JSON text is returned unchanged.
 */
export function formatModelText(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return text;
	}
	const formatted = formatModelData(parsed);
	if (!/\[\d+\]\{/.test(formatted)) return text;
	return Buffer.byteLength(formatted) < Buffer.byteLength(trimmed) ? formatted : text;
}
