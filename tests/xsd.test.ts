import { assert, describe, expect, test } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { Sax, Xml, Xsd } from "../src/index.ts";
import * as Example from "../examples/xsd/order.generated.ts";
import { splitEvery } from "./support/chunks.ts";

const XS = `xmlns:xs="http://www.w3.org/2001/XMLSchema"`;

const schema = (body: string, attributes = "") =>
  `<xs:schema ${XS} ${attributes}>${body}</xs:schema>`;

const compile = (xsd: string, options?: Xsd.CompileOptions) =>
  Effect.runSync(Xsd.compile(xsd, options));

const compileError = (xsd: string, options?: Xsd.CompileOptions) => {
  const r = Effect.runSync(Effect.result(Xsd.compile(xsd, options)));
  assert(Result.isFailure(r), "expected the schema to be rejected");
  return r.failure;
};

const value = (model: Xsd.Model, doc: string, options?: Xsd.ParseOptions) =>
  Effect.runSync(Xsd.parse(model, doc, options)).value;

const invalid = (model: Xsd.Model, doc: string, options?: Xsd.ParseOptions) => {
  const r = Effect.runSync(Effect.result(Xsd.parse(model, doc, options)));
  assert(Result.isFailure(r), "expected the document to be rejected");
  return r.failure;
};

/** The error, failing the test unless it is a validation error. */
const validation = (e: Xsd.XsdError): Xsd.XsdValidationError => {
  assert(e instanceof Xsd.XsdValidationError, `expected a validation error, got ${e.message}`);
  return e;
};

const rule = (model: Xsd.Model, doc: string) => validation(invalid(model, doc)).rule;

const isRecord = (v: Xsd.XsdValue): v is Xsd.XsdRecord =>
  Predicate.isObject(v) &&
  !Arr.isArray(v) &&
  !(v instanceof Xml.XmlElement) &&
  !(v instanceof Uint8Array) &&
  !BigDecimal.isBigDecimal(v);

/** The value, failing the test unless it is a record. */
const record = (v: Xsd.XsdValue): Xsd.XsdRecord => {
  assert(isRecord(v), "expected a record");
  return v;
};

const isList = (v: Xsd.XsdRecord[string]): v is ReadonlyArray<Xsd.XsdValue> => Arr.isArray(v);

/** The property's array, failing the test unless it is one. */
const list = (r: Xsd.XsdRecord, property: string): ReadonlyArray<Xsd.XsdValue> => {
  const items = r[property];
  assert(isList(items), `expected ${property} to be an array`);
  return items;
};

const element = (name: string, type: string) =>
  schema(`<xs:element name="${name}" type="${type}"/>`);

describe("Xsd.compile", () => {
  test("keys global components by expanded name", () => {
    const model = compile(
      schema(
        `<xs:element name="a" type="t:T"/><xs:complexType name="T"/>`,
        `targetNamespace="urn:t" xmlns:t="urn:t"`,
      ),
    );
    expect(Record.keys(model.elements)).toEqual(["{urn:t}a"]);
    expect(model.elements["{urn:t}a"]?.type).toBe("{urn:t}T");
    expect(model.types["{urn:t}T"]?._tag).toBe("ComplexType");
  });

  test("loads includes and imports, resolving relative locations", () => {
    const model = compile(
      schema(
        `<xs:include schemaLocation="parts/types.xsd"/>
         <xs:import namespace="urn:other" schemaLocation="../other.xsd"/>
         <xs:element name="a" type="t:T"/><xs:element name="b" type="o:O"/>`,
        `targetNamespace="urn:t" xmlns:t="urn:t" xmlns:o="urn:other"`,
      ),
      {
        location: "schemas/main.xsd",
        documents: {
          "schemas/parts/types.xsd": schema(
            `<xs:simpleType name="T"><xs:restriction base="xs:int"/></xs:simpleType>`,
            `targetNamespace="urn:t"`,
          ),
          "other.xsd": schema(
            `<xs:simpleType name="O"><xs:restriction base="xs:boolean"/></xs:simpleType>`,
            `targetNamespace="urn:other"`,
          ),
        },
      },
    );
    expect(value(model, `<a xmlns="urn:t">5</a>`)).toBe(5);
    expect(value(model, `<b xmlns="urn:t">true</b>`)).toBe(true);
  });

  test("a chameleon include takes the including namespace", () => {
    const model = compile(
      schema(
        `<xs:include schemaLocation="c.xsd"/><xs:element name="a" type="t:C"/>`,
        `targetNamespace="urn:t" xmlns:t="urn:t"`,
      ),
      {
        documents: {
          "c.xsd": schema(
            `<xs:complexType name="C"><xs:sequence><xs:element name="x" type="X"/></xs:sequence></xs:complexType>
             <xs:simpleType name="X"><xs:restriction base="xs:int"/></xs:simpleType>`,
          ),
        },
      },
    );
    expect(Arr.sort(Record.keys(model.types), Order.String)).toEqual(["{urn:t}C", "{urn:t}X"]);
    expect(value(model, `<t:a xmlns:t="urn:t"><x>1</x></t:a>`)).toEqual({ x: 1 });
  });

  test("fetches documents with resolve, once each", () => {
    const fetched: Array<string> = [];
    const model = compile(
      schema(`<xs:include schemaLocation="b.xsd"/><xs:include schemaLocation="./b.xsd"/>`),
      {
        location: "http://example.com/s/a.xsd",
        resolve: (location) =>
          Effect.sync(() => {
            fetched.push(location);
            return schema(`<xs:element name="b" type="xs:string"/>`);
          }),
      },
    );
    expect(fetched).toEqual(["http://example.com/s/b.xsd"]);
    expect(Record.keys(model.elements)).toEqual(["b"]);
  });

  test.each([
    [schema(`<xs:include schemaLocation="missing.xsd"/>`), "missing.xsd was not given"],
    [schema(`<xs:redefine schemaLocation="x.xsd"/>`), "xs:redefine is not supported"],
    [element("a", "Nope"), "no type named Nope"],
    [element("a", "p:T"), `prefix "p"`],
    [schema(`<xs:element name="a"/><xs:element name="a"/>`), "defined twice"],
    [`<schema/>`, "not xs:schema"],
    [`<xs:schema ${XS}>`, "never closed"],
    [
      schema(`<xs:group name="g"><xs:sequence><xs:group ref="g"/></xs:sequence></xs:group>
              <xs:complexType name="T"><xs:group ref="g"/></xs:complexType>`),
      "contains itself",
    ],
    [
      schema(
        `<xs:complexType name="T"><xs:complexContent><xs:extension base="T"/></xs:complexContent></xs:complexType>`,
      ),
      "derived from itself",
    ],
    [
      schema(`<xs:element name="a"><xs:complexType><xs:sequence>
                <xs:element name="b" minOccurs="2" maxOccurs="1"/></xs:sequence></xs:complexType></xs:element>`),
      "less than minOccurs",
    ],
    [
      schema(
        `<xs:simpleType name="S"><xs:restriction base="xs:string"><xs:pattern value="[z-a]"/></xs:restriction></xs:simpleType>`,
      ),
      "backwards",
    ],
  ])("rejects an invalid schema (%#)", (xsd, reason) => {
    expect(compileError(xsd).message).toContain(reason);
  });
});

