"""Prepares SUMM-RE test meetings for the ASR bench (CC-BY-SA-4.0, linagora/SUMM-RE).

Each shard holds whole close-talk tracks, one per participant: the shard is
read into memory over HTTP (never written to disk), the chosen meetings'
tracks are decoded to PCM16 mono 16 kHz with ffmpeg, and a mix of the tracks
(the condition Sondine hears through one microphone, labelled as a mixture)
is written beside them with the manual segments and word times.

Run through uv with pinned packages (see the bench README); writes to the
bench cache given as the first argument, for every meeting or only those named
after it (another Mac with a faster link can prepare some, see the README).
"""

import hashlib
import io
import json
import subprocess
import sys
from pathlib import Path

import fsspec
import numpy as np
import pyarrow.parquet as pq

REVISION = "47cb4ec3437ef5497b6092b8c6d1e0b5b1d86dc0"
BASE = f"https://huggingface.co/datasets/linagora/SUMM-RE/resolve/{REVISION}/data/test/"
RATE = 16_000

# Eight meetings of eight participant groups, three or four people, two over
# Zoom (suffix Z), chosen from the test split's index (2026-11-06).
MEETINGS = {
    "007a_ECRH": ["test-00000-of-00028.parquet"],
    "012c_EBPZ": ["test-00001-of-00028.parquet", "test-00002-of-00028.parquet"],
    "013c_EAPD": ["test-00002-of-00028.parquet"],
    "024c_EBPH": ["test-00006-of-00028.parquet"],
    "047a_EDRH": ["test-00010-of-00028.parquet"],
    "077c_EBPH": ["test-00022-of-00028.parquet"],
    "093c_EBPZ": ["test-00024-of-00028.parquet", "test-00025-of-00028.parquet"],
    "102a_EBRH": ["test-00026-of-00028.parquet"],
}


def decode(audio_bytes: bytes) -> np.ndarray:
    pcm = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"],
        input=audio_bytes,
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(pcm, dtype=np.int16)


def main() -> None:
    root = Path(sys.argv[1]) / "corpora" / "summre-test"
    root.mkdir(parents=True, exist_ok=True)
    chosen = sys.argv[2:] or list(MEETINGS)
    unknown = [m for m in chosen if m not in MEETINGS]
    if unknown:
        raise SystemExit(f"unknown meetings: {unknown}")
    fs = fsspec.filesystem("https")
    shards: dict[str, list[str]] = {}
    for meeting in chosen:
        names = MEETINGS[meeting]
        for name in names:
            shards.setdefault(name, []).append(meeting)
    tracks: dict[str, dict[str, np.ndarray]] = {m: {} for m in MEETINGS}
    segments: dict[str, list[dict]] = {m: [] for m in MEETINGS}
    for name, wanted in sorted(shards.items()):
        if all((root / m / "reference.json").exists() for m in wanted):
            continue
        print(f"reading {name}", file=sys.stderr, flush=True)
        with fs.open(BASE + name, "rb", block_size=8 * 2**20) as handle:
            table = pq.read_table(io.BytesIO(handle.read()))
        for row in table.to_pylist():
            meeting = row["meeting_id"]
            if meeting not in wanted:
                continue
            speaker = row["speaker_id"]
            tracks[meeting][speaker] = decode(row["audio"]["bytes"])
            for segment in row["segments"] or []:
                segments[meeting].append(
                    {
                        "speaker": speaker,
                        "start": segment["start"],
                        "end": segment["end"],
                        "text": segment["transcript"],
                        "words": [[w["start"], w["end"], w["word"]] for w in (segment["words"] or [])],
                    }
                )
        del table
        # A meeting is whole once its last shard (in name order) is read.
        for meeting in wanted:
            if name == max(MEETINGS[meeting]):
                write(root, meeting, tracks.pop(meeting), segments.pop(meeting))
    print(json.dumps(sorted(p.name for p in root.iterdir() if (p / "reference.json").exists())))


def write(root: Path, meeting: str, by_speaker: dict[str, np.ndarray], turns: list[dict]) -> None:
    directory = root / meeting
    directory.mkdir(exist_ok=True)
    length = max(len(t) for t in by_speaker.values())
    mix = np.zeros(length, dtype=np.float64)
    files = {}
    for speaker, samples in sorted(by_speaker.items()):
        data = samples.tobytes()
        (directory / f"{speaker}.pcm").write_bytes(data)
        files[speaker] = {"pcm": f"{speaker}.pcm", "sha256": hashlib.sha256(data).hexdigest(), "samples": len(samples)}
        mix[: len(samples)] += samples
    peak = np.max(np.abs(mix)) or 1.0
    # Summed close-talk tracks; scaled down only if the sum would clip.
    scale = min(1.0, 32_000 / peak)
    mixed = np.clip(np.round(mix * scale), -32_768, 32_767).astype(np.int16).tobytes()
    (directory / "mix.pcm").write_bytes(mixed)
    reference = {
        "meeting": meeting,
        "license": "CC-BY-SA-4.0 (linagora/SUMM-RE)",
        "revision": REVISION,
        "rate": RATE,
        "durationMs": round(length / RATE * 1000),
        "tracks": files,
        "mix": {"pcm": "mix.pcm", "sha256": hashlib.sha256(mixed).hexdigest(), "scale": scale},
        "segments": sorted(turns, key=lambda t: (t["start"], t["speaker"])),
    }
    (directory / "reference.json").write_text(json.dumps(reference, ensure_ascii=False))
    print(f"wrote {meeting}: {len(by_speaker)} tracks, {length / RATE / 60:.1f} min", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
