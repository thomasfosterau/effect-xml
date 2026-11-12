---
"@thomasfosterau/effect-xml": patch
---

With `dtd: "internal"`, reading a large document as one string no longer takes superlinear time once a DOCTYPE declares an entity (#191). The DTD-aware text grammar searched for an `&` to the end of the buffer for every run of text; it now reads each run once. Events, positions and errors are unchanged.
