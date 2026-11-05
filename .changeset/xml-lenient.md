---
"@thomasfosterau/effect-xml": minor
---

Lenient reading with `strict: false`, for documents known to be well-formed, on `Sax.forEach`, `Xml.parsePlain`, `Xml.parse` and `Xml.parseBytes`. A well-formed document reads exactly as it does strictly (events without positions, or the same tree); names, duplicate attributes, characters XML forbids and unknown references are not checked, and of the resource limits only `maxTotalBytes` and `maxDepth` apply. Markup that cannot be read at all, and unbalanced tags in a tree, still fail, and `Xml.parse` rereads strictly on any failure, so its failures are the strict ones. On the benchmark's documents, lenient `Sax.forEach` is about 2.5 times as fast as strict, and lenient `Xml.parsePlain` about twice.
