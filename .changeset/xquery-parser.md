---
"@thomasfosterau/effect-xml": minor
---

Add `XQuery.compile` and `XQuery.XPath.compile`, the XQuery 3.1 / XPath 3.1 compiler front end: the whole grammar of Appendix A (the prolog, FLWOR with windows, `group by`, `order by` and `count`, direct, computed and string constructors, `switch`, `typeswitch`, `try` / `catch`, `validate`, extension expressions, maps, arrays, lookups, arrows and inline functions), with its lexical rules (nested comments, reserved function names, `Q{uri}local` names, entity and character references) and grammar notes, to a tagged syntax tree with offsets. Compiling builds the static context (predeclared and host namespaces, default namespaces, variables, function signatures, base URI, boundary-space, construction, ordering and the other prolog settings) and reports the first static error as an `XQueryError` at its offset: `XPST0003`, `XPST0008`, `XPST0017`, `XPST0051`, `XPST0080`, `XPST0081`, and the prolog's and constructors' `XQST` errors.
