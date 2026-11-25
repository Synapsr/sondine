import { CORPUS_IDS, ENGINE_IDS } from "./ids.ts";

export const asrUsage = `usage: sondine-bench asr <command>

  asr fetch --corpus <${CORPUS_IDS.join("|")}>[,…] [--size 100]
      Downloads (pinned, checked) and prepares corpora in ~/Library/Caches/sondine-bench.
  asr run --engine <${ENGINE_IDS.join("|")}> --corpus <id> [--size 100] [--label local]
      Transcribes the corpus as the product sends audio, scores it with fr-norm,
      and writes a result JSON to bench/results/local/. Nemotron needs AC power,
      normal memory pressure and no Sondine worker loaded.
  asr report <result.json> […]   one markdown table of runs
  asr meetings --engine <id>
      SUMM-RE test meetings (prepared by apps/bench/src/asr/summre/prepare.py): the
      summed close-talk tracks transcribed with speakers, scored with MeetEval
      tcpWER and cpWER (collar 5 s) and a speaker-agnostic WER.
  asr meetings-report <result.json> […]`;

export const goldenUsage = `usage: sondine-bench golden <command>

  golden add <audio file> --scenario <appel-fr|personne-fr|fr-en>
      Copies a recording exported from Sondine into the private golden set
      (~/Library/Application Support/Sondine/golden/v0), and seeds its
      reference.txt with Whisper large-v3 and Sortformer, for Téo to correct.
  golden status                  each situation, its length and whether it is corrected`;
