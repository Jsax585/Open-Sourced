import { describe, expect, it } from "bun:test";
import { type RelayFailure, relayFailureMessage } from "../../src/tools/browser/relay/probe";

// Agents read these errors to recover: a closed Chrome sent them to reinstall the extension,
// and none of the errors named the escape for pages that need no sign-in.
describe("relayFailureMessage", () => {
	it.each<[RelayFailure, string[]]>([
		["no-extension", ["never connected. Chrome may be closed", "only if the extension is missing"]],
		["extension-gone", ["disconnected and has not come back"]],
		["unreachable", ["is not reachable"]],
		["outdated-relay", ["is out of date"]],
		["outdated-extension", ["extension is out of date"]],
	])("%s names the cause and the relay: false escape", (outcome, parts) => {
		const message = relayFailureMessage(outcome, "http://127.0.0.1:9224");
		for (const part of [...parts, "`app: { relay: false }`"]) expect(message).toContain(part);
	});
});
