export const vocabularyUsage = `vocabulary run --db <copy.db> --model <file.gguf> --server <llama-server> --out <private dir> [options]
      Runs the Vocabulary's rules over a copy of Sondine's database (it is written to),
      on the last 7 days' transcripts, with the user's People and --words, and measures
      the model's cost (time, tokens, the server's peak resident memory).
        --words <Téo,Sondine=le nom de mon app>  words added to the copy's list, with notes
        --socket <path.sock>   where the server listens (default /tmp/sondine-bench-vocabulary.sock)
        --no-model             the rule without the model only`;
