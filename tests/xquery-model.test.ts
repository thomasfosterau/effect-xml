/**
 * The XDM 3.1 model behind `XQuery`: the atomic type hierarchy, atomic values
 * and their canonical forms, node handles and document order, maps, arrays,
 * atomization and the effective boolean value.
 */
import { assert, describe, expect, test } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { QName, Xml, XQuery } from "../src/index.ts";
import { at, failure, some, success } from "./support/narrow.ts";

const T = XQuery.AtomicTypes;
const isQName = Schema.is(QName);
const { AtomicValue } = XQuery;

const parse = (xml: string, options?: XQuery.NodeOptions) =>
  XQuery.XdmNode.fromDocument(
    Effect.runSync(Xml.parse(xml, { limits: { maxDepth: 100_000 } })),
    options,
  );

const lexical = (type: XQuery.AtomicType, s: string) =>
  XQuery.atomicString(success(XQuery.fromLexical(type, s), `${s} as xs:${type.name}`));

const resolve = (prefix: string) => (prefix === "p" ? "urn:p" : undefined);

const bindings = (n: XQuery.XdmNode) =>
  n.namespaces.map((ns) => [
    Option.getOrElse(
      Option.map(ns.name, (q) => q.local),
      () => "",
    ),
    ns.stringValue,
  ]);

const ebv = (...items: XQuery.Sequence) => XQuery.effectiveBooleanValue(items);

const code = (result: Result.Result<unknown, XQuery.XQueryError>) => failure(result).code.local;

describe("atomic type hierarchy", () => {
  test("derivation follows XML Schema, re-rooted at xs:anyAtomicType", () => {
    expect(XQuery.derivesFrom(T.unsignedByte, T.integer)).toBe(true);
    expect(XQuery.derivesFrom(T.unsignedByte, T.decimal)).toBe(true);
    expect(XQuery.derivesFrom(T.int, T.unsignedInt)).toBe(false);
    expect(XQuery.derivesFrom(T.ID, T.NCName)).toBe(true);
    expect(XQuery.derivesFrom(T.string, T.anyAtomicType)).toBe(true);
    expect(some(T.decimal.base)).toBe(T.anyAtomicType);
    expect(Option.isNone(T.anyAtomicType.base)).toBe(true);
  });

  test("the types XDM adds", () => {
    expect(some(T.untypedAtomic.base)).toBe(T.anyAtomicType);
    expect(some(T.dayTimeDuration.base)).toBe(T.duration);
    expect(some(T.yearMonthDuration.base)).toBe(T.duration);
    expect(some(T.dateTimeStamp.base)).toBe(T.dateTime);
  });

  test("primitive types", () => {
    expect(T.byte.primitive).toBe("decimal");
    expect(T.token.primitive).toBe("string");
    expect(T.dayTimeDuration.primitive).toBe("duration");
    expect(T.untypedAtomic.primitive).toBe("untypedAtomic");
    expect(XQuery.isNumericType(T.short)).toBe(true);
    expect(XQuery.isNumericType(T.float)).toBe(true);
    expect(XQuery.isNumericType(T.string)).toBe(false);
  });

  test("lookup by expanded name", () => {
    const xs = "http://www.w3.org/2001/XMLSchema";
    expect(some(XQuery.atomicType(xs, "integer"))).toBe(T.integer);
    expect(Option.isNone(XQuery.atomicType(xs, "anyType"))).toBe(true);
    expect(Option.isNone(XQuery.atomicType(null, "integer"))).toBe(true);
  });
});

