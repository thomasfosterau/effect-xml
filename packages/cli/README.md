# @thomasfosterau/effect-xml-cli

Command-line tools for [`@thomasfosterau/effect-xml`](https://github.com/thomasfosterau/effect-xml#readme). It ships one executable, `effect-xml-xsd`, which turns an XML Schema (XSD 1.0) into a TypeScript module: a type per schema type, the compiled schema as a literal, and a typed parser per global element (what `Xsd.generate` writes).

It is a separate package so the library stays platform-neutral and side-effect free; this one runs on Node (≥ 22) through `@effect/platform-node`.

## Usage

```sh
effect-xml-xsd generate <schema.xsd> -o <out.ts> [options]
```

| Option | Meaning |
| --- | --- |
| `-o`, `--out <file>` | The module to write. Its header names the schema relative to it. |
| `--import-from <module>` | The module the generated code imports the library from (default `@thomasfosterau/effect-xml`). |
| `--root <expanded name>` | Write a parser only for this global element (`{namespace}local`); repeat for several. All of them by default. |
| `--remote` | Fetch `xs:include` / `xs:import` locations that are `http:` or `https:` URLs. Without it a remote location is an error. Relative locations are always read from disk, relative to the schema that names them. |
| `--check` | Write nothing: exit non-zero when the file at `--out` differs from what would be written (or is missing). For keeping a committed module fresh in CI. |

```sh
# Generate, and later check in CI that the committed module is current:
effect-xml-xsd generate schemas/order.xsd -o src/order.generated.ts
effect-xml-xsd generate schemas/order.xsd -o src/order.generated.ts --check
```

Then use the module:

```ts
import * as Order from "./order.generated.ts";

const order = yield * Order.order.parse(input); // Effect<Order.Order, Xsd.XsdError>
```

## License

MIT
