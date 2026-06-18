/**
 * effect-sax — a tour of the three layers. Run with: `bun run example`
 */
import { Console, Effect, Stream } from "effect"
import { Html, Sax, Xml } from "../src/index.ts"

// 1. Streaming SAX: feed arbitrary chunks; events come out fully typed.
const saxDemo = Effect.gen(function* () {
  yield* Console.log("\n# 1. Streaming SAX (chunk boundaries don't matter)")
  const chunks = Stream.fromIterable(["<order id=", '"7"><item>Wid', "get</item></order>"])
  yield* chunks.pipe(
    Sax.tokenize(),
    Stream.runForEach((ev) =>
      Console.log(
        `  ${ev._tag}` +
          (Sax.isStartElement(ev) ? ` <${ev.name}> ${JSON.stringify(ev.attributes.map((a) => [a.name, a.value]))}` : "") +
          (Sax.isText(ev) ? ` ${JSON.stringify(ev.data)}` : "") +
          (Sax.isEndElement(ev) ? ` </${ev.name}>` : "")
      )
    )
  )
})

// 2. Typed DOM with namespace resolution and queries.
const xmlDemo = Effect.gen(function* () {
  yield* Console.log("\n# 2. Typed XML DOM + namespaces")
  const doc = yield* Xml.parse(
    `<catalog xmlns:p="urn:products">
       <p:product sku="A1">Widget</p:product>
       <p:product sku="A2">Gadget</p:product>
     </catalog>`,
    { dropWhitespaceOnlyText: true }
  )
  for (const product of doc.root.elements) {
    yield* Console.log(
      `  ${product.name.qualified} (ns=${product.name.namespace}) sku=${product.attribute("sku")} -> ${product.textContent}`
    )
  }
  yield* Console.log("  round-trip: " + Xml.serialize(doc.root.elements[0]!))
})

// 3. Lenient HTML fragment parsing.
const htmlDemo = Effect.gen(function* () {
  yield* Console.log("\n# 3. Lenient HTML")
  const nodes = yield* Html.parseFragment(`<p>Hello <b>world<br>!</p><script>if (a<b) {}</script>`)
  for (const n of nodes) {
    if (n._tag === "XmlElement") {
      yield* Console.log(`  <${n.name.qualified}> => ${JSON.stringify(n.textContent)}`)
    }
  }
})

// 4. Errors are typed and exhaustively narrowable.
const errorDemo = Effect.gen(function* () {
  yield* Console.log("\n# 4. Typed errors")
  yield* Xml.parse(`<a></b>`).pipe(
    Effect.catchTag("MismatchedEndTag", (e) => Console.log(`  caught: ${e.message}`))
  )
})

Effect.runPromise(
  Effect.all([saxDemo, xmlDemo, htmlDemo, errorDemo], { discard: true })
).catch((e) => {
  console.error(e)
  process.exit(1)
})
