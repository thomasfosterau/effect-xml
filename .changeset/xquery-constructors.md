---
"@thomasfosterau/effect-xml": minor
---

`XQuery.evaluate` runs XQuery's node constructors: direct elements (attributes with enclosed expressions, namespace declarations, boundary whitespace), comments and processing instructions, and the computed `element`, `attribute`, `text`, `document`, `comment`, `processing-instruction` and `namespace` constructors, with the dynamic errors the specification gives them. Constructed nodes have a fresh identity and are ordinary `Xml` DOM values underneath; the prolog's `boundary-space` and `copy-namespaces` modes are honoured. `XQuery.XdmNode` gains `fromAttribute`, `fromText`, `fromComment`, `fromProcessingInstruction` and `fromNamespace` for parentless nodes.
