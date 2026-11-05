---
"@thomasfosterau/effect-xml": minor
---

`Xml.XPath` now runs on the XQuery engine, in XPath 1.0 compatibility mode, and takes the whole of XPath 1.0: every axis but `namespace`, unions, arithmetic (`+`, `-`, `*`, `div`, `mod`, unary minus), variables (declared with `CompileOptions.variables`, given to the evaluation functions' new `options` argument) and every XPath 1.0 function, plus the rest of XPath 3.1. An expression no longer has to be a location path: the new `Xml.XPath.number`, `boolean` and `evaluate` read any value, and `evaluate` returns the dynamic error an XPath 3.1 expression can raise (`select` and the others then return nothing). `XPathError`'s `reason` now ends with the error code (`(err:XPST0003)`), and `Axis` names all thirteen axes.

Results follow the XPath data model: adjacent text and CDATA nodes are one text node (`text()` selects the run; `select` still returns the DOM nodes it is made of), and from a document, `/` is the document node, so `/node()` includes the comments and processing instructions around the root element. Selection over a document is about 40% faster, and XSD identity constraints about 10%.

`XQuery.XPath.compile` takes `xpath1Compatibility` (XPath 3.1's XPath 1.0 compatibility mode: general comparisons, arithmetic and static function arguments convert as XPath 1.0 did), and the QT3 tests that depend on it run.
