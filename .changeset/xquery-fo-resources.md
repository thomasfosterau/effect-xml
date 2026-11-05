---
"@thomasfosterau/effect-xml": minor
---

XQuery and XPath: `fn:parse-xml` and `fn:parse-xml-fragment` (through `Xml.parse`; `FODC0006` for text that is not well-formed), `fn:serialize` (the `xml`, `xhtml`, `html`, `text`, `json` and `adaptive` methods, with parameters from an options map or an `output:serialization-parameters` element; `indent`, `omit-xml-declaration`, `standalone`, `version`, `item-separator`, `use-character-maps`, `allow-duplicate-names` and `json-node-output-method` take effect, the other parameters are checked and ignored), `fn:unparsed-text-lines`, `fn:uri-collection`, `fn:id` / `fn:element-with-id` (over `xml:id`) and `fn:idref`, and `fn:environment-variable` / `fn:available-environment-variables` over the new `environment` evaluate option (empty by default; the process environment is never read). `fn:unparsed-text` now fails with `FOUT1190` for an unknown encoding name and for text with characters XML does not allow.