describe("atomic values", () => {
  test("lexical forms are checked against their types", () => {
    expect(lexical(T.integer, " +007 ")).toBe("7");
    expect(lexical(T.decimal, "1.500")).toBe("1.5");
    expect(lexical(T.decimal, "-.5")).toBe("-0.5");
    expect(lexical(T.boolean, "1")).toBe("true");
    expect(lexical(T.token, "  a   b ")).toBe("a b");
    expect(lexical(T.string, "  a   b ")).toBe("  a   b ");
    expect(code(XQuery.fromLexical(T.int, "2147483648"))).toBe("FORG0001");
    expect(code(XQuery.fromLexical(T.dayTimeDuration, "P1Y"))).toBe("FORG0001");
    expect(code(XQuery.fromLexical(T.yearMonthDuration, "PT1H"))).toBe("FORG0001");
    expect(code(XQuery.fromLexical(T.dateTimeStamp, "2001-01-01T00:00:00"))).toBe("FORG0001");
    expect(code(XQuery.fromLexical(T.anyAtomicType, "x"))).toBe("XPST0080");
  });

  test("integer-derived values are bigints, whatever their size", () => {
    expect(success(XQuery.fromLexical(T.byte, "12")).value).toBe(12n);
    expect(success(XQuery.fromLexical(T.integer, "123456789012345678901234567890")).value).toBe(
      123456789012345678901234567890n,
    );
  });

  test("QNames resolve their prefixes", () => {
    const qname = success(XQuery.fromLexical(T.QName, "p:x", { resolve })).value;
    assert(isQName(qname));
    expect(qname.clark).toBe("{urn:p}x");
    expect(code(XQuery.fromLexical(T.QName, "q:x", { resolve }))).toBe("FONS0004");
    expect(code(XQuery.fromLexical(T.QName, "1x"))).toBe("FORG0001");
  });

  test("canonical string forms of doubles and floats", () => {
    expect(XQuery.atomicString(AtomicValue.double(1e7))).toBe("1.0E7");
    expect(XQuery.atomicString(AtomicValue.double(123456))).toBe("123456");
    expect(XQuery.atomicString(AtomicValue.double(1e6))).toBe("1.0E6");
    expect(XQuery.atomicString(AtomicValue.double(0.000001))).toBe("0.000001");
    expect(XQuery.atomicString(AtomicValue.double(1.5e-7))).toBe("1.5E-7");
    expect(XQuery.atomicString(AtomicValue.double(-0))).toBe("-0");
    expect(XQuery.atomicString(AtomicValue.double(Number.NaN))).toBe("NaN");
    expect(XQuery.atomicString(AtomicValue.double(-Infinity))).toBe("-INF");
    expect(XQuery.atomicString(AtomicValue.float(0.1))).toBe("0.1");
    expect(XQuery.atomicString(AtomicValue.float(1e10))).toBe("1.0E10");
  });

  test("canonical string forms of the other types", () => {
    expect(XQuery.atomicString(AtomicValue.decimal(BigDecimal.fromStringUnsafe("100")))).toBe(
      "100",
    );
    expect(lexical(T.decimal, "0.0000000000000000001")).toBe("0.0000000000000000001");
    expect(lexical(T.hexBinary, "0aff")).toBe("0AFF");
    expect(lexical(T.base64Binary, "AQID")).toBe("AQID");
    expect(lexical(T.base64Binary, "AQ==")).toBe("AQ==");
    expect(lexical(T.dayTimeDuration, "PT36H")).toBe("P1DT12H");
    expect(lexical(T.yearMonthDuration, "P13M")).toBe("P1Y1M");
    expect(lexical(T.yearMonthDuration, "P0Y")).toBe("P0M");
    expect(lexical(T.duration, "-P0DT90S")).toBe("-PT1M30S");
    expect(lexical(T.duration, "P0D")).toBe("PT0S");
    expect(lexical(T.dateTime, "2001-01-01T12:00:00.500+00:00")).toBe("2001-01-01T12:00:00.5Z");
    expect(lexical(T.time, "12:00:00.000")).toBe("12:00:00");
  });
});

