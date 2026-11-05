---
"@thomasfosterau/effect-xml": patch
---

XQuery / XPath: partially applying a function, as in `substring(?, 1)` or `$f(?, 1)`, now makes an anonymous function item (XPath 3.1 §3.1.5.2), so `fn:function-name` of it is the empty sequence instead of the original function's name.
