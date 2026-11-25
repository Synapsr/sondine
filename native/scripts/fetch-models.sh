#!/usr/bin/env bash
# Downloads the models the native package needs into native/.models (git-ignored),
# from pinned upstream URLs, and verifies each file's sha256 before keeping it.
#
# Usage: native/scripts/fetch-models.sh [destination]   (default: native/.models)
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
native_dir="$(dirname "$script_dir")"
models_dir="${1:-$native_dir/.models}"

# Silero VAD v6.2 (MIT), tag v6.2 = commit be95df9 (2025-11-06). The file is unchanged
# through v6.2.3 (same git blob 80c5592e).
silero_commit="be95df9152c0d7618fa1edfeb296fc3dae32376f"
silero_url="https://raw.githubusercontent.com/snakers4/silero-vad/${silero_commit}/src/silero_vad/data/silero_vad.onnx"
silero_sha256="1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3"
silero_license="$script_dir/licenses/silero-vad-LICENSE"
silero_license_sha256="2e63e9a38b6e8fc0c7bc37ce174caca1862870856c6daf5697cfb785e925520b"

# WeSpeaker VoxCeleb ResNet34-LM speaker embedding (CC-BY-4.0), Core ML conversion by
# Fluid Inference, for naming voices. Five files of one compiled model, pinned at a revision.
wespeaker_commit="7eab74f3463c736418d0eb10296261ae581146c9"
wespeaker_base="https://huggingface.co/FluidInference/speaker-diarization-coreml/resolve/${wespeaker_commit}/wespeaker_v2.mlmodelc"
wespeaker_files=(
  "analytics/coremldata.bin d2b1fcde6121aea3ff0e14c1dc50d09dacb0314a2e89156353c31804230a422f"
  "coremldata.bin 6feb2472a71fa9d8a84020c85206138a4f6261c565c9884bf518d59dd5838da7"
  "metadata.json ddc4858b4051254098015cd0b97080149839d697faf7b036f933190e70b26758"
  "model.mil 2850f775d6ba659f01f616fed77ce6a45a25de3eb7e4bf3a4b07b658be4e13dd"
  "weights/weight.bin 34004f6798d35cad7071e2fdc67e63faaa782f53697e1cb49bcb452cf81ae151"
)
wespeaker_license="$script_dir/licenses/wespeaker-LICENSE"
wespeaker_license_sha256="736763bf08829e36266b8a3bebcc041ac68575424e976490671a7e6b43a525cf"
wespeaker_notice="$script_dir/licenses/wespeaker-NOTICE.md"
# Sondine's earlier prototype installed the same files here; they are cloned
# instead of downloaded when their sha256 matches.
wespeaker_local="$HOME/Library/Application Support/com.sondine.desktop.next/models/voice-identity-wespeaker/1.0.0/external/wespeaker_v2.mlmodelc"

sha256_of() {
  shasum -a 256 "$1" | awk '{print $1}'
}

# fetch <url> <sha256> <destination file> [local copy]
fetch() {
  local url="$1" expected="$2" destination="$3" local_copy="${4:-}"
  if [[ -f "$destination" && "$(sha256_of "$destination")" == "$expected" ]]; then
    echo "ok       $destination"
    return
  fi
  mkdir -p "$(dirname "$destination")"
  if [[ -n "$local_copy" && -f "$local_copy" && "$(sha256_of "$local_copy")" == "$expected" ]]; then
    cp -c "$local_copy" "$destination" 2>/dev/null || cp "$local_copy" "$destination"
    echo "copied   $destination"
    return
  fi
  local partial
  partial="$(mktemp "$destination.partial.XXXXXX")"
  echo "download $url"
  if ! curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 --retry 3 \
    --output "$partial" "$url"; then
    rm -f "$partial"
    exit 1
  fi
  local actual
  actual="$(sha256_of "$partial")"
  if [[ "$actual" != "$expected" ]]; then
    rm -f "$partial"
    echo "error: sha256 mismatch for $url" >&2
    echo "  expected $expected" >&2
    echo "  actual   $actual" >&2
    exit 1
  fi
  mv -f "$partial" "$destination"
  echo "ok       $destination"
}

if [[ "$(sha256_of "$silero_license")" != "$silero_license_sha256" ]]; then
  echo "error: $silero_license does not match the pinned Silero license" >&2
  exit 1
fi

fetch "$silero_url" "$silero_sha256" "$models_dir/silero-vad/silero_vad.onnx"
cp "$silero_license" "$models_dir/silero-vad/LICENSE"

if [[ "$(sha256_of "$wespeaker_license")" != "$wespeaker_license_sha256" ]]; then
  echo "error: $wespeaker_license does not match the pinned model license" >&2
  exit 1
fi

for entry in "${wespeaker_files[@]}"; do
  file="${entry% *}"
  fetch "$wespeaker_base/$file" "${entry#* }" "$models_dir/wespeaker/wespeaker_v2.mlmodelc/$file" "$wespeaker_local/$file"
done
cp "$wespeaker_license" "$models_dir/wespeaker/LICENSE"
cp "$wespeaker_notice" "$models_dir/wespeaker/NOTICE.md"