describe("Xsd.parse — simple types", () => {
  test.each([
    ["xs:string", " a  b ", " a  b "],
    ["xs:token", " a \n b ", "a b"],
    ["xs:boolean", "1", true],
    ["xs:int", " -42 ", -42],
    ["xs:unsignedByte", "255", 255],
    ["xs:long", "9223372036854775807", 9223372036854775807n],
    ["xs:integer", "+12", 12n],
    ["xs:double", "-INF", -Infinity],
    ["xs:float", "0.1", Math.fround(0.1)],
    ["xs:date", "2024-02-29", "2024-02-29"],
    ["xs:dateTime", "2024-01-01T24:00:00Z", "2024-01-01T24:00:00Z"],
    ["xs:duration", "P1Y2MT3.5S", "P1Y2MT3.5S"],
    ["xs:gYear", "-0044", "-0044"],
    ["xs:anyURI", " http://x/ ", "http://x/"],
    ["xs:NMTOKENS", " a b\tc ", ["a", "b", "c"]],
  ])("%s decodes %j", (type, input, expected) => {
    expect(value(compile(element("v", type)), `<v>${input}</v>`)).toEqual(expected);
  });

  test("decimal values are BigDecimals", () => {
    const v = value(compile(element("v", "xs:decimal")), `<v>-.50</v>`);
    assert(BigDecimal.isBigDecimal(v));
    expect(BigDecimal.format(v)).toBe("-0.5");
  });

  test("binary values are bytes", () => {
    expect(value(compile(element("v", "xs:hexBinary")), `<v>0aFF</v>`)).toEqual(
      Uint8Array.of(10, 255),
    );
    expect(value(compile(element("v", "xs:base64Binary")), `<v>aGk=</v>`)).toEqual(
      Uint8Array.of(104, 105),
    );
  });

  test("QName values are expanded names", () => {
    const model = compile(element("v", "xs:QName"));
    expect(value(model, `<v xmlns:p="urn:p">p:x</v>`)).toBe("{urn:p}x");
    expect(rule(model, `<v>q:x</v>`)).toBe("InvalidValue");
  });

  test.each([
    ["xs:int", "2147483648"],
    ["xs:boolean", "yes"],
    ["xs:date", "2023-02-29"],
    ["xs:dateTime", "2024-01-01T10:00:00+15:00"],
    ["xs:duration", "P"],
    ["xs:hexBinary", "abc"],
    ["xs:NCName", "a:b"],
    ["xs:language", "toolonglanguage"],
    ["xs:positiveInteger", "0"],
    ["xs:IDREFS", ""],
  ])("%s rejects %j", (type, input) => {
    expect(rule(compile(element("v", type)), `<v>${input}</v>`)).toBe("InvalidValue");
  });

  const restricted = (facets: string, base = "xs:string") =>
    compile(
      schema(
        `<xs:element name="v"><xs:simpleType><xs:restriction base="${base}">${facets}</xs:restriction></xs:simpleType></xs:element>`,
      ),
    );

  test.each([
    [`<xs:length value="3"/>`, "abc", "ab"],
    [`<xs:minLength value="2"/><xs:maxLength value="3"/>`, "ab", "abcd"],
    [`<xs:pattern value="\\d{3}-[A-Z]+"/>`, "123-AB", "12-AB"],
    [`<xs:pattern value="a"/><xs:pattern value="b"/>`, "b", "c"],
    [`<xs:enumeration value="x"/><xs:enumeration value="y"/>`, "y", "z"],
    [`<xs:whiteSpace value="collapse"/><xs:length value="3"/>`, "  abc  ", "a b c"],
  ])("string facets %s", (facets, ok, bad) => {
    const model = restricted(facets);
    expect(Result.isSuccess(Effect.runSync(Effect.result(Xsd.parse(model, `<v>${ok}</v>`))))).toBe(
      true,
    );
    expect(rule(model, `<v>${bad}</v>`)).toBe("InvalidValue");
  });

  test.each([
    [`<xs:minInclusive value="1"/><xs:maxExclusive value="10"/>`, "xs:int", "9", "10"],
    [`<xs:minExclusive value="0.5"/>`, "xs:decimal", "0.51", "0.5"],
    [`<xs:totalDigits value="3"/><xs:fractionDigits value="1"/>`, "xs:decimal", "12.3", "1.23"],
    [`<xs:maxInclusive value="2024-01-01"/>`, "xs:date", "2023-12-31Z", "2024-01-02"],
    [`<xs:maxInclusive value="P1D"/>`, "xs:duration", "PT23H", "P2D"],
    [`<xs:enumeration value="1.0"/>`, "xs:decimal", "1", "2"],
    [`<xs:minInclusive value="-5"/>`, "xs:long", "-5", "-6"],
    [`<xs:maxExclusive value="1e1"/>`, "xs:double", "9.5", "10"],
  ])("ordered facets %s on %s", (facets, base, ok, bad) => {
    const model = restricted(facets, base);
    expect(Result.isSuccess(Effect.runSync(Effect.result(Xsd.parse(model, `<v>${ok}</v>`))))).toBe(
      true,
    );
    expect(rule(model, `<v>${bad}</v>`)).toBe("InvalidValue");
  });

  test("lists and unions", () => {
    const model = compile(
      schema(`
        <xs:simpleType name="Ints"><xs:list itemType="xs:int"/></xs:simpleType>
        <xs:simpleType name="Short"><xs:restriction base="Ints"><xs:maxLength value="2"/></xs:restriction></xs:simpleType>
        <xs:simpleType name="IntOrAuto"><xs:union memberTypes="xs:int">
          <xs:simpleType><xs:restriction base="xs:token"><xs:enumeration value="auto"/></xs:restriction></xs:simpleType>
        </xs:union></xs:simpleType>
        <xs:element name="l" type="Short"/><xs:element name="u" type="IntOrAuto"/>`),
    );
    expect(value(model, `<l> 1  2 </l>`)).toEqual([1, 2]);
    expect(rule(model, `<l>1 2 3</l>`)).toBe("InvalidValue");
    expect(rule(model, `<l>1 x</l>`)).toBe("InvalidValue");
    expect(value(model, `<u>7</u>`)).toBe(7);
    expect(value(model, `<u> auto </u>`)).toBe("auto");
    expect(rule(model, `<u>manual</u>`)).toBe("InvalidValue");
  });

  test("element defaults and fixed values", () => {
    const model = compile(
      schema(`<xs:element name="r"><xs:complexType><xs:sequence>
        <xs:element name="d" type="xs:int" default="5"/>
        <xs:element name="f" type="xs:decimal" fixed="1.0"/>
      </xs:sequence></xs:complexType></xs:element>`),
    );
    expect(record(value(model, `<r><d/><f>1</f></r>`))["d"]).toBe(5);
    expect(rule(model, `<r><d/><f>2</f></r>`)).toBe("InvalidValue");
  });
});

