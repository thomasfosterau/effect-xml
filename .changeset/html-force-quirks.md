---
"@thomasfosterau/effect-xml": patch
---

`Html.parseDocument` honours the WHATWG tokenizer's force-quirks flag: a DOCTYPE with no name, a bogus one (`<!DOCTYPE html bogus>`), a missing or unterminated identifier, or one cut short by the end of input now puts the document in quirks mode, as browsers do. `SaxEvent.Doctype` carries the flag as `forceQuirks` (always `false` in XML mode).
