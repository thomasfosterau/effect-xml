---
"@thomasfosterau/effect-xml": patch
---

`Html.parseDocument` is linear in nesting depth: tree construction counts the open elements by name, so a scope check for a name with no open element (a block start tag asking whether a `p` is in button scope) no longer walks the whole stack. 40,000 nested `<div>`s parse in about 60 ms instead of 7 s.
