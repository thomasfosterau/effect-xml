---
"@thomasfosterau/effect-xml": minor
---

Parse the DOCTYPE internal subset's declarations against their grammar instead of skimming them. Documents that parsed before may now fail with `MalformedDeclaration`:

- element type declarations: `EMPTY` / `ANY` (case-sensitive), mixed content (`(#PCDATA)` or `(#PCDATA | a)*`, `#PCDATA` first and `*` once there are names), and children content models with one connector kind per group, occurrence indicators directly after a name or `)`, and no SGML forms (`&` connectors, minimization, inclusions and exclusions, `CDATA` / `RCDATA` content);
- attribute enumerations and `NOTATION` types (unquoted, `|`-separated, at least one);
- notation declarations (`SYSTEM` or `PUBLIC` identifiers), and public identifiers restricted to `PubidChar`s in entity declarations too;
- `NDATA` on a parameter entity, a malformed reference or a parameter-entity reference in any entity value (parameter entities' included, used or not);
- in the subset, an XML declaration, a processing instruction whose target is not a Name or has no whitespace before its data, and `--` inside a comment. These two checks also apply with `dtd: "ignore"`.

The W3C conformance gate now rejects 932 of its 951 not-wf documents (from 777).
