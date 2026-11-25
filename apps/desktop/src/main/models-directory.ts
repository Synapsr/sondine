import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { MODELS_HOME_RELATIVE, modelsDirectory } from "@sondine/engines";

// Model weights live outside the group container (ADR 013), in
// ~/Library/Application Support/Sondine/models. The sandboxed helper reads
// that folder through a read-only exception and cannot read the app bundle
// (ADR 010), so main copies the bundled VAD model there and points the helper
// at the copy.

// The folder and its layout belong to the model store (packages/engines).
export { MODELS_HOME_RELATIVE, modelsDirectory };

const VAD_MODEL = join("silero-vad", "silero_vad.onnx");

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

export type InstalledModel =
  | { readonly ok: true; readonly path: string; readonly copied: boolean }
  | { readonly ok: false; readonly error: string };

/**
 * Makes `<models>/silero-vad/silero_vad.onnx` a copy of the bundled model:
 * kept when its content matches, otherwise replaced atomically.
 */
export function installVadModel(bundled: string, models: string): InstalledModel {
  const target = join(models, VAD_MODEL);
  try {
    const expected = sha256(bundled);
    if (existsSync(target) && sha256(target) === expected) {
      return { ok: true, path: target, copied: false };
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    const partial = `${target}.partial`;
    rmSync(partial, { force: true });
    copyFileSync(bundled, partial);
    if (sha256(partial) !== expected) {
      rmSync(partial, { force: true });
      return { ok: false, error: "the copied model does not match the bundled one" };
    }
    renameSync(partial, target);
    return { ok: true, path: target, copied: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
