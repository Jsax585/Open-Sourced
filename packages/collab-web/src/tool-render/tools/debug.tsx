/** `debug` — DAP debugger sessions: launch/attach, breakpoints, stepping, evaluate. */
import { t } from "@oh-my-pi/pi-utils/i18n-browser";
import type { ReactNode } from "react";
import { formatStatus } from "../../lib/format";
import { Badge, CodeBlock, Kv, KvGrid, PathText, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, display, isRecord, normalizeWs, num, str, truncate } from "../util";

/** Session snapshot the TUI renders as its "Session" section (details.snapshot). */
interface SessionSnapshot {
	id: string | null;
	adapter: string | null;
	status: string | null;
	program: string | null;
	stopReason: string | null;
	frameName: string | null;
	sourcePath: string | null;
	line: number | null;
	column: number | null;
	exitCode: number | null;
	needsConfigurationDone: boolean;
}

function snapshotOf(result: ToolRenderProps["result"]): SessionSnapshot | null {
	const rec = detailsRecord(result);
	if (!rec || !isRecord(rec.snapshot)) return null;
	const snap = rec.snapshot;
	const source = isRecord(snap.source) ? snap.source : null;
	return {
		id: str(snap.id) ?? (num(snap.id) !== null ? String(snap.id) : null),
		adapter: str(snap.adapter),
		status: str(snap.status),
		program: str(snap.program),
		stopReason: str(snap.stopReason),
		frameName: str(snap.frameName),
		sourcePath: source ? str(source.path) : null,
		line: num(snap.line),
		column: num(snap.column),
		exitCode: num(snap.exitCode),
		needsConfigurationDone: snap.needsConfigurationDone === true,
	};
}

function actionOf(props: ToolRenderProps): string {
	const action = str(props.args.action) ?? str(detailsRecord(props.result)?.action);
	return action ? action.replace(/_/g, " ") : t("request");
}

/** Mirrors the TUI's summarizeDebugCall target priority. */
function targetTextOf(args: Record<string, unknown>): string | null {
	return (
		str(args.function) ??
		str(args.expression) ??
		str(args.command) ??
		str(args.memory_reference) ??
		str(args.instruction_reference) ??
		str(args.data_id) ??
		str(args.name)
	);
}

function Summary(props: ToolRenderProps): ReactNode {
	const { args } = props;
	const program = str(args.program);
	const file = str(args.file);
	const line = num(args.line);
	const target = targetTextOf(args);
	return (
		<>
			<Badge tone="accent">{actionOf(props)}</Badge>
			{program !== null ? (
				<PathText path={program} />
			) : file !== null ? (
				<PathText path={file} from={line ?? undefined} />
			) : target !== null ? (
				<span>{truncate(normalizeWs(target), 80)}</span>
			) : null}
		</>
	);
}

/** Scalar args worth a KvGrid row, in display order (program/file/expression are special-cased). */
const SCALAR_ARGS: ReadonlyArray<readonly [key: string, label: string]> = [
	["adapter", t("adapter")],
	["cwd", t("cwd")],
	["function", t("function")],
	["name", t("name")],
	["condition", t("condition")],
	["hit_condition", t("hit condition")],
	["context", t("context")],
	["frame_id", t("frame id")],
	["scope_id", t("scope id")],
	["variable_ref", t("variable ref")],
	["pid", "pid"],
	["host", t("host")],
	["port", t("port")],
	["levels", t("levels")],
	["memory_reference", t("memory ref")],
	["instruction_reference", t("instruction ref")],
	["instruction_count", t("instruction count")],
	["instruction_offset", t("instruction offset")],
	["offset", t("offset")],
	["count", t("count")],
	["data", t("data")],
	["data_id", t("data id")],
	["access_type", t("access")],
	["command", t("command")],
	["resolve_symbols", t("resolve symbols")],
	["allow_partial", t("allow partial")],
	["start_module", t("start module")],
	["module_count", t("module count")],
	["timeout", t("timeout")],
];

function Body(props: ToolRenderProps): ReactNode {
	const { args, result } = props;
	const program = str(args.program);
	const file = str(args.file);
	const line = num(args.line);
	const expression = str(args.expression);
	const programArgs = Array.isArray(args.args) ? args.args.filter(a => typeof a === "string") : [];

	const argRows: ReactNode[] = [];
	if (program !== null) {
		argRows.push(
			<Kv key="program" k={t("program")}>
				<PathText path={program} />
			</Kv>,
		);
	}
	if (programArgs.length > 0) {
		argRows.push(
			<Kv key="args" k={t("args")}>
				{truncate(programArgs.join(" "), 160)}
			</Kv>,
		);
	}
	if (file !== null) {
		argRows.push(
			<Kv key="file" k={t("file\u0004packages/collab-web/src/tool-render/tools/debug.tsx:Body")}>
				<PathText path={file} from={line ?? undefined} />
			</Kv>,
		);
	} else if (line !== null) {
		argRows.push(
			<Kv key="line" k={t("line")}>
				{line}
			</Kv>,
		);
	}
	for (const [key, label] of SCALAR_ARGS) {
		const value = args[key];
		if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
		argRows.push(
			<Kv key={key} k={label}>
				{truncate(display(value), 120)}
			</Kv>,
		);
	}

	let customArgsJson = "";
	if (isRecord(args.arguments)) {
		try {
			customArgsJson = JSON.stringify(args.arguments, null, 2) ?? "";
		} catch {
			customArgsJson = "";
		}
	}

	const snapshot = snapshotOf(result);
	return (
		<>
			{argRows.length > 0 && <KvGrid>{argRows}</KvGrid>}
			{expression !== null && <CodeBlock code={expression} title={t("expression")} maxLines={8} />}
			{customArgsJson && <CodeBlock code={customArgsJson} lang="json" title={t("arguments")} maxLines={10} />}
			{snapshot && (
				<KvGrid>
					{snapshot.id !== null && <Kv k={t("session")}>{snapshot.id}</Kv>}
					{snapshot.adapter !== null && <Kv k={t("adapter")}>{snapshot.adapter}</Kv>}
					{snapshot.status !== null && (
						<Kv k={t("status")}>
							<Badge tone={snapshot.status === "exited" ? "warn" : "ok"}>{formatStatus(snapshot.status)}</Badge>
						</Kv>
					)}
					{snapshot.program !== null && (
						<Kv k={t("program")}>
							<PathText path={snapshot.program} />
						</Kv>
					)}
					{snapshot.stopReason !== null && <Kv k={t("stop reason")}>{snapshot.stopReason}</Kv>}
					{snapshot.frameName !== null && <Kv k={t("frame")}>{snapshot.frameName}</Kv>}
					{snapshot.sourcePath !== null && snapshot.line !== null && (
						<Kv k={t("location")}>
							<PathText
								path={snapshot.sourcePath}
								sel={snapshot.column !== null ? `${snapshot.line}:${snapshot.column}` : String(snapshot.line)}
							/>
						</Kv>
					)}
					{snapshot.exitCode !== null && <Kv k={t("exit code")}>{snapshot.exitCode}</Kv>}
					{snapshot.needsConfigurationDone && (
						<Kv k={t("configuration")}>{t("pending configurationDone — set breakpoints, then continue")}</Kv>
					)}
				</KvGrid>
			)}
			<ResultText result={result} maxLines={10} />
		</>
	);
}

export const debugRenderer: ToolRenderer = { Summary, Body };
