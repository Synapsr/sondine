# Voice embeddings on SUMM-RE — first calibration (2026-11-07)

How far apart WeSpeaker embeddings put voices, to set where Sondine starts
suggesting « Marie ? » (architecture §8, Phase A: suggest only).

## Setup

- `sondine-voice` (native/, WeSpeaker VoxCeleb ResNet34-LM, Fluid
  Inference's Core ML conversion `wespeaker_v2`, revision `7eab74f`), debug
  build, on the MacBook Air M5.
- The eight SUMM-RE test meetings of the meetings bench, cut from the room
  mix (the condition of one microphone in a room). Each speaker's exclusive
  speech (their segments without any other speaker's time, 0.25 s off each
  end, stretches of 1 s or more) is split in two halves, each embedded from
  at most 30 s.
- SUMM-RE participant ids are global: 021 and 024 speak in both 007a_ECRH
  and 102a_EBRH, which gives same-person pairs across two meetings.
- Script: the session's `voice-calib/calibrate.py` (not kept in the
  repository yet).

## Results (cosine similarity)

| Pairs                                 | Count | Values                              |
| ------------------------------------- | ----- | ----------------------------------- |
| Same voice, two halves of one meeting | 28    | median 0.93, p10 0.84, minimum 0.69 |
| Same person, two meetings (021, 024)  | 8     | 0.81 to 0.84                        |
| Different people (first halves)       | 376   | median 0.16, p99 0.48, maximum 0.63 |

## Reading

- On this data a suggestion at 0.70 with a 0.10 lead over the next person
  separates every same-person pair from every different-person pair. That
  was the provisional setting, replaced on 2026-11-10 by a confidence on the
  centroid of a person's named voices, calibrated on Téo's labels too
  (ADR 030).
- Two people across meetings is far too few to claim a false-accept rate:
  the golden set and Téo's own confirmations (calls on the microphone vs a
  room, phone codecs) must refine it per channel pair before any automatic
  link (architecture §8).
