/**
 * Parsing benchmarks. Run with `vp run bench` (or `vpx bench/parse.ts
 * [megabytes]`).
 *
 * The input is a generated SpreadsheetML worksheet (the shape of a large
 * XLSX `sheet1.xml`, about 8 MB by default). effect-xml is measured as a SAX
 * stream (whole string and 64 KiB chunks), as bytes, as a DOM (strictly and
 * with `recover: true`, which reads it with the lexer, not directly), with
 * `dtd: "internal"` (as SAX and DOM, and as a DOM with a DOCTYPE that
 * declares entities the worksheet references), with
 * streaming selection of rows, and validated against a schema for the
 * worksheet (as events, and as typed values), queried with XPath
 * (`XQuery.evaluate` over the parsed DOM), and queried with `XQuery.stream`
 * against parsing and evaluating the same query over the DOM. A generated product catalog is
 * validated against a schema that uses substitution groups, derivation,
 * choices and facets, which the worksheet's schema does not. HTML is measured with
 * `Html.parseDocument` and `Html.parseFragment` on a generated page that
 * exercises formatting elements, implied end tags, tables, foreign content,
 * entities and CRLF line ends (the input of #13).
 *
 * Other parsers are compared when they are installed, without being
 * dependencies of this package: `pnpm add -D saxes sax htmlparser2 easysax
 * @eksml/xml txml fast-xml-parser` (and revert `package.json`,
 * `pnpm-workspace.yaml` and `pnpm-lock.yaml` afterwards) to include them.
 * None of them reports positions per event.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Html, Sax, Xml, Xsd, XQuery } from "../src/index.ts";

const SML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const megabytes = Number(process.argv[2] ?? 8);

/** One row of the worksheet: eight cells. */
const rowOf = (r: number): string =>
  `<row r="${r}" spans="1:8">${Arr.map(Arr.range(0, 7), (c) => {
    const ref = `${String.fromCharCode(65 + c)}${r}`;
    return c % 3 === 0
      ? `<c r="${ref}" t="s"><v>${(r * 7 + c) % 1000}</v></c>`
      : `<c r="${ref}" s="1"><v>${(r * c) / 7}</v></c>`;
  }).join("")}</row>`;

