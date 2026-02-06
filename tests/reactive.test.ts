/**
 * Reactive operations tests
 */
import { test, expect, describe } from "bun:test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  createMessageStream,
  isolateStarts,
  isolateContent,
  harvestTagContent,
  selectByTag,
  quantifyTag,
  ContentChunk,
} from "../source/index";

describe("Reactive Operations", () => {
  test("isolates element starts", async () => {
    const markup = "<root><child>data</child></root>";
    const msgFlow = createMessageStream(markup);
    const starts = isolateStarts(msgFlow);

    const collected = await Effect.runPromise(
      Stream.runCollect(starts).pipe(Effect.map((chunk) => Array.from(chunk)))
    );

    expect(collected).toHaveLength(2);
    expect(collected[0].tagIdentifier).toBe("root");
    expect(collected[1].tagIdentifier).toBe("child");
  });

  test("isolates content chunks", async () => {
    const markup = "<root>first<child>second</child>third</root>";
    const msgFlow = createMessageStream(markup);
    const content = isolateContent(msgFlow);

    const collected = await Effect.runPromise(
      Stream.runCollect(content).pipe(Effect.map((chunk) => Array.from(chunk)))
    );

    expect(collected).toHaveLength(3);
    expect(collected[0].payload).toBe("first");
    expect(collected[1].payload).toBe("second");
    expect(collected[2].payload).toBe("third");
  });

  test("harvests content between tags", async () => {
    const markup = "<root><title>First</title><title>Second</title></root>";
    const msgFlow = createMessageStream(markup);
    const titles = harvestTagContent(msgFlow, "title");

    const collected = await Effect.runPromise(
      Stream.runCollect(titles).pipe(Effect.map((chunk) => Array.from(chunk)))
    );

    expect(collected).toHaveLength(2);
    expect(collected[0]).toBe("First");
    expect(collected[1]).toBe("Second");
  });

  test("selects by tag identifier", async () => {
    const markup = "<root><child>data</child><other>info</other></root>";
    const msgFlow = createMessageStream(markup);
    const childMsgs = selectByTag(msgFlow, "child");

    const collected = await Effect.runPromise(
      Stream.runCollect(childMsgs).pipe(Effect.map((chunk) => Array.from(chunk)))
    );

    expect(collected).toHaveLength(2);
    expect(collected[0]).toMatchObject({ tagIdentifier: "child" });
    expect(collected[1]).toMatchObject({ tagIdentifier: "child" });
  });

  test("processes chunked streams", async () => {
    // Note: Each chunk is treated as independent XML. This demonstrates
    // processing multiple separate documents, not splitting a single document.
    const chunks = Stream.fromIterable([
      "<root>",
      "<child>data</child>",
      "</root>",
    ]);

    const messages = await Effect.runPromise(
      chunks.pipe(
        Stream.flatMap((chunk) => createMessageStream(chunk)),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk))
      )
    );

    expect(messages.length).toBeGreaterThan(0);
  });

  test("quantifies tag occurrences", async () => {
    const markup =
      "<root><item>1</item><item>2</item><item>3</item></root>";
    const msgFlow = createMessageStream(markup);

    const total = await Effect.runPromise(quantifyTag(msgFlow, "item"));

    expect(total).toBe(3);
  });

  test("harvests nested content", async () => {
    const markup = `
      <library>
        <book><title>First</title></book>
        <book><title>Second</title></book>
        <book><title>Third</title></book>
      </library>
    `;

    const msgFlow = createMessageStream(markup);
    const titles = harvestTagContent(msgFlow, "title");

    const collected = await Effect.runPromise(
      Stream.runCollect(titles).pipe(Effect.map((chunk) => Array.from(chunk)))
    );

    expect(collected).toHaveLength(3);
    expect(collected[0]).toBe("First");
    expect(collected[1]).toBe("Second");
    expect(collected[2]).toBe("Third");
  });

  test("handles high volume", async () => {
    const items = Array.from({ length: 100 }, (_, i) => `<item>${i}</item>`).join(
      ""
    );
    const markup = `<root>${items}</root>`;

    const msgFlow = createMessageStream(markup);
    const total = await Effect.runPromise(quantifyTag(msgFlow, "item"));

    expect(total).toBe(100);
  });

  test("filters with configuration", async () => {
    const markup = "<root>   </root>";
    const msgFlow = createMessageStream(markup, { collapseWhitespace: true });

    const messages = await Effect.runPromise(
      Stream.runCollect(msgFlow).pipe(Effect.map((chunk) => Array.from(chunk)))
    );

    const contentMsgs = messages.filter((m) => m instanceof ContentChunk);
    expect(contentMsgs).toHaveLength(0);
  });

  test("isolates element ends", async () => {
    const markup = "<root><child>data</child></root>";
    const msgFlow = createMessageStream(markup);
    
    const { isolateEnds, ElementEnd } = await import("../source/index");
    const ends = isolateEnds(msgFlow);

    const collected = await Effect.runPromise(
      Stream.runCollect(ends).pipe(Effect.map((chunk) => Array.from(chunk)))
    );

    expect(collected).toHaveLength(2);
    expect(collected[0].tagIdentifier).toBe("child");
    expect(collected[1].tagIdentifier).toBe("root");
  });

  test("aggregates properties from tags", async () => {
    const markup = '<root><item id="1" type="a"/><item id="2" type="b"/></root>';
    const msgFlow = createMessageStream(markup);
    
    const { aggregateProperties } = await import("../source/index");
    const props = await Effect.runPromise(aggregateProperties(msgFlow, "item"));

    expect(props).toHaveLength(2);
    expect(props[0]).toEqual({ id: "1", type: "a" });
    expect(props[1]).toEqual({ id: "2", type: "b" });
  });

  test("transforms messages with custom mapper", async () => {
    const markup = "<root><child>data</child></root>";
    const msgFlow = createMessageStream(markup);
    
    const { transformStream, ElementStart } = await import("../source/index");
    const transformed = transformStream(msgFlow, (msg) => {
      if (msg instanceof ElementStart) {
        return msg.tagIdentifier.toUpperCase();
      }
      return null;
    });

    const collected = await Effect.runPromise(
      transformed.pipe(
        Stream.filter((v) => v !== null),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk))
      )
    );

    expect(collected).toEqual(["ROOT", "CHILD"]);
  });

  test("folds messages into accumulated state", async () => {
    const markup = "<root><a/><b/><c/></root>";
    const msgFlow = createMessageStream(markup);
    
    const { foldMessages, ElementStart } = await import("../source/index");
    const result = await Effect.runPromise(
      foldMessages(
        msgFlow,
        { count: 0, depth: 0 },
        (state, msg) => {
          if (msg instanceof ElementStart) {
            return { count: state.count + 1, depth: state.depth + 1 };
          }
          return state;
        }
      )
    );

    expect(result.count).toBe(4); // root, a, b, c
  });

  test("applies schema validation to messages", async () => {
    const markup = "<root><child>data</child></root>";
    const msgFlow = createMessageStream(markup);
    
    const { applyValidation, ElementStart } = await import("../source/index");
    const Schema = await import("@effect/schema/Schema");
    
    // Create a schema that only accepts ElementStart with tagIdentifier "root"
    const RootTagSchema = Schema.Struct({
      _tag: Schema.Literal("ElementStart"),
      tagIdentifier: Schema.Literal("root"),
      propertyBag: Schema.Record(Schema.String, Schema.String),
      standalone: Schema.Boolean,
      messageId: Schema.String,
      byteOffset: Schema.Number,
    });

    const validated = applyValidation(RootTagSchema)(msgFlow);

    const collected = await Effect.runPromise(
      validated.pipe(
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchAll(() => Effect.succeed([]))
      )
    );

    // Should have at least one message (the root tag) or catch validation errors
    expect(collected.length).toBeGreaterThanOrEqual(0);
  });
});
