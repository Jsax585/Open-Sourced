import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getTinyModelsCacheDir } from "@oh-my-pi/pi-utils";
import type { TinyModelDtype } from "../tiny/dtype";

/**
 * On-device speech-to-text model registry. Each tier maps a stable settings key
 * onto a locally-runnable ASR model and the engine that loads it:
 *
 * - `transformers` — a transformers.js / ONNX Whisper repo, loaded by the
 *   `@huggingface/transformers` `automatic-speech-recognition` pipeline.
 * - `sherpa` — a sherpa-onnx (Next-gen Kaldi) offline model, loaded by the
 *   native `sherpa-onnx-node` addon. Used for NVIDIA Parakeet, the Open ASR
 *   Leaderboard accuracy/speed leader, and Orukeet, a Parakeet fine-tune.
 *
 * The worker resolves the spec by key and loads the model lazily (kept warm
 * afterwards). Both engines run inside the hard-killed subprocess worker.
 */

/** ASR runtime that loads a given tier's model. */
export type SttEngine = "transformers" | "sherpa";

interface SttModelBase {
	/** Canonical catalog model id sent over the worker protocol. */
	key: string;
	engine: SttEngine;
	/** Hugging Face repo id (transformers.js ONNX repo, or sherpa-onnx model repo). */
	repo: string;
	/** English-only checkpoint: rejects a configured source `language`. */
	englishOnly: boolean;
	label: string;
	description: string;
	/** Approximate on-disk download size for the shipped weights (UI hint). */
	sizeHint: string;
}

/** A Whisper-family tier loaded via the transformers.js ASR pipeline. */
export interface TransformersSttModelSpec extends SttModelBase {
	engine: "transformers";
	/** ONNX precision used unless overridden by `PI_TINY_DTYPE` / `providers.tinyModelDtype`. */
	dtype: TinyModelDtype;
}

/** A sherpa-onnx offline tier (e.g. NeMo Parakeet transducer) loaded natively. */
export interface SherpaSttModelSpec extends SttModelBase {
	engine: "sherpa";
	/** sherpa-onnx offline model family (e.g. `nemo_transducer`). */
	modelType: string;
	/** Model files (paths relative to the repo root) fetched into the local cache at the same relative paths. */
	files: { encoder: string; decoder: string; joiner: string; tokens: string };
}

export type SttModelSpec = TransformersSttModelSpec | SherpaSttModelSpec;

/**
 * Speech models, ordered light → SoTA. Defaults to {@link DEFAULT_STT_MODEL_KEY}.
 * The Whisper checkpoints run on transformers.js; NVIDIA Parakeet TDT 0.6B v3
 * and its Orukeet fine-tune run on sherpa-onnx.
 */
export const STT_MODELS = [
	{
		key: "whisper-base",
		engine: "transformers",
		repo: "onnx-community/whisper-base",
		dtype: "q8",
		englishOnly: false,
		label: "Fast (Whisper base)",
		description: "Whisper base, multilingual. Smallest + fastest; lowest accuracy. Best for low-resource machines.",
		sizeHint: "~60 MB",
	},
	{
		key: "whisper-small",
		engine: "transformers",
		repo: "onnx-community/whisper-small",
		dtype: "q8",
		englishOnly: false,
		label: "Balanced (Whisper small)",
		description: "Whisper small, multilingual. More accurate than Fast, still light on CPU/RAM.",
		sizeHint: "~190 MB",
	},
	{
		key: "whisper-large-v3-turbo",
		engine: "transformers",
		repo: "onnx-community/whisper-large-v3-turbo",
		dtype: "q4",
		englishOnly: false,
		label: "Turbo (Whisper large-v3)",
		description: "Whisper large-v3-turbo, 99 languages. Widest language coverage; large download, slower.",
		sizeHint: "~600 MB",
	},
	{
		key: "parakeet-tdt-0.6b-v3",
		engine: "sherpa",
		repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
		modelType: "nemo_transducer",
		files: {
			encoder: "encoder.int8.onnx",
			decoder: "decoder.int8.onnx",
			joiner: "joiner.int8.onnx",
			tokens: "tokens.txt",
		},
		englishOnly: false,
		label: "Parakeet TDT v3 (SoTA)",
		description:
			"NVIDIA Parakeet TDT 0.6B v3, 25 languages. Open ASR Leaderboard leader — best accuracy and far fastest decoding. Default.",
		sizeHint: "~680 MB",
	},
	{
		key: "orukeet",
		engine: "sherpa",
		repo: "oruk/orukeet",
		modelType: "nemo_transducer",
		files: {
			encoder: "onnx/sherpa-v0.1.0-int8/encoder.int8.onnx",
			decoder: "onnx/sherpa-v0.1.0-int8/decoder.int8.onnx",
			joiner: "onnx/sherpa-v0.1.0-int8/joiner.int8.onnx",
			tokens: "onnx/sherpa-v0.1.0-int8/tokens.txt",
		},
		englishOnly: false,
		label: "Orukeet (Parakeet fine-tune)",
		description: "Oruk's fine-tune of Parakeet TDT 0.6B v3, same 25 languages.",
		sizeHint: "~670 MB",
	},
] as const satisfies readonly SttModelSpec[];

