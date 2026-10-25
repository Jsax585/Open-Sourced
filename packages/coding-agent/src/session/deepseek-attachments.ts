import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { isRecord, parseImageMetadata } from "@oh-my-pi/pi-utils";
import { imageDecodeFailureReason } from "@oh-my-pi/pi-tui/chat/image-loading";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionManager } from "./session-manager";

interface DetachedAttachment {
	sourceId: string;
	token: string;
	kind: "image" | "file";
	mediaType: string;
	size: number;
	name?: string;
	width?: number;
	height?: number;
	originalDimensions?: { width: number; height: number };
	data: Buffer;
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validName(value: unknown, file: boolean): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value !== value.trim() ||
		/[/\\\u0000-\u001f\u007f]/u.test(value)
	)
		return false;
	if (!file) return value.length <= 255 && value !== "." && value !== "..";
	const stem = value.split(".", 1)[0].replace(/[. ]+$/u, "");
	return (
		Buffer.byteLength(value) <= 255 &&
		Buffer.from(value).toString("utf8") === value &&
		!/[<>:"|?*]|[. ]$/u.test(value) &&
		!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem)
	);
}

/** Read-only DeepSeek attachment snapshots, materialized only when an import is persisted. */
export class DeepSeekAttachments {
	#home: string;
	#attachments = new Map<string, DetachedAttachment>();

	constructor(home: string) {
		this.#home = path.resolve(home);
	}

