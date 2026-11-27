# Allo

`AlloRound0.woff2` is Allo by Josh Puckett, a redrawing of Inter, with its
roundness axis (`ROND`) set to 0, as on Sondine's site. It is under the SIL
Open Font License 1.1, whose text is in [OFL.txt](OFL.txt) and must stay next
to the file. It is not covered by Sondine's AGPL license (see `NOTICE`).
Allo's name is not a Reserved Font Name, so the modified file keeps it.

|               |                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source        | `allo-font@1.1.0` on npm (`fonts/webfonts/AlloVariable.woff2`), https://allo.joshpuckett.me                                                                                           |
| Source sha256 | `9fcf83756500769576e7253bc6dac94ddfa16769468faa8edecf416a60b12d8c` (725,924 bytes), version 1.100; package tarball `b0a8045e03ecac6af1118665c18e4c9a26874582402ac639264ff9eb0ee98f2a` |
| Made          | 2026-11-27, fontTools 4.60.1                                                                                                                                                          |
| sha256        | `882450eaf1abb2e0f633b9c8a8efd6e8a18c399420221e5ee72f5ede4e29afb3` (218,480 bytes)                                                                                                    |
| License       | SIL Open Font License 1.1                                                                                                                                                             |

## How it was made

```bash
npm pack allo-font@1.1.0   # then fonts/webfonts/AlloVariable.woff2 from the tarball
uvx --from "fonttools[woff]==4.60.1" python - AlloVariable.woff2 AlloRound0.woff2 <<'PY'
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
source, output = sys.argv[1:]
font = TTFont(source, recalcTimestamp=False)  # the same bytes on every run
# The named instances sit at ROND 50; moved to 0, they survive the cut, and
# the iPhone app finds AlloVariable-SemiBold and the others by name.
for instance in font["fvar"].instances:
    instance.coordinates["ROND"] = 0
font = instancer.instantiateVariableFont(font, {"ROND": 0})
font.flavor = "woff2"
font.save(output)
PY
```

Unlike the site's file, it keeps every character of the source (716), not a
Latin cut: transcripts can hold any language the font covers.

## Axes

Checked with fontTools on the WOFF2:

| Axis   | Range   | Default | Use in Sondine                                                          |
| ------ | ------- | ------- | ----------------------------------------------------------------------- |
| `opsz` | 9–32    | 14      | Follows the font size (`font-optical-sizing: auto`)                     |
| `wght` | 100–900 | 400     | Follows `font-weight`: 400, 500, 600 for text, 460, 560, 640 for titles |
| `ROND` | 0       | 0       | Fixed: the axis is gone                                                 |

## Notes

- The package also ships nine oblique files; Sondine takes only the upright
  variable file and lets the browser slant it for the rare italic.
- The font has U+202F (narrow no-break space), used in French typography.
- The iPhone app ships the same file, in `apps/ios/Shared/Fonts/`.
