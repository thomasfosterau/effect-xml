---
"@thomasfosterau/effect-xml": patch
---

`Sax.select` and `Xsd.select` match path steps against the elements outside a selected subtree without allocating: a name test reads the element's name directly (its node is built only for a step with predicates), and the steps an element matched are no longer kept in hash sets. A path that rarely or never matches (`//x:nope`) is about 5–8% faster.
