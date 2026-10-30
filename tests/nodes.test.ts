/**
 * The parsers build DOM nodes without running the `Schema` class constructors
 * (`src/internal/nodes.ts`), so every node they produce must be exactly what
 * `new` would have produced from the same fields. If an `effect` upgrade
 * changes what a `Schema` class instance holds, this fails.
 */
import { describe, expect, test } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Hash from "effect/Hash";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Html, Sax, Xml } from "../src/index.ts";
import {
  HtmlAttribute,
  HtmlComment,
  HtmlDoctype,
  HtmlDocument,
  HtmlElement,
  HtmlTemplateContent,
  HtmlText,
} from "../src/Html/Node.ts";
import { QName } from "../src/Name.ts";
import {
  XmlAttribute,
  XmlCData,
  XmlComment,
  XmlDeclaration,
  XmlDoctype,
  XmlDocument,
  XmlElement,
  XmlProcessingInstruction,
  XmlText,
} from "../src/Xml/Node.ts";

/** Every class the parsers build. */
type Instance =
  | QName
  | XmlAttribute
  | XmlText
  | XmlCData
  | XmlComment
  | XmlProcessingInstruction
  | XmlElement
  | XmlDeclaration
  | XmlDoctype
  | XmlDocument
  | HtmlAttribute
  | HtmlText
  | HtmlComment
  | HtmlTemplateContent
  | HtmlElement
  | HtmlDoctype
  | HtmlDocument;

/** A class the parsers build, constructed (and validated) from its own fields. */
type InstanceClass = new (fields: Instance) => Instance;

/** The same instance built with `new` (and so by the class's own schema). */
const rebuild = (node: Instance): Instance => {
  // SAFETY: each instance's constructor is its Schema class, which takes the
  // instance as its fields.
  const Class = node.constructor as InstanceClass;
  return new Class(node);
};

/** The classes that are their own schema; the others encode through their node union. */
const ownSchemas = [
  QName,
  XmlAttribute,
  XmlDeclaration,
  XmlDoctype,
  XmlDocument,
  HtmlAttribute,
  HtmlTemplateContent,
  HtmlDoctype,
  HtmlDocument,
] as const;

/** The schema that encodes `node`. */
const schemaOf = (node: Instance): Schema.Codec<unknown, unknown> =>
  Option.getOrElse(
    Arr.findFirst(ownSchemas, (Class): boolean => node instanceof Class),
    (): Schema.Codec<unknown, unknown> =>
      node.constructor.name.startsWith("Html") ? Html.HtmlNode : Xml.XmlNode,
  );

/** The present one of an optional part. */
const optional = <A>(part: A | null): ReadonlyArray<A> => (part === null ? [] : [part]);

/** The nodes directly inside `node`: names, attributes, children, declarations. */
const parts: (node: Instance) => ReadonlyArray<Instance> = Match.type<Instance>().pipe(
  Match.when(Match.instanceOf(XmlAttribute), (n) => [n.name]),
  Match.when(Match.instanceOf(XmlElement), (n) => [n.name, ...n.attributes, ...n.children]),
  Match.when(Match.instanceOf(XmlDocument), (n) => [
    ...optional(n.declaration),
    ...optional(n.doctype),
    ...n.children,
  ]),
  Match.when(Match.instanceOf(HtmlElement), (n) => [
    ...n.attributes,
    ...n.children,
    ...optional(n.content),
  ]),
  Match.when(Match.instanceOf(HtmlTemplateContent), (n) => n.children),
  Match.when(Match.instanceOf(HtmlDocument), (n) => [...optional(n.doctype), ...n.children]),
  Match.orElse((): ReadonlyArray<Instance> => []),
);

/** Every node in these trees, without recursion. */
const everyNode = (roots: ReadonlyArray<Instance>): Array<Instance> =>
  Arr.unfold(roots, (pending) =>
    Arr.match(pending, {
      onEmpty: () => Option.none(),
      onNonEmpty: ([node, ...rest]) => Option.some([node, [...parts(node), ...rest]] as const),
    }),
  );

/** An instance's own properties, in order, with their descriptors. */
const own = (value: Instance) =>
  Reflect.ownKeys(value).map((key) => [key, Object.getOwnPropertyDescriptor(value, key)]);

