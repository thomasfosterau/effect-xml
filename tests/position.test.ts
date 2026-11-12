import { assert, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Eq from "effect/Equal";
import * as Hash from "effect/Hash";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import {
  advance,
  makePosition,
  MismatchedEndTag,
  origin,
  Sax,
  showPosition,
  Xml,
} from "../src/index.ts";
import { at } from "./support/narrow.ts";
import { plain } from "./support/plain.ts";

const isMismatchedEndTag = Schema.is(MismatchedEndTag);

const collect = (input: string) => Sax.collect(input);

describe("Position — lazy lines and columns", () => {
  it.effect("a span resolves its ends on read", () =>
    Effect.gen(function* () {
      const evs = yield* collect("<a>\r\n  <b x='1'/>\n</a>");
      const b = at(evs, 2);
      expect(b._tag).toBe("StartElement");
      expect(b.span.start.offset).toBe(7);
      expect(b.span.start.line).toBe(2);
      expect(b.span.start.column).toBe(3);
      expect(showPosition(b.span.end)).toBe("2:13");
      // Each end is made once.
      expect(b.span.start).toBe(b.span.start);
    }),
  );

  it.effect("JSON shows offset, line and column", () =>
    Effect.gen(function* () {
      const evs = yield* collect("<a>\nhi</a>");
      expect(plain(at(evs, 1).span)).toStrictEqual({
        start: { offset: 3, line: 1, column: 4 },
        end: { offset: 6, line: 2, column: 3 },
      });
    }),
  );

  it.effect("only offset is an own property", () =>
    Effect.gen(function* () {
      const evs = yield* collect("<a>hi</a>");
      const span = at(evs, 1).span;
      expect(R.keys(span)).toStrictEqual([]);
      expect(R.keys(span.start)).toStrictEqual(["offset"]);
      expect({ ...span.start }).toStrictEqual({ offset: 3 });
    }),
  );

  it.effect("Eq.equals compares resolved positions", () =>
    Effect.gen(function* () {
      const [one, two] = yield* Effect.all([collect("<a>\nx</a>"), collect("<a>\nx</a>")], {
        concurrency: 1,
      });
      expect(Eq.equals(one, two)).toBe(true);
      expect(Hash.hash(at(one, 1).span)).toBe(Hash.hash(at(two, 1).span));
      // Same offsets, different lines.
      const [lf, sp] = yield* Effect.all([collect("<a>\n<b/></a>"), collect("<a> <b/></a>")], {
        concurrency: 1,
      });
      expect(at(lf, 2).span.start.offset).toBe(at(sp, 2).span.start.offset);
      expect(Eq.equals(at(lf, 2).span, at(sp, 2).span)).toBe(false);
      // A parser's position is not a plain object.
      expect(Eq.equals(at(one, 0).span.start, { offset: 0, line: 1, column: 1 })).toBe(false);
      expect(Eq.equals(at(one, 0).span.start, origin)).toBe(true);
    }),
  );

  it.effect("errors carry a plain position, encoded as before", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Xml.parse("<a>\n</b>"));
      assert(isMismatchedEndTag(error));
      expect(error.position).toStrictEqual({ offset: 4, line: 2, column: 1 });
      expect(R.keys(error.position)).toStrictEqual(["offset", "line", "column"]);
      expect((yield* Schema.encodeEffect(MismatchedEndTag)(error)).position).toStrictEqual({
        offset: 4,
        line: 2,
        column: 1,
      });
      expect(error.message).toContain("at 2:1");
    }),
  );

  it("origin, makePosition and advance", () => {
    expect(plain(origin)).toStrictEqual({ offset: 0, line: 1, column: 1 });
    const next = advance(advance(origin, "a"), "\n");
    expect([next.offset, next.line, next.column]).toStrictEqual([2, 2, 1]);
    expect(Eq.equals(next, makePosition({ offset: 2, line: 2, column: 1 }))).toBe(true);
    expect(showPosition({ offset: 9, line: 3, column: 4 })).toBe("3:4");
  });
});