describe("node handles", () => {
  const doc = parse(
    `<a xmlns="urn:d" xmlns:p="urn:p" p:x="1" y="2">one<![CDATA[two]]><![CDATA[]]><b xml:lang="fr" xmlns=""><c/></b><!--note--><?pi data?></a>`,
    { documentUri: "http://example.org/doc.xml" },
  );
  const a = at(doc.children, 0);
  const b = at(a.children, 1);

  test("kinds, merged text and attributes without namespace declarations", () => {
    expect(doc.kind).toBe("document");
    expect(a.children.map((c) => c.kind)).toEqual([
      "text",
      "element",
      "comment",
      "processing-instruction",
    ]);
    expect(at(a.children, 0).stringValue).toBe("onetwo");
    expect(a.attributes.map((n) => some(n.name).clark)).toEqual(["{urn:p}x", "y"]);
    expect(some(at(a.children, 3).name).local).toBe("pi");
    expect(at(a.children, 3).stringValue).toBe("data");
  });

  test("in-scope namespaces, with the default undeclared below", () => {
    expect(a.namespaces.map((ns) => ns.stringValue)).toEqual([
      "http://www.w3.org/XML/1998/namespace",
      "urn:d",
      "urn:p",
    ]);
    expect(Option.isNone(at(a.namespaces, 1).name)).toBe(true);
    expect(bindings(at(b.children, 0)).map(([prefix]) => prefix)).toEqual(["xml", "p"]);
  });

  test("identity, parents and the root", () => {
    expect(at(a.children, 1)).toBe(b);
    expect(some(b.parent)).toBe(a);
    expect(at(b.children, 0).root).toBe(doc);
    expect(Option.isNone(doc.parent)).toBe(true);
    expect(b.depth).toBe(2);
    // A second tree over the same DOM is a different tree.
    expect(XQuery.XdmNode.fromDocument(Effect.runSync(Xml.parse("<a/>")))).not.toBe(doc);
  });

  test("string values, languages and URIs", () => {
    expect(doc.stringValue).toBe("onetwo");
    expect(at(a.attributes, 0).stringValue).toBe("1");
    expect(some(at(b.children, 0).lang)).toBe("fr");
    expect(Option.isNone(a.lang)).toBe(true);
    expect(some(doc.documentUri)).toBe("http://example.org/doc.xml");
    expect(some(at(a.attributes, 0).baseUri)).toBe("http://example.org/doc.xml");
    expect(Option.isNone(a.documentUri)).toBe(true);
  });

  test("xml:base resolves on the way down", () => {
    const tree = parse(`<a xml:base="sub/"><b xml:base="x.xml"/></a>`, {
      baseUri: "http://example.org/base/",
    });
    const inner = at(at(tree.children, 0).children, 0);
    expect(some(inner.baseUri)).toBe("http://example.org/base/sub/x.xml");
  });

  test("document order: ancestors first, namespaces and attributes before children", () => {
    const c = at(b.children, 0);
    const [x, y] = [at(a.attributes, 0), at(a.attributes, 1)];
    const ns = at(a.namespaces, 0);
    expect(XQuery.compareDocumentOrder(doc, c)).toBe(-1);
    expect(XQuery.compareDocumentOrder(c, a)).toBe(1);
    expect(XQuery.compareDocumentOrder(x, y)).toBe(-1);
    expect(XQuery.compareDocumentOrder(ns, x)).toBe(-1);
    expect(XQuery.compareDocumentOrder(y, at(a.children, 0))).toBe(-1);
    expect(XQuery.compareDocumentOrder(c, at(a.children, 2))).toBe(-1);
    expect(XQuery.compareDocumentOrder(b, b)).toBe(0);
    expect(XQuery.sortDocumentOrder([c, a, doc, c, x])).toEqual([doc, a, x, c]);
  });

  test("document order across trees is stable", () => {
    const one = parse("<a/>");
    const two = parse("<a/>");
    expect(XQuery.compareDocumentOrder(at(one.children, 0), two)).toBe(-1);
    expect(XQuery.compareDocumentOrder(two, at(one.children, 0))).toBe(1);
  });

  test("a parentless element is the root of its own tree", () => {
    const element = XQuery.XdmNode.fromElement(Xml.element("e", [Xml.attr("k", "v")]));
    expect(element.kind).toBe("element");
    expect(element.root).toBe(element);
    expect(at(element.attributes, 0).stringValue).toBe("v");
  });

  test("deep documents need no deep stack", () => {
    const depth = 20_000;
    const xml = `${"<d>".repeat(depth)}x${"</d>".repeat(depth)}`;
    const tree = parse(xml);
    const deepest = Arr.reduce(Arr.range(2, depth), at(tree.children, 0), (node) =>
      at(node.children, 0),
    );
    expect(deepest.depth).toBe(depth);
    expect(XQuery.compareDocumentOrder(tree, deepest)).toBe(-1);
    expect(deepest.root).toBe(tree);
    expect(tree.stringValue).toBe("x");
  });
});

describe("atomization", () => {
  const doc = parse(`<a n="1">4<!--c--><?p d?></a>`);
  const a = at(doc.children, 0);

  test("nodes give their typed values: untypedAtomic, or string for comments and PIs", () => {
    const atoms = success(
      XQuery.atomize([doc, at(a.attributes, 0), at(a.children, 1), at(a.children, 2)]),
    );
    expect(atoms.map((v) => [v.type.name, v.value])).toEqual([
      ["untypedAtomic", "4"],
      ["untypedAtomic", "1"],
      ["string", "c"],
      ["string", "d"],
    ]);
  });

  test("arrays atomize to their members; maps and functions fail", () => {
    const array = new XQuery.ArrayItem([[AtomicValue.integer(1n)], [], [AtomicValue.string("s")]]);
    expect(success(XQuery.atomize([array])).map(XQuery.atomicString)).toEqual(["1", "s"]);
    expect(code(XQuery.atomize([XQuery.MapItem.empty]))).toBe("FOTY0013");
    const f = new XQuery.FunctionItem(Option.none(), 0, () => Result.succeed([]));
    expect(code(XQuery.atomize([f]))).toBe("FOTY0013");
    expect(code(XQuery.stringValue(f))).toBe("FOTY0014");
  });
});

