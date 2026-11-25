# Allo

`AlloVariable.woff2` is Allo by Josh Puckett, a redrawing of Inter, as
published in the `allo-font` npm package (`fonts/webfonts/AlloVariable.woff2`).
It is under the SIL Open Font License 1.1, whose text is in [OFL.txt](OFL.txt)
and must stay next to the file. It is not covered by Sondine's AGPL license
(see `NOTICE`).

|           |                                                                                    |
| --------- | ---------------------------------------------------------------------------------- |
| Source    | `allo-font@1.0.3` on npm, https://allo.joshpuckett.me                              |
| Retrieved | 2026-11-18                                                                         |
| sha256    | `482bec1444dabaf1a493b34aa926bb7751ef5edc3e5a9f90a4111c7bb1e0c0ec` (448,516 bytes) |
| Version   | 1.003 (name table)                                                                 |
| License   | SIL Open Font License 1.1                                                          |

## Axes

Checked with fontTools on the WOFF2:

| Axis   | Range   | Default | Use in Sondine                                      |
| ------ | ------- | ------- | --------------------------------------------------- |
| `opsz` | 9–32    | 14      | Follows the font size (`font-optical-sizing: auto`) |
| `wght` | 100–900 | 400     | Follows `font-weight`; the theme uses 400, 500, 600 |
| `ROND` | 0–100   | 50      | Left at its default                                 |

## Notes

- The package also ships nine oblique files; Sondine takes only the upright
  variable file and lets the browser slant it for the rare italic.
- The font has U+202F (narrow no-break space), used in French typography.
