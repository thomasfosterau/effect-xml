---
"@thomasfosterau/effect-xml": minor
---

**Breaking:** the HTML parsers build an HTML DOM of their own instead of the XML DOM. `Html.parseDocument` (and `parseDocumentStream`, `parseDocumentBytes`, `parseDocumentBytesStream`) returns an `Html.HtmlDocument`; `Html.parseDocumentFragment`, `parseFragment` and `parseFragmentStream` return `ReadonlyArray<Html.HtmlNode>`. The new classes (`HtmlDocument`, `HtmlDoctype`, `HtmlElement`, `HtmlTemplateContent`, `HtmlAttribute`, `HtmlText`, `HtmlComment` and the `HtmlNode` union) are `Schema` classes like the XML DOM's, shaped like the WHATWG DOM:

- an element has a short `namespace` (`"html"`, `"svg"` or `"mathml"`; `Html.NAMESPACE_URIS` maps them to URIs) and its local `name`, plus `attribute`, `attributeNS`, `elements`, `child`, `childElements`, `descendants`, `text` and `textContent`;
- a `<template>`'s contents are a separate `content` fragment, not its children;
- the document records its `mode` (`"no-quirks"`, `"quirks"` or `"limited-quirks"`), now worked out with the WHATWG's complete DOCTYPE tables (an HTML 4.01 strict DOCTYPE used to be taken for quirks mode), and `documentElement`;
- only adjusted foreign attributes (`xlink:href`, `xml:lang`, …) carry a `namespace` (`"xlink"`, `"xml"`, `"xmlns"`) and `prefix`; a DOCTYPE's absent identifiers are `""`;
- there are no CDATA or processing-instruction nodes: tree construction turns a processing-instruction event into a comment, as the HTML tokenizer does, and the lenient `parseFragment` turns a CDATA section into text (merged with adjacent text) and a processing instruction into a comment.

`Html.serialize` and `Html.serializeFragment` take the HTML DOM (writing a template's contents). `parseDocument` is also about 5% faster (`parseFragment` is unchanged): tree construction now builds attributes, text and comments as their final nodes and reuses its working arrays, instead of converting a whole second tree at the end.

**Migrating:** wrap a result in `Html.toXml(...)` to get the XML DOM the parsers used to return (element names as `QName`s in their namespace URIs, template contents as children), for XPath, `C14n`, the XML `Writer`, cursors and `Xml.serialize`. `doc.root` becomes `doc.documentElement`, `el.name.local` becomes `el.name`, and `el.name.namespace === Html.SVG_NS` becomes `el.namespace === "svg"`.
