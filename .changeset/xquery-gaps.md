---
"@thomasfosterau/effect-xml": minor
---

Close small XQuery gaps: `fn:default-language` returns the new `defaultLanguage` option of `XQuery.evaluate` (default `en`); a library module that gives the context item a value is `err:XQST0113`; whitespace in a library module's namespace URI literal is normalized as it is in an import's; the `i` flag of `fn:matches`, `fn:replace` and `fn:tokenize` no longer makes `\p{Lu}` and `\p{Ll}` match every cased letter; an absolute `xml:base` stands as written (`base-uri` no longer adds a trailing slash to `http://example.com`); an array lookup casts an untyped key to `xs:integer`; a map is an instance of a function type only if its result type admits the empty sequence; a `processing-instruction("…")` test whose name is not an NCName is `err:XPTY0004`; a direct element constructor in another's content inherits only the namespaces its enclosing constructors declare; and a range may have up to two million items.
