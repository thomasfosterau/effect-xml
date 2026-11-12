---
"@thomasfosterau/effect-xml": patch
---

XQuery: a range `a to b` is held by its bounds wherever its items aren't needed, so `count(1 to 100000000)`, `(1 to 10000000000)[5]`, `fn:empty`, `fn:exists`, `fn:head`, `fn:tail`, `fn:reverse`, `fn:subsequence`, `fn:sum` and `fn:avg` of a range, general comparisons against a range (`5 = (1 to 10000000000)`), and `for` clauses and quantified expressions over one (which now iterate it instead of building it) work on ranges of any length. An operation that does build a range's items still stops at two million with `err:XPDY0130`.
