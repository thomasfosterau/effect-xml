---
"@thomasfosterau/effect-xml": minor
---

`XQuery.evaluate` implements the date, time and duration functions of Functions and Operators 3.1: the component functions (`year-from-dateTime` … `timezone-from-time`, `years-from-duration` … `seconds-from-duration`), `dateTime`, `adjust-dateTime-to-timezone`, `adjust-date-to-timezone`, `adjust-time-to-timezone` and `parse-ietf-date`. Map keys that are dates or times are now the same key when they denote the same instant (`xs:time("12:00:00Z")` and `xs:time("13:00:00+01:00")`, or `24:00:00` and the next day's midnight), as `op:same-key` requires.
