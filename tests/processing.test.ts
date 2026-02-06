/**
 * Core processing tests
 */
import { test, expect, describe } from "bun:test";
import * as Effect from "effect/Effect";
import { collectMessages, ElementStart, ContentChunk, ElementEnd } from "../source/index";

describe("Message Generation", () => {
  test("processes basic structure", async () => {
    const markup = "<container><child>data</child></container>";
    const messages = await Effect.runPromise(collectMessages(markup));

    expect(messages).toHaveLength(5);
    expect(messages[0]).toBeInstanceOf(ElementStart);
    expect(messages[1]).toBeInstanceOf(ElementStart);
    expect(messages[2]).toBeInstanceOf(ContentChunk);
    expect(messages[3]).toBeInstanceOf(ElementEnd);
    expect(messages[4]).toBeInstanceOf(ElementEnd);
  });

  test("handles standalone elements", async () => {
    const markup = "<container><void /></container>";
    const messages = await Effect.runPromise(collectMessages(markup));

    const voidMsg = messages.find(
      (m) => m instanceof ElementStart && m.tagIdentifier === "void"
    );
    expect(voidMsg).toBeDefined();
    if (voidMsg instanceof ElementStart) {
      expect(voidMsg.standalone).toBe(true);
    }
  });

  test("extracts properties", async () => {
    const markup = '<root alpha="x" beta="y" />';
    const messages = await Effect.runPromise(collectMessages(markup));

    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg).toBeInstanceOf(ElementStart);
    if (msg instanceof ElementStart) {
      expect(msg.tagIdentifier).toBe("root");
      expect(msg.propertyBag).toEqual({ alpha: "x", beta: "y" });
      expect(msg.standalone).toBe(true);
    }
  });

  test("recognizes markup notes", async () => {
    const markup = "<root><!-- note --></root>";
    const messages = await Effect.runPromise(collectMessages(markup));

    const noteMsg = messages.find((m) => m._tag === "MarkupNote");
    expect(noteMsg).toBeDefined();
  });

  test("recognizes raw data sections", async () => {
    const markup = "<root><![CDATA[<raw> content]]></root>";
    const messages = await Effect.runPromise(collectMessages(markup));

    const rawMsg = messages.find((m) => m._tag === "RawDataSection");
    expect(rawMsg).toBeDefined();
  });

  test("recognizes meta instructions", async () => {
    const markup = '<?xml version="1.0"?><root />';
    const messages = await Effect.runPromise(collectMessages(markup));

    const metaMsg = messages.find((m) => m._tag === "MetaInstruction");
    expect(metaMsg).toBeDefined();
  });

  test("handles deep nesting", async () => {
    const markup =
      "<root><level1><level2><level3>deepest</level3></level2></level1></root>";
    const messages = await Effect.runPromise(collectMessages(markup));

    const starts = messages.filter((m) => m instanceof ElementStart);
    const ends = messages.filter((m) => m instanceof ElementEnd);

    expect(starts).toHaveLength(4);
    expect(ends).toHaveLength(4);
  });

  test("collapses whitespace", async () => {
    const markup = "<root>  content  </root>";
    const messages = await Effect.runPromise(
      collectMessages(markup, { collapseWhitespace: true })
    );

    const contentMsg = messages.find((m) => m instanceof ContentChunk);
    expect(contentMsg).toBeDefined();
    if (contentMsg instanceof ContentChunk) {
      expect(contentMsg.payload).toBe("content");
    }
  });

  test("handles multiple properties", async () => {
    const markup = '<elem x="1" y="2" z="3" />';
    const messages = await Effect.runPromise(collectMessages(markup));

    const msg = messages[0];
    if (msg instanceof ElementStart) {
      expect(msg.propertyBag).toEqual({ x: "1", y: "2", z: "3" });
    }
  });

  test("handles empty elements", async () => {
    const markup = "<root></root>";
    const messages = await Effect.runPromise(collectMessages(markup));

    expect(messages).toHaveLength(2);
    expect(messages[0]).toBeInstanceOf(ElementStart);
    expect(messages[1]).toBeInstanceOf(ElementEnd);
  });

  test("generates unique message IDs", async () => {
    const markup = "<a><b></b><c></c></a>";
    const messages = await Effect.runPromise(collectMessages(markup));

    const ids = messages.map((m) => m.messageId);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  test("tracks byte offsets", async () => {
    const markup = "<root><child></child></root>";
    const messages = await Effect.runPromise(collectMessages(markup));

    for (const msg of messages) {
      expect(typeof msg.byteOffset).toBe("number");
      expect(msg.byteOffset).toBeGreaterThanOrEqual(0);
    }
  });
});