/**
 * SoTA default — NVIDIA Parakeet TDT 0.6B v3 (sherpa-onnx). Tops the Open ASR
 * Leaderboard on accuracy while decoding ~20× faster than Whisper large-v3.
 */
export const DEFAULT_STT_MODEL_KEY = "parakeet-tdt-0.6b-v3";

export type SttModelKey = (typeof STT_MODELS)[number]["key"];

/** A concrete entry from {@link STT_MODELS}; `key` is the literal tier union. */
export type SttModel = (typeof STT_MODELS)[number];

export const STT_MODEL_VALUES = [
	"whisper-base",
	"whisper-small",
	"whisper-large-v3-turbo",
	"parakeet-tdt-0.6b-v3",
	"orukeet",
] as const satisfies readonly SttModelKey[];

type MissingSttModelValue = Exclude<SttModelKey, (typeof STT_MODEL_VALUES)[number]>;
type ExtraSttModelValue = Exclude<(typeof STT_MODEL_VALUES)[number], SttModelKey>;
const STT_MODEL_VALUES_MATCH_REGISTRY: MissingSttModelValue extends never
	? ExtraSttModelValue extends never
		? true
		: never
	: never = true;
void STT_MODEL_VALUES_MATCH_REGISTRY;

export const STT_MODEL_OPTIONS = STT_MODELS.map(({ key, label, description }) => ({
	value: key,
	label,
	description,
})) satisfies ReadonlyArray<{ value: SttModelKey; label: string; description: string }>;

export function isSttModelKey(value: string): value is SttModelKey {
	return STT_MODELS.some(model => model.key === value);
}

export function getSttModelSpec(key: string): SttModel | undefined {
	return STT_MODELS.find(model => model.key === key);
}

/** Resolve a catalog model id, falling back to the SoTA default when unknown. */
export function resolveSttModelSpec(key: string | undefined): SttModel {
	return (key !== undefined ? getSttModelSpec(key) : undefined) ?? getSttModelSpec(DEFAULT_STT_MODEL_KEY)!;
}

/** Cache path of one sherpa model file; the cache mirrors the file's repo-relative path. */
export function sherpaModelFilePath(spec: SherpaSttModelSpec, role: keyof SherpaSttModelSpec["files"]): string {
	return path.join(getTinyModelsCacheDir(), spec.repo, spec.files[role]);
}

/**
 * Whether a sherpa model file is ready to load: present and non-empty. Shared by
 * the preflight cache check and the worker so both agree on "downloaded"; the
 * `.part` sidecar of an interrupted fetch never matches.
 */
export function isSherpaModelFilePresent(file: string): Promise<boolean> {
	return fs
		.stat(file)
		.then(stats => stats.size > 0)
		.catch(() => false);
}