describe("Xsd.parse — content models", () => {
  const model = compile(
    schema(`
      <xs:element name="r"><xs:complexType><xs:sequence>
        <xs:element name="a" type="xs:int" minOccurs="0"/>
        <xs:choice maxOccurs="2">
          <xs:element name="b" type="xs:string"/>
          <xs:element name="c" type="xs:string"/>
        </xs:choice>
        <xs:element name="d" type="xs:string" minOccurs="2" maxOccurs="3"/>
      </xs:sequence></xs:complexType></xs:element>
      <xs:element name="all"><xs:complexType><xs:all>
        <xs:element name="x" type="xs:int"/>
        <xs:element name="y" type="xs:int" minOccurs="0"/>
      </xs:all></xs:complexType></xs:element>`),
  );

  test("sequences, choices and counted repetition", () => {
    expect(value(model, `<r><a>1</a><b>x</b><c>y</c><d>1</d><d>2</d></r>`)).toEqual({
      a: 1,
      b: ["x"],
      c: ["y"],
      d: ["1", "2"],
    });
    expect(value(model, `<r><c>y</c><d/><d/><d/></r>`)).toEqual({
      b: [],
      c: ["y"],
      d: ["", "", ""],
    });
  });

  test.each([
    [`<r><d/><d/></r>`, "UnexpectedElement"],
    [`<r><b/><d/></r>`, "MissingElement"],
    [`<r><b/><b/><b/><d/><d/></r>`, "UnexpectedElement"],
    [`<r><b/><d/><d/><d/><d/></r>`, "UnexpectedElement"],
    [`<r><a>1</a><a>1</a></r>`, "UnexpectedElement"],
    [`<r><e/></r>`, "UnexpectedElement"],
    [`<r>text<b/><d/><d/></r>`, "UnexpectedText"],
  ])("rejects %s", (doc, expected) => {
    expect(rule(model, doc)).toBe(expected);
  });

  test("whitespace between elements is ignored in element-only content", () => {
    expect(value(model, `<r>\n  <b/>\n  <d/> <d/>\n</r>`)).toEqual({ b: [""], c: [], d: ["", ""] });
  });

  test("xs:all in any order, each at most once", () => {
    expect(value(model, `<all><y>2</y><x>1</x></all>`)).toEqual({ x: 1, y: 2 });
    expect(value(model, `<all><x>1</x></all>`)).toEqual({ x: 1 });
    expect(rule(model, `<all><y>2</y></all>`)).toBe("MissingElement");
    expect(rule(model, `<all><x>1</x><x>1</x></all>`)).toBe("UnexpectedElement");
  });

  test("errors say what was expected, where", () => {
    const e = validation(invalid(model, `<r>\n<b/>\n<e/></r>`));
    expect(e.reason).toBe("<e> is not allowed here; expected <b> or <c> or <d>");
    expect(e.path).toBe("/r");
    expect(e.position).toEqual({ offset: 9, line: 3, column: 1 });
  });

  test("large bounds are counted, not unrolled", () => {
    const big = compile(
      schema(`<xs:element name="r"><xs:complexType><xs:sequence>
        <xs:element name="i" type="xs:int" minOccurs="1000" maxOccurs="100000"/>
      </xs:sequence></xs:complexType></xs:element>`),
    );
    const items = (n: number) => `<r>${"<i>1</i>".repeat(n)}</r>`;
    expect(rule(big, items(999))).toBe("MissingElement");
    expect(list(record(value(big, items(5000))), "i").length).toBe(5000);
  });
});