/** Assert every node in `roots` is indistinguishable from the same node built with `new`; the class names seen. */
const expectAsConstructed = (roots: ReadonlyArray<Instance>): Array<string> => {
  const nodes = everyNode(roots);
  Arr.forEach(nodes, (actual) => {
    const expected = rebuild(actual);
    expect(Object.getPrototypeOf(actual)).toBe(Object.getPrototypeOf(expected));
    expect(own(actual)).toEqual(own(expected));
    expect(Object.isFrozen(actual)).toBe(Object.isFrozen(expected));
    expect(Object.isExtensible(actual)).toBe(Object.isExtensible(expected));
    expect(Equal.equals(actual, expected)).toBe(true);
    expect(Equal.equals(expected, actual)).toBe(true);
    expect(Hash.hash(actual)).toBe(Hash.hash(expected));
    expect(String(actual)).toBe(String(expected));
    const schema = schemaOf(actual);
    expect(Schema.is(schema)(actual)).toBe(true);
    expect(Schema.encodeSync(schema)(actual)).toStrictEqual(Schema.encodeSync(schema)(expected));
  });
  return Arr.dedupe(Arr.map(nodes, (node) => node.constructor.name));
};

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE r SYSTEM "r.dtd">
<?top level?>
<r xmlns="urn:d" xmlns:p="urn:p" p:a="1" b="2" xml:lang="en">
  text<![CDATA[cdata]]><!-- comment --><?pi data?>
  <p:e/><e><f>deep</f></e>
</r>
<!-- after -->`;

const allClasses = [
  "QName",
  "XmlAttribute",
  "XmlText",
  "XmlCData",
  "XmlComment",
  "XmlProcessingInstruction",
  "XmlElement",
  "XmlDeclaration",
  "XmlDoctype",
  "XmlDocument",
];

describe("parsed nodes are indistinguishable from constructed ones", () => {
  test("Xml.parse", async () => {
    const doc = await Effect.runPromise(Xml.parse(xml));
    expect(Arr.sort(expectAsConstructed([doc]), Order.String)).toEqual(
      Arr.sort(allClasses, Order.String),
    );
  });

  test("Xml.parse without namespaces, and recovering", async () => {
    const plain = await Effect.runPromise(Xml.parse(xml, { namespaces: false }));
    const recovered = await Effect.runPromise(
      Xml.parse(`<r q:x="1" a="1" a="2"><open>text<x:y/></r>`, { recover: true }),
    );
    expectAsConstructed([plain, recovered]);
  });

  test("Sax.select", async () => {
    const selected = await Effect.runPromise(
      Stream.make(xml).pipe(
        Sax.tokenize(),
        Sax.select("//d:e", { namespaces: { d: "urn:d" } }),
        Stream.runCollect,
      ),
    );
    expect(selected.length).toBe(1);
    expectAsConstructed(selected);
  });

  const htmlInput =
    `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">` +
    `<title>t</title><p class=x>a<b>b<i>c</b>d</i><!-- c --><table>x<tr><td>y</table>` +
    `<template><td>in<template>nested</template></td></template>` +
    `<svg viewBox="0 0 1 1"><rect xlink:href="#a" xmlns:xlink="${Html.XLINK_NS}"/></svg>` +
    `<math definitionurl=u><mi>x</mi></math><select><option selected>o</select><selectedcontent>`;

  const htmlClasses = [
    "HtmlAttribute",
    "HtmlText",
    "HtmlComment",
    "HtmlTemplateContent",
    "HtmlElement",
    "HtmlDoctype",
    "HtmlDocument",
  ];

  test("Html.parseDocument", async () => {
    const doc = await Effect.runPromise(Html.parseDocument(htmlInput));
    expect(Arr.sort(expectAsConstructed([doc]), Order.String)).toEqual(
      Arr.sort(htmlClasses, Order.String),
    );
  });

  test("Html.parseDocumentFragment", async () => {
    const nodes = await Effect.runPromise(
      Html.parseDocumentFragment(`<td>a<template><b>t</b></template><svg><g xml:lang=en/></svg>`, {
        context: "tr",
      }),
    );
    expectAsConstructed(nodes);
  });

  test("Html.parseFragment", async () => {
    const nodes = await Effect.runPromise(
      Html.parseFragment(`<P Class=x>a<br><b>b<![CDATA[c]]><!-- c --><?pi d?></p>tail`),
    );
    expectAsConstructed(nodes);
  });

  test("Html.toXml", async () => {
    const doc = await Effect.runPromise(Html.parseDocument(htmlInput));
    expect(Arr.sort(expectAsConstructed([Html.toXml(doc)]), Order.String)).toEqual(
      Arr.sort(
        [
          "QName",
          "XmlAttribute",
          "XmlText",
          "XmlComment",
          "XmlElement",
          "XmlDoctype",
          "XmlDocument",
        ],
        Order.String,
      ),
    );
  });
});
