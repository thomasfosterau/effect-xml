---
"@thomasfosterau/effect-xml": minor
---

`XQuery.evaluate` implements more of Functions and Operators 3.1: the sequence functions `index-of`, `distinct-values`, `insert-before`, `remove`, `unordered`, `sort`, `trace` and `deep-equal` with a collation; the node functions `has-children`, `innermost`, `outermost`, `path`, `generate-id`, `nilled`, `base-uri`, `document-uri` and `lang`; `resolve-QName`, `prefix-from-QName`, `local-name-from-QName`, `namespace-uri-from-QName`, `in-scope-prefixes`, `namespace-uri-for-prefix`, `resolve-uri` and `implicit-timezone`; the higher-order functions `function-lookup`, `function-name`, `for-each`, `filter`, `fold-left`, `fold-right`, `for-each-pair` and `apply`; and every remaining `map:` and `array:` function. `XdmNode.identity` is a new string that identifies a node, as `generate-id` returns it. Integer arithmetic is faster.
