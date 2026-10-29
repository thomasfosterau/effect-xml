---
"@thomasfosterau/effect-xml": minor
---

`Html.parseDocumentFragment(input, { context })` parses an HTML fragment with the WHATWG fragment parsing algorithm, as a browser's `innerHTML` setter does: the context element (`"td"`, `"textarea"`, `"svg path"`, …; default `"body"`) sets the tokenizer's initial state and the insertion mode, and the result is the nodes the context element would hold. The lenient `Html.parseFragment` is unchanged. A new `scripting` option (on every `Html` entry point, and `Sax.tokenize` in HTML mode) sets the scripting flag: with it on, `<noscript>` content is raw text. The html5lib conformance gate now runs its `#document-fragment` and `#script-on` cases too: 1405 of 1405 pass.
