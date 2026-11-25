import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cachePath, fetchPinned, speechExecutable, type PinnedFile } from "../asr/assets.ts";

// The non-candidate control that seeds golden references (ADR 005: seeded by
// a control, corrected by Téo): Whisper large-v3 through whisper.cpp,
// built once from a pinned commit, and Sortformer (speech.cpp) for who speaks.
// Neither is a candidate, so the seed favours none of them.

const WHISPER_CPP = {
  repository: "https://github.com/ggml-org/whisper.cpp",
  tag: "v1.9.5",
  commit: "d1be6fde11ac6e0407606b4e42fe72d34add8037",
};

/** Large-v3 rather than turbo: the most accurate Whisper, and a copy Téo already had. */
export const WHISPER_MODEL: PinnedFile = {
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3.bin",
  sizeBytes: 3_095_033_483,
  sha256: "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2",
  path: "models/whisper-large-v3/ggml-large-v3.bin",
};

export const SORTFORMER_MODEL: PinnedFile = {
  url: "https://huggingface.co/sakasegawa/Nemotron-3-Diarization-GGUF/resolve/9096d41cb78bba7ac882b96d453e25239eac692b/Nemotron-3-Diarization-99M-Q8_0.gguf",
  sizeBytes: 106_179_488,
  sha256: "336df6350dce2ea5ff06aa6e2b249d331a859ced13305fbb45c44bdb3c0abe20",
  path: "models/nemotron-3-diarization/Nemotron-3-Diarization-99M-Q8_0.gguf",
};

/** whisper.cpp's `whisper-cli`, built with Metal from the pinned commit. */
export function whisperCli(log: (line: string) => void): string {
  const source = cachePath(`src/whisper.cpp-${WHISPER_CPP.tag}`);
  const binary = join(source, "build", "bin", "whisper-cli");
  if (existsSync(binary)) return binary;
  if (!existsSync(join(source, ".git"))) {
    mkdirSync(source, { recursive: true });
    log(`fetching whisper.cpp ${WHISPER_CPP.tag}`);
    execFileSync("git", ["init", "-q", source]);
    execFileSync("git", [
      "-C",
      source,
      "fetch",
      "-q",
      "--depth",
      "1",
      WHISPER_CPP.repository,
      WHISPER_CPP.commit,
    ]);
    execFileSync("git", ["-C", source, "checkout", "-q", "FETCH_HEAD"]);
  }
  const head = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (head !== WHISPER_CPP.commit)
    throw new Error(`whisper.cpp at ${head}, not the pinned ${WHISPER_CPP.commit}`);
  log("building whisper-cli (Metal)");
  execFileSync(
    "cmake",
    ["-S", source, "-B", join(source, "build"), "-DGGML_METAL=ON", "-DCMAKE_BUILD_TYPE=Release"],
    {
      stdio: "ignore",
    },
  );
  execFileSync(
    "cmake",
    ["--build", join(source, "build"), "--config", "Release", "-j", "--target", "whisper-cli"],
    {
      stdio: "ignore",
    },
  );
  if (!existsSync(binary)) throw new Error("whisper-cli did not build");
  return binary;
}

export interface SeedSegment {
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
}

/** Whisper's segments of a 16 kHz WAV, language detected (French and English talks). */
export async function whisperSegments(
  wav: string,
  log: (line: string) => void,
): Promise<SeedSegment[]> {
  const cli = whisperCli(log);
  const model = await fetchPinned(WHISPER_MODEL, log);
  const output = `${wav}.whisper`;
  execFileSync(cli, ["-m", model, "-f", wav, "-l", "auto", "-oj", "-of", output, "-np"], {
    stdio: "ignore",
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(readFileSync(`${output}.json`, "utf8")) as {
    transcription?: { offsets?: { from?: number; to?: number }; text?: string }[];
  };
  return (parsed.transcription ?? []).map((segment) => ({
    startSec: (segment.offsets?.from ?? 0) / 1000,
    endSec: (segment.offsets?.to ?? 0) / 1000,
    text: (segment.text ?? "").trim(),
  }));
}

export interface SpeakerTurn {
  readonly speaker: string;
  readonly startSec: number;
  readonly endSec: number;
}

/** Sortformer's turns as RTTM (`SPEAKER file 1 start duration … speaker …`). */
export async function sortformerTurns(
  wav: string,
  log: (line: string) => void,
): Promise<SpeakerTurn[]> {
  const model = await fetchPinned(SORTFORMER_MODEL, log);
  const rttm = execFileSync(await speechExecutable(), ["diarize", model, "--format", "rttm", wav], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return rttm
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields[0] === "SPEAKER")
    .map((fields) => {
      const startSec = Number(fields[3]);
      return { speaker: fields[7] ?? "?", startSec, endSec: startSec + Number(fields[4]) };
    });
}