describe("Xsd.parse — complex types", () => {
  const model = compile(
    schema(
      `
      <xs:complexType name="Base">
        <xs:sequence><xs:element name="a" type="xs:string"/></xs:sequence>
        <xs:attribute name="id" type="xs:int" use="required"/>
        <xs:attribute name="kind" type="xs:string" default="base"/>
      </xs:complexType>
      <xs:complexType name="Extended"><xs:complexContent><xs:extension base="t:Base">
        <xs:sequence><xs:element name="b" type="xs:int"/></xs:sequence>
        <xs:attributeGroup ref="t:Extra"/>
      </xs:extension></xs:complexContent></xs:complexType>
      <xs:complexType name="Restricted"><xs:complexContent><xs:restriction base="t:Base">
        <xs:sequence><xs:element name="a" type="xs:string"/></xs:sequence>
        <xs:attribute name="kind" use="prohibited"/>
      </xs:restriction></xs:complexContent></xs:complexType>
      <xs:attributeGroup name="Extra"><xs:attribute name="note" type="xs:string"/></xs:attributeGroup>
      <xs:complexType name="Money"><xs:simpleContent><xs:extension base="xs:decimal">
        <xs:attribute name="currency" type="xs:string" fixed="AUD"/>
      </xs:extension></xs:simpleContent></xs:complexType>
      <xs:complexType name="SmallMoney"><xs:simpleContent><xs:restriction base="t:Money">
        <xs:maxInclusive value="10"/>
      </xs:restriction></xs:simpleContent></xs:complexType>
      <xs:element name="ext" type="t:Extended"/>
      <xs:element name="res" type="t:Restricted"/>
      <xs:element name="money" type="t:SmallMoney"/>
      <xs:element name="mixed"><xs:complexType mixed="true"><xs:sequence>
        <xs:element name="b" type="xs:string" minOccurs="0" maxOccurs="unbounded"/>
      </xs:sequence></xs:complexType></xs:element>
      <xs:element name="empty"><xs:complexType><xs:attribute name="x" type="xs:int"/></xs:complexType></xs:element>
      <xs:element name="anything"/>`,
      `targetNamespace="urn:t" xmlns:t="urn:t" elementFormDefault="qualified"`,
    ),
  );
  const ns = `xmlns="urn:t"`;

  test("extension appends content and attributes", () => {
    expect(value(model, `<ext ${ns} id="1" note="n"><a>x</a><b>2</b></ext>`)).toEqual({
      id: 1,
      kind: "base",
      note: "n",
      a: "x",
      b: 2,
    });
    expect(rule(model, `<ext ${ns} id="1"><b>2</b><a>x</a></ext>`)).toBe("UnexpectedElement");
  });

  test("restriction can prohibit attributes", () => {
    expect(value(model, `<res ${ns} id="3"><a>x</a></res>`)).toEqual({ id: 3, a: "x" });
    expect(rule(model, `<res ${ns} id="3" kind="k"><a>x</a></res>`)).toBe("UnexpectedAttribute");
  });

  test("attributes: required, typed, unknown", () => {
    expect(rule(model, `<ext ${ns}><a/><b>1</b></ext>`)).toBe("MissingAttribute");
    expect(rule(model, `<ext ${ns} id="x"><a/><b>1</b></ext>`)).toBe("InvalidValue");
    expect(rule(model, `<ext ${ns} id="1" other="1"><a/><b>1</b></ext>`)).toBe(
      "UnexpectedAttribute",
    );
  });

  test("simple content with attributes, restricted by facets", () => {
    const v = record(value(model, `<money ${ns}>9.99</money>`));
    expect(v["currency"]).toBe("AUD");
    assert(BigDecimal.isBigDecimal(v["$value"]));
    expect(rule(model, `<money ${ns}>11</money>`)).toBe("InvalidValue");
    expect(rule(model, `<money ${ns} currency="USD">1</money>`)).toBe("InvalidValue");
    expect(rule(model, `<money ${ns}>1<x/></money>`)).toBe("UnexpectedElement");
  });

  test("mixed content keeps its text", () => {
    expect(value(model, `<mixed ${ns}>a <b>x</b> c</mixed>`)).toEqual({ b: ["x"], $text: "a  c" });
  });

  test("empty content admits nothing, not even whitespace", () => {
    expect(value(model, `<empty ${ns} x="1"/>`)).toEqual({ x: 1 });
    expect(rule(model, `<empty ${ns}> </empty>`)).toBe("UnexpectedText");
    expect(rule(model, `<empty ${ns}><a/></empty>`)).toBe("UnexpectedElement");
  });

  test("an element without a type is anyType", () => {
    const v = record(
      value(model, `<anything ${ns} a="1">x<y:z xmlns:y="urn:y"><w/></y:z></anything>`),
    );
    const [z] = list(v, "$any");
    assert(z instanceof Xml.XmlElement);
    expect(z.name.clark).toBe("{urn:y}z");
    expect(v["$text"]).toBe("x");
    expect(v["$attributes"]).toEqual({ a: "1" });
  });
});

describe("Xsd.parse — derivation and substitution", () => {
  const model = compile(
    schema(`
      <xs:complexType name="Shape" abstract="true"><xs:attribute name="id" type="xs:ID"/></xs:complexType>
      <xs:complexType name="Circle"><xs:complexContent><xs:extension base="Shape">
        <xs:attribute name="r" type="xs:int" use="required"/></xs:extension></xs:complexContent></xs:complexType>
      <xs:complexType name="Square"><xs:complexContent><xs:extension base="Shape">
        <xs:attribute name="side" type="xs:int" use="required"/></xs:extension></xs:complexContent></xs:complexType>
      <xs:element name="shape" type="Shape" abstract="true"/>
      <xs:element name="circle" type="Circle" substitutionGroup="shape"/>
      <xs:element name="square" type="Square" substitutionGroup="shape"/>
      <xs:element name="locked" type="Circle" block="extension"/>
      <xs:element name="any" type="Shape" nillable="true"/>
      <xs:element name="drawing"><xs:complexType><xs:sequence>
        <xs:element ref="shape" maxOccurs="unbounded"/>
        <xs:element name="link" type="xs:IDREF" minOccurs="0"/>
      </xs:sequence></xs:complexType></xs:element>
      <xs:element name="plain"><xs:complexType><xs:sequence>
        <xs:element ref="sealed" maxOccurs="unbounded"/></xs:sequence></xs:complexType></xs:element>
      <xs:element name="sealed" type="xs:string" block="substitution"/>
      <xs:element name="sub" type="xs:string" substitutionGroup="sealed"/>`),
  );
  const XSI = `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`;

  test("substitution group members appear for their head", () => {
    expect(
      value(model, `<drawing><circle r="1"/><square side="2"/><circle r="3"/></drawing>`),
    ).toEqual({ circle: [{ r: 1 }, { r: 3 }], square: [{ side: 2 }] });
    expect(rule(model, `<drawing><shape/></drawing>`)).toBe("UnexpectedElement");
    expect(rule(model, `<plain><sub>x</sub></plain>`)).toBe("UnexpectedElement");
    expect(rule(model, `<shape/>`)).toBe("InvalidType");
  });

  test("xsi:type selects a derived type", () => {
    expect(value(model, `<any ${XSI} xsi:type="Square" side="4"/>`)).toEqual({
      side: 4,
      $type: "Square",
    });
    expect(rule(model, `<any/>`)).toBe("InvalidType");
    expect(
      rule(model, `<any ${XSI} xsi:type="xs:int" xmlns:xs="http://www.w3.org/2001/XMLSchema"/>`),
    ).toBe("InvalidType");
    expect(rule(model, `<any ${XSI} xsi:type="Nope"/>`)).toBe("InvalidType");
    expect(rule(model, `<locked ${XSI} xsi:type="Square" side="1"/>`)).toBe("InvalidType");
  });

  test("xsi:nil", () => {
    expect(value(model, `<any ${XSI} xsi:type="Circle" xsi:nil="true" r="1"/>`)).toBeNull();
    // An abstract type can't govern an element, even a nil one.
    expect(rule(model, `<any ${XSI} xsi:nil="true"/>`)).toBe("InvalidType");
    expect(rule(model, `<circle ${XSI} xsi:nil="true" r="1"/>`)).toBe("Nil");
    expect(rule(model, `<any ${XSI} xsi:nil="true" xsi:type="Circle" r="1">x</any>`)).toBe("Nil");
  });

  test("IDs are unique and IDREFs resolve", () => {
    expect(value(model, `<drawing><circle id="c" r="1"/><link>c</link></drawing>`)).toEqual({
      circle: [{ id: "c", r: 1 }],
      square: [],
      link: "c",
    });
    expect(rule(model, `<drawing><circle id="c" r="1"/><square id="c" side="1"/></drawing>`)).toBe(
      "InvalidValue",
    );
    expect(rule(model, `<drawing><circle id="c" r="1"/><link>d</link></drawing>`)).toBe(
      "IdentityConstraint",
    );
  });
});

