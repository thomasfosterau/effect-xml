---
"@thomasfosterau/effect-xml-cli": minor
---

New package `@thomasfosterau/effect-xml-cli` with the `effect-xml-xsd generate <schema.xsd> -o <out.ts>` command: it compiles an XML Schema file (includes and imports resolved relative to it, `http(s):` locations only with `--remote`) and writes the typed parser module `Xsd.generate` makes, with `--import-from`, repeatable `--root`, and a `--check` mode that exits non-zero when the file on disk is stale.
