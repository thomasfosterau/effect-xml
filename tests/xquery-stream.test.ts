import { describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { Sax, Xml, XQuery } from "../src/index.ts";
import { splitEvery } from "./support/chunks.ts";
import { failure, success } from "./support/narrow.ts";

const X = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const namespaces = { x: X };

const sheet =
  `<?xml version="1.0"?>` +
  `<worksheet xmlns="${X}" xmlns:r="urn:r" xml:lang="en"><sheetData>` +
  Array.from(
    { length: 6 },
    (_, i) =>
      `<row r="${i + 1}"${i % 2 ? ' hidden="1"' : ""}>` +
      `<c r="A${i + 1}" t="s"><v>${i}</v></c><c r="B${i + 1}"><v>${i * 1.5}</v></c>` +
      `<!-- row ${i + 1} --><?pi ${i}?></row>`,
  ).join("") +
  `</sheetData></worksheet>`;

/** Nested matches: `s` inside `s`, with text and CDATA between. */
const nested = `<a xmlns:p="urn:p"><s n="1">x<s n="2"><t>one</t><s n="3"><t>two</t></s></s><![CDATA[y]]><t>three</t></s><b><s n="4"/></b></a>`;

/** An item in a form that compares by value: its adaptive serialization, and a node's kind. */
const canonical = (item: XQuery.Item): string => {
  const kind = XQuery.isNode(item) ? `${item.kind} ` : "";
  const out = Effect.runSync(
    XQuery.evaluate("serialize($x, map { 'method': 'adaptive' })", { variables: { x: item } }),
  );
  const [s] = out;
  return kind + (s !== undefined && XQuery.isAtomic(s) ? XQuery.atomicString(s) : "?");
};

/** The `err:` local name of an error from a stream, which must be an `XQueryError`. */
const codeOf = (error: { readonly _tag: string }): string =>
  Predicate.isTagged(error, "XQueryError") && error instanceof XQuery.XQueryError
    ? error.code.local
    : "not an XQueryError";

const viaDom = (doc: string, query: string, options: XQuery.StreamOptions = {}) =>
  Effect.runSync(
    XQuery.evaluate(query, { ...options, context: Effect.runSync(Xml.parse(doc)) }),
  ).map(canonical);

const streamed = (
  chunks: ReadonlyArray<string>,
  query: string | XQuery.Query | XQuery.StreamQuery,
  options: XQuery.StreamOptions = {},
) =>
  Stream.fromIterable(chunks).pipe(
    Sax.tokenize(),
    XQuery.stream(query, options),
    Stream.runCollect,
    Effect.map((items) => Array.from(items, canonical)),
  );

const sizes = [1, 2, 3, 5, 8, 13, 64, Infinity];

/** Streamed results for every chunk size equal the DOM evaluation's. */
const expectSame = async (doc: string, query: string, options: XQuery.StreamOptions = {}) => {
  const expected = viaDom(doc, query, options);
  await Effect.runPromise(
    Effect.forEach(
      sizes,
      (size) =>
        streamed(size === Infinity ? [doc] : splitEvery(doc, size), query, options).pipe(
          Effect.map((items) => expect(items).toEqual(expected)),
        ),
      { concurrency: 1, discard: true },
    ),
  );
  return expected;
};

const notStreamable = (query: string) => {
  const error = failure(
    XQuery.compileStream(query, { namespaces }),
    `expected ${query} not to be streamable`,
  );
  expect(error.code).toEqual(XQuery.NotStreamableCode);
  expect(error.code.namespace).toBe(XQuery.ImplementationNamespace);
  return error;
};

const streamingB = (doc: string) =>
  Effect.runPromise(
    Effect.result(Stream.make(doc).pipe(Sax.tokenize(), XQuery.stream("//b"), Stream.runCollect)),
  );

const withNs = { compile: { namespaces } };

describe("XQuery.stream", () => {
  test.each([
    "//x:row",
    "/x:worksheet/x:sheetData/x:row/@r",
    "x:worksheet/x:sheetData/x:row[@r > 2]",
    "//x:row[not(@hidden = '1')]/x:c[starts-with(@r, 'B')]/x:v/string()",
    "//x:row ! map { 'r': string(@r), 'cells': array { x:c/x:v ! string() } }",
    "//x:row[2]",
    "//x:c[1]/@r",
    "/x:worksheet/x:sheetData/x:row[position() < 3]/@r",
    "//x:row[@hidden][2]/@r",
    "//x:row[x:c/x:v = '3']",
    "//x:row[x:c][@r mod 2 = 0]/@r",
    "//*:row[local-name() = 'row' and namespace-uri() = '" + X + "']/@r",
    "//element(x:row)/x:c/x:v",
    "//x:sheetData/descendant::x:c/@r",
    "//x:row/self::x:row/@r",
    "//x:row[@r = 1]/descendant-or-self::*",
    "//x:row ! (@r, count(x:c), sum(x:c/x:v))",
    "//x:v/text()",
    "//x:row/comment()",
    "//x:row/processing-instruction()",
    "//x:row ! in-scope-prefixes(.)",
    "//x:row ! lang('en')",
    "//x:row[1] ! serialize(.)",
    "//x:row//x:v",
    "//x:row/node()",
    "//x:row ! <r n='{@r}'>{x:c[1]}</r>",
    "//x:row ! x:c ! @r ! string()",
    "//x:row/x:c[x:v > 3]/@r",
    "//x:row[@r = (1, 3)]",
    ".//x:row[3]/x:c/@r",
  ])("%s", async (query) => {
    const expected = await expectSame(sheet, query, withNs);
    expect(expected.length).toBeGreaterThan(0);
  });

  test.each([
    "//s",
    "//s/@n",
    "//s/t",
    "//s//t",
    "//s ! t ! string()",
    "//s[t]/@n",
    "//s[1]/@n",
    "//s ! string()",
    "//s/s",
    "/a/s/descendant-or-self::s/@n",
    "//s[t]//t",
    "//s[t]/descendant::t ! string()",
  ])("nested matches: %s", async (query) => {
    await expectSame(nested, query);
  });

  test("variables, XPath queries and a prolog", async () => {
    await expectSame(sheet, "//x:row[@r = $n]/x:c/@r", {
      ...withNs,
      variables: { n: XQuery.AtomicValue.integer(4n) },
    });
    const xpath = success(XQuery.XPath.compile("//x:row[@r > 4]/@r", { namespaces }));
    const viaXPath = await Effect.runPromise(streamed([sheet], xpath));
    expect(viaXPath).toEqual(viaDom(sheet, "//x:row[@r > 4]/@r", withNs));
    const prolog = `declare namespace x = "${X}";
      declare variable $twice := 2;
      declare function local:f($row) { $row/@r * $twice };
      //x:row ! local:f(.)`;
    expect(await expectSame(sheet, prolog)).toEqual(["2", "4", "6", "8", "10", "12"]);
  });

  test("a compiled stream query runs on any number of streams", async () => {
    const compiled = success(XQuery.compileStream("//x:row/@r", { namespaces }));
    const first = await Effect.runPromise(streamed([sheet], compiled));
    const second = await Effect.runPromise(streamed(splitEvery(sheet, 3), compiled));
    expect(second).toEqual(first);
    expect(first).toHaveLength(6);
  });

  test("resources come through the Resolver", async () => {
    const lookup = XQuery.XdmNode.fromDocument(Effect.runSync(Xml.parse("<k>!</k>")));
    const resolver = XQuery.staticResolver({ documents: { "urn:k": lookup } });
    const out = await Effect.runPromise(
      streamed([sheet], "//x:row[@r < 3] ! concat(@r, doc('urn:k')/k)", withNs).pipe(
        Effect.provideService(XQuery.Resolver, resolver),
      ),
    );
    expect(out).toEqual(['"1!"', '"2!"']);
  });

  test.each([
    "//x:row[last()]",
    "count(//x:row)",
    "//x:row/..",
    "//x:row ! position()",
    "//text()",
    "//@r",
    "/",
    "//x:row ! root()",
    "//x:row ! /x:worksheet",
    "//x:row[doc('urn:d')]",
    "//x:row[x:c][1]",
    "descendant::x:row[1]",
    "//x:row/following-sibling::x:row",
    "//x:row ! generate-id()",
    "(//x:row, //x:c)",
    "declare context item := .; //x:row",
    "declare variable $n := count(//x:row); //x:row",
    "declare function local:up($n) { $n/.. }; //x:row ! local:up(.)",
  ])("not streamable: %s", (query) => {
    const error = notStreamable(query);
    expect(error.description.length).toBeGreaterThan(0);
  });

  test("the error says where", () => {
    expect(notStreamable("//x:row[last()]").offset).toBe(8);
    expect(notStreamable("//x:row/..").offset).toBe(8);
  });

  test("a query that isn't streamable fails the stream", async () => {
    const r = await Effect.runPromise(Effect.result(streamed([sheet], "//x:row[last()]", withNs)));
    expect(codeOf(failure(r))).toBe("NotStreamable");
    const syntax = await Effect.runPromise(Effect.result(streamed([sheet], "//x:row[")));
    expect(codeOf(failure(syntax))).toBe("XPST0003");
  });

  test("dynamic errors fail the stream after the items before them", async () => {
    const seen: Array<string> = [];
    const r = await Effect.runPromise(
      Effect.result(
        Stream.make(`<a><b n="1"/><b n="2"/><b n="x"/><b n="3"/></a>`).pipe(
          Sax.tokenize(),
          XQuery.stream("//b ! xs:integer(@n)"),
          Stream.runForEach((item) => Effect.sync(() => seen.push(canonical(item)))),
        ),
      ),
    );
    expect(codeOf(failure(r))).toBe("FORG0001");
    expect(seen).toEqual(["1", "2"]);
  });

  test("errors in selection predicates fail the stream", async () => {
    const r = await Effect.runPromise(
      Effect.result(
        Stream.make(`<a><b n="1"/><b n="x"/></a>`).pipe(
          Sax.tokenize(),
          XQuery.stream("//b[xs:integer(@n) > 0]/@n"),
          Stream.runCollect,
        ),
      ),
    );
    expect(codeOf(failure(r))).toBe("FORG0001");
  });

  test("well-formedness errors still surface", async () => {
    expect(failure(await streamingB(`<a><b></a>`))._tag).toBe("MismatchedEndTag");
    expect(failure(await streamingB(`<a><b/>`))._tag).toBe("InvalidDocumentStructure");
    expect(failure(await streamingB(`<a><q:b/></a>`))._tag).toBe("UnboundNamespacePrefix");
  });

  test("a large sheet streams through", async () => {
    const rows = 20_000;
    const big = `<sheet>${Array.from({ length: rows }, (_, i) => `<row r="${i}"><v>${i}</v></row>`).join("")}</sheet>`;
    let total = 0n;
    await Effect.runPromise(
      Stream.make(big).pipe(
        Sax.tokenize(),
        XQuery.stream("//row ! xs:integer(v)"),
        Stream.runForEach((item) =>
          Effect.sync(() => {
            if (XQuery.isAtomic(item) && Predicate.isBigInt(item.value)) total += item.value;
          }),
        ),
      ),
    );
    expect(total).toBe(BigInt((rows * (rows - 1)) / 2));
  });

  test("compileStream takes a compiled query", () => {
    const query = success(XQuery.compile("//row ! string(@r)"));
    expect(Result.isSuccess(XQuery.compileStream(query))).toBe(true);
  });
});
