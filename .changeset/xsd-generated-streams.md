---
"@thomasfosterau/effect-xml": minor
---

`Xsd.generate` now writes a typed stream for every child element of a root that can occur more than once, grouped under the root's parser and named after the property the child fills: `Order.order.streams.line` streams each `<line>` of an `<order>` as an `Order.Line`. `Xsd.parser<A, S>(model, element, streams?)` takes the children to stream (property → expanded name), and `Xsd.Parser` gains `streams` (`Xsd.Streams<S>`).