/** Whole rows, generated until their text reaches `bytes`. */
const sheet = (bytes: number): string => {
  const rows = Arr.unfold({ r: 1, size: 0 }, ({ r, size }) => {
    if (size >= bytes) return Option.none();
    const row = rowOf(r);
    return Option.some([row, { r: r + 1, size: size + row.length }] as const);
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${SML}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>${rows.join("")}</sheetData></worksheet>`;
};

/** The part of the SpreadsheetML schema the generated worksheet uses. */
const worksheetSchema = `
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns="${SML}" targetNamespace="${SML}"
           elementFormDefault="qualified">
  <xs:simpleType name="ST_CellType"><xs:restriction base="xs:string">
    <xs:enumeration value="b"/><xs:enumeration value="n"/><xs:enumeration value="e"/>
    <xs:enumeration value="s"/><xs:enumeration value="str"/><xs:enumeration value="inlineStr"/>
  </xs:restriction></xs:simpleType>
  <xs:complexType name="CT_Cell">
    <xs:sequence><xs:element name="v" type="xs:string" minOccurs="0"/></xs:sequence>
    <xs:attribute name="r" type="xs:string"/>
    <xs:attribute name="s" type="xs:unsignedInt" default="0"/>
    <xs:attribute name="t" type="ST_CellType" default="n"/>
  </xs:complexType>
  <xs:complexType name="CT_Row">
    <xs:sequence><xs:element name="c" type="CT_Cell" minOccurs="0" maxOccurs="unbounded"/></xs:sequence>
    <xs:attribute name="r" type="xs:unsignedInt"/>
    <xs:attribute name="spans" type="xs:string"/>
  </xs:complexType>
  <xs:element name="worksheet"><xs:complexType><xs:sequence>
    <xs:element name="sheetData"><xs:complexType><xs:sequence>
      <xs:element name="row" type="CT_Row" minOccurs="0" maxOccurs="unbounded"/>
    </xs:sequence></xs:complexType></xs:element>
  </xs:sequence></xs:complexType></xs:element>
</xs:schema>`;

const input = sheet(megabytes * 1024 * 1024);
const bytes = new TextEncoder().encode(input);
const chunks = input.match(/[\s\S]{1,65536}/g) ?? [];

/** `body` under a DOCTYPE that declares an entity the body never references (#191). */
const withEntity = (body: string) =>
  body.replace("<worksheet", '<!DOCTYPE worksheet [<!ENTITY e "x">]>\n<worksheet');

// `vpx bench/parse.ts 8 entity` times only the rows whose name contains the second argument.
const only = Option.fromNullishOr(process.argv[3]);

/** Runs `run` once to warm up, then `runs` times, and prints the median. */
const time = <E>(name: string, run: Effect.Effect<unknown, E>, runs = 5, size = input.length) =>
  Effect.gen(function* () {
    if (Option.isSome(only) && !name.includes(only.value)) return;
    yield* run; // warm up
    const samples = yield* Effect.forEach(
      Arr.range(1, runs),
      () =>
        Effect.gen(function* () {
          const start = performance.now();
          yield* run;
          return performance.now() - start;
        }),
      { concurrency: 1 },
    );
    const median = Arr.sort(samples, Order.Number)[Math.floor(samples.length / 2)] ?? 0;
    const mbps = size / 1024 / 1024 / (median / 1000);
    yield* Console.log(
      `${name.padEnd(36)} ${median.toFixed(0).padStart(6)} ms  ${mbps.toFixed(1).padStart(6)} MB/s`,
    );
  });

/** A benchmark of a third-party parser's work, which is synchronous. */
const timeSync = (name: string, run: () => void) => time(name, Effect.sync(run));

/** A comparison parser that is not installed, so its benchmark is skipped. */
class NotInstalled extends Schema.TaggedError<NotInstalled, { readonly brand: unique symbol }>()(
  "NotInstalled",
  {
    pkg: Schema.String,
  },
) {}

/**
 * A third-party parser the benchmark compares against, if it is installed:
 * `Module` is the slice of its exports the benchmark calls.
 */
const optional = <Module>(pkg: string): Effect.Effect<Option.Option<Module>> =>
  Effect.option(
    Effect.tryPromise({
      try: (): Promise<Module> => import(pkg),
      catch: () => new NotInstalled({ pkg }),
    }),
  );

/** Benchmarks `run` against a comparison parser, when it is installed. */
const compare = <Module>(
  label: string,
  installed: Effect.Effect<Option.Option<Module>>,
  run: (module: Module) => void,
) =>
  Effect.flatMap(
    installed,
    Option.match({
      onNone: () => Effect.void,
      onSome: (module) => timeSync(label, () => run(module)),
    }),
  );

type Handler = (...args: ReadonlyArray<unknown>) => void;

/** A streaming parser fed with `write` and finished with `end` or `close`. */
interface Writable {
  on(event: string, handler: Handler): void;
  write(input: string): Writable;
  end(): void;
  close(): void;
}

interface SaxesModule {
  readonly SaxesParser: new (options: { readonly xmlns: boolean }) => Writable;
}
interface SaxModule {
  parser(strict: boolean, options: { readonly xmlns: boolean }): Writable & { onopentag: Handler };
}
interface Htmlparser2Module {
  readonly Parser: new (
    handlers: { readonly onopentag: Handler; readonly ontext: Handler },
    options: { readonly xmlMode: boolean },
  ) => Writable;
}
interface EasysaxModule {
  readonly default: new () => Writable;
}
interface EksmlSaxModule {
  createSaxParser(options: { readonly entities: boolean }): Writable;
}
interface DomModule {
  parse(input: string, options?: { readonly entities: boolean }): void;
}
interface FxpModule {
  readonly XMLParser: new (options: { readonly ignoreAttributes: boolean }) => {
    parse(input: string): void;
  };
}

const keyedSchema = worksheetSchema
  .replace(
    `</xs:sequence></xs:complexType></xs:element>
  </xs:sequence></xs:complexType></xs:element>`,
    `</xs:sequence></xs:complexType>
      <xs:key name="row" xmlns:x="${SML}"><xs:selector xpath="x:row"/><xs:field xpath="@r"/></xs:key>
    </xs:element>
  </xs:sequence></xs:complexType></xs:element>`,
  )
  .replace(
    `<xs:element name="row" type="CT_Row" minOccurs="0" maxOccurs="unbounded"/>`,
    `<xs:element name="row" type="CT_Row" minOccurs="0" maxOccurs="unbounded">
        <xs:unique name="cell" xmlns:x="${SML}"><xs:selector xpath="x:c"/><xs:field xpath="@r"/></xs:unique>
      </xs:element>`,
  );

const CAT = "urn:example:catalog";
const catalogSchema = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns="${CAT}" targetNamespace="${CAT}" elementFormDefault="qualified">
  <xs:simpleType name="Sku"><xs:restriction base="xs:token"><xs:pattern value="[A-Z]{3}-\\d{4}"/></xs:restriction></xs:simpleType>
  <xs:simpleType name="Price"><xs:restriction base="xs:decimal"><xs:minInclusive value="0"/><xs:fractionDigits value="2"/></xs:restriction></xs:simpleType>
  <xs:simpleType name="Tags"><xs:restriction><xs:simpleType><xs:list itemType="xs:NCName"/></xs:simpleType><xs:maxLength value="8"/></xs:restriction></xs:simpleType>
  <xs:simpleType name="Rating"><xs:restriction base="xs:string"><xs:enumeration value="G"/><xs:enumeration value="PG"/><xs:enumeration value="M"/><xs:enumeration value="R"/></xs:restriction></xs:simpleType>
  <xs:complexType name="Product" abstract="true"><xs:sequence>
    <xs:element name="title" type="xs:string"/>
    <xs:element name="price" type="Price"/>
    <xs:element name="released" type="xs:date" minOccurs="0"/>
    <xs:element name="tags" type="Tags" minOccurs="0"/>
  </xs:sequence>
  <xs:attribute name="sku" type="Sku" use="required"/>
  <xs:attribute name="stock" type="xs:nonNegativeInteger" default="0"/></xs:complexType>
  <xs:complexType name="Book"><xs:complexContent><xs:extension base="Product"><xs:sequence>
    <xs:choice><xs:element name="isbn" type="xs:string"/><xs:element name="issn" type="xs:string"/></xs:choice>
    <xs:element name="author" type="xs:string" maxOccurs="unbounded"/>
  </xs:sequence><xs:attribute name="pages" type="xs:positiveInteger"/></xs:extension></xs:complexContent></xs:complexType>
  <xs:complexType name="Track"><xs:simpleContent><xs:extension base="xs:duration"><xs:attribute name="n" type="xs:int" use="required"/></xs:extension></xs:simpleContent></xs:complexType>
  <xs:complexType name="Disc"><xs:complexContent><xs:extension base="Product"><xs:sequence>
    <xs:element name="track" type="Track" maxOccurs="unbounded"/>
  </xs:sequence><xs:attribute name="rating" type="Rating"/></xs:extension></xs:complexContent></xs:complexType>
  <xs:element name="product" type="Product" abstract="true"/>
  <xs:element name="book" type="Book" substitutionGroup="product"/>
  <xs:element name="disc" type="Disc" substitutionGroup="product"/>
  <xs:element name="catalog"><xs:complexType><xs:sequence>
    <xs:element ref="product" maxOccurs="unbounded"/>
  </xs:sequence><xs:attribute name="updated" type="xs:dateTime"/></xs:complexType></xs:element>
</xs:schema>`;
/** One product of the catalog, a book or a disc by turns. */
const itemOf = (n: number): string => {
  const sku = `${String.fromCharCode(65 + (n % 26), 65 + ((n >> 3) % 26), 65 + ((n >> 6) % 26))}-${String(n % 10000).padStart(4, "0")}`;
  const released =
    n % 2 === 0
      ? ""
      : `<released>20${String(n % 25).padStart(2, "0")}-0${(n % 9) + 1}-1${n % 10}</released>`;
  const common = `<title>Item ${n} &amp; co</title><price>${(n % 997) + 0.25}</price>${released}<tags>t${n % 7} new sale</tags>`;
  return n % 3 === 0
    ? `<disc sku="${sku}" rating="${["G", "PG", "M", "R"][n % 4]}">${common}` +
        `<track n="1">PT3M${n % 60}S</track><track n="2">PT4M1S</track><track n="3">PT2M59.5S</track></disc>`
    : `<book sku="${sku}" stock="${n % 50}" pages="${(n % 900) + 1}">${common}` +
        `<isbn>978-0-${n}</isbn><author>A. Writer</author><author>B. Other</author></book>`;
};

const catalogOf = (): string => {
  const items = Arr.unfold({ n: 0, size: 0 }, ({ n, size }) => {
    if (size >= megabytes * 1024 * 1024) return Option.none();
    const item = itemOf(n);
    return Option.some([item, { n: n + 1, size: size + item.length }] as const);
  });
  return `<?xml version="1.0"?>\n<catalog xmlns="${CAT}" updated="2026-11-04T12:00:00Z">${items.join("")}</catalog>`;
};
const catalog = catalogOf();

// The same megabytes of HTML: a block that runs the adoption agency
// (misnested <b>/<i>), implied end tags (<p>, <td>), table insertion modes,
// SVG foreign content, a character reference and CRLF line ends.
const htmlBlock = (n: number): string =>
  `<div class="x"><p>Hello <b>world <i>${n}</b> &amp; more</i></p>` +
  `<table><tr><td>x<td>y</table><svg><rect/></svg></div>\r\n`;
const html = ((): string => {
  const blocks = Arr.unfold({ n: 0, size: 0 }, ({ n, size }) => {
    if (size >= megabytes * 1024 * 1024) return Option.none();
    const block = htmlBlock(n);
    return Option.some([block, { n: n + 1, size: size + block.length }] as const);
  });
  return `<!DOCTYPE html><html><head><title>bench</title></head><body>${blocks.join("")}</body></html>`;
})();

const main = Effect.fn("bench")(function* () {
  yield* Console.log(`input: ${(input.length / 1024 / 1024).toFixed(1)} MB worksheet\n`);

  yield* time("effect-xml SAX (string)", Sax.tokenizeString(input).pipe(Stream.runDrain));
  yield* time(
    "effect-xml SAX (64 KiB chunks)",
    Stream.fromIterable(chunks).pipe(Sax.tokenize(), Stream.runDrain),
  );
  yield* time(
    "effect-xml SAX (bytes)",
    Stream.make(bytes).pipe(Sax.tokenizeBytes(), Stream.runDrain),
  );
  yield* time(
    "effect-xml SAX (dtd internal)",
    Sax.tokenizeString(input, { dtd: "internal" }).pipe(Stream.runDrain),
  );
  yield* time("effect-xml DOM (Xml.parse)", Xml.parse(input));
  yield* time("effect-xml DOM (dtd internal)", Xml.parse(input, { dtd: "internal" }));
  // The worksheet with a DOCTYPE that declares entities, and references to
  // them: the DTD-aware grammars, which a document without one doesn't pay.
  const declared = input
    .replaceAll('s="1"', 's="&s;"')
    .replaceAll("<v>0</v>", "&sd;")
    .replace(
      "<worksheet",
      '<!DOCTYPE worksheet [<!ENTITY s "1"><!ENTITY sd "<v>0</v>">]>\n<worksheet',
    );
  yield* time("effect-xml DOM (DOCTYPE + entities)", Xml.parse(declared, { dtd: "internal" }));
  // A DOCTYPE that declares an entity the body never references, read whole:
  // the DTD-aware text grammar over one large string (#191). The sizes show it
  // is linear.
  const entityDoc = withEntity(input);
  yield* time(
    "effect-xml Sax.forEach (entity)",
    Sax.forEach(entityDoc, () => {}, { dtd: "internal" }),
  );
  yield* time("effect-xml DOM (entity, whole)", Xml.parse(entityDoc, { dtd: "internal" }));
  yield* Effect.forEach(
    [1, 2, 4, 8],
    (mb) => {
      const doc = withEntity(sheet(mb * 1024 * 1024));
      return time(
        `effect-xml Sax.forEach (entity, ${mb} MB)`,
        Sax.forEach(doc, () => {}, { dtd: "internal" }),
        5,
        doc.length,
      );
    },
    { concurrency: 1 },
  );
  yield* time("effect-xml DOM (Xml.parse, recover)", Xml.parse(input, { recover: true }));
  yield* time(
    "effect-xml rows (Sax.select)",
    Stream.make(input).pipe(
      Sax.tokenize(),
      Sax.select("//x:row", { namespaces: { x: SML } }),
      Stream.runDrain,
    ),
  );

  const model = yield* Xsd.compile(worksheetSchema);
  yield* time(
    "effect-xml XSD events (Xsd.validate)",
    Stream.fromIterable(chunks).pipe(Sax.tokenize(), Xsd.validate(model), Stream.runDrain),
  );
  yield* time("effect-xml XSD values (Xsd.parse)", Xsd.parse(model, input));

  // XPath over the parsed worksheet: the even rows' cell values. Compiled
  // once; each run evaluates it against a fresh XDM view of the same DOM (so
  // node handles are built during the run, as for a newly loaded document).
  const sheetDom = yield* Xml.parse(input);
  const rowsQuery = yield* Effect.fromResult(
    XQuery.XPath.compile("//x:row[@r mod 2 = 0]/x:c/x:v", { namespaces: { x: SML } }),
  );
  yield* time(
    "effect-xml XPath (XQuery.evaluate)",
    Effect.suspend(() =>
      XQuery.evaluate(rowsQuery, { context: XQuery.XdmNode.fromDocument(sheetDom) }),
    ),
  );

  // The same queries streamed (`XQuery.stream` over the SAX events of 64 KiB
  // chunks, each row built and queried as it ends), against the DOM: parsing
  // the document and evaluating the query over it, as a caller without
  // streaming would.
  const rowsStream = yield* Effect.fromResult(XQuery.compileStream(rowsQuery));
  yield* time(
    "effect-xml XQuery.stream (rows)",
    Stream.fromIterable(chunks).pipe(Sax.tokenize(), XQuery.stream(rowsStream), Stream.runDrain),
  );
  yield* time(
    "effect-xml XQuery DOM (rows)",
    Effect.flatMap(Xml.parse(input), (dom) => XQuery.evaluate(rowsQuery, { context: dom })),
  );
  const mapQuery = yield* Effect.fromResult(
    XQuery.compile("//x:row ! map { 'r': string(@r), 'cells': array { x:c/x:v ! string() } }", {
      namespaces: { x: SML },
    }),
  );
  const mapStream = yield* Effect.fromResult(XQuery.compileStream(mapQuery));
  yield* time(
    "effect-xml XQuery.stream (row maps)",
    Stream.fromIterable(chunks).pipe(Sax.tokenize(), XQuery.stream(mapStream), Stream.runDrain),
  );
  yield* time(
    "effect-xml XQuery DOM (row maps)",
    Effect.flatMap(Xml.parse(input), (dom) => XQuery.evaluate(mapQuery, { context: dom })),
  );

  // Xml.XPath over the same DOM: a document-wide selection with an attribute
  // predicate, and small lookups compiled once and run from every row (the
  // shape of a configuration lookup, and of XSD identity-constraint fields).
  const cellsPath = Xml.XPath.compile("//x:row/x:c[@t = 's']/x:v", { namespaces: { x: SML } });
  const cellPath = Xml.XPath.compile("x:c[starts-with(@r, 'B')]/x:v", { namespaces: { x: SML } });
  const rowElements = sheetDom.root.elements.flatMap((data) => data.elements);
  if (Result.isSuccess(cellsPath) && Result.isSuccess(cellPath)) {
    const cells = cellsPath.success;
    const cell = cellPath.success;
    yield* timeSync("effect-xml XPath (Xml.XPath.select)", () => {
      Xml.XPath.select(cells, sheetDom);
    });
    yield* timeSync("effect-xml XPath lookups (per row)", () => {
      Arr.forEach(rowElements, (row) => Xml.XPath.first(cell, row));
    });
  }

  // The worksheet again, against its schema with identity constraints: a key
  // over the rows' numbers and, in each row, unique cell references, so the
  // selectors and fields are evaluated once per row and once per cell.
  const keyedModel = yield* Xsd.compile(keyedSchema);
  yield* time(
    "effect-xml XSD identity (Xsd.validate)",
    Stream.fromIterable(chunks).pipe(Sax.tokenize(), Xsd.validate(keyedModel), Stream.runDrain),
  );

  const catalogModel = yield* Xsd.compile(catalogSchema);
  yield* time(
    "effect-xml XSD catalog (Xsd.parse)",
    Xsd.parse(catalogModel, catalog),
    5,
    catalog.length,
  );

  yield* Console.log("");
  yield* time("effect-xml HTML (Html.parseDocument)", Html.parseDocument(html), 5, html.length);
  yield* time("effect-xml HTML (Html.parseFragment)", Html.parseFragment(html), 5, html.length);

  yield* Effect.all(
    [
      compare("saxes (SAX)", optional<SaxesModule>("saxes"), (m) => {
        const p = new m.SaxesParser({ xmlns: true });
        p.on("opentag", () => {});
        p.on("text", () => {});
        p.write(input).close();
      }),
      compare("sax (SAX)", optional<SaxModule>("sax"), (m) => {
        const p = m.parser(true, { xmlns: true });
        p.onopentag = () => {};
        p.write(input).close();
      }),
      compare("htmlparser2 (SAX, xmlMode)", optional<Htmlparser2Module>("htmlparser2"), (m) => {
        const p = new m.Parser({ onopentag: () => {}, ontext: () => {} }, { xmlMode: true });
        p.write(input);
        p.end();
      }),
      compare("easysax (SAX)", optional<EasysaxModule>("easysax"), (m) => {
        const p = new m.default();
        p.on("startNode", () => {});
        p.on("textNode", () => {});
        p.write(input);
        p.end();
      }),
      compare("@eksml/xml (SAX)", optional<EksmlSaxModule>("@eksml/xml/sax"), (m) => {
        const p = m.createSaxParser({ entities: true });
        p.on("openTag", () => {});
        p.on("text", () => {});
        p.write(input);
        p.close();
      }),
      compare("@eksml/xml (DOM)", optional<DomModule>("@eksml/xml/parser"), (m) => {
        m.parse(input, { entities: true });
      }),
      compare("txml (DOM)", optional<DomModule>("txml"), (m) => {
        m.parse(input);
      }),
      compare("fast-xml-parser (DOM)", optional<FxpModule>("fast-xml-parser"), (m) => {
        new m.XMLParser({ ignoreAttributes: false }).parse(input);
      }),
    ],
    { concurrency: 1, discard: true },
  );
});

NodeRuntime.runMain(main());
