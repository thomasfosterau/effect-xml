---
"@thomasfosterau/effect-xml": patch
---

`Xsd`: `unique`, `key` and `keyref` fields now compare as typed values in their value spaces (XSD 1.0 §3.11.4) instead of whitespace-collapsed strings. A `decimal` `1.0` and `1` are the same value, an `int` `01` matches a key `1`, and a `string` `1` differs from an `int` `1`. Lists compare item by item and a union value by the member type that accepts it; a field with no simple type (wildcard-matched or nilled) still compares by its collapsed string.
