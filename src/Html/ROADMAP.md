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

## Next: HTML tree construction (`Html.parseDocument`)

Implement the WHATWG algorithm on top of the existing tokenizer:

1. **The stack of open elements** + **active formatting elements** list.
2. **Insertion modes** — a switch over `InsertionMode` driving the 20+ states
   already enumerated in `Tokenizer.ts`.
3. **Implied tags & scoping**: implicit `html`/`head`/`body`, `</p>` auto-close,
   table foster-parenting, generate-implied-end-tags.
4. **The adoption agency algorithm** for misnested formatting elements.
5. **Tokenizer/tree-builder feedback**: the tree builder selects the tokenizer's
   raw-text/rcdata/plaintext state and CDATA-in-foreign-content handling.
6. **The full named character-reference table** (~2,200 entries) replacing the
   common subset in `internal/entities.ts`, plus the HTML-specific ambiguous
   ampersand / missing-semicolon rules.
7. **Foreign content** (SVG/MathML) namespace adjustments and the integration
   points.

The output continues to be the typed `XmlNode` DOM, so downstream queries,
serialization, and Schema validation keep working unchanged.

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
