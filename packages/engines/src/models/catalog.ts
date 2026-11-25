import type { ArtifactRef } from "../contract.ts";
import {
  CC_BY_4_0_LICENSE,
  NEMOTRON_OPENMDW_LICENSE,
  QWEN_APACHE_2_0_LICENSE,
} from "./license-texts.ts";

/**
 * Model artifacts Sondine knows, each pinned to one upstream file (ADR 016
 * "Models"). An installed file is the artifact only when its size and sha256
 * match; the license and notices are kept next to it.
 */
export interface CatalogArtifact extends ArtifactRef {
  readonly label: string;
  /** Name of the weights file inside the artifact's directory. */
  readonly fileName: string;
  /** The pinned upstream file; only a download the user starts may fetch it (ADR 002). */
  readonly url: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly license: {
    /** SPDX id, or the license's own name when SPDX has none. */
    readonly id: string;
    readonly text: string;
    readonly sha256: string;
    /** The license as published upstream at the pinned revision, for a link next to the text. */
    readonly url: string;
  };
  /** Copyright and origin notices the license requires us to keep. */
  readonly notices: string;
  /** ADR 005: OpenMDW weights are downloaded by the user, never bundled. */
  readonly distribution: "user-download" | "bundled";
  readonly minimumMemoryBytes: number;
  /**
   * Home-relative paths where this exact file may already sit, looked at
   * besides the Hugging Face cache (`locate.ts`). Never a disk scan.
   */
  readonly knownLocations: readonly string[];
  /**
   * `final`: the transcript every episode needs, so onboarding asks for it.
   * `live`: near-live text, only for the setting that turns it on.
   * `journal`: the daily journal's language model (ADR 028), from Settings ▸ Journal.
   */
  readonly role: "final" | "live" | "journal";
}

export const NEMOTRON_ARTIFACT: CatalogArtifact = {
  artifactId: "nemotron-3.5-transcribe-30b-iq4nl",
  // The upstream repository's revision, shortened.
  version: "55d2890",
  label: "Nemotron 3.5 Transcribe 30B (IQ4_NL)",
  fileName: "model.gguf",
  url: "https://huggingface.co/sakasegawa/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B-GGUF/resolve/55d289085ed6b1acd1cfd2e6cf279fdeb32fee5f/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B-IQ4_NL.gguf",
  sizeBytes: 18_997_225_856,
  sha256: "9688cee08c96ee0f54c0cc1cb07856307a79097fb0088cdb8fb31de6dd26c2be",
  license: {
    id: "OpenMDW-1.1",
    text: NEMOTRON_OPENMDW_LICENSE,
    sha256: "18c3a96fd1ee779263aa9210e3d962d5899511890254f3f3efd70ece81d89866",
    url: "https://huggingface.co/sakasegawa/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B-GGUF/blob/55d289085ed6b1acd1cfd2e6cf279fdeb32fee5f/LICENSE",
  },
  notices: `NVIDIA Nemotron 3.5 Transcribe 30B-A4B
Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
Licensed under the OpenMDW License Agreement, version 1.1 (LICENSE.txt).

Source model: https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B
(revision ef905575a106fdad904f3b0ce661dccad654607d).
GGUF conversion for speech.cpp, IQ4_NL weights, by Sakasegawa:
https://huggingface.co/sakasegawa/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B-GGUF
(revision 55d289085ed6b1acd1cfd2e6cf279fdeb32fee5f).
`,
  distribution: "user-download",
  // ADR 005: release 1 targets 32 GB Macs.
  minimumMemoryBytes: 32 * 1024 ** 3,
  knownLocations: [
    // The M0 spike's copy (Sondine's earlier prototype), which the real-engine test also reads.
    "Library/Application Support/com.sondine.desktop.next/models/nemotron-3.5-transcribe/0.9.3-iq4nl/external/model.gguf",
  ],
  role: "final",
};

