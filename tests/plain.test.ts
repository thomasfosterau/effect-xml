/**
 * Plain trees (`Xml.parsePlain`) against the DOM: the same documents parse,
 * the same ones fail and with the same failures as `Xml.parse` with
 * `namespaces: false`, and each tree is the DOM's, plainly.
 */
import { describe, expect, test } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import { Xml } from "../src/index.ts";
import { documents } from "./support/documents.ts";

/** A DOM element as the plain tree has it. */
const plain = (element: Xml.XmlElement): Xml.PlainElement => ({
  name: element.name.qualified,
  attributes: R.fromEntries(element.attributes.map((a) => [a.name.qualified, a.value])),
  children: Arr.reduce(element.children, Arr.empty<Xml.PlainNode>(), (out, node) =>
    Match.value(node).pipe(
      Match.tag("XmlElement", (child) => [...out, plain(child)]),
      Match.tag("XmlText", "XmlCData", (text) => {
        const last = out.at(-1);
        return P.isString(last) ? [...out.slice(0, -1), last + text.data] : [...out, text.data];
      }),
      Match.orElse(() => out),
    ),
  ),
});

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(Effect.exit(effect));

describe("Xml.parsePlain", () => {
  test("agrees with Xml.parse without namespaces: trees and failures", () => {
    Arr.forEach(documents(3, 3000), (doc) =>
      expect(run(Xml.parsePlain(doc)), doc).toStrictEqual(
        Exit.map(run(Xml.parse(doc, { namespaces: false })), (d) => plain(d.root)),
      ),
    );
  });

  test("joins text and CDATA, and leaves out comments, PIs and the DOCTYPE", () => {
    const root = Effect.runSync(
      Xml.parsePlain(
        `<?xml version="1.0"?><!DOCTYPE r><r a="1">x<!-- c --><![CDATA[<y>]]>&amp;<?p d?><e/>z</r>`,
      ),
    );
    expect(root).toStrictEqual({
      name: "r",
      attributes: { a: "1" },
      children: ["x<y>&", { name: "e", attributes: {}, children: [] }, "z"],
    });
  });

  test("an attribute named __proto__ is an attribute", () => {
    const root = Effect.runSync(Xml.parsePlain(`<r __proto__="p" b="2"/>`));
    expect(Object.getPrototypeOf(root.attributes)).toBe(Object.prototype);
    expect(R.toEntries(root.attributes)).toStrictEqual([
      ["__proto__", "p"],
      ["b", "2"],
    ]);
  });

  test("reads bytes, and fails where Xml.parse fails, at the same place", () => {
    const bytes = new TextEncoder().encode(`<r>\n  <a></b></r>`);
    expect(run(Xml.parsePlain(bytes))).toStrictEqual(
      run(Effect.map(Xml.parseBytes(bytes, { namespaces: false }), (d) => plain(d.root))),
    );
    expect(Exit.isFailure(run(Xml.parsePlain(bytes)))).toBe(true);
  });
});
