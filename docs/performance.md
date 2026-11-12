# Performance and bundle size

Back to the [README](https://github.com/thomasfosterau/effect-xml/blob/trunk/README.md).

## Bundle size

Import a layer from its own entry point (`import * as Sax from "@thomasfosterau/effect-xml/Sax"`) when bundle size matters. Each module is published as its own file, so a bundler keeps only the modules a program reaches: a program that calls only `Sax.forEach` bundles about 105 KB of this package (minified, `effect` and effect-parse not counted) and `Xml.parse` about 110 KB, with no XQuery or XML Schema code. The root entry's namespaces (`import { Sax } from "@thomasfosterau/effect-xml"`) are objects holding every member of every layer, which bundlers can't take apart, so a bundle that imports from the root carries the whole library (about 360–590 KB, depending on the bundler). `vp run size` checks these budgets in CI.

## Performance

The XML tokenizer reads text, tags, comments, CDATA sections and processing instructions with a hand-written scanner, and leaves everything else (and every error) to its grammars, so it is strict and still fast. For documents known to be well-formed, `Sax.forEach`, `Xml.parsePlain` and `Xml.parse` also read leniently with `strict: false`: a well-formed document gives the same events (without positions) or the same tree, but names, duplicate attributes and characters XML forbids are not checked, an unknown reference is left as written, only the `maxTotalBytes` and `maxDepth` limits apply, and a malformed document may be read rather than rejected (markup that cannot be read at all, and unbalanced tags in a tree, still fail).

Over the built package in Node 22, on an 8 MB spreadsheet worksheet and an 8 MB feed with namespaces, comments, CDATA and references:

|                                   | worksheet | feed     |
| --------------------------------- | --------- | -------- |
| `Sax.tokenizeString`              | 28 MB/s   | 36 MB/s  |
| `Sax.forEach`, `positions: false` | 41 MB/s   | 49 MB/s  |
| `Sax.forEach`, `strict: false`    | 104 MB/s  | 114 MB/s |
| `Xml.parse`                       | 21 MB/s   | 27 MB/s  |
| `Xml.parsePlain`                  | 30 MB/s   | 37 MB/s  |
| `Xml.parsePlain`, `strict: false` | 57 MB/s   | 66 MB/s  |

In the same runs, saxes and htmlparser2 read 44–58 MB/s, @eksml/xml's and easysax's SAX parsers 98–132 MB/s, and txml's and @eksml/xml's DOM parsers 42–67 MB/s, none of them with positions per event. `Sax.forEach` hands its callback a second argument, `position()`, which returns where the current event starts and costs nothing until called: with `positions: false` it locates events as a classic SAX parser's current line and column does, and reading it on every start tag keeps the speed of saxes reading its `line`. `vp run bench` measures them when they are installed.
