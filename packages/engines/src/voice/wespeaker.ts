// The speaker embedding model Sondine ships in `Contents/Helpers/Sondine
// Voice.app` (architecture §8), run by native/'s `sondine-voice`. WeSpeaker
// VoxCeleb ResNet34-LM (CC-BY-4.0), in Fluid Inference's Core ML conversion.
// native/scripts/fetch-models.sh fetches these files into native/.models
// (its list must match this one: wespeaker.test.ts checks it);
// apps/desktop/scripts/build-mac.mjs stages them and check-package.mjs checks
// them. Plain data, no imports: Node runs this file from the build scripts.
export const WESPEAKER_MODEL = {
  name: "wespeaker_v2.mlmodelc",
  repository: "https://huggingface.co/FluidInference/speaker-diarization-coreml",
  revision: "7eab74f3463c736418d0eb10296261ae581146c9",
  license: "CC-BY-4.0",
  /** Under native/.models/wespeaker/, and in the voice app's Resources. */
  files: [
    {
      path: "analytics/coremldata.bin",
      sha256: "d2b1fcde6121aea3ff0e14c1dc50d09dacb0314a2e89156353c31804230a422f",
    },
    {
      path: "coremldata.bin",
      sha256: "6feb2472a71fa9d8a84020c85206138a4f6261c565c9884bf518d59dd5838da7",
    },
    {
      path: "metadata.json",
      sha256: "ddc4858b4051254098015cd0b97080149839d697faf7b036f933190e70b26758",
    },
    {
      path: "model.mil",
      sha256: "2850f775d6ba659f01f616fed77ce6a45a25de3eb7e4bf3a4b07b658be4e13dd",
    },
    {
      path: "weights/weight.bin",
      sha256: "34004f6798d35cad7071e2fdc67e63faaa782f53697e1cb49bcb452cf81ae151",
    },
  ],
  /** Copied next to the model, shipped in the voice app's Resources. */
  notices: [
    {
      file: "LICENSE",
      sha256: "736763bf08829e36266b8a3bebcc041ac68575424e976490671a7e6b43a525cf",
    },
    { file: "NOTICE.md" },
  ],
} as const;
