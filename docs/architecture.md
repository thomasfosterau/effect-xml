# Architecture

Three layers, each a thin composition of the one below, with XML Schema and XQuery on top of the SAX stream:

```
input chunks ──▶ Lexer ──▶ Sax (Stream<SaxEvent>) ──▶ tree builder ──▶ XmlDocument
 string/Stream  (internal)   public streaming API      (Xml / Html)      typed DOM
```

`@thomasfosterau/effect-xml-cli` (`packages/cli`, private for now) ships the `effect-xml-xsd` command on `effect/cli` and `@effect/platform-node`. It is the only Node-specific code: nothing under `src/` imports a platform package or `node:*`.

## Entry points

| Entry | Source | Contents |
| --- | --- | --- |
| `.` | `src/index.ts` | Every layer as a namespace, plus `Encoding`, `Limits`, the shared errors, names and positions |
| `./Sax` | `src/Sax.ts` | `SaxEvent` and the `Stream` combinators over the lexer; `select` runs an `Xml.XPath` path through `XQuery.stream`'s streamability analysis |
| `./Xml` | `src/Xml/` | Schema-backed DOM, cursors, the namespace-resolving tree builder, plain trees, `Writer`, `C14n`, `Ns`, `XPath` |
| `./Html` | `src/Html/` | HTML tokenizing, WHATWG tree construction, the lenient fragment builder, serialization |
| `./Xsd` | `src/Xsd/` | XML Schema 1.0: a serializable compiled `Model`, validation and typed parsers over the SAX stream, TypeScript generation |
| `./XQuery` | `src/XQuery/` | XQuery / XPath 3.1 (in progress): the XDM model, `compile`, `evaluate`, and `stream` for the streamable subset |

A new entry is added to `pack.entry` in `vite.config.ts`, `exports` in `package.json`, `entry` in `.fallowrc.json` and this table.

## Internals (`src/internal/`, never exported)

- **Reading.** `lexer.ts` is the incremental lexer; `tokens.ts`, `declarations.ts` and `names.ts` are its effect-parse grammars; `scan.ts` is a hand-written fast path for the common XML tokens; `direct.ts` reads complete input strictly in one loop; `lenient.ts` is the single-pass reader behind `strict: false`. `tokenizer.ts` drives lexer, limits, DTD and conversion for every SAX consumer.
- **Entities and DTDs.** `entities.ts`, `htmlEntities.generated.ts` (the WHATWG table; generated), `dtd.ts`, `expansion.ts`.
- **Limits.** `guard.ts` enforces them; `unwind.ts` is the exception boundary for tree builders.
- **Helpers.** `tree.ts` (stack-safe preorder traversal; use it instead of recursion over a DOM), `drive.ts` (the lexer pull loop), `convert.ts` (lexer events to SAX events), `position.ts` (lazy line/column), `streamPath.ts` and `selector.ts` (streamed selection), `foreign.ts` (SVG / MathML tables).
- **`xsd/`.** Schema-document reader, datatypes and facets (XSD regexes translated to `v`-flag `RegExp`s), content models as lazily built derivative automata, the compiled per-model runtime, the streaming validator and identity constraints.
- **`xquery/`.** The atomic type hierarchy and values, node handles and sequences; `parser/` (the effect-parse grammar, static context and analysis, library modules); `eval/` (the AST compiled to closures, axes, FLWOR as a stage pipeline, constructors, casting, comparison, arithmetic, the built-in function registry; dynamic errors are thrown and caught once per evaluation in `raise.ts`); `stream/analyze.ts` (streamability).

## Invariants

- **Chunk boundaries never change the output.** The lexer runs each grammar in effect-parse partial mode and retries once pending input has grown by half, so a token split across many chunks still lexes in linear time. `tests/streaming.test.ts` asserts identical events and spans for every chunk size.
- **The scanner is an optimisation, never a second semantics.** Until a DOCTYPE declares a general entity, `scan.ts` reads the common tokens and hands everything else, including every error, to the grammars. `tests/scan.test.ts` compares the two, whole and chunked.
- **`dtd: "internal"` costs nothing until something is declared.** The DTD-aware grammars take over only once a DOCTYPE declares a general entity; `tests/dtd-internal.test.ts` holds this equal to using them from the first token.
- **Positions count raw UTF-16 units.** CR and CRLF are normalized before lexing, but offsets still count the raw input. Lines and columns resolve lazily from a per-input line index; compare spans by value (`Equal.equals`), not with structural matchers, which see only `offset`.
- **The lexer is mutable, never observably.** `Sax.tokenize` builds it inside `Stream.suspend`; faults are data, lifted into the stream's error channel.
- **`Html.parseDocument` drives lexer and tree builder in lockstep**, one token at a time, so foreign content can set `suppressRawText` before the next token.
- **Hot paths are plain code.** The per-token lexer → SAX path and the tree builders use loops, `switch` on `_tag` and native `Map`s where Effect combinators measurably cost throughput; each lint override in `vite.config.ts` gives the measurement. `vp run bench` should not regress.
- **`dist/` mirrors `src/`** (`unbundle`) and every module is side-effect free, so bundlers drop what a program never reaches. `vp run size` holds `Sax.forEach`-only and `Xml.parse`-only bundles to their budgets and keeps XQuery and XSD out of them.

## Conformance gates

Pass counts may only go up; raise the baseline when a change improves it.

- `tests/conformance.test.ts`: the vendored html5lib tree-construction suite, exact count.
- `tests/html5lib-tokenizer.test.ts`: html5lib tokenizer tests (`HTML5LIB_REPORT=1` lists failures).
- `tests/xmlconf.test.ts`: the W3C XML Conformance Test Suite (`XMLCONF_REPORT=1`).
- `tests/qt3.test.ts` and `tests/qt3-parse.test.ts`: the W3C QT3 suite as XQuery 3.1 and XPath 3.1, with per-test-set baselines in `tests/qt3*.baseline.json` (`QT3_REPORT=1` prints a new baseline). What counts as supported is decided at the top of `tests/support/qt3.ts`.

Fixtures under `tests/fixtures/` are upstream files: never reformat them.