/** Near-live text (ADR 018): small and fast, one person at a time, no speakers. */
export const PARAKEET_ARTIFACT: CatalogArtifact = {
  artifactId: "parakeet-tdt-0.6b-v3-f16",
  // The upstream repository's revision, shortened.
  version: "b7ed82d",
  label: "Parakeet TDT 0.6B v3 (F16)",
  fileName: "model.gguf",
  url: "https://huggingface.co/sakasegawa/parakeet-tdt-0.6b-v3-GGUF/resolve/b7ed82dbfba6e63da0ef9cf5104f5fc67da44414/parakeet-tdt-0.6B-v3-F16.gguf",
  sizeBytes: 1_255_370_688,
  sha256: "7b74de31ac48427934104f0d074613f8d759d7d108777c114476346789d94426",
  license: {
    id: "CC-BY-4.0",
    text: CC_BY_4_0_LICENSE,
    sha256: "9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411",
    url: "https://creativecommons.org/licenses/by/4.0/legalcode.txt",
  },
  notices: `parakeet-tdt-0.6b-v3
Copyright (c) NVIDIA CORPORATION & AFFILIATES.
Licensed under Creative Commons Attribution 4.0 International (LICENSE.txt).

Source model: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
GGUF conversion for speech.cpp, F16 weights, by Sakasegawa:
https://huggingface.co/sakasegawa/parakeet-tdt-0.6b-v3-GGUF
(revision b7ed82dbfba6e63da0ef9cf5104f5fc67da44414). Sondine uses the file unchanged.
`,
  distribution: "user-download",
  minimumMemoryBytes: 8 * 1024 ** 3,
  knownLocations: [
    // The bench's pinned copy (apps/bench/src/asr/assets.ts).
    "Library/Caches/sondine-bench/models/parakeet-tdt-0.6b-v3/parakeet-tdt-0.6B-v3-F16.gguf",
  ],
  role: "live",
};

/**
 * The daily journal and commitments (ADR 028): Qwen3.5 9B, chosen on Téo's
 * days against Gemma 4 E4B and Ministral 3 14B
 * (`bench/results/journal-2026-11-09.md`).
 */
export const JOURNAL_ARTIFACT: CatalogArtifact = {
  artifactId: "qwen3.5-9b-q4km",
  // The GGUF repository's revision, shortened.
  version: "3885219",
  label: "Qwen3.5 9B (Q4_K_M)",
  fileName: "model.gguf",
  url: "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/3885219b6810b007914f3a7950a8d1b469d598a5/Qwen3.5-9B-Q4_K_M.gguf",
  sizeBytes: 5_680_522_464,
  sha256: "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8",
  license: {
    id: "Apache-2.0",
    text: QWEN_APACHE_2_0_LICENSE,
    // The text with LF line endings (upstream's file is CRLF, see license-texts.ts).
    sha256: "50cbab8a892c5f2993b8c7351a99182507472def3b1374558308605d99b86b32",
    url: "https://huggingface.co/Qwen/Qwen3.5-9B/blob/c202236235762e1c871ad0ccb60c8ee5ba337b9a/LICENSE",
  },
  notices: `Qwen3.5-9B
Copyright 2026 Alibaba Cloud.
Licensed under the Apache License, Version 2.0 (LICENSE.txt).

Source model: https://huggingface.co/Qwen/Qwen3.5-9B
(revision c202236235762e1c871ad0ccb60c8ee5ba337b9a).
GGUF conversion, Q4_K_M weights, by Unsloth:
https://huggingface.co/unsloth/Qwen3.5-9B-GGUF
(revision 3885219b6810b007914f3a7950a8d1b469d598a5). Sondine uses the file unchanged.
`,
  distribution: "user-download",
  // 6.3 GB at its peak, never beside Nemotron (ADR 028).
  minimumMemoryBytes: 16 * 1024 ** 3,
  knownLocations: [
    // The journal bench's pinned copy (apps/bench journal).
    "Library/Caches/sondine-bench/models/textgen/qwen3.5-9b-q4_k_m.gguf",
  ],
  role: "journal",
};

export const MODEL_CATALOG: readonly CatalogArtifact[] = [
  NEMOTRON_ARTIFACT,
  PARAKEET_ARTIFACT,
  JOURNAL_ARTIFACT,
];

/** The catalog entry for an artifact id, at `version` or the newest one listed. */
export function catalogArtifact(
  artifactId: string,
  version?: string,
  catalog: readonly CatalogArtifact[] = MODEL_CATALOG,
): CatalogArtifact | undefined {
  return catalog.find(
    (artifact) =>
      artifact.artifactId === artifactId && (version === undefined || artifact.version === version),
  );
}