describe("Xsd.parse — wildcards", () => {
  const model = compile(
    schema(
      `
      <xs:element name="known" type="xs:int"/>
      <xs:attribute name="flag" type="xs:boolean"/>
      <xs:element name="r"><xs:complexType><xs:sequence>
        <xs:element name="a" type="xs:string"/>
        <xs:any namespace="##other" processContents="skip" minOccurs="0" maxOccurs="unbounded"/>
        <xs:any namespace="##targetNamespace" processContents="strict" minOccurs="0"/>
      </xs:sequence><xs:anyAttribute processContents="lax"/></xs:complexType></xs:element>`,
      `targetNamespace="urn:t" xmlns:t="urn:t" elementFormDefault="qualified"`,
    ),
  );

  test("skip wildcards keep elements as DOM", () => {
    const v = record(value(model, `<r xmlns="urn:t"><a/><o:x xmlns:o="urn:o"><y/></o:x></r>`));
    const [x] = list(v, "$any");
    assert(x instanceof Xml.XmlElement);
    expect(Xml.serialize(x)).toBe(`<o:x xmlns:o="urn:o"><y/></o:x>`);
  });

  test("strict wildcards validate against global declarations", () => {
    expect(rule(model, `<r xmlns="urn:t"><a/><known>x</known></r>`)).toBe("InvalidValue");
    expect(rule(model, `<r xmlns="urn:t"><a/><unknown/></r>`)).toBe("UnexpectedElement");
    expect(rule(model, `<r xmlns="urn:t"><a/><b xmlns=""/></r>`)).toBe("UnexpectedElement");
  });

  test("lax attribute wildcards validate what they know", () => {
    const v = value(model, `<r xmlns="urn:t" xmlns:t="urn:t" t:flag="true" x="1"><a/></r>`);
    expect(v).toMatchObject({ $attributes: { "{urn:t}flag": "true", x: "1" } });
    expect(rule(model, `<r xmlns="urn:t" xmlns:t="urn:t" t:flag="maybe"><a/></r>`)).toBe(
      "InvalidValue",
    );
  });
});

describe("Xsd.parse — attribute wildcards across derivations", () => {
  const model = compile(
    schema(`
      <xs:attributeGroup name="g"><xs:anyAttribute namespace="urn:a urn:b" processContents="skip"/></xs:attributeGroup>
      <xs:complexType name="Base"><xs:attributeGroup ref="g"/><xs:anyAttribute namespace="urn:b urn:c" processContents="skip"/></xs:complexType>
      <xs:complexType name="Wider"><xs:complexContent><xs:extension base="Base">
        <xs:anyAttribute namespace="##other" processContents="skip"/></xs:extension></xs:complexContent></xs:complexType>
      <xs:complexType name="Local"><xs:complexContent><xs:extension base="Base">
        <xs:anyAttribute namespace="##local" processContents="skip"/></xs:extension></xs:complexContent></xs:complexType>
      <xs:element name="base" type="Base"/><xs:element name="wider" type="Wider"/><xs:element name="local" type="Local"/>`),
  );
  const attr = (ns: string) => `xmlns:p="${ns}" p:x="1"`;

  test("a type's wildcards intersect", () => {
    expect(value(model, `<base ${attr("urn:b")}/>`)).toEqual({ $attributes: { "{urn:b}x": "1" } });
    expect(rule(model, `<base ${attr("urn:a")}/>`)).toBe("UnexpectedAttribute");
  });

  test("extension unites them with the base's", () => {
    expect(value(model, `<wider ${attr("urn:z")}/>`)).toEqual({ $attributes: { "{urn:z}x": "1" } });
    expect(rule(model, `<wider x="1"/>`)).toBe("UnexpectedAttribute");
    expect(value(model, `<local x="1"/>`)).toEqual({ $attributes: { x: "1" } });
    expect(rule(model, `<local ${attr("urn:a")}/>`)).toBe("UnexpectedAttribute");
  });
});

