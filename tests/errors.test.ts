import { assert, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as P from "effect/Predicate";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { Sax, Xml } from "../src/index.ts";

const parseError = (input: string, options?: Xml.ParseOptions) =>
  Effect.gen(function* () {
    const r = yield* Xml.parse(input, options).pipe(Effect.result);
    assert(Result.isFailure(r), `expected ${input} to fail to parse`);
    return r.failure;
  });

describe("typed errors", () => {
  it.effect("mismatched end tag", () =>
    Effect.gen(function* () {
      const e = yield* parseError(`<a></b>`);
      expect(e._tag).toBe("MismatchedEndTag");
      assert(P.isTagged(e, "MismatchedEndTag"));
      expect(e.expected).toBe("a");
      expect(e.actual).toBe("b");
    }),
  );

  it.effect("unexpected end tag with empty stack", () =>
    Effect.gen(function* () {
      const e = yield* parseError(`</a>`);
      expect(e._tag).toBe("UnexpectedEndTag");
    }),
  );

  it.effect("unclosed element at EOF is a structural error", () =>
    Effect.gen(function* () {
      const e = yield* parseError(`<a><b>`);
      expect(e._tag).toBe("InvalidDocumentStructure");
      expect(e.message).toContain("never closed");
    }),
  );

  it.effect("EOF in the middle of a tag is a lex error", () =>
    Effect.gen(function* () {
      const e = yield* parseError(`<a><b`);
      expect(e._tag).toBe("UnexpectedEndOfInput");
    }),
  );

  it.effect.each([
    [`<a x="1>`, 8],
    [`<a x='1>`, 8],
    [`<a x="1" y="2>text`, 18],
  ] as const)(
    "an unclosed attribute quote in %s is reported where the input ends (#157)",
    ([input, offset]) =>
      Effect.gen(function* () {
        const fromParse = yield* parseError(input);
        assert(P.isTagged(fromParse, "UnexpectedEndOfInput"));
        expect(fromParse.position.offset).toBe(offset);
        const fromDtd = yield* parseError(input, { dtd: "internal" });
        assert(P.isTagged(fromDtd, "UnexpectedEndOfInput"));
        expect(fromDtd.position.offset).toBe(offset);
        const chunked = yield* Stream.fromIterable(input).pipe(
          Sax.tokenize(),
          Stream.runDrain,
          Effect.flip,
        );
        assert(P.isTagged(chunked, "UnexpectedEndOfInput"));
        expect(chunked.position.offset).toBe(offset);
      }),
  );

  it.effect("multiple root elements", () =>
    Effect.gen(function* () {
      const e = yield* parseError(`<a/><b/>`);
      expect(e._tag).toBe("InvalidDocumentStructure");
      expect(e.message).toContain("multiple root");
    }),
  );

  it.effect("a DOCTYPE inside the root element is not well-formed (#118)", () =>
    Effect.gen(function* () {
      const e = yield* parseError(`<w><!DOCTYPE html PUBLIC 'a' 'b'><a/></w>`);
      expect(e._tag).toBe("InvalidDocumentStructure");
      expect(e.message).toContain("at 1:4: a document type declaration is only allowed once");
    }),
  );

  it.effect("HTML still reads a stray DOCTYPE in content, which tree construction ignores", () =>
    Effect.gen(function* () {
      const events = yield* Sax.collect(`<w><!DOCTYPE html><a/></w>`, { mode: "html" });
      expect(events.map((e) => e._tag)).toStrictEqual([
        "StartElement",
        "Doctype",
        "StartElement",
        "EndElement",
      ]);
    }),
  );

  it.effect("character data outside the root", () =>
    Effect.gen(function* () {
      const e = yield* parseError(`text<a/>`);
      expect(e._tag).toBe("InvalidDocumentStructure");
    }),
  );

  it.effect("duplicate attribute", () =>
    Effect.gen(function* () {
      const e = yield* parseError(`<a x="1" x="2"/>`);
      expect(e._tag).toBe("DuplicateAttribute");
    }),
  );

  it.effect("unbound namespace prefix", () =>
    Effect.gen(function* () {
      const e = yield* parseError(`<x:a/>`);
      expect(e._tag).toBe("UnboundNamespacePrefix");
      assert(P.isTagged(e, "UnboundNamespacePrefix"));
      expect(e.prefix).toBe("x");
    }),
  );

  it.effect("errors carry a usable message and position", () =>
    Effect.gen(function* () {
      const e = yield* parseError(`<a>\n</b>`);
      expect(e.message).toBeTypeOf("string");
      expect(e.message).toContain("2:");
    }),
  );

  it.effect("malformed declarations are positioned MalformedDeclaration errors", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, string, string]> = [
        [
          `<?xml version="1.0" standalone="maybe"?><a/>`,
          "1:33",
          `expected "yes" or "no", found "m"`,
        ],
        [`<?xml encoding="UTF-8"?><a/>`, "1:7", `expected "version", found "e"`],
        [
          `<?xml version="1.0"encoding="UTF-8"?><a/>`,
          "1:20",
          `expected whitespace or "?>", found "e"`,
        ],
        [`<a><? pi?></a>`, "1:6", `expected processing instruction target, found " "`],
        [`<a><?XML x?></a>`, "1:6", `expected processing instruction target, found "X"`],
        [`<!doctype a><a/>`, "1:3", `expected "DOCTYPE", found "d"`],
        [`<!DOCTYPE a PUBLIC "p"><a/>`, "1:23", `expected whitespace, found ">"`],
        [`<!DOCTYPE\n  a junk><a/>`, "2:5", `expected "[" or ">", found "j"`],
      ];
      yield* Effect.forEach(
        cases,
        ([input, at, detail]) =>
          Sax.collect(input).pipe(
            Effect.result,
            Effect.map((r) => {
              assert(
                Result.isFailure(r) && P.isTagged(r.failure, "MalformedDeclaration"),
                `expected MalformedDeclaration for ${input}`,
              );
              expect(r.failure.message).toContain(`at ${at}: ${detail}`);
            }),
          ),
        { concurrency: 1, discard: true },
      );
    }),
  );

  it.effect("strict mode rejects a bare '<'", () =>
    Effect.gen(function* () {
      const r = yield* Sax.collect("<a>1 < 2</a>").pipe(Effect.result);
      expect(r._tag).toBe("Failure");
      assert(Result.isFailure(r));
      expect(r.failure._tag).toBe("UnexpectedCharacter");
    }),
  );
});
