---
"@thomasfosterau/effect-xml": patch
---

Document that `Html.serialize` and `Html.serializeFragment` follow the WHATWG serialization algorithm for `<pre>`, `<textarea>` and `<listing>`: no extra newline is written at their start, so text that really begins with a newline loses it when the output is parsed again (whatwg/html#944). Behaviour is unchanged.