describe("Xsd.parse — identity constraints", () => {
  const model = compile(
    schema(
      `<xs:element name="db"><xs:complexType><xs:sequence>
        <xs:element name="user" maxOccurs="unbounded"><xs:complexType>
          <xs:attribute name="id" type="xs:string"/><xs:attribute name="email" type="xs:string"/>
        </xs:complexType></xs:element>
        <xs:element name="post" minOccurs="0" maxOccurs="unbounded"><xs:complexType>
          <xs:attribute name="author" type="xs:string"/></xs:complexType></xs:element>
      </xs:sequence></xs:complexType>
      <xs:key name="userId"><xs:selector xpath="d:user"/><xs:field xpath="@id"/></xs:key>
      <xs:unique name="email"><xs:selector xpath="d:user"/><xs:field xpath="@email"/></xs:unique>
      <xs:keyref name="author" refer="d:userId"><xs:selector xpath="d:post"/><xs:field xpath="@author"/></xs:keyref>
      </xs:element>`,
      `targetNamespace="urn:d" xmlns:d="urn:d" elementFormDefault="qualified"`,
    ),
  );
  const db = (body: string) => `<db xmlns="urn:d">${body}</db>`;

  test("valid keys, uniques and references", () => {
    expect(
      Result.isSuccess(
        Effect.runSync(
          Effect.result(
            Xsd.parse(model, db(`<user id="a" email="x"/><user id="b"/><post author="a"/>`)),
          ),
        ),
      ),
    ).toBe(true);
  });

  test.each([
    [`<user id="a"/><user id="a"/>`, "not unique"],
    [`<user/>`, "missing"],
    [`<user id="a" email="x"/><user id="b" email="x"/>`, "not unique"],
    [`<user id="a"/><post author="b"/>`, "refers to no"],
  ])("rejects %s", (body, reason) => {
    const e = validation(invalid(model, db(body)));
    expect(e.rule).toBe("IdentityConstraint");
    expect(e.reason).toContain(reason);
  });
});

describe("Xsd.parse — well-formedness and roots", () => {
  const model = compile(
    schema(`<xs:element name="a" type="xs:string"/><xs:element name="b" type="xs:int"/>`),
  );

  test.each([
    [`<a>x</b>`, "MismatchedEndTag"],
    [`<a>x</a><a/>`, "InvalidDocumentStructure"],
    [`<a>x</a>text`, "InvalidDocumentStructure"],
    [`<a>x`, "InvalidDocumentStructure"],
    [`<p:a/>`, "UnboundNamespacePrefix"],
    [`<a x="1" x="2"/>`, "DuplicateAttribute"],
    [``, "InvalidDocumentStructure"],
  ])("%s fails with %s", (doc, tag) => {
    expect(invalid(model, doc)._tag).toBe(tag);
  });

  test("an undeclared root is unexpected", () => {
    expect(rule(model, `<c/>`)).toBe("UnexpectedElement");
  });

  test("a parser accepts only its own root", () => {
    const b = Xsd.parser<number>(model, "b");
    expect(Effect.runSync(b.parse(`<b>4</b>`))).toBe(4);
    const e = validation(Effect.runSync(Effect.flip(b.parse(`<a>x</a>`))));
    expect(e.reason).toBe("the document element is <a>, not <b>");
  });
});

describe("Xsd streaming", () => {
  const model = compile(
    schema(`<xs:element name="r"><xs:complexType><xs:sequence>
      <xs:element name="n" type="xs:int" maxOccurs="unbounded"/>
    </xs:sequence><xs:attribute name="v" type="xs:string"/></xs:complexType></xs:element>`),
  );
  const doc = `<r v="é&amp;x">${Array.from({ length: 20 }, (_, i) => `<n> ${i} </n>`).join("")}</r>`;

  test.each([1, 2, 3, 7, 64])("chunks of %i give the same value", (size) => {
    const v = Effect.runSync(Xsd.parseStream(model)(Stream.fromIterable(splitEvery(doc, size))));
    expect(v.value).toEqual(value(model, doc));
  });

  test("bytes", () => {
    const v = Effect.runSync(Xsd.parseBytes(model, new TextEncoder().encode(doc)));
    expect(v.value).toEqual(value(model, doc));
  });

  test("validate passes events through and fails fast", () => {
    const events = Effect.runSync(
      Sax.tokenizeString(`<r><n>1</n></r>`).pipe(Xsd.validate(model), Stream.runCollect),
    );
    expect(Array.from(events).map((e) => e._tag)).toEqual([
      "StartElement",
      "StartElement",
      "Text",
      "EndElement",
      "EndElement",
    ]);
    let seen = 0;
    const failed = Effect.runSync(
      Effect.flip(
        Stream.fromIterable(
          splitEvery(`<r><n>1</n><n>x</n>${"<n>2</n>".repeat(1000)}</r>`, 4),
        ).pipe(
          Sax.tokenize(),
          Stream.tap(() => Effect.sync(() => seen++)),
          Xsd.validate(model),
          Stream.runDrain,
        ),
      ),
    );
    expect(failed._tag).toBe("XsdValidationError");
    expect(seen).toBeLessThan(20);
  });
});

