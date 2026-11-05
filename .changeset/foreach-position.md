---
"@thomasfosterau/effect-xml": minor
---

`Sax.forEach` passes its callback a second argument, `position()`: where the event being handed over starts, made only when called. With `positions: false` it locates events without a span on each, as a classic SAX parser reports its current position; it is the event's `span.start` when events have positions. Line lookups that move forward a little at a time are cheaper too.
