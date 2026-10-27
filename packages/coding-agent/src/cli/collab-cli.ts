/**
 * CLI handlers for local Collab discovery and explicit link retrieval.
 * Listing returns metadata only; capabilities travel over authenticated IPC
 * only when a caller requests a link.
 */
import { t } from "@oh-my-pi/pi-utils/i18n";
import { formatAge } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import {
	COLLAB_REGISTRY_VERSION,
	type CollabHostSnapshot,
	type CollabListOptions,
	type CollabResolvedLink,
	listCollabHosts,
	resolveCollabHostLink,
} from "../collab/registry";
import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";

export interface CollabListCommandArgs {
	/** Emit deterministic machine-readable JSON. */
	json: boolean;
	/** Registry overrides (tests). */
	registry?: CollabListOptions;
}

export interface CollabLinkCommandArgs {
	selector: string;
	/** Request a view-only link instead of control access. */
	view: boolean;
	json: boolean;
	/** Registry overrides (tests). */
	registry?: CollabListOptions;
}

/** Versioned top-level JSON shape for `omp collab list --json`. */
export interface CollabListJsonOutput {
	version: number;
	hosts: CollabHostSnapshot[];
}

/** Versioned capability response for `omp collab link --json`. */
export interface CollabLinkJsonOutput extends CollabResolvedLink {
	version: number;
}

export async function runCollabListCommand(
	args: CollabListCommandArgs,
	print: (line: string) => void = line => console.log(line),
): Promise<void> {
	const hosts = await listCollabHosts(args.registry);
	if (args.json) {
		const output: CollabListJsonOutput = { version: COLLAB_REGISTRY_VERSION, hosts };
		print(JSON.stringify(output, null, 2));
		return;
	}

	if (hosts.length === 0) {
		print(chalk.dim(t("No active Collab hosts.")));
		return;
	}

	print(chalk.green(t("{0} active Collab {1}", `${hosts.length}`, `${hosts.length === 1 ? "host" : "hosts"}`)));
	for (const host of hosts) {
		// Session names and POSIX paths come from other processes and may carry
		// tabs, newlines, or escape bytes; keep each on one clean line.
		const name = host.sessionName ? sanitizeDisplayLine(host.sessionName) : "";
		const sessionId = sanitizeDisplayLine(host.sessionId);
		const session = name ? `${name} (${sessionId})` : sessionId;
		const cwd = sanitizeDisplayLine(shortenPath(host.cwd));
		const guests = host.participants - 1;
		const details = [
			`pid ${host.pid}`,
			`gen ${host.generation}`,
			host.model ? sanitizeDisplayLine(`${host.model.provider}/${host.model.id}`) : t("no model"),
			t("started {0}", `${formatAge(Math.round((Date.now() - host.startedAt) / 1000)) || t("just now")}`),
			t("{0} {1}\u0004packages/coding-agent/src/cli/collab-cli.ts:runCollabListCommand.details", `${guests}`, `${guests === 1 ? "guest" : "guests"}`),
			host.access,
			t("relay {0}", `${host.relayConnected ? t("connected") : t("reconnecting")}`),
		];
		if (host.inputRequired) details.push(t("input required"));
		if (host.busy !== null) details.push(host.busy ? t("working") : t("idle\u0004packages/coding-agent/src/cli/collab-cli.ts:runCollabListCommand"));
		print("");
		print(`${host.instanceId}  ${session}  ${chalk.dim(cwd)}`);
		print(`  ${chalk.dim(details.join(" · "))}`);
	}
	print(chalk.dim(t("Get a link: omp collab link <instanceId|pid> [--view]")));
}

export async function runCollabLinkCommand(
	args: CollabLinkCommandArgs,
	print: (line: string) => void = line => console.log(line),
): Promise<void> {
	const link = await resolveCollabHostLink(args.selector, args.view ? "view" : "control", args.registry);
	if (args.json) {
		const output: CollabLinkJsonOutput = { version: COLLAB_REGISTRY_VERSION, ...link };
		print(JSON.stringify(output, null, 2));
		return;
	}
	print(link.url);
}