	async content(block: unknown): Promise<ImageContent | TextContent> {
		if (!isRecord(block) || (block.type !== "image" && block.type !== "file") || !isRecord(block.attachment)) {
			throw new Error("Invalid DeepSeek attachment block");
		}
		if (
			Object.keys(block).some(key => !["type", "attachment", "offloaded"].includes(key)) ||
			(block.offloaded !== undefined && (block.type !== "image" || block.offloaded !== true))
		) {
			throw new Error("Invalid DeepSeek attachment block layout");
		}
		const ref = block.attachment;
		const kind = block.type;
		const allowed =
			kind === "image"
				? ["attachmentId", "bytes", "name", "mediaType", "width", "height", "originalDimensions"]
				: ["attachmentId", "bytes", "name"];
		const match = typeof ref.attachmentId === "string" ? /^sha256:([a-f0-9]{64})$/.exec(ref.attachmentId) : null;
		if (
			!match ||
			Object.keys(ref).some(key => !allowed.includes(key)) ||
			!Number.isSafeInteger(ref.bytes) ||
			typeof ref.bytes !== "number" ||
			ref.bytes < 0 ||
			(kind === "file" ? !validName(ref.name, true) : ref.name !== undefined && !validName(ref.name, false))
		) {
			throw new Error("Invalid DeepSeek attachment reference");
		}
		const sourceId = ref.attachmentId as string;
		let mediaType = "application/octet-stream";
		let originalDimensions: DetachedAttachment["originalDimensions"];
		if (kind === "image") {
			if (
				typeof ref.mediaType !== "string" ||
				!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(ref.mediaType) ||
				!positiveInteger(ref.width) ||
				!positiveInteger(ref.height) ||
				ref.bytes === 0
			) {
				throw new Error("Invalid DeepSeek image metadata");
			}
			mediaType = ref.mediaType;
			if (ref.originalDimensions !== undefined) {
				const dimensions = ref.originalDimensions;
				if (
					!isRecord(dimensions) ||
					Object.keys(dimensions).some(key => key !== "width" && key !== "height") ||
					!positiveInteger(dimensions.width) ||
					!positiveInteger(dimensions.height)
				) {
					throw new Error("Invalid DeepSeek original image dimensions");
				}
				originalDimensions = { width: dimensions.width, height: dimensions.height };
			}
		}
		const digest = match[1];
		const key = JSON.stringify([kind, sourceId, ref.name]);
		const cached = this.#attachments.get(key);
		if (
			cached &&
			(cached.size !== ref.bytes ||
				cached.mediaType !== mediaType ||
				(kind === "image" &&
					(cached.width !== ref.width ||
						cached.height !== ref.height ||
						cached.originalDimensions?.width !== originalDimensions?.width ||
						cached.originalDimensions?.height !== originalDimensions?.height)))
		) {
			throw new Error("Conflicting DeepSeek attachment metadata");
		}
		let data = cached?.data;
		if (!data) {
			try {
				const home = await fs.realpath(this.#home);
				const root = path.join(home, "attachments", "v1");
				const sourcePath =
					kind === "image"
						? path.join(root, "objects", digest.slice(0, 2), digest)
						: path.join(root, "files", digest.slice(0, 2), digest, ref.name as string);
				if ((await fs.realpath(sourcePath)) !== sourcePath || !(await fs.stat(sourcePath)).isFile()) {
					throw new Error("Invalid DeepSeek attachment storage layout");
				}
				data = await fs.readFile(sourcePath);
			} catch {
				throw new Error(
					`Missing required DeepSeek attachment ${sourceId}; restore referenced bytes under DSH_HOME/attachments/v1`,
				);
			}
		}
		if (data.length !== ref.bytes || new Bun.CryptoHasher("sha256").update(data).digest("hex") !== digest) {
			throw new Error("DeepSeek attachment bytes do not match their size or digest");
		}
		if (kind === "image" && !cached) {
			const metadata = parseImageMetadata(data);
			if (metadata?.mimeType !== mediaType || metadata.width !== ref.width || metadata.height !== ref.height) {
				throw new Error("DeepSeek image bytes do not match their media type or dimensions");
			}
			const failure = await imageDecodeFailureReason({
				type: "image",
				mimeType: mediaType,
				data: data.toString("base64"),
			});
			if (failure !== null) throw new Error(`Invalid DeepSeek image bytes: ${failure}`);
		}
		const attachment: DetachedAttachment = {
			sourceId,
			kind,
			mediaType,
			size: data.length,
			data,
			token: cached?.token ?? `deepseek-attachment:${crypto.randomUUID()}`,
			...(ref.name === undefined ? {} : { name: ref.name as string }),
			...(kind === "image" ? { width: ref.width as number, height: ref.height as number } : {}),
			...(originalDimensions ? { originalDimensions } : {}),
		};
		this.#attachments.set(key, attachment);
		if (kind === "image" && block.offloaded !== true) {
			return { type: "image", mimeType: mediaType, data: data.toString("base64") };
		}
		const label = kind === "file" ? "Historical DeepSeek file" : "Historical DeepSeek offloaded image";
		return {
			type: "text",
			text: `[${label}${attachment.name ? ` ${JSON.stringify(attachment.name)}` : ""}, ${data.length} bytes: ${attachment.token}]`,
		};
	}

	/** Called before target journal publication; the runtime owns failed-target cleanup. */
	async preparePersist(source: SessionManager, target: SessionManager): Promise<void> {
		if (source === target) throw new Error("DeepSeek attachments require a separate import destination");
		if (this.#attachments.size === 0) return;
		const entries = target.getEntries();
		const boundary = entries.findLast(
			entry =>
				entry.type === "compaction" &&
				entry.preserveData &&
				Object.hasOwn(entry.preserveData, "deepseekImportContext"),
		);
		if (!boundary || boundary.type !== "compaction") throw new Error("Missing DeepSeek import attachment boundary");
		const replacements = new Map<string, string>();
		const descriptors: (Omit<DetachedAttachment, "data" | "token"> & { id: string })[] = [];
		for (const attachment of this.#attachments.values()) {
			const allocated = await target.allocateArtifactPath("deepseek-attachment");
			if (!allocated.id || !allocated.path) throw new Error("Cannot allocate imported DeepSeek attachment artifact");
			const destination = await fs.open(allocated.path, "wx", 0o600);
			try {
				const written = await destination.write(attachment.data);
				if (written.bytesWritten !== attachment.size) throw new Error("Short write importing DeepSeek attachment");
			} finally {
				await destination.close();
			}
			const copied = await fs.readFile(allocated.path);
			if (!copied.equals(attachment.data))
				throw new Error("Imported DeepSeek attachment failed destination verification");
			replacements.set(attachment.token, `artifact://${allocated.id}`);
			descriptors.push({
				id: allocated.id,
				sourceId: attachment.sourceId,
				kind: attachment.kind,
				mediaType: attachment.mediaType,
				size: attachment.size,
				...(attachment.name === undefined ? {} : { name: attachment.name }),
				...(attachment.width === undefined ? {} : { width: attachment.width, height: attachment.height }),
				...(attachment.originalDimensions === undefined
					? {}
					: { originalDimensions: attachment.originalDimensions }),
			});
		}
		const replaceContent = (value: unknown): unknown => {
			if (typeof value === "string") {
				let text = value;
				for (const [token, destination] of replacements) text = text.replaceAll(token, destination);
				return text;
			}
			if (Array.isArray(value)) return value.map(replaceContent);
			if (!isRecord(value)) return value;
			return Object.fromEntries(
				Object.entries(value).map(([key, child]) => [key, key === "arguments" ? child : replaceContent(child)]),
			);
		};
		for (const entry of entries) {
			if (entry.type === "message" && "content" in entry.message) {
				Object.assign(entry.message, { content: replaceContent(entry.message.content) });
			} else if (entry.type === "custom_message") {
				Object.assign(entry, { content: replaceContent(entry.content) });
			}
			if (
				entry.type === "compaction" &&
				entry.preserveData &&
				Object.hasOwn(entry.preserveData, "deepseekImportContext")
			) {
				const context = entry.preserveData.deepseekImportContext;
				if (!isRecord(context) || !Array.isArray(context.messages))
					throw new Error("Invalid DeepSeek import attachment context");
				entry.preserveData.deepseekImportContext = {
					...context,
					messages: context.messages.map(message =>
						isRecord(message) && Object.hasOwn(message, "content")
							? { ...message, content: replaceContent(message.content) }
							: message,
					),
				};
			}
		}
		boundary.preserveData = { ...boundary.preserveData, deepseekImportAttachments: descriptors };
	}
}
