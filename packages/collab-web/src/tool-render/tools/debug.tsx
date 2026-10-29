/** `debug` — DAP debugger sessions: launch/attach, breakpoints, stepping, evaluate. */
import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n-browser";
import type { ReactNode } from "react";
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
	return action ? action.replace(/_/g, " ") : __ompTranslate("request");
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
	["adapter", __ompTranslate("adapter")],
	["cwd", __ompTranslate("cwd")],
	["function", __ompTranslate("function")],
	["name", __ompTranslate("name")],
	["condition", __ompTranslate("condition")],
	["hit_condition", __ompTranslate("hit condition")],
	["context", __ompTranslate("context")],
	["frame_id", __ompTranslate("frame id")],
	["scope_id", __ompTranslate("scope id")],
	["variable_ref", __ompTranslate("variable ref")],
	["pid", "pid"],
	["host", __ompTranslate("host")],
	["port", __ompTranslate("port")],
	["levels", __ompTranslate("levels")],
	["memory_reference", __ompTranslate("memory ref")],
	["instruction_reference", __ompTranslate("instruction ref")],
	["instruction_count", __ompTranslate("instruction count")],
	["instruction_offset", __ompTranslate("instruction offset")],
	["offset", __ompTranslate("offset")],
	["count", __ompTranslate("count")],
	["data", __ompTranslate("data")],
	["data_id", __ompTranslate("data id")],
	["access_type", __ompTranslate("access")],
	["command", __ompTranslate("command")],
	["resolve_symbols", __ompTranslate("resolve symbols")],
	["allow_partial", __ompTranslate("allow partial")],
	["start_module", __ompTranslate("start module")],
	["module_count", __ompTranslate("module count")],
	["timeout", __ompTranslate("timeout")],
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
			<Kv key="program" k="program">
				<PathText path={program} />
			</Kv>,
		);
	}
	if (programArgs.length > 0) {
		argRows.push(
			<Kv key="args" k={__ompTranslate("args")}>
				{truncate(programArgs.join(" "), 160)}
			</Kv>,
		);
	}
	if (file !== null) {
		argRows.push(
			<Kv key="file" k={__ompTranslate("file\u0004tool.debug.file")}>
				<PathText path={file} from={line ?? undefined} />
			</Kv>,
		);
	} else if (line !== null) {
		argRows.push(
			<Kv key="line" k={__ompTranslate("line")}>
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
			{expression !== null && <CodeBlock code={expression} title={__ompTranslate("expression")} maxLines={8} />}
			{customArgsJson && (
				<CodeBlock code={customArgsJson} lang="json" title={__ompTranslate("arguments")} maxLines={10} />
			)}
			{snapshot && (
				<KvGrid>
					{snapshot.id !== null && <Kv k={__ompTranslate("session")}>{snapshot.id}</Kv>}
					{snapshot.adapter !== null && <Kv k={__ompTranslate("adapter")}>{snapshot.adapter}</Kv>}
					{snapshot.status !== null && (
						<Kv k={__ompTranslate("status")}>
							<Badge tone={snapshot.status === "exited" ? "warn" : "ok"}>{snapshot.status}</Badge>
						</Kv>
					)}
					{snapshot.program !== null && (
						<Kv k="program">
							<PathText path={snapshot.program} />
						</Kv>
					)}
					{snapshot.stopReason !== null && <Kv k={__ompTranslate("stop reason")}>{snapshot.stopReason}</Kv>}
					{snapshot.frameName !== null && <Kv k={__ompTranslate("frame")}>{snapshot.frameName}</Kv>}
					{snapshot.sourcePath !== null && snapshot.line !== null && (
						<Kv k={__ompTranslate("location")}>
							<PathText
								path={snapshot.sourcePath}
								sel={snapshot.column !== null ? `${snapshot.line}:${snapshot.column}` : String(snapshot.line)}
							/>
						</Kv>
					)}
					{snapshot.exitCode !== null && <Kv k={__ompTranslate("exit code")}>{snapshot.exitCode}</Kv>}
					{snapshot.needsConfigurationDone && (
						<Kv k={__ompTranslate("configuration")}>
							pending configurationDone — set breakpoints, then continue
						</Kv>
					)}
				</KvGrid>
			)}
			<ResultText result={result} maxLines={10} />
		</>
	);
}

export const debugRenderer: ToolRenderer = { Summary, Body };
