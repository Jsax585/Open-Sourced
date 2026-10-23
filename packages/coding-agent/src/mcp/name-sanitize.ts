/**
 * Validator-strict normalization for `mcp__…` registry names (lowercase,
 * hyphen folded to `_`, digits controlled by `keepDigits`, underscores
 * collapsed and trimmed, caller's fallback substituted when empty).
 */
export interface SanitizeNamePartOptions {
	keepDigits?: boolean;
}

export function sanitizeNamePart(value: string, fallback: string, opts?: SanitizeNamePartOptions): string {
	// Lowercase, hyphen folded to `_`, and doubled underscores collapsed so the
	// server/tool boundary is preserved. `keepDigits` selects current vs legacy mint.
	const keepDigits = opts?.keepDigits ?? true;
	const sanitized = value
		.toLowerCase()
		.replace(keepDigits ? /[^a-z0-9_]+/g : /[^a-z_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");

	return sanitized.length > 0 ? sanitized : fallback;
}
