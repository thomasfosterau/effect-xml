---
"@thomasfosterau/effect-xml": patch
---

Document what `Writer.events` yields (`@yields`) in its doc comment, and look up the XML Schema reader's and validator's fixed name tables (unsupported schema components, facet names, `xsi:` attributes, Unicode categories, blocked derivations) and `isSaxError`'s tag list as keyed sets instead of scanning arrays. No behaviour change.
