/**
 * Stream operation tests
 */
import { test, expect, describe } from "bun:test";
import * as Eff from "effect/Effect";
import * as Str from "effect/Stream";
import {
  generateSignalStream,
  keepOpenings,
  keepCharData,
  captureElementText,
  selectByElement,
  countElement,
  TagOpened,
  CharData,
} from "../lib/mod";

describe("Stream Operations", () => {
  test("filters to opening tags only", async () => {
    const markup = "<root><child>data</child></root>";
    const flow = generateSignalStream(markup);
    const openings = keepOpenings(flow);

    const collected = await Eff.runPromise(
      Str.runCollect(openings).pipe(Eff.map((chunk) => Array.from(chunk)))
    );

    expect(collected).toHaveLength(2);
    expect(collected[0].elementName).toBe("root");
    expect(collected[1].elementName).toBe("child");
  });

  test("filters to character data only", async () => {
    const markup = "<root>first<child>second</child>third</root>";
    const flow = generateSignalStream(markup);
    const charData = keepCharData(flow);

    const collected = await Eff.runPromise(
      Str.runCollect(charData).pipe(Eff.map((chunk) => Array.from(chunk)))
    );

    expect(collected).toHaveLength(3);
    expect(collected[0].content).toBe("first");
    expect(collected[1].content).toBe("second");
    expect(collected[2].content).toBe("third");
  });

  test("captures text within element boundaries", async () => {
    const markup = "<root><title>First</title><title>Second</title></root>";
    const flow = generateSignalStream(markup);
    const titles = captureElementText(flow, "title");

    const collected = await Eff.runPromise(
      Str.runCollect(titles).pipe(Eff.map((chunk) => Array.from(chunk)))
    );

    expect(collected).toHaveLength(2);
    expect(collected[0]).toBe("First");
    expect(collected[1]).toBe("Second");
  });

  test("selects signals by element identifier", async () => {
    const markup = "<root><child>data</child><other>info</other></root>";
    const flow = generateSignalStream(markup);
    const childSignals = selectByElement(flow, "child");

    const collected = await Eff.runPromise(
      Str.runCollect(childSignals).pipe(Eff.map((chunk) => Array.from(chunk)))
    );

    expect(collected).toHaveLength(2);
    expect(collected[0]).toMatchObject({ elementName: "child" });
    expect(collected[1]).toMatchObject({ elementName: "child" });
  });

  test("processes chunked streams", async () => {
    const chunks = Str.fromIterable([
      "<root>",
      "<child>data</child>",
      "</root>",
    ]);

    const signals = await Eff.runPromise(
      chunks.pipe(
        Str.flatMap((chunk) => generateSignalStream(chunk)),
        Str.runCollect,
        Eff.map((chunk) => Array.from(chunk))
      )
    );

    expect(signals.length).toBeGreaterThan(0);
  });

  test("counts element occurrences", async () => {
    const markup =
      "<root><item>1</item><item>2</item><item>3</item></root>";
    const flow = generateSignalStream(markup);

    const total = await Eff.runPromise(countElement(flow, "item"));

    expect(total).toBe(3);
  });

  test("captures nested element text", async () => {
    const markup = `
      <library>
        <book><title>First Book</title></book>
        <book><title>Second Book</title></book>
        <book><title>Third Book</title></book>
      </library>
    `;

    const flow = generateSignalStream(markup);
    const titles = captureElementText(flow, "title");

    const collected = await Eff.runPromise(
      Str.runCollect(titles).pipe(Eff.map((chunk) => Array.from(chunk)))
    );

    expect(collected).toHaveLength(3);
    expect(collected[0]).toBe("First Book");
    expect(collected[1]).toBe("Second Book");
    expect(collected[2]).toBe("Third Book");
  });

  test("processes large element counts", async () => {
    const items = Array.from({ length: 100 }, (_, i) => `<item>${i}</item>`).join("");
    const markup = `<root>${items}</root>`;

    const flow = generateSignalStream(markup);
    const total = await Eff.runPromise(countElement(flow, "item"));

    expect(total).toBe(100);
  });
});
