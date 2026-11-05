---
"@thomasfosterau/effect-xml": minor
---

XQuery and XPath: the formatting functions of F&O 3.1. `fn:format-integer` (decimal digit patterns in any Unicode digit family, with grouping; alphabetic, roman, circled and English-word numbering; ordinals), `fn:format-number` (decimal formats from `declare decimal-format`, from the new `decimalFormats` compile option, or named by its third argument), and `fn:format-date` / `fn:format-time` / `fn:format-dateTime` (English names, the `AD` and `ISO` calendars with ISO weeks, timezones as offsets, military letters or names, and an IANA `$place` through `Intl`; other languages and calendars fall back with a `[Language: en]` or `[Calendar: AD]` prefix).
