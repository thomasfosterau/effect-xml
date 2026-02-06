/**
 * Example usage of effect-sax message-based XML processing
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  createMessageStream,
  collectMessages,
  isolateStarts,
  harvestTagContent,
  quantifyTag,
  ElementStart,
  ContentChunk,
} from "../source/index";

const sampleMarkup = `<?xml version="1.0"?>
<warehouse>
  <product sku="A001" dept="tech">
    <itemName>Mechanical Keyboard</itemName>
    <vendor>KeyboardCo</vendor>
    <releaseYear>2024</releaseYear>
    <retailPrice>89.99</retailPrice>
  </product>
  <product sku="A002" dept="books">
    <itemName>TypeScript Handbook</itemName>
    <vendor>TechBooks</vendor>
    <releaseYear>2023</releaseYear>
    <retailPrice>34.99</retailPrice>
  </product>
  <!-- Seasonal inventory -->
  <product sku="A003" dept="tech">
    <itemName>USB-C Hub</itemName>
    <vendor>KeyboardCo</vendor>
    <releaseYear>2024</releaseYear>
    <retailPrice>24.99</retailPrice>
  </product>
</warehouse>`;

// Example 1: Display all messages
const example1 = Effect.gen(function* (_) {
  console.log("=== Example 1: All Messages ===");
  const allMessages = yield* _(collectMessages(sampleMarkup));

  for (const msg of allMessages) {
    if (msg instanceof ElementStart) {
      console.log(
        `Start <${msg.tagIdentifier}>`,
        "props:",
        msg.propertyBag,
        "standalone:",
        msg.standalone
      );
    } else if (msg instanceof ContentChunk) {
      console.log(`Content:`, msg.payload);
    } else {
      console.log(`Message:`, msg._tag);
    }
  }
});

// Example 2: Isolate element starts
const example2 = Effect.gen(function* (_) {
  console.log("\n=== Example 2: Element Starts ===");
  const msgFlow = createMessageStream(sampleMarkup);
  const starts = isolateStarts(msgFlow);

  yield* _(
    starts,
    Stream.runForEach((elem) =>
      Effect.sync(() => {
        console.log(`Element: <${elem.tagIdentifier}>`, elem.propertyBag);
      })
    )
  );
});

// Example 3: Harvest product names
const example3 = Effect.gen(function* (_) {
  console.log("\n=== Example 3: Product Names ===");
  const msgFlow = createMessageStream(sampleMarkup);
  const names = harvestTagContent(msgFlow, "itemName");

  yield* _(
    names,
    Stream.runForEach((productName) =>
      Effect.sync(() => {
        console.log("Product:", productName);
      })
    )
  );
});

// Example 4: Stream processing with multiple chunks
// Note: Each chunk must be well-formed XML. This example treats each chunk
// as an independent document. For true streaming of large files split across
// arbitrary boundaries, use Effect's file streaming capabilities.
const example4 = Effect.gen(function* (_) {
  console.log("\n=== Example 4: Chunked Processing ===");

  const markupChunks = Stream.fromIterable([
    "<stockList>",
    "<stock><code>XYZ</code></stock>",
    "<stock><code>ABC</code></stock>",
    "</stockList>",
  ]);

  yield* _(
    markupChunks,
    Stream.flatMap((chunk) => createMessageStream(chunk)),
    Stream.filter((msg) => msg instanceof ContentChunk && msg.payload.length > 0),
    Stream.runForEach((msg) =>
      Effect.sync(() => {
        if (msg instanceof ContentChunk) {
          console.log("Stock code:", msg.payload);
        }
      })
    )
  );
});

// Example 5: Count specific elements
const example5 = Effect.gen(function* (_) {
  console.log("\n=== Example 5: Quantify Products ===");
  const msgFlow = createMessageStream(sampleMarkup);

  const productQty = yield* _(quantifyTag(msgFlow, "product"));

  console.log(`Total products: ${productQty}`);
});

// Execute all examples
const mainExample = Effect.gen(function* (_) {
  yield* _(example1);
  yield* _(example2);
  yield* _(example3);
  yield* _(example4);
  yield* _(example5);
});

Effect.runPromise(mainExample).catch(console.error);
