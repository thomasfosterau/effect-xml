# html5ever / xml5ever roadmap

This library deliberately shipped the **streaming SAX foundation + typed XML
tree builder** first. This document tracks the path to spec-faithful HTML and
XML5 tree construction, in the spirit of Servo's `html5ever`/`xml5ever`.

## Done

- ✅ Incremental, chunk-boundary-safe tokenizer (`src/internal/lexer.ts`).
- ✅ HTML tokenization mode: bare `<`, unquoted/boolean attributes, bogus
  comments, raw-text (`script`/`style`) and rcdata (`title`/`textarea`).
- ✅ Element-category tables: void, raw-text, rcdata, formatting
  (`src/Html/Tokenizer.ts`).
- ✅ The `InsertionMode` vocabulary that tree construction switches over.
- ✅ A lenient, pragmatic fragment builder (`Html.parseFragment`) for use today.
- ✅ **HTML tree construction** (`Html.parseDocument`, `src/Html/TreeConstruction.ts`):
  implicit `html`/`head`/`body`; the `initial`→`beforeHtml`→`beforeHead`→
  `inHead`→`afterHead`→`inBody`→`afterBody` spine; the stack of open elements;
  the **list of active formatting elements** with reconstruction and the Noah's
  Ark clause; generate-implied-end-tags, `</p>` and list-item auto-closing,
  heading nesting; void-element handling; head-content routing
  (`title`/`style`/`script`/`meta`/`link`/`base`); and the full
  **adoption agency algorithm** for misnested formatting elements
  (`<b>1<i>2</b>3</i>` → `<b>1<i>2</i></b><i>3</i>`, `<b>1<p>2</b>3` →
  `<b>1</b><p><b>2</b>3</p>`). Elements are placed in the HTML namespace; output
  is the typed `XmlNode` DOM.

## Next: complete the WHATWG algorithm

Still handled leniently (as generic flow content) rather than per-spec:

1. ~~Table insertion modes~~ ✅ done — `in table`/`in table body`/`in row`/
   `in cell`/`in caption`/`in column group`, implicit `tbody`/`tr` synthesis,
   reset-the-insertion-mode-appropriately, the active-formatting markers for
   cells/captions, and **foster parenting** (non-table content and character data
   are relocated before the table). Remaining table nuances: the pending
   table-character whitespace buffer and `<input type=hidden>`/`<form>` special
   cases.
2. ~~`select` insertion modes~~ ✅ done — `in select` and `in select in table`,
   option/optgroup auto-closing, nested-select handling, and dropping out of
   select on table tags.
2b. ~~**`template`**~~ ✅ done — the `in template` mode and the stack of template
   insertion modes, the `content`-fragment contents (children are the template's
   own children in the output DOM), the active-formatting marker, generate-all-
   implied-end-tags-thoroughly and clear-to-marker on `</template>`, the
   reset-the-insertion-mode `template`/`select`/`head` cases, and the
   no-synthetic-`body`-inside-template rule. Remaining: the table-without-table
   foster edges inside template content.
3. ~~**Foreign content** (SVG/MathML)~~ ✅ done — elements are placed in the SVG
   / MathML namespaces, SVG tag and attribute names are case-corrected, the
   XLink/XML/XMLNS foreign attributes get their namespaces, integration points
   (`annotation-xml`, `foreignObject`/`desc`/`title`, the MathML text points) and
   HTML breakout tags are handled, and self-closing foreign tags are honoured.
   Still to do: CDATA-in-foreign-content (the tokenizer is decoupled from the
   tree, so `<![CDATA[` is not yet switched on inside foreign elements).
3b. ~~**Frameset**~~ ✅ done — the `in frameset` / `after frameset` /
   `after after frameset` modes, the **frameset-ok** flag (cleared by body flow
   content, non-whitespace characters and an explicit `<body>`), `<frameset>`
   replacing an eligible body, `<frame>`/`<noframes>` handling, frameset
   documents carrying no `<body>`, and document-level comments after `</html>`.
4. ~~**Quirks-mode detection** from the DOCTYPE~~ ✅ basic detection: no DOCTYPE or a quirky one sets quirks mode (e.g. <table> no longer closes <p>).
5. ~~The full named character-reference table~~ ✅ done — all ~2,125 WHATWG named
   references ship in `internal/htmlEntities.generated.ts`, and html-mode
   decoding is now spec-compliant: maximal-munch, the ~106 **legacy
   semicolon-less** references (e.g. `&copy`), the **ambiguous-ampersand** rule in
   attributes, semicolon-less numeric references, and the numeric Windows-1252
   remap.
6. ~~**Markers** in the active-formatting list~~ ✅ done — applet/object/marquee (and table/cell/caption) push a marker; the end tags clear back to it.
   `applet`/`object`/`marquee`/table scopes) — the type is already threaded
   through; the insert/clear-to-marker steps land with the table modes.

**Conformance gate (in place):** the official **html5lib-tests**
`tree-construction` suite runs in `tests/conformance.test.ts` against vendored
fixtures (`tests/fixtures/html5lib/`). The current baseline is **1339/1368**
(~92%) runnable cases (only fragment-context and scripted cases are excluded);
the test fails on any regression, so the items above are tracked as the pass
count climbs toward 100%.

The remaining ~104 failures cluster around: the `in head noscript` insertion
mode; tokenizer/tree-builder coupling for `<plaintext>` and `<![CDATA[` *inside*
foreign content (the tokenizer can't currently see the adjusted current node);
the table-without-table foster edges inside `<template>`; column-group character
handling; and a handful of intricate adoption-agency cases.

## Next: XML5 tree construction (`Xml.parseWell` → `Xml.parse5`)

`xml5ever` follows the XML5 proposal: XML's grammar with HTML-style error
recovery instead of fatal well-formedness errors. The current strict
`Xml.TreeBuilder` already centralizes the open-element stack and namespace
scoping; the XML5 builder will reuse it with a recovering policy (auto-close on
mismatch, synthesize missing roots) selectable via a `recover` option, leaving
the strict mode as the default.

## API shape (planned)

```ts
// Spec-faithful, never-fails HTML document parsing.
Html.parseDocument(input): Effect<XmlDocument>          // implicit html/head/body
Html.parseDocumentStream(): (Stream<string>) => Effect<XmlDocument>

// XML5 recovering parse.
Xml.parse(input, { recover: true }): Effect<XmlDocument>
```
