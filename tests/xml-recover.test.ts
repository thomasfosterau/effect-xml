import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { Xml } from "../src/index.ts";
import { success } from "./support/narrow.ts";

const recover = (input: string) => Xml.parse(input, { recover: true });
const repaired = (input: string) =>
  Effect.gen(function* () {
    return Xml.serializeDocument(yield* recover(input));
  });
const strict = (input: string) => Effect.result(Xml.parse(input));

describe("Xml.parse({ recover: true })", () => {
  it.effect("a document that needs no repair parses as it does strictly", () =>
    Effect.gen(function* () {
      const input = `<?xml version="1.0"?><!-- before --><a x="1"><b>t</b><c/></a><!-- after -->\n`;
      const parsed = success(yield* strict(input));
      expect(yield* recover(input)).toStrictEqual(parsed);
    }),
  );

  it.effect("an end tag closes the open elements up to the one it names", () =>
    Effect.gen(function* () {
      expect(yield* repaired("<a><b><c>x</a>")).toBe("<a><b><c>x</c></b></a>");
    }),
  );

  it.effect("an end tag that names no open element is ignored", () =>
    Effect.gen(function* () {
      expect(yield* repaired("<a>x</b>y</a>")).toBe("<a>xy</a>");
      expect(yield* repaired("</z><a/>")).toBe("<a/>");
    }),
  );

  it.effect("elements still open at the end are closed", () =>
    Effect.gen(function* () {
      expect(yield* repaired("<a><b>text")).toBe("<a><b>text</b></a>");
    }),
  );

  it.effect("content after the root's end tag is kept under the root", () =>
    Effect.gen(function* () {
      expect(yield* repaired("<a>1</a><b>2</b>tail")).toBe("<a>1<b>2</b>tail</a>");
      // Comments and whitespace after the root keep their place.
      expect(yield* repaired("<a/>\n<!--c-->\n")).toBe("<a/><!--c-->");
    }),
  );

  it.effect("character data before the root opens a synthesized root", () =>
    Effect.gen(function* () {
      expect(yield* repaired("hello <b>world</b>")).toBe("<root>hello <b>world</b></root>");
      expect(yield* repaired("<!--only a comment-->")).toBe("<!--only a comment--><root/>");
      expect(yield* repaired("")).toBe("<root/>");
    }),
  );

  it.effect("a repeated attribute keeps its first value", () =>
    Effect.gen(function* () {
      const root = (yield* recover(
        `<a x="1" x="2" p:y="3" q:y="4" xmlns:p="urn:n" xmlns:q="urn:n"/>`,
      )).root;
      expect(root.attribute("x")).toEqual(Option.some("1"));
      expect(root.attributes.map((a) => a.name.qualified)).toStrictEqual([
        "x",
        "p:y",
        "xmlns:p",
        "xmlns:q",
      ]);
    }),
  );

  it.effect("an unbound prefix leaves the name without a namespace", () =>
    Effect.gen(function* () {
      const root = (yield* recover(`<p:a q:b="1"/>`)).root;
      expect(root.name.qualified).toBe("p:a");
      expect(root.name.namespace).toEqual(Option.none());
      expect(root.attributes[0]?.name.namespace).toEqual(Option.none());
    }),
  );

  it.effect("namespaces still resolve where they are bound", () =>
    Effect.gen(function* () {
      const root = (yield* recover(`<a xmlns="urn:d"><b>x</a>`)).root;
      expect(root.name.namespace).toEqual(Option.some("urn:d"));
      expect(root.elements[0]?.name.namespace).toEqual(Option.some("urn:d"));
    }),
  );

  it.effect("without recover, the same inputs fail as before", () =>
    Effect.gen(function* () {
      const failures = yield* Effect.forEach(
        ["<a><b><c>x</a>", "<a>x</b>y</a>", "<a><b>text", "<a/><b/>", "hello", `<a x="1" x="2"/>`],
        (input) =>
          Effect.gen(function* () {
            return Result.isFailure(yield* strict(input));
          }),
        { concurrency: 1 },
      );
      expect(failures).toStrictEqual([true, true, true, true, true, true]);
      const mismatch = yield* strict("<a><b></a>");
      expect(Result.isFailure(mismatch) && mismatch.failure._tag).toBe("MismatchedEndTag");
    }),
  );

  it.effect("the result does not depend on chunk boundaries", () =>
    Effect.gen(function* () {
      const input = `<doc><p>one<p>two</doc><extra a="1">x</extra>tail<!--c-->`;
      const whole = Xml.serializeDocument(yield* recover(input));
      yield* Effect.forEach(
        Arr.range(1, input.length),
        (size) =>
          Effect.gen(function* () {
            const chunks = Arr.makeBy(Math.ceil(input.length / size), (i) =>
              input.slice(i * size, i * size + size),
            );
            const doc = yield* Stream.fromIterable(chunks).pipe(Xml.parseStream({ recover: true }));
            expect(Xml.serializeDocument(doc)).toBe(whole);
          }),
        { concurrency: 1, discard: true },
      );
    }),
  );
});