describe("effective boolean value", () => {
  test("the rules of XPath 3.1 §2.4.3", () => {
    const doc = parse("<a/>");
    expect(success(ebv())).toBe(false);
    expect(success(ebv(doc, AtomicValue.integer(0n)))).toBe(true);
    expect(success(ebv(AtomicValue.boolean(false)))).toBe(false);
    expect(success(ebv(AtomicValue.string("")))).toBe(false);
    expect(success(ebv(AtomicValue.untypedAtomic("0")))).toBe(true);
    expect(success(ebv(AtomicValue.anyURI("x")))).toBe(true);
    expect(success(ebv(AtomicValue.integer(0n)))).toBe(false);
    expect(success(ebv(AtomicValue.decimal(BigDecimal.fromStringUnsafe("0.0"))))).toBe(false);
    expect(success(ebv(AtomicValue.double(Number.NaN)))).toBe(false);
    expect(success(ebv(AtomicValue.float(-1)))).toBe(true);
  });

  test("everything else is err:FORG0006", () => {
    expect(code(ebv(AtomicValue.integer(1n), AtomicValue.integer(2n)))).toBe("FORG0006");
    expect(code(ebv(success(XQuery.fromLexical(T.date, "2001-01-01"))))).toBe("FORG0006");
    expect(code(ebv(new XQuery.ArrayItem([])))).toBe("FORG0006");
    expect(code(ebv(XQuery.MapItem.empty))).toBe("FORG0006");
  });
});

describe("maps and arrays", () => {
  test("numeric keys are compared by exact value", () => {
    const map = XQuery.MapItem.empty.set(AtomicValue.integer(1n), [AtomicValue.string("one")]);
    expect(map.has(AtomicValue.double(1))).toBe(true);
    expect(map.has(AtomicValue.decimal(BigDecimal.fromStringUnsafe("1.0")))).toBe(true);
    const tenth = XQuery.MapItem.empty.set(
      AtomicValue.decimal(BigDecimal.fromStringUnsafe("0.1")),
      [],
    );
    // xs:double 0.1 is not exactly one tenth.
    expect(tenth.has(AtomicValue.double(0.1))).toBe(false);
    expect(tenth.has(AtomicValue.float(0.1))).toBe(false);
    const nan = XQuery.MapItem.empty.set(AtomicValue.double(Number.NaN), []);
    expect(nan.has(AtomicValue.float(Number.NaN))).toBe(true);
  });

  test("strings, untyped values and URIs are the same key; other types are not", () => {
    const map = XQuery.MapItem.empty.set(AtomicValue.string("1"), []);
    expect(map.has(AtomicValue.untypedAtomic("1"))).toBe(true);
    expect(map.has(AtomicValue.anyURI("1"))).toBe(true);
    expect(map.has(AtomicValue.integer(1n))).toBe(false);
    const durations = XQuery.MapItem.empty.set(
      success(XQuery.fromLexical(T.dayTimeDuration, "PT0S")),
      [],
    );
    expect(durations.has(success(XQuery.fromLexical(T.yearMonthDuration, "P0M")))).toBe(true);
  });

  test("maps are persistent", () => {
    const one = XQuery.MapItem.fromEntries([[AtomicValue.string("a"), [AtomicValue.integer(1n)]]]);
    const two = one.set(AtomicValue.string("b"), []);
    expect([one.size, two.size, two.remove(AtomicValue.string("a")).size]).toEqual([1, 2, 1]);
    expect(two.keys().map(XQuery.atomicString).toSorted()).toEqual(["a", "b"]);
    expect(
      some(one.get(AtomicValue.string("a"))).map((item) => success(XQuery.stringValue(item))),
    ).toEqual(["1"]);
  });

  test("arrays index from 1", () => {
    const array = new XQuery.ArrayItem([[AtomicValue.integer(1n)], []]);
    expect(array.size).toBe(2);
    expect(some(array.get(1)).length).toBe(1);
    expect(Option.isNone(array.get(0))).toBe(true);
    expect(XQuery.isFunction(array)).toBe(true);
    expect(XQuery.isFunction(AtomicValue.integer(1n))).toBe(false);
  });
});

describe("XQueryError", () => {
  test("carries an err: QName code, a description, an offset and an error value", () => {
    const error = new XQuery.XQueryError({
      code: XQuery.errorCode("FOER0000"),
      description: "raised",
      offset: 7,
      value: [AtomicValue.integer(1n)],
    });
    expect(error.code.clark).toBe("{http://www.w3.org/2005/xqt-errors}FOER0000");
    expect(error.message).toBe("err:FOER0000 at offset 7: raised");
    expect(XQuery.hasErrorCode(error, "FOER0000")).toBe(true);
    expect(XQuery.xqueryError("XPST0003", "bad").message).toBe("err:XPST0003: bad");
    // Not an item: `Any` lets it through to the error's own check.
    const values = Schema.decodeUnknownSync(Schema.Array(Schema.Any))([1]);
    expect(
      () => new XQuery.XQueryError({ code: XQuery.errorCode("X"), description: "", value: values }),
    ).toThrow("Schema validation failed");
  });
});
