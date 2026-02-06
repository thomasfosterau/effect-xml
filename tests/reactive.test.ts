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
  ElementStart,
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
});
