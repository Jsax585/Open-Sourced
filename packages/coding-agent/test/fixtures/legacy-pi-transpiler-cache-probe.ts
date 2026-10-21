import { loadLegacyPiModule } from "../../src/extensibility/plugins/legacy-pi-compat";

// Loads one extension entry the way a fresh omp process does at startup.
const entry = process.argv[2];
if (!entry) throw new Error("Usage: legacy-pi-transpiler-cache-probe.ts <extension entry>");
const loaded = (await loadLegacyPiModule(entry)) as { loaded: string };
process.stdout.write(`${loaded.loaded}\n`);
