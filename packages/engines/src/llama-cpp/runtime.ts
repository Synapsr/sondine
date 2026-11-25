// The llama.cpp release Sondine ships as `Contents/Helpers/Sondine Text.app`
// (ADR 028): `llama-server` and the libraries it loads from its own folder
// (`@loader_path`). apps/desktop/scripts/build-mac.mjs downloads this
// archive, checks it and every staged file, and signs them. Plain data, no
// imports: Node runs this file from the build script.
export const LLAMA_CPP_RUNTIME = {
  name: "llama.cpp",
  version: "b12233",
  repository: "https://github.com/ggml-org/llama.cpp",
  revision: "5f490d7bfe78844e6390c869454c149fd7e003a8",
  archive: {
    url: "https://github.com/ggml-org/llama.cpp/releases/download/b12233/llama-b12233-bin-macos-arm64.tar.gz",
    sizeBytes: 16_723_665,
    sha256: "822623c5a6b7520707f4ecd82edaa648b03908a345181f62bd2778ee55e75504",
    /** The folder the archive holds its files in. */
    root: "llama-b12233",
  },
  /** The server, then each library under the name it is loaded by, with the file that name points to. */
  files: [
    {
      name: "llama-server",
      target: "llama-server",
      sha256: "e7e3c60a5e612460d095bfd219047040d6bb9d0b56466aae30a480980b676959",
    },
    {
      name: "libllama-server-impl.dylib",
      target: "libllama-server-impl.dylib",
      sha256: "410585e4cd9c5ce5b65f97667b305beb55b54b6b311b325907a072d7e05092f1",
    },
    {
      name: "libllama-common.0.dylib",
      target: "libllama-common.0.9.0.dylib",
      sha256: "0eabc47a55c53fff48fb7f47a36cd7f2dede5719b8cf2ebf2a41396c4ad3072b",
    },
    {
      name: "libmtmd.0.dylib",
      target: "libmtmd.0.9.0.dylib",
      sha256: "c4dde47e8e4778ccc8d031757f9aff709fe8f6c36ed18cbd22140827c8782df1",
    },
    {
      name: "libllama.0.dylib",
      target: "libllama.0.9.0.dylib",
      sha256: "b382a48152e6e467b9a7ec15c84ad9d6a55294ed9bfaa91ac7d2fbcbb75782ab",
    },
    {
      name: "libggml.0.dylib",
      target: "libggml.0.29.0.dylib",
      sha256: "440e319dc28fda41e94cc2e18944b1ecad3e58df28c3705ef57066f66490c798",
    },
    {
      name: "libggml-cpu.0.dylib",
      target: "libggml-cpu.0.29.0.dylib",
      sha256: "0cae225e9b2f9fcb0c64a1f21f855dcb2ee83c059f503cd37cbff331d509c6a6",
    },
    {
      name: "libggml-blas.0.dylib",
      target: "libggml-blas.0.29.0.dylib",
      sha256: "786754ac19bff80ad4ca76d44d3031f32593772f38d9da819b428dc702f63339",
    },
    {
      name: "libggml-metal.0.dylib",
      target: "libggml-metal.0.29.0.dylib",
      sha256: "00ae0501d0936835df9f5baa26c07042d430fd62a328f0fcc5c31ad67eeb3ee5",
    },
    {
      name: "libggml-rpc.0.dylib",
      target: "libggml-rpc.0.29.0.dylib",
      sha256: "461f3f42bf76d3db18a6341bf94d5388cc367397aa974417b2811e9665431c30",
    },
    {
      name: "libggml-base.0.dylib",
      target: "libggml-base.0.29.0.dylib",
      sha256: "bf5ab1da2b51218b8d09150aed293df87fc776c1589779d2de35a62cfa4b177e",
    },
  ],
  license: "MIT",
  /** The archive's own LICENSE (llama.cpp and ggml, MIT), shipped in the app's Resources. */
  notice: {
    file: "LICENSE",
    sha256: "94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d",
  },
} as const;