describe("Xsd.select", () => {
  const model = compile(
    schema(
      `<xs:element name="sheet"><xs:complexType><xs:sequence>
        <xs:element name="title" type="xs:string"/>
        <xs:element name="head" minOccurs="0"><xs:complexType>
          <xs:attribute name="n" type="xs:int"/></xs:complexType></xs:element>
        <xs:element name="row" maxOccurs="unbounded"><xs:complexType><xs:sequence>
          <xs:element name="c" type="xs:int" maxOccurs="unbounded"/>
        </xs:sequence><xs:attribute name="r" type="xs:int"/><xs:attribute name="hidden" type="xs:boolean"/>
        </xs:complexType></xs:element>
      </xs:sequence></xs:complexType></xs:element>
      <xs:element name="keyed"><xs:complexType><xs:sequence>
        <xs:element name="group" maxOccurs="unbounded"><xs:complexType><xs:sequence>
          <xs:element name="item" maxOccurs="unbounded"><xs:complexType>
            <xs:attribute name="id" type="xs:int"/></xs:complexType></xs:element>
        </xs:sequence></xs:complexType>
        <xs:unique name="id"><xs:selector xpath="s:item"/><xs:field xpath="@id"/></xs:unique>
        </xs:element>
      </xs:sequence></xs:complexType></xs:element>`,
      `targetNamespace="urn:s" xmlns:s="urn:s" elementFormDefault="qualified"`,
    ),
  );
  const ns = { namespaces: { s: "urn:s" } };
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => `<row r="${i + 1}"><c>${i}</c><c>0${i}</c></row>`).join("");
  const sheet = (body: string) => `<sheet xmlns="urn:s"><title>T</title>${body}</sheet>`;
  const selected = (doc: string, path: string, size = 64) =>
    Effect.runSync(
      Stream.fromIterable(splitEvery(doc, size)).pipe(
        Sax.tokenize(),
        Xsd.select(model, path, ns),
        Stream.runCollect,
      ),
    );

  test.each([1, 5, 64])("emits each selected element's value (chunks of %i)", (size) => {
    expect(selected(sheet(rows(3)), "/s:sheet/s:row", size)).toEqual([
      { r: 1, c: [0, 0] },
      { r: 2, c: [1, 1] },
      { r: 3, c: [2, 2] },
    ]);
  });

  test("predicates on attributes and descendant steps", () => {
    const doc = sheet(`<row r="1" hidden="true"><c>1</c></row><row r="2"><c>2</c></row>`);
    expect(selected(doc, "//s:row[not(@hidden)]")).toEqual([{ r: 2, c: [2] }]);
    expect(selected(doc, "//s:c")).toEqual([1, 2]);
  });

  test("a selected element is left out of its parent's value", () => {
    const events: Array<Xsd.XsdValue> = [];
    const program = Stream.make(sheet(`<head n="1"/>${rows(2)}`)).pipe(
      Sax.tokenize(),
      Xsd.select(model, "/s:sheet/s:row | /s:sheet/s:head", ns),
      Stream.runForEach((v) => Effect.sync(() => events.push(v))),
    );
    const failed = Effect.runSync(Effect.flip(program));
    // A union is not streamable.
    expect(failed._tag).toBe("XPathError");
    const root = Effect.runSync(
      Stream.make(sheet(`<head n="1"/>${rows(2)}`)).pipe(
        Sax.tokenize(),
        Xsd.select(model, "/s:sheet", ns),
        Stream.runCollect,
      ),
    );
    // Selecting the document element emits the whole value.
    expect(record(root[0] ?? null)).toEqual({
      title: "T",
      head: { n: 1 },
      row: [
        { r: 1, c: [0, 0] },
        { r: 2, c: [1, 1] },
      ],
    });
  });

  test("the parent's array stays empty and a single child is left out", () => {
    const parser = Xsd.parser<Xsd.XsdRecord>(model, "{urn:s}sheet");
    const doc = sheet(`<head n="1"/>${rows(2)}`);
    const run = (path: string) =>
      Effect.runSync(
        Stream.make(doc).pipe(
          Sax.tokenize(),
          parser.stream<{ readonly r: number }>(path, ns),
          Stream.runCollect,
        ),
      );
    expect(run("s:sheet/s:row").map((r) => r.r)).toEqual([1, 2]);
    expect(run("s:sheet/s:head")).toEqual([{ n: 1 }]);
  });

  test("fails at the first violation, after emitting what came before it", () => {
    const seen: Array<Xsd.XsdValue> = [];
    const failed = Effect.runSync(
      Effect.flip(
        Stream.make(sheet(`${rows(2)}<row r="x"/>${rows(2)}`)).pipe(
          Sax.tokenize(),
          Xsd.select(model, "/s:sheet/s:row", ns),
          Stream.runForEach((v) => Effect.sync(() => seen.push(v))),
        ),
      ),
    );
    expect(failed._tag).toBe("XsdValidationError");
    expect(seen).toHaveLength(2);
  });

  test("the root option applies", () => {
    const failed = Effect.runSync(
      Effect.flip(
        Stream.make(sheet(rows(1))).pipe(
          Sax.tokenize(),
          Xsd.select(model, "//s:row", { ...ns, root: "{urn:s}keyed" }),
          Stream.runDrain,
        ),
      ),
    );
    expect(failed._tag).toBe("XsdValidationError");
  });

  test("elements in an identity-constraint scope are emitted when it closes", () => {
    const doc = `<keyed xmlns="urn:s"><group><item id="1"/><item id="2"/></group><group><item id="3"/><item id="3"/></group></keyed>`;
    const seen: Array<Xsd.XsdValue> = [];
    const failed = Effect.runSync(
      Effect.flip(
        Stream.make(doc).pipe(
          Sax.tokenize(),
          Xsd.select(model, "//s:item", ns),
          Stream.runForEach((v) => Effect.sync(() => seen.push(v))),
        ),
      ),
    );
    expect(failed._tag).toBe("XsdValidationError");
    // The first group's items were released when it closed; the second's never were.
    expect(seen).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("an invalid or unstreamable path fails the stream", () => {
    const fail = (path: string) =>
      Effect.runSync(
        Effect.flip(
          Stream.make(sheet(rows(1))).pipe(
            Sax.tokenize(),
            Xsd.select(model, path, ns),
            Stream.runDrain,
          ),
        ),
      );
    expect(fail("s:sheet/s:row[1]")._tag).toBe("XPathError");
    expect(fail("s:sheet/(")._tag).toBe("XPathError");
  });
});

describe("Xsd.generate", () => {
  const model = compile(
    schema(
      `<xs:simpleType name="Colour"><xs:restriction base="xs:token">
         <xs:enumeration value="red"/><xs:enumeration value="blue"/></xs:restriction></xs:simpleType>
       <xs:complexType name="Base"><xs:attribute name="id" type="xs:long" use="required"/></xs:complexType>
       <xs:complexType name="Derived"><xs:complexContent><xs:extension base="t:Base">
         <xs:sequence><xs:element name="price" type="xs:decimal"/></xs:sequence>
       </xs:extension></xs:complexContent></xs:complexType>
       <xs:element name="model" type="t:Base" nillable="true"/>
       <xs:element name="thing"><xs:complexType><xs:sequence>
         <xs:element name="colour" type="t:Colour" maxOccurs="unbounded"/>
         <xs:element name="first-name" type="xs:string" minOccurs="0"/>
         <xs:any namespace="##other" processContents="lax"/>
       </xs:sequence></xs:complexType></xs:element>`,
      `targetNamespace="urn:t" xmlns:t="urn:t"`,
    ),
  );
  const source = Effect.runSync(Xsd.generate(model, { importFrom: "pkg" }));

  test("types, the model and parsers", () => {
    expect(source).toContain(`import type * as BigDecimal from "effect/BigDecimal";`);
    expect(source).toContain(`import type { Xml } from "pkg";`);
    expect(source).toContain(`export type Colour = "red" | "blue";`);
    expect(source).toContain(
      `export interface Base {\n  /** The attribute id. */\n  readonly id: bigint;\n}`,
    );
    expect(source).toContain(`readonly price: BigDecimal.BigDecimal;`);
    expect(source).toContain(`readonly colour: ReadonlyArray<Colour>;`);
    expect(source).toContain(`readonly "first-name"?: string;`);
    expect(source).toContain(`readonly $any: ReadonlyArray<Xml.XmlElement>;`);
    expect(source).toContain(`export const model: Xsd.Model = {`);
    // `model` is taken by the module itself, so the parser for <model> is numbered.
    expect(source).toContain(
      `export const model2 = Xsd.parser<Base | (Derived & { readonly $type: "{urn:t}Derived" }) | null>(model, "{urn:t}model");`,
    );
    expect(source).toContain(`export const thing = Xsd.parser<Thing>(model, "{urn:t}thing");`);
  });

  test("enumerations become literal unions where they can", () => {
    const enums = compile(
      schema(`
        <xs:simpleType name="Level"><xs:restriction base="xs:int"><xs:enumeration value="1"/><xs:enumeration value="+2"/></xs:restriction></xs:simpleType>
        <xs:simpleType name="Big"><xs:restriction base="xs:integer"><xs:enumeration value="+10"/></xs:restriction></xs:simpleType>
        <xs:simpleType name="Yes"><xs:restriction base="xs:boolean"><xs:enumeration value="1"/></xs:restriction></xs:simpleType>
        <xs:simpleType name="Day"><xs:restriction base="xs:date"><xs:enumeration value="2024-01-01"/></xs:restriction></xs:simpleType>
        <xs:simpleType name="Ratio"><xs:restriction base="xs:decimal"><xs:enumeration value="0.5"/></xs:restriction></xs:simpleType>
        <xs:simpleType name="Spaced"><xs:restriction base="xs:token"><xs:enumeration value=" a  b "/></xs:restriction></xs:simpleType>
        <xs:simpleType name="Words"><xs:list itemType="Spaced"/></xs:simpleType>
        <xs:simpleType name="Either"><xs:union memberTypes="Level Yes"/></xs:simpleType>`),
    );
    const out = Effect.runSync(Xsd.generate(enums));
    expect(out).toContain(`export type Level = 1 | 2;`);
    expect(out).toContain(`export type Big = 10n;`);
    expect(out).toContain(`export type Yes = true;`);
    expect(out).toContain(`export type Day = "2024-01-01";`);
    expect(out).toContain(`export type Ratio = BigDecimal.BigDecimal;`);
    expect(out).toContain(`export type Spaced = "a b";`);
    expect(out).toContain(`export type Words = ReadonlyArray<"a b">;`);
    expect(out).toContain(`export type Either = 1 | 2 | true;`);
  });

  test("an invalid model fails", () => {
    const broken: Xsd.Model = {
      elements: {},
      attributes: {},
      types: { T: { _tag: "SimpleType", name: "T", variety: "atomic", base: "Nope" } },
    };
    expect(Effect.runSync(Effect.flip(Xsd.generate(broken))).message).toContain("Nope");
  });

  test("is deterministic", () => {
    expect(
      Effect.runSync(
        Xsd.generate(compile(Effect.runSync(Effect.succeed(schema(`<xs:element name="x"/>`))))),
      ),
    ).toBe(Effect.runSync(Xsd.generate(compile(schema(`<xs:element name="x"/>`)))));
  });
});

describe("the generated example (examples/xsd)", () => {
  const SOURCES = import.meta.glob<string>("../examples/xsd/order.*", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  const xsd = SOURCES["../examples/xsd/order.xsd"] ?? "";
  const generated = SOURCES["../examples/xsd/order.generated.ts"] ?? "";

  test("is what the generator writes today", () => {
    const model = compile(xsd);
    const source = Effect.runSync(
      Xsd.generate(model, { importFrom: "../../src/index.ts", source: "order.xsd" }),
    );
    // Regenerate with the CLI (packages/cli): effect-xml-xsd generate examples/xsd/order.xsd -o examples/xsd/order.generated.ts --import-from ../../src/index.ts
    expect(source).toBe(generated);
  });

  test("its parser produces the values its types describe", () => {
    const order: Example.Order = Effect.runSync(
      Example.order.parse(
        `<order xmlns="urn:example:order" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                xmlns:x="urn:x" number="7" paid="1">
           <customer xsi:type="Person"><name>Ann</name></customer>
           <placed>2026-01-01T00:00:00Z</placed>
           <line id="a"><sku>ABC-0001</sku><quantity>2</quantity><price currency="EUR">1.5</price><note>n</note></line>
           <x:extra/>
         </order>`,
      ),
    );
    expect(order.number).toBe(7);
    expect(order.paid).toBe(true);
    expect(order.customer).toEqual({ name: "Ann", $type: "{urn:example:order}Person" });
    // Every type derived from the abstract Party is a Party.
    const party: Example.Party = order.customer;
    expect(party.name).toBe("Ann");
    const [line] = order.line;
    assert(line !== undefined);
    expect(line.quantity).toBe(2n);
    expect(line.price.currency).toBe("EUR");
    expect(BigDecimal.format(line.price.$value)).toBe("1.5");
    expect(Arr.map(order.$any, (e) => e.name.clark)).toEqual(["{urn:x}extra"]);
  });

  test("its unique constraint holds", () => {
    const line = `<line id="ID"><sku>ABC-0001</sku><quantity>1</quantity><price>1</price></line>`;
    const e = validation(
      Effect.runSync(
        Effect.flip(
          Example.order.parse(
            `<order xmlns="urn:example:order" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" number="1">
               <customer xsi:type="Person"><name>A</name></customer><placed>2026-01-01T00:00:00Z</placed>
               ${line.replace("ID", "a")}${line.replace("ID", "b")}</order>`,
          ),
        ),
      ),
    );
    expect(e.rule).toBe("IdentityConstraint");
  });
});
