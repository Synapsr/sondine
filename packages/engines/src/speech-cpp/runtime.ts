// The speech.cpp release Sondine ships as `Contents/Helpers/Sondine Speech.app`
// (ADR 016). apps/desktop/scripts/build-mac.mjs downloads this archive, checks
// it, and stages its `speech` executable; the worker client checks that the
// running worker reports `version`. Plain data, no imports: Node runs this
// file from the build script.
export const SPEECH_CPP_RUNTIME = {
  name: "speech.cpp",
  version: "0.9.3",
  repository: "https://github.com/nyosegawa/speech.cpp",
  revision: "6c166276d3a8b47fdbb7ded7db837d47952767d0",
  /** The worker protocol this client speaks (docs/worker.md at the revision). */
  workerProtocol: 3,
  archive: {
    url: "https://github.com/nyosegawa/speech.cpp/releases/download/v0.9.3/speech-0.9.3-macos-arm64-metal.zip",
    sizeBytes: 5_815_053,
    sha256: "d85f4980dfa2068004dded069d4311cddb292c9f9d758da489123d6e55c0df3d",
  },
  /** The archive's executable; it links only system frameworks. */
  executable: {
    name: "speech",
    sha256: "e25f01cb1ee583498a6150583766890f4aca6fefed857cec1bfb2037c534a36f",
  },
  license: "MIT",
  /** Kept in apps/desktop/build/speech/ and shipped in the app's Resources. */
  notices: [
    {
      file: "LICENSE.txt",
      source:
        "https://raw.githubusercontent.com/nyosegawa/speech.cpp/6c166276d3a8b47fdbb7ded7db837d47952767d0/LICENSE",
      sha256: "688f8aca0abe167966d277ed00bd594a5a51b028a4fbc1516ff9de7ef05c521a",
    },
    {
      file: "third-party-notices/cpp-httplib-LICENSE",
      source:
        "https://raw.githubusercontent.com/nyosegawa/speech.cpp/6c166276d3a8b47fdbb7ded7db837d47952767d0/vendor/cpp-httplib/LICENSE",
      sha256: "4b45cbe16d7b71b89ae6127e26e0d90a029198ca5e958ad8e3d0b8bbed364d8b",
    },
    {
      file: "third-party-notices/miniaudio-LICENSE",
      source:
        "https://raw.githubusercontent.com/nyosegawa/speech.cpp/6c166276d3a8b47fdbb7ded7db837d47952767d0/vendor/miniaudio/LICENSE",
      sha256: "bde09ed161fef45da2194cba70601aab33ca6fdfe6eed2e3d95efd15b48561f9",
    },
    {
      file: "third-party-notices/ggml-LICENSE",
      source:
        "https://raw.githubusercontent.com/nyosegawa/ggml/32184667ce22179e9c2dd3b52200257df061a1e7/LICENSE",
      sha256: "94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d",
    },
  ],
} as const;
