---
"@thomasfosterau/effect-xml": minor
---

XQuery: the UCA collations (`http://www.w3.org/2013/collation/UCA?…`) run on `Intl.Collator`. `lang`, `strength`, `caseLevel`, `alternate`, `caseFirst`, `numeric` and `normalization` map onto it, `fallback=no` raises `err:FOCH0002` (`err:XQST0038` in `default collation`) for what it can't honour, `fn:contains` and its relatives match under them, `order by`, `group by`, value comparisons, `switch` and `fn:deep-equal` use them as the default collation, and `fn:collation-key` raises `err:FOCH0004` for them, since `Intl` has no sort keys.
