# WeSpeaker speaker embedding (wespeaker_v2.mlmodelc)

Sondine names voices with a speaker embedding model, run unmodified on the
Mac (Core ML, CPU and Neural Engine).

- Model: WeSpeaker VoxCeleb ResNet34-LM, as published by pyannote
  (`pyannote/wespeaker-voxceleb-resnet34-LM`, revision 837717dd), wrapping
  WeSpeaker's VoxCeleb ResNet34-LM checkpoint. WeSpeaker:
  https://github.com/wenet-e2e/wespeaker
- Core ML conversion by Fluid Inference: fixed input shapes, the fbank
  frontend fused into the model, weights palettized to 8 bits
  (`FluidInference/speaker-diarization-coreml`, revision
  7eab74f3463c736418d0eb10296261ae581146c9, `wespeaker_v2.mlmodelc`).
  These are modified Core ML conversions of the original checkpoint.
- License: Creative Commons Attribution 4.0 International (CC-BY-4.0),
  https://creativecommons.org/licenses/by/4.0/ (text in LICENSE).
