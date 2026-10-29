import { describe, expect, test } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { Xml } from "../src/index.ts";
import { success } from "./support/narrow.ts";

const recover = (input: string) => Effect.runSync(Xml.parse(input, { recover: true }));
const repaired = (input: string) => Xml.serializeDocument(recover(input));
const strict = (input: string) => Effect.runSync(Effect.result(Xml.parse(input)));

describe("Xml.parse({ recover: true })", () => {
  test("a document that needs no repair parses as it does strictly", () => {
    const input = `<?xml version="1.0"?><!-- before --><a x="1"><b>t</b><c/></a><!-- after -->\n`;
    const parsed = success(strict(input));
    expect(recover(input)).toStrictEqual(parsed);
  });

  test("an end tag closes the open elements up to the one it names", () => {
    expect(repaired("<a><b><c>x</a>")).toBe("<a><b><c>x</c></b></a>");
  });

  test("an end tag that names no open element is ignored", () => {
    expect(repaired("<a>x</b>y</a>")).toBe("<a>xy</a>");
    expect(repaired("</z><a/>")).toBe("<a/>");
  });

  test("elements still open at the end are closed", () => {
    expect(repaired("<a><b>text")).toBe("<a><b>text</b></a>");
  });

  test("content after the root's end tag is kept under the root", () => {
    expect(repaired("<a>1</a><b>2</b>tail")).toBe("<a>1<b>2</b>tail</a>");
    // Comments and whitespace after the root keep their place.
    expect(repaired("<a/>\n<!--c-->\n")).toBe("<a/><!--c-->");
  });

  test("character data before the root opens a synthesized root", () => {
    expect(repaired("hello <b>world</b>")).toBe("<root>hello <b>world</b></root>");
    expect(repaired("<!--only a comment-->")).toBe("<!--only a comment--><root/>");
    expect(repaired("")).toBe("<root/>");
  });

  test("a repeated attribute keeps its first value", () => {
    const root = recover(`<a x="1" x="2" p:y="3" q:y="4" xmlns:p="urn:n" xmlns:q="urn:n"/>`).root;
    expect(root.attribute("x")).toBe("1");
    expect(root.attributes.map((a) => a.name.qualified)).toStrictEqual([
      "x",
      "p:y",
      "xmlns:p",
      "xmlns:q",
    ]);
  });

  test("an unbound prefix leaves the name without a namespace", () => {
    const root = recover(`<p:a q:b="1"/>`).root;
    expect(root.name.qualified).toBe("p:a");
    expect(root.name.namespace).toBeNull();
    expect(root.attributes[0]?.name.namespace).toBeNull();
  });

  test("namespaces still resolve where they are bound", () => {
    const root = recover(`<a xmlns="urn:d"><b>x</a>`).root;
    expect(root.name.namespace).toBe("urn:d");
    expect(root.elements[0]?.name.namespace).toBe("urn:d");
  });

  test("without recover, the same inputs fail as before", () => {
    const failures = Arr.map(
      ["<a><b><c>x</a>", "<a>x</b>y</a>", "<a><b>text", "<a/><b/>", "hello", `<a x="1" x="2"/>`],
      (input) => Result.isFailure(strict(input)),
    );
    expect(failures).toStrictEqual([true, true, true, true, true, true]);
    const mismatch = strict("<a><b></a>");
    expect(Result.isFailure(mismatch) && mismatch.failure._tag).toBe("MismatchedEndTag");
  });

  test("the result does not depend on chunk boundaries", () => {
    const input = `<doc><p>one<p>two</doc><extra a="1">x</extra>tail<!--c-->`;
    const whole = Xml.serializeDocument(recover(input));
    Arr.forEach(Arr.range(1, input.length), (size) => {
      const chunks = Arr.makeBy(Math.ceil(input.length / size), (i) =>
        input.slice(i * size, i * size + size),
      );
      const doc = Effect.runSync(
        Stream.fromIterable(chunks).pipe(Xml.parseStream({ recover: true })),
      );
      expect(Xml.serializeDocument(doc)).toBe(whole);
    });
  });
});
