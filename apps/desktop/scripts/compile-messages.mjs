// Compiles messages/*.json into src/renderer/paraglide (git-ignored output).
import { compile } from "@inlang/paraglide-js";
import { paraglideOptions } from "./paraglide-options.mjs";

await compile(paraglideOptions);
