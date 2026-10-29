/**
 * A tour of `@thomasfosterau/effect-xml`: its three layers, then XML Schema. Run with: `vp run example`
 */
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as BigDecimal from "effect/BigDecimal";
import { Html, Sax, Xml } from "../src/index.ts";
import * as Order from "./xsd/order.generated.ts";

/** Display a value as JSON. */
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// 1. Streaming SAX: feed arbitrary chunks; events come out fully typed.
const saxDemo = Effect.fn("saxDemo")(function* () {
  yield* Console.log("\n# 1. Streaming SAX (chunk boundaries don't matter)");
  const chunks = Stream.fromIterable(["<order id=", '"7"><item>Wid', "get</item></order>"]);
  yield* chunks.pipe(
    Sax.tokenize(),
    Stream.runForEach((ev) =>
      Console.log(
        `  ${ev._tag}` +
          (Sax.isStartElement(ev)
            ? ` <${ev.name}> ${toJson(ev.attributes.map((a) => [a.name, a.value]))}`
            : "") +
          (Sax.isText(ev) ? ` ${toJson(ev.data)}` : "") +
          (Sax.isEndElement(ev) ? ` </${ev.name}>` : ""),
      ),
    ),
  );
});

// 2. Typed DOM with namespace resolution and queries.
const xmlDemo = Effect.fn("xmlDemo")(function* () {
  yield* Console.log("\n# 2. Typed XML DOM + namespaces");
  const doc = yield* Xml.parse(
    `<catalog xmlns:p="urn:products">
       <p:product sku="A1">Widget</p:product>
       <p:product sku="A2">Gadget</p:product>
     </catalog>`,
    { dropWhitespaceOnlyText: true },
  );
  yield* Effect.forEach(
    doc.root.elements,
    (product) =>
      Console.log(
        `  ${product.name.qualified} (ns=${product.name.namespace}) sku=${product.attribute("sku")} -> ${product.textContent}`,
      ),
    { concurrency: 1, discard: true },
  );
  yield* Option.match(Arr.head(doc.root.elements), {
    onNone: () => Effect.void,
    onSome: (first) => Console.log("  round-trip: " + Xml.serialize(first)),
  });
});

// 3. HTML: full document (WHATWG tree construction) and lenient fragment.
const htmlDemo = Effect.fn("htmlDemo")(function* () {
  yield* Console.log("\n# 3. HTML");
  const doc = yield* Html.parseDocument(`<title>Hi</title><p>1<p>2<b>x<i>y</b>z`);
  yield* Console.log("  parseDocument: " + Xml.serialize(doc.root));

  const nodes = yield* Html.parseFragment(`<p>Hello <b>world<br>!</p><script>if (a<b) {}</script>`);
  yield* Effect.forEach(
    Arr.filter(nodes, Schema.is(Xml.XmlElement)),
    (el) => Console.log(`  fragment <${el.name.qualified}> => ${toJson(el.textContent)}`),
    { concurrency: 1, discard: true },
  );
});

// 4. Errors are typed and exhaustively narrowable.
const errorDemo = Effect.fn("errorDemo")(function* () {
  yield* Console.log("\n# 4. Typed errors");
  yield* Xml.parse(`<a></b>`).pipe(
    Effect.catchTag("MismatchedEndTag", (e) => Console.log(`  caught: ${e.message}`)),
  );
});

// 5. XML Schema: a parser generated from examples/xsd/order.xsd (by the
// `effect-xml-xsd generate` command, packages/cli) validates as it streams and
// returns typed values.
const xsdDemo = Effect.fn("xsdDemo")(function* () {
  yield* Console.log("\n# 5. Parsers generated from an XML Schema");
  const order = yield* Order.order.parse(
    `<order xmlns="urn:example:order" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" number="42">
       <customer xsi:type="Company"><name>Acme</name><abn>51 824 753 556</abn></customer>
       <placed>2026-10-23T09:30:00+11:00</placed>
       <line id="l1"><sku>TEA-0001</sku><quantity>3</quantity><price>4.50</price></line>
     </order>`,
  );
  const [line] = order.line;
  yield* Console.log(
    `  order ${order.number} for ${order.customer.name} (${order.customer.$type})`,
  );
  if (line !== undefined)
    yield* Console.log(
      `  ${line.quantity} × ${line.sku} at ${BigDecimal.format(line.price.$value)} ${line.price.currency}`,
    );
  yield* Order.order
    .parse(
      `<order xmlns="urn:example:order" number="1"><placed>2026-10-23T09:30:00Z</placed></order>`,
    )
    .pipe(Effect.catchTag("XsdValidationError", (e) => Console.log(`  caught: ${e.message}`)));
});

// The entry point: run the tour in order. A failure rejects the promise, which
// Node reports and turns into a non-zero exit.
void Effect.runPromise(
  Effect.all([saxDemo(), xmlDemo(), htmlDemo(), errorDemo(), xsdDemo()], {
    concurrency: 1,
    discard: true,
  }),
);
