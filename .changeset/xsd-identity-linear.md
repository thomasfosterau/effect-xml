---
"@thomasfosterau/effect-xml": patch
---

XML Schema identity constraints (`xs:key`, `xs:unique`, `xs:keyref`) are checked in linear time: a key table was copied for every row added and every child that closed, and each uniqueness and reference check scanned it. Validating a 4 MB worksheet with a key on its rows drops from about 9.9 s to 1.5 s. Results and errors are unchanged.
