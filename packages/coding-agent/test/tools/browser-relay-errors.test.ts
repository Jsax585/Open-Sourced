import { afterEach, describe, expect, it } from "bun:test";
import { VERSION } from "@oh-my-pi/pi-utils";
import { acquireBrowser } from "../../src/tools/browser/registry";

let stopServer: (() => void) | undefined;

afterEach(() => {
	stopServer?.();
	stopServer = undefined;
});

function relayWaitingFor(body: object): string {
	const server = Bun.serve({ port: 0, fetch: () => new Response(JSON.stringify(body), { status: 503 }) });
	stopServer = () => server.stop(true);
	return `http://127.0.0.1:${server.port}`;
}

async function openError(cdpUrl: string): Promise<string> {
	return acquireBrowser({ kind: "relay", cdpUrl }, { cwd: process.cwd() }).then(
		() => "opened",
		(failure: Error) => failure.message,
	);
}

describe("browser relay connection errors", () => {
	// Agents read these errors to recover: a closed Chrome sent them to reinstall the extension,
	// and none of the errors named the escape for pages that need no sign-in.
	it("points a never-connected extension at Chrome first, not at reinstalling", async () => {
		const message = await openError(
			relayWaitingFor({ extensionSeen: false, uptimeMs: 60_000, ompRelayVersion: VERSION }),
		);
		expect(message).toContain("never connected. Chrome may be closed");
		expect(message).toContain("only if the extension is missing");
		expect(message).toContain("`app: { relay: false }`");
	});

	it("names relay: false when the extension went away or nothing serves the relay", async () => {
		const gone = await openError(
			relayWaitingFor({ extensionSeen: true, uptimeMs: 60_000, disconnectedMs: 60_000, ompRelayVersion: VERSION }),
		);
		expect(gone).toContain("disconnected and has not come back");
		expect(gone).toContain("`app: { relay: false }`");

		const port = relayWaitingFor({}).split(":").at(-1);
		stopServer?.();
		const unreachable = await openError(`http://127.0.0.1:${port}`);
		expect(unreachable).toContain("is not reachable");
		expect(unreachable).toContain("`app: { relay: false }`");
	});
});
