import { assert, describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import { Sax, Xml } from "../src/index.ts";

const parseError = async (input: string, options?: Xml.ParseOptions) => {
  const r = await Effect.runPromise(Xml.parse(input, options).pipe(Effect.result));
  assert(Result.isFailure(r), `expected ${input} to fail to parse`);
  return r.failure;
};

describe("typed errors", () => {
  test("mismatched end tag", async () => {
    const e = await parseError(`<a></b>`);
    expect(e._tag).toBe("MismatchedEndTag");
    assert(Predicate.isTagged(e, "MismatchedEndTag"));
    expect(e.expected).toBe("a");
    expect(e.actual).toBe("b");
  });

  test("unexpected end tag with empty stack", async () => {
    const e = await parseError(`</a>`);
    expect(e._tag).toBe("UnexpectedEndTag");
  });

  test("unclosed element at EOF is a structural error", async () => {
    const e = await parseError(`<a><b>`);
    expect(e._tag).toBe("InvalidDocumentStructure");
    expect(e.message).toContain("never closed");
  });

  test("EOF in the middle of a tag is a lex error", async () => {
    const e = await parseError(`<a><b`);
    expect(e._tag).toBe("UnexpectedEndOfInput");
  });

  test("multiple root elements", async () => {
    const e = await parseError(`<a/><b/>`);
    expect(e._tag).toBe("InvalidDocumentStructure");
    expect(e.message).toContain("multiple root");
  });

  test("character data outside the root", async () => {
    const e = await parseError(`text<a/>`);
    expect(e._tag).toBe("InvalidDocumentStructure");
  });

  test("duplicate attribute", async () => {
    const e = await parseError(`<a x="1" x="2"/>`);
    expect(e._tag).toBe("DuplicateAttribute");
  });

  test("unbound namespace prefix", async () => {
    const e = await parseError(`<x:a/>`);
    expect(e._tag).toBe("UnboundNamespacePrefix");
    assert(Predicate.isTagged(e, "UnboundNamespacePrefix"));
    expect(e.prefix).toBe("x");
  });

  test("errors carry a usable message and position", async () => {
    const e = await parseError(`<a>\n</b>`);
    expect(e.message).toBeTypeOf("string");
    expect(e.message).toContain("2:");
  });

  test("malformed declarations are positioned MalformedDeclaration errors", async () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      [`<?xml version="1.0" standalone="maybe"?><a/>`, "1:33", `expected "yes" or "no", found "m"`],
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
    await Effect.runPromise(
      Effect.forEach(
        cases,
        ([input, at, detail]) =>
          Sax.collect(input).pipe(
            Effect.result,
            Effect.map((r) => {
              assert(
                Result.isFailure(r) && Predicate.isTagged(r.failure, "MalformedDeclaration"),
                `expected MalformedDeclaration for ${input}`,
              );
              expect(r.failure.message).toContain(`at ${at}: ${detail}`);
            }),
          ),
        { concurrency: 1, discard: true },
      ),
    );
  });

  test("strict mode rejects a bare '<'", async () => {
    const r = await Effect.runPromise(Sax.collect("<a>1 < 2</a>").pipe(Effect.result));
    expect(r._tag).toBe("Failure");
    assert(Result.isFailure(r));
    expect(r.failure._tag).toBe("UnexpectedCharacter");
  });
});
