/**
 * Core parsing tests
 */
import { test, expect, describe } from "bun:test";
import * as Eff from "effect/Effect";
import { gatherSignals, TagOpened, CharData, TagClosed } from "../lib/mod";

describe("XML Signal Generation", () => {
  test("handles basic element structure", async () => {
    const markup = "<container><child>data</child></container>";
    const signals = await Eff.runPromise(gatherSignals(markup));

    expect(signals).toHaveLength(5);
    expect(signals[0]).toBeInstanceOf(TagOpened);
    expect(signals[1]).toBeInstanceOf(TagOpened);
    expect(signals[2]).toBeInstanceOf(CharData);
    expect(signals[3]).toBeInstanceOf(TagClosed);
    expect(signals[4]).toBeInstanceOf(TagClosed);
  });

  test("processes self-closing elements", async () => {
    const markup = "<container><empty /></container>";
    const signals = await Eff.runPromise(gatherSignals(markup));

    const emptySig = signals.find(
      (s) => s instanceof TagOpened && s.elementName === "empty"
    );
    expect(emptySig).toBeDefined();
    if (emptySig instanceof TagOpened) {
      expect(emptySig.selfClosed).toBe(true);
    }
  });

  test("extracts element attributes", async () => {
    const markup = '<root identifier="val1" label="val2" />';
    const signals = await Eff.runPromise(gatherSignals(markup));

    expect(signals).toHaveLength(1);
    const sig = signals[0];
    expect(sig).toBeInstanceOf(TagOpened);
    if (sig instanceof TagOpened) {
      expect(sig.elementName).toBe("root");
      expect(sig.attrs).toEqual({ identifier: "val1", label: "val2" });
      expect(sig.selfClosed).toBe(true);
    }
  });

  test("recognizes annotations", async () => {
    const markup = "<root><!-- note here --></root>";
    const signals = await Eff.runPromise(gatherSignals(markup));

    const annotSig = signals.find((s) => s._tag === "Annotation");
    expect(annotSig).toBeDefined();
  });

  test("recognizes CDATA blocks", async () => {
    const markup = "<root><![CDATA[raw <content> text]]></root>";
    const signals = await Eff.runPromise(gatherSignals(markup));

    const cdataSig = signals.find((s) => s._tag === "CDataBlock");
    expect(cdataSig).toBeDefined();
  });

  test("recognizes directives", async () => {
    const markup = '<?xml version="1.0"?><root />';
    const signals = await Eff.runPromise(gatherSignals(markup));

    const directiveSig = signals.find((s) => s._tag === "Directive");
    expect(directiveSig).toBeDefined();
  });

  test("handles deeply nested structure", async () => {
    const markup =
      "<root><level1><level2><level3>deepest</level3></level2></level1></root>";
    const signals = await Eff.runPromise(gatherSignals(markup));

    const openings = signals.filter((s) => s instanceof TagOpened);
    const closings = signals.filter((s) => s instanceof TagClosed);

    expect(openings).toHaveLength(4);
    expect(closings).toHaveLength(4);
  });

  test("applies whitespace trimming", async () => {
    const markup = "<root>  content  </root>";
    const signals = await Eff.runPromise(
      gatherSignals(markup, { trimWhitespace: true })
    );

    const dataSig = signals.find((s) => s instanceof CharData);
    expect(dataSig).toBeDefined();
    if (dataSig instanceof CharData) {
      expect(dataSig.content).toBe("content");
    }
  });

  test("handles multiple attributes", async () => {
    const markup = '<elem a="1" b="2" c="3" />';
    const signals = await Eff.runPromise(gatherSignals(markup));

    const sig = signals[0];
    if (sig instanceof TagOpened) {
      expect(sig.attrs).toEqual({ a: "1", b: "2", c: "3" });
    }
  });

  test("handles empty elements", async () => {
    const markup = "<root></root>";
    const signals = await Eff.runPromise(gatherSignals(markup));

    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(TagOpened);
    expect(signals[1]).toBeInstanceOf(TagClosed);
  });
});
