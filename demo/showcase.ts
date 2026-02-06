/**
 * Demonstration of effect-sax capabilities
 */
import * as Eff from "effect/Effect";
import * as Str from "effect/Stream";
import {
  generateSignalStream,
  gatherSignals,
  keepOpenings,
  captureElementText,
  countElement,
  TagOpened,
  CharData,
} from "../lib/mod";

const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<catalog>
  <product id="p1" category="electronics">
    <name>Laptop Computer</name>
    <manufacturer>TechCorp</manufacturer>
    <year>2023</year>
    <cost>1299.99</cost>
  </product>
  <product id="p2" category="books">
    <name>Programming Guide</name>
    <manufacturer>PublishCo</manufacturer>
    <year>2022</year>
    <cost>49.99</cost>
  </product>
  <!-- Inventory note -->
  <product id="p3" category="electronics">
    <name>Wireless Mouse</name>
    <manufacturer>TechCorp</manufacturer>
    <year>2024</year>
    <cost>29.99</cost>
  </product>
</catalog>`;

// Demo 1: Display all signals
const demo1 = Eff.gen(function* (_) {
  console.log("=== Demo 1: All Signals ===");
  const allSignals = yield* _(gatherSignals(sampleXml));

  for (const sig of allSignals) {
    if (sig instanceof TagOpened) {
      console.log(
        `Opening: <${sig.elementName}>`,
        "attrs:",
        sig.attrs,
        "selfClosed:",
        sig.selfClosed
      );
    } else if (sig instanceof CharData) {
      console.log(`Content:`, sig.content);
    } else {
      console.log(`Signal:`, sig);
    }
  }
});

// Demo 2: Extract only opening tags
const demo2 = Eff.gen(function* (_) {
  console.log("\n=== Demo 2: Opening Tags ===");
  const flow = generateSignalStream(sampleXml);
  const openings = keepOpenings(flow);

  yield* _(
    openings,
    Str.runForEach((tag) =>
      Eff.sync(() => {
        console.log(`Element: <${tag.elementName}>`, tag.attrs);
      })
    )
  );
});

// Demo 3: Capture product names
const demo3 = Eff.gen(function* (_) {
  console.log("\n=== Demo 3: Product Names ===");
  const flow = generateSignalStream(sampleXml);
  const names = captureElementText(flow, "name");

  yield* _(
    names,
    Str.runForEach((productName) =>
      Eff.sync(() => {
        console.log("Product:", productName);
      })
    )
  );
});

// Demo 4: Stream processing with chunks
const demo4 = Eff.gen(function* (_) {
  console.log("\n=== Demo 4: Chunked Stream ===");

  // Simulate streaming chunks
  const xmlChunks = Str.fromIterable([
    "<inventory>",
    "<item><id>001</id></item>",
    "<item><id>002</id></item>",
    "</inventory>",
  ]);

  yield* _(
    xmlChunks,
    Str.flatMap((chunk) => generateSignalStream(chunk)),
    Str.filter((sig) => sig instanceof CharData && sig.content.trim().length > 0),
    Str.runForEach((sig) =>
      Eff.sync(() => {
        if (sig instanceof CharData) {
          console.log("Item ID:", sig.content);
        }
      })
    )
  );
});

// Demo 5: Count specific elements
const demo5 = Eff.gen(function* (_) {
  console.log("\n=== Demo 5: Count Products ===");
  const flow = generateSignalStream(sampleXml);

  const productCount = yield* _(countElement(flow, "product"));

  console.log(`Total products: ${productCount}`);
});

// Execute all demonstrations
const mainProgram = Eff.gen(function* (_) {
  yield* _(demo1);
  yield* _(demo2);
  yield* _(demo3);
  yield* _(demo4);
  yield* _(demo5);
});

Eff.runPromise(mainProgram).catch(console.error);
