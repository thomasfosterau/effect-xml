---
"@thomasfosterau/effect-xml": minor
---

`XQuery.evaluate` runs every FLWOR clause: `order by` (`stable`, `ascending` / `descending`, `empty least` / `greatest` and `declare default order empty`, NaN ordered beside the empty sequence, the codepoint and HTML ASCII case-insensitive collations, relative collation URIs resolved against the base URI), `group by` (grouping keys compared as `fn:deep-equal` does, the other variables concatenated per group, typed grouping variables), tumbling and sliding `window` clauses with `start` / `end` / `only end` conditions and their `previous`, `next` and positional variables, and `count` after reordering. `for $x as T allowing empty` now checks the empty binding against `T`.
