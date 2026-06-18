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

1. **Table insertion modes** (`in table`/`in table body`/`in row`/`in cell`/
   `in caption`/`in column group`) with **foster parenting** and the table
   character-pending buffer.
2. **`select`** insertion modes and **`template`** with its insertion-mode stack.
3. **Foreign content** (SVG/MathML): namespace + attribute-name adjustments,
   integration points, self-closing handling, CDATA-in-foreign-content.
4. **Quirks-mode detection** from the DOCTYPE.
5. ~~The full named character-reference table~~ ✅ done — all ~2,125 WHATWG named
   references ship in `internal/htmlEntities.generated.ts`, and html-mode
   decoding is now spec-compliant: maximal-munch, the ~106 **legacy
   semicolon-less** references (e.g. `&copy`), the **ambiguous-ampersand** rule in
   attributes, semicolon-less numeric references, and the numeric Windows-1252
   remap.
6. **Markers** in the active-formatting list (inserted by
   `applet`/`object`/`marquee`/table scopes) — the type is already threaded
   through; the insert/clear-to-marker steps land with the table modes.

Validation target: run the **html5lib-tests** `tree-construction` suite as the
conformance gate for the items above.

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
