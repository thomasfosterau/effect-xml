/**
 * Tests of the QT3 conformance harness (`tests/support/qt3.ts`): spec
 * dependencies, assertions checked against the XDM result, error codes,
 * combinators and the engine it runs. The gate itself is `tests/qt3.test.ts`.
 */
import { assert, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import { Xml, XQuery } from "../src/index.ts";
import {
  Assertion,
  check,
  codeMatches,
  type Engine,
  Outcome,
  type Request,
  specApplies,
} from "./support/qt3.ts";

// -----------------------------------------------------------------------------
// The harness itself
// -----------------------------------------------------------------------------

const requestFor = (query: string): Request => ({
  spec: "XQ31",
  query,
  baseUri: Option.none(),
  namespaces: [],
  contextItem: Option.none(),
  variables: [],
  documents: HashMap.empty(),
  collections: HashMap.empty(),
  resources: HashMap.empty(),
  suiteFile: (uri) => Effect.fail(XQuery.xqueryError("FOUT1170", `${uri} is not available`)),
  modules: [],
  decimalFormats: [],
  defaultCollation: Option.none(),
  xpath1Compatibility: false,
});

/** An engine that answers from a table of queries, and records what it was asked. */
const tableEngine = (
  table: Readonly<Record<string, XQuery.Sequence>>,
  asked: Array<Request> = [],
): Engine => ({
  evaluate: (request) => {
    asked.push(request);
    return Effect.fromOption(Option.fromUndefinedOr(table[request.query]), () =>
      XQuery.xqueryError("XPST0003", `unknown query ${request.query}`),
    );
  },
  serialize: (_, result) =>
    Effect.succeed(
      result.map((item) => (XQuery.isAtomic(item) ? XQuery.atomicString(item) : "")).join(" "),
    ),
});

const verdict = (assertion: Assertion, outcome: Outcome, engine: Engine = tableEngine({})) =>
  check(assertion, outcome, { engine, request: requestFor("") });

const value = (...items: ReadonlyArray<XQuery.Item>) => Outcome.Value({ sequence: items });
const raised = (code: string) => Outcome.Raised({ error: XQuery.xqueryError(code, "boom") });
const passes = (v: Option.Option<string>) =>
  assert.isTrue(
    Option.isNone(v),
    Option.getOrElse(v, () => ""),
  );
const fails = (v: Option.Option<string>) =>
  assert.isTrue(Option.isSome(v), "expected the assertion to fail");

const str = (s: string) => XQuery.AtomicValue.string(s);
const int = (n: number) => XQuery.AtomicValue.integer(BigInt(n));

describe("QT3 harness", () => {
  it("spec dependencies: exact versions and `+` ranges", () => {
    expect(specApplies("XQ31", "XQ10+")).toBe(true);
    expect(specApplies("XQ31", "XQ30")).toBe(false);
    expect(specApplies("XQ31", "XP31+")).toBe(false);
    expect(specApplies("XP31", "XP20+ XQ10+")).toBe(true);
    expect(specApplies("XP31", "XP31 XQ31")).toBe(true);
    expect(specApplies("XP31", "XP20 XP30")).toBe(false);
    expect(specApplies("XQ31", "XT30+")).toBe(false);
  });

  it.effect("structural assertions are checked against the XDM result", () =>
    Effect.gen(function* () {
      passes(yield* verdict(Assertion.AssertCount({ count: 0 }), value()));
      fails(yield* verdict(Assertion.AssertCount({ count: 0 }), value(int(1))));
      passes(yield* verdict(Assertion.AssertCount({ count: 2 }), value(int(1), int(2))));
      passes(
        yield* verdict(
          Assertion.AssertBoolean({ expected: true }),
          value(XQuery.AtomicValue.boolean(true)),
        ),
      );
      fails(yield* verdict(Assertion.AssertBoolean({ expected: true }), value(str("true"))));
      passes(
        yield* verdict(
          Assertion.AssertBoolean({ expected: false }),
          value(XQuery.AtomicValue.boolean(false)),
        ),
      );
      passes(
        yield* verdict(
          Assertion.AssertStringValue({ expected: "1 a", normalizeSpace: false }),
          value(int(1), str("a")),
        ),
      );
      passes(
        yield* verdict(
          Assertion.AssertStringValue({ expected: " x  y ", normalizeSpace: true }),
          value(str("x y")),
        ),
      );
      fails(yield* verdict(Assertion.AssertCount({ count: 1 }), raised("FOER0000")));
    }),
  );

  it.effect("error codes: err: local names, EQNames and `*`", () =>
    Effect.gen(function* () {
      passes(yield* verdict(Assertion.Error({ code: "XPTY0004" }), raised("XPTY0004")));
      fails(yield* verdict(Assertion.Error({ code: "XPTY0004" }), raised("FORG0001")));
      passes(yield* verdict(Assertion.Error({ code: "*" }), raised("FORG0001")));
      fails(yield* verdict(Assertion.Error({ code: "*" }), value()));
      expect(
        codeMatches("Q{http://www.example.com/}EXER3141", {
          namespace: Option.some("http://www.example.com/"),
          local: "EXER3141",
        }),
      ).toBe(true);
      expect(codeMatches("Q{}USER9999", { namespace: Option.none(), local: "USER9999" })).toBe(
        true,
      );
    }),
  );

  it.effect("combinators", () =>
    Effect.gen(function* () {
      const empty = Assertion.AssertCount({ count: 0 });
      const one = Assertion.AssertCount({ count: 1 });
      passes(yield* verdict(Assertion.AnyOf({ of: [one, empty] }), value()));
      fails(yield* verdict(Assertion.AllOf({ of: [one, empty] }), value()));
      passes(
        yield* verdict(
          Assertion.AnyOf({ of: [Assertion.Error({ code: "FOAR0001" }), empty] }),
          raised("FOAR0001"),
        ),
      );
      passes(yield* verdict(Assertion.Not({ of: one }), value()));
      fails(yield* verdict(Assertion.Not({ of: empty }), value()));
    }),
  );

  it.effect("a test the engine can't run never passes, whatever it expects", () =>
    Effect.gen(function* () {
      const broken = Outcome.Broken({ reason: "not implemented" });
      fails(yield* verdict(Assertion.Error({ code: "*" }), broken));
      fails(yield* verdict(Assertion.Not({ of: Assertion.AssertCount({ count: 0 }) }), broken));
    }),
  );

  it.effect("assert-xml compares nodes by expanded name, merging text and sorting attributes", () =>
    Effect.gen(function* () {
      const doc = yield* Xml.parse(`<a xmlns="u" y="2" x="1">t<![CDATA[u]]><b/></a>`);
      const node = XQuery.XdmNode.fromDocument(doc);
      passes(
        yield* verdict(
          Assertion.AssertXml({
            expected: `<a xmlns="u" x="1" y="2">tu<b/></a>`,
            ignorePrefixes: false,
          }),
          value(node),
        ),
      );
      passes(
        yield* verdict(
          Assertion.AssertXml({
            expected: `<p:a xmlns:p="u" x="1" y="2">tu<p:b/></p:a>`,
            ignorePrefixes: true,
          }),
          value(node),
        ),
      );
      fails(
        yield* verdict(
          Assertion.AssertXml({ expected: `<a x="1" y="2">tu<b/></a>`, ignorePrefixes: true }),
          value(node),
        ),
      );
      passes(
        yield* verdict(
          Assertion.AssertXml({ expected: "1 2", ignorePrefixes: false }),
          value(int(1), int(2)),
        ),
      );
    }),
  );

  it.effect("XPath assertions are evaluated by the engine with $result bound", () =>
    Effect.gen(function* () {
      const asked: Array<Request> = [];
      const engine = tableEngine(
        {
          "$result instance of xs:integer": [XQuery.AtomicValue.boolean(true)],
          "deep-equal($result, (1))": [XQuery.AtomicValue.boolean(false)],
          "(1, 2)": [int(2), int(1)],
          "deep-equal($a, $b)": [XQuery.AtomicValue.boolean(true)],
        },
        asked,
      );
      passes(yield* verdict(Assertion.AssertType({ type: "xs:integer" }), value(int(1)), engine));
      const [first] = asked;
      assert.isDefined(first);
      const bound = Arr.findFirst(first.variables, (v) => v.name === "result");
      assert(Option.isSome(bound));
      expect(bound.value.value).toEqual([int(1)]);
      fails(yield* verdict(Assertion.AssertDeepEq({ expr: "1" }), value(int(1)), engine));
      passes(
        yield* verdict(
          Assertion.AssertPermutation({ expr: "(1, 2)" }),
          value(int(1), int(2)),
          engine,
        ),
      );
      fails(yield* verdict(Assertion.Assert({ expr: "unknown()" }), value(int(1)), engine));
    }),
  );
});
