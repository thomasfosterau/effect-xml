---
"@thomasfosterau/effect-xml": patch
---

Fix XQuery JSON conversion and map key edge cases: `fn:json-doc` reports undecodable bytes as `FOUT1200`, `fn:json-to-xml` and `fn:xml-to-json` follow F&O 3.1 for escapes, attributes, `indent`, option atomization, the `duplicates` values and the result's base URI, `group by` compares keys as `fn:deep-equal` does, and casting a float or double to `xs:decimal` keeps its exact value so it is the same map key.
