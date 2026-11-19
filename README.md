# @thomasfosterau/effect-xml

Type-safe, streaming **XML and HTML parsing** for [Effect](https://effect.website): a chunk-boundary-safe SAX stream, a `Schema`-backed XML DOM, WHATWG HTML parsing, XML Schema validation and XPath / XQuery 3.1. Every failure is a typed error.

> [!CAUTION]
> Experimental and pre-1.0, largely written with Claude Code. The API may change between minor versions.

## Install

```sh
pnpm add @thomasfosterau/effect-xml effect @thomasfosterau/effect-parse
```

`effect` and `@thomasfosterau/effect-parse` are peers. ESM-only, side-effect free, and runs anywhere Effect does.

## Example

```ts
import * as Effect from "effect/Effect";
import { Xml } from "@thomasfosterau/effect-xml";

const program = Effect.gen(function* () {
  const doc = yield* Xml.parse(
    `<catalog xmlns:p="urn:products">
       <p:product sku="A1">Widget</p:product>
     </catalog>`,
    { dropWhitespaceOnlyText: true },
  );
  const product = doc.root.elements[0];
  if (product === undefined) return;
  product.name.qualified; // "p:product"
  product.name.namespace; // Option.some("urn:products")
  product.attribute("sku"); // Option.some("A1")
  return Xml.serialize(product); // round-trips back to XML
});
```

## Entry points

Import a layer from its own subpath to keep bundles small; the root `@thomasfosterau/effect-xml` re-exports every layer as a namespace.

| Import | What it is | Guide |
| --- | --- | --- |
| `@thomasfosterau/effect-xml/Sax` | Incremental tokenizer as a `Stream` of typed events | [Streaming SAX](https://github.com/thomasfosterau/effect-xml/blob/trunk/docs/sax.md) |
| `@thomasfosterau/effect-xml/Xml` | Schema-backed DOM, namespaces, XPath 1.0, `Bind`, writer | [The XML DOM](https://github.com/thomasfosterau/effect-xml/blob/trunk/docs/xml.md) |
| `@thomasfosterau/effect-xml/Html` | WHATWG tree construction and an HTML DOM | [HTML](https://github.com/thomasfosterau/effect-xml/blob/trunk/docs/html.md) |
| `@thomasfosterau/effect-xml/Xsd` | XML Schema 1.0 validation, typed parsers, code generation | [XML Schema](https://github.com/thomasfosterau/effect-xml/blob/trunk/docs/xsd.md) |
| `@thomasfosterau/effect-xml/XQuery` | XPath 3.1 and XQuery 3.1 (in progress) | [XQuery](https://github.com/thomasfosterau/effect-xml/blob/trunk/docs/xquery.md) |

Shared topics: [errors](https://github.com/thomasfosterau/effect-xml/blob/trunk/docs/errors.md), [names and positions](https://github.com/thomasfosterau/effect-xml/blob/trunk/docs/positions.md), [performance and bundle size](https://github.com/thomasfosterau/effect-xml/blob/trunk/docs/performance.md).

## Links

- [Guides](https://github.com/thomasfosterau/effect-xml/tree/trunk/docs); the API reference is in each export's doc comment
- [examples/usage.ts](https://github.com/thomasfosterau/effect-xml/blob/trunk/examples/usage.ts), a tour of the layers
- [Contributing](https://github.com/thomasfosterau/effect-xml/blob/trunk/docs/CONTRIBUTING.md), [security](https://github.com/thomasfosterau/effect-xml/blob/trunk/docs/SECURITY.md), [changelog](https://github.com/thomasfosterau/effect-xml/blob/trunk/CHANGELOG.md)
- [`@thomasfosterau/effect-xml-cli`](https://github.com/thomasfosterau/effect-xml/tree/trunk/packages/cli), the `effect-xml-xsd` command

## License

MIT, see [LICENSE.md](https://github.com/thomasfosterau/effect-xml/blob/trunk/LICENSE.md).
