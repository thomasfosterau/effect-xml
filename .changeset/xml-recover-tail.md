---
"@thomasfosterau/effect-xml": minor
---

`recover: true` now reads the rest of what XML5 recovers from (#184):

- XML5's short end tag `</>` closes the element open innermost. The tokenizer gives it that element's name, so it is an `EndElement` like any other (it was dropped); with no element open it is still dropped.
- A comment with `--` in it runs to `-->` or `--!>`, as in HTML.
- Markup the input ends inside of is read as HTML reads it at the end: a comment, CDATA section or processing instruction keeps its data, and an unfinished start or end tag is dropped (they failed with `UnexpectedEndOfInput`).
- A `<!doctype>` keyword in any case is read, and a malformed DOCTYPE is read as HTML reads it (one with no name is dropped). A processing instruction whose target is a `Name` keeps its target and its data up to `?>`; a malformed XML declaration is dropped; any other `<?` is a bogus comment.
- With `dtd: "internal"`, entity replacement text that is not balanced markup is balanced (an element left open is closed at its end, an end tag for nothing opened in it is dropped), declarations in it are dropped, a reference to an undeclared entity in it is text, and an entity whose value is not well-formed is not declared. Recursion, external entities, characters XML does not allow and the limits still fail.
- `Xml.parse` and `Xml.parseBytes` with `recover: true` and `strict: false` read the document strictly first, at strict reading's speed, and recover only if that fails; the tree is the same.

A document strict XML reads is read the same, and reading without `recover` is unchanged.
