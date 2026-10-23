---
"@thomasfosterau/effect-xml": minor
---

The strict XML lexer now rejects malformed documents it used to accept (W3C conformance suite: 777 of 951 not-wf documents rejected, up from 618). Documents that parsed before may now fail:

- Characters XML 1.0 does not allow (C0 controls other than tab, LF and CR; U+FFFE, U+FFFF) anywhere in the input, and character references to them, fail with `UnexpectedCharacter` / `InvalidEntity`. A hexadecimal reference must use a lower-case `x` (`&#x58;`, not `&#X58;`).
- A comment may not contain `--`; text may not contain `]]>`.
- Element and attribute names must be XML `Name`s; every attribute needs `=` and a quoted value, with no literal `<` in it, and whitespace between attributes.
- The XML declaration must be at the very start of the document, and references and CDATA sections are not allowed outside the root element (`InvalidDocumentStructure`).

HTML mode is unchanged.
