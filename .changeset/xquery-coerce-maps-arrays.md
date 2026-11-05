---
"@thomasfosterau/effect-xml": patch
---

`XQuery.evaluate` coerces a map or array passed where a function type is expected (XPath 3.1 §3.1.5.3) instead of raising `err:XPTY0004`: one that already stands for the type stays a map or array, and one that does not (`filter((4, 5, 6), [1, 2, 3, true(), false(), true()])`) is wrapped in a function item that converts its arguments and checks its result.
