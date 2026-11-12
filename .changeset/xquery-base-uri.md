---
"@thomasfosterau/effect-xml": patch
---

XQuery: a comment, processing instruction, attribute or text node with no parent has no base URI (it no longer takes the static base URI), `fn:resolve-uri` follows RFC 3986 on the text as written (an IRI stays an IRI, a malformed reference or base is `FORG0002`), and `declare base-uri` collapses whitespace and resolves a relative URI against the host's base URI (`XPST0001` when there is none).
