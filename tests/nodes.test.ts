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
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Html, Sax, Xml } from "../src/index.ts";
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
  | XmlDocument;

/** The same instance built with `new` (and so by the class's own schema). */
const rebuild = (node: Instance): Instance => {
  if (node instanceof QName) return new QName({ ...node });
  if (node instanceof XmlAttribute) return new XmlAttribute({ ...node });
  if (node instanceof XmlText) return new XmlText({ ...node });
  if (node instanceof XmlCData) return new XmlCData({ ...node });
  if (node instanceof XmlComment) return new XmlComment({ ...node });
  if (node instanceof XmlProcessingInstruction) return new XmlProcessingInstruction({ ...node });
  if (node instanceof XmlElement) return new XmlElement({ ...node });
  if (node instanceof XmlDeclaration) return new XmlDeclaration({ ...node });
  if (node instanceof XmlDoctype) return new XmlDoctype({ ...node });
  return new XmlDocument({ ...node });
};

/** The schema that encodes `node`. */
const schemaOf = (node: Instance): Schema.Codec<unknown, unknown> =>
  node instanceof QName
    ? QName
    : node instanceof XmlAttribute
      ? XmlAttribute
      : node instanceof XmlDeclaration
        ? XmlDeclaration
        : node instanceof XmlDoctype
          ? XmlDoctype
          : node instanceof XmlDocument
            ? XmlDocument
            : Xml.XmlNode;

/** The nodes directly inside `node`: names, attributes, children, declarations. */
const parts = (node: Instance): ReadonlyArray<Instance> => {
  if (node instanceof XmlAttribute) return [node.name];
  if (node instanceof XmlElement) return [node.name, ...node.attributes, ...node.children];
  if (node instanceof XmlDocument)
    return [
      ...(node.declaration === null ? [] : [node.declaration]),
      ...(node.doctype === null ? [] : [node.doctype]),
      ...node.children,
    ];
  return [];
};

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

  test("Html.parseDocument", async () => {
    const doc = await Effect.runPromise(
      Html.parseDocument(
        `<!DOCTYPE html><title>t</title><p class=x>a<b>b<i>c</b>d</i><!-- c -->` +
          `<svg viewBox="0 0 1 1"><rect xlink:href="#a"/></svg><math><mi>x</mi></math>`,
      ),
    );
    expectAsConstructed([doc]);
  });

  test("Html.parseFragment", async () => {
    const nodes = await Effect.runPromise(
      Html.parseFragment(`<P Class=x>a<br><b>b<![CDATA[c]]><!-- c --><?pi d?></p>tail`),
    );
    expectAsConstructed(nodes);
  });
});
