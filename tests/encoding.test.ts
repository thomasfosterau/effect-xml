import { assert, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as P from "effect/Predicate";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { Encoding, Html, Sax, Xml } from "../src/index.ts";
import { concatBytes, splitBytes } from "./support/chunks.ts";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const utf16 = (s: string, little: boolean, bom: boolean): Uint8Array => {
  // By UTF-16 code unit (iterating the string would give code points).
  const units = Array.from({ length: s.length }, (_, k) => s.charCodeAt(k));
  const all = bom ? [0xfeff, ...units] : units;
  const out = new Uint8Array(all.length * 2);
  const view = new DataView(out.buffer);
  all.forEach((unit, i) => view.setUint16(i * 2, unit, little));
  return out;
};

const utf32 = (s: string, little: boolean, bom: boolean): Uint8Array => {
  // Never `undefined`: each item of a string's iterator is one whole code point.
  const cps = Array.from(s, (c) => c.codePointAt(0) ?? 0);
  if (bom) cps.unshift(0xfeff);
  const out = new Uint8Array(cps.length * 4);
  const view = new DataView(out.buffer);
  cps.forEach((cp, i) => view.setUint32(i * 4, cp, little));
  return out;
};

const latin1 = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => concatBytes(parts);

const rootText = (bytes: Uint8Array, options?: Xml.ParseBytesOptions) =>
  Xml.parseBytes(bytes, options).pipe(Effect.map((d) => d.root.textContent));

const failure = <E>(effect: Effect.Effect<unknown, E>) =>
  Effect.gen(function* () {
    const r = yield* Effect.result(effect);
    assert(Result.isFailure(r), "expected failure");
    return r.failure;
  });

/** Split bytes into chunks of `size`, to exercise chunk boundaries inside sequences. */
const chunks = splitBytes;

const text = "héllo wörld — 𝄞 ✓";

/** The SAX events of a byte stream delivered as `parts`. */
const tokenizeParts = (parts: ReadonlyArray<Uint8Array>) =>
  Stream.fromIterable(parts).pipe(
    Sax.tokenizeBytes(),
    Stream.runCollect,
    Effect.map((c) => Arr.fromIterable(c)),
  );

/** An HTML page with `charset` in its head and `café` in its body, as source text. */
const htmlPage = (charset: string) =>
  `<!doctype html><html><head>${charset}</head><body><p>caf\xe9</p></body></html>`;

/** Parse an HTML document from bytes and serialize its document element. */
const para = (bytes: Uint8Array, options?: Html.HtmlBytesOptions) =>
  Html.parseDocumentBytes(bytes, options).pipe(
    Effect.map((d) => Html.serialize(d.documentElement)),
  );

describe("XML encoding detection (Appendix F)", () => {
  it.effect("UTF-8 without BOM or declaration", () =>
    Effect.gen(function* () {
      expect(yield* rootText(utf8(`<a>${text}</a>`))).toBe(text);
    }),
  );

  it.effect("UTF-8 with BOM", () =>
    Effect.gen(function* () {
      expect(
        yield* rootText(concat(new Uint8Array([0xef, 0xbb, 0xbf]), utf8(`<a>${text}</a>`))),
      ).toBe(text);
    }),
  );

  [true, false].forEach((little) => {
    const name = little ? "LE" : "BE";
    it.effect(`UTF-16${name} with BOM`, () =>
      Effect.gen(function* () {
        const doc = `<?xml version="1.0" encoding="UTF-16"?><a>${text}</a>`;
        expect(yield* rootText(utf16(doc, little, true))).toBe(text);
      }),
    );

    it.effect(`UTF-16${name} without BOM, recognised from the first bytes`, () =>
      Effect.gen(function* () {
        const doc = `<?xml version="1.0" encoding="UTF-16"?><a>${text}</a>`;
        expect(yield* rootText(utf16(doc, little, false))).toBe(text);
      }),
    );

    it.effect(`UTF-32${name} with and without BOM`, () =>
      Effect.gen(function* () {
        const doc = `<?xml version="1.0" encoding="UTF-32"?><a>${text}</a>`;
        expect(yield* rootText(utf32(doc, little, true))).toBe(text);
        expect(yield* rootText(utf32(doc, little, false))).toBe(text);
      }),
    );
  });

  it.effect("ISO-8859-1 from the declaration, decoded exactly (not as windows-1252)", () =>
    Effect.gen(function* () {
      const doc = latin1(`<?xml version="1.0" encoding="ISO-8859-1"?><a>caf\xe9 \x80</a>`);
      expect(yield* rootText(doc)).toBe("café \x80");
    }),
  );

  it.effect("a legacy multi-byte encoding from the declaration", () =>
    Effect.gen(function* () {
      // "日本" in Shift_JIS.
      const doc = concat(
        utf8(`<?xml version='1.0' encoding='Shift_JIS'?><a>`),
        new Uint8Array([0x93, 0xfa, 0x96, 0x7b]),
        utf8(`</a>`),
      );
      expect(yield* rootText(doc)).toBe("日本");
    }),
  );

  it.effect("an external hint overrides the declaration but not the BOM", () =>
    Effect.gen(function* () {
      const doc = latin1(`<?xml version="1.0" encoding="UTF-8"?><a>caf\xe9</a>`);
      expect(yield* rootText(doc, { encoding: "iso-8859-1" })).toBe("café");
      const bom = utf16(`<a>x</a>`, true, true);
      expect(yield* rootText(bom, { encoding: "iso-8859-1" })).toBe("x");
    }),
  );

  it.effect("invalid UTF-8 is a typed failure, not U+FFFD", () =>
    Effect.gen(function* () {
      const e = yield* failure(
        Xml.parseBytes(concat(utf8("<a>"), new Uint8Array([0xc3, 0x28]), utf8("</a>"))),
      );
      expect(e._tag).toBe("InvalidByteSequence");
    }),
  );

  it.effect("bytes outside US-ASCII are a typed failure when ASCII is declared", () =>
    Effect.gen(function* () {
      const e = yield* failure(
        Xml.parseBytes(latin1(`<?xml version="1.0" encoding="US-ASCII"?><a>\xe9</a>`)),
      );
      assert(P.isTagged(e, "InvalidByteSequence"), "expected InvalidByteSequence");
      expect(e.offset).toBe(44);
    }),
  );

  it.effect("an unknown encoding is UnsupportedEncoding", () =>
    Effect.gen(function* () {
      const e = yield* failure(
        Xml.parseBytes(utf8(`<?xml version="1.0" encoding="x-no-such"?><a/>`)),
      );
      expect(e._tag).toBe("UnsupportedEncoding");
    }),
  );

  it.effect("a declaration contradicting the BOM is UnsupportedEncoding", () =>
    Effect.gen(function* () {
      const doc = concat(
        new Uint8Array([0xef, 0xbb, 0xbf]),
        utf8(`<?xml version="1.0" encoding="UTF-16"?><a/>`),
      );
      expect((yield* failure(Xml.parseBytes(doc)))._tag).toBe("UnsupportedEncoding");
    }),
  );

  it.effect(
    "a declaration contradicting the first bytes of big-endian UTF-16 is UnsupportedEncoding",
    () =>
      Effect.gen(function* () {
        const doc = utf16(`<?xml version="1.0" encoding="UTF-8"?><a/>`, false, true);
        expect((yield* failure(Xml.parseBytes(doc)))._tag).toBe("UnsupportedEncoding");
        expect(
          Encoding.sniffXml(
            utf16(`<?xml version="1.0" encoding="UTF-16"?><a/>`, false, false),
            true,
          ),
        ).toEqual({
          encoding: "utf-16be",
          bomLength: 0,
          source: "declaration",
        });
      }),
  );

  it.effect("a UTF-8 byte order mark with another declared encoding is UnsupportedEncoding", () =>
    Effect.gen(function* () {
      const doc = concat(
        new Uint8Array([0xef, 0xbb, 0xbf]),
        utf8(`<?xml version="1.0" encoding="ISO-8859-1"?><a/>`),
      );
      expect((yield* failure(Xml.parseBytes(doc)))._tag).toBe("UnsupportedEncoding");
    }),
  );

  it.effect("EBCDIC is reported as unsupported", () =>
    Effect.gen(function* () {
      expect(
        (yield* failure(Xml.parseBytes(new Uint8Array([0x4c, 0x6f, 0xa7, 0x94, 0x40]))))._tag,
      ).toBe("UnsupportedEncoding");
    }),
  );

  it("sniffXml reports how the encoding was found", () => {
    expect(Encoding.sniffXml(utf8(`<a/>`), true)).toEqual({
      encoding: "utf-8",
      bomLength: 0,
      source: "default",
    });
    expect(Encoding.sniffXml(utf8(`<?xml version="1.0" encoding="windows-1252"?>`), true)).toEqual({
      encoding: "windows-1252",
      bomLength: 0,
      source: "declaration",
    });
    expect(Encoding.sniffXml(utf8(`<?xml version="1.0" enc`), false)).toBe(Encoding.NeedMore);
  });

  it("sniffXml reads a declaration that runs past its first 4096 characters", () => {
    const declaration = `<?xml version="1.0"${" ".repeat(5000)}encoding="windows-1252"?>`;
    expect(Encoding.sniffXml(utf8(`${declaration}<a/>`), true)).toEqual({
      encoding: "windows-1252",
      bomLength: 0,
      source: "declaration",
    });
    // A large first chunk is read only as far as the declaration needs.
    const body = `<a>${"x".repeat(100_000)}</a>`;
    expect(
      Encoding.sniffXml(utf8(`<?xml version="1.0" encoding="windows-1252"?>${body}`), false),
    ).toEqual({ encoding: "windows-1252", bomLength: 0, source: "declaration" });
  });
});

describe("streaming byte input", () => {
  const cases: ReadonlyArray<[string, Uint8Array]> = [
    ["UTF-8", utf8(`<?xml version="1.0"?><a b="${text}">${text}</a>`)],
    [
      "UTF-16LE",
      utf16(`<?xml version="1.0" encoding="UTF-16"?><a b="${text}">${text}</a>`, true, true),
    ],
    [
      "UTF-16BE",
      utf16(`<?xml version="1.0" encoding="UTF-16"?><a b="${text}">${text}</a>`, false, false),
    ],
    ["UTF-32LE", utf32(`<?xml version="1.0"?><a b="${text}">${text}</a>`, true, false)],
  ];

  it.effect.each(cases)("%s: every chunk size gives the same events", ([_name, bytes]) =>
    Effect.gen(function* () {
      const whole = yield* tokenizeParts([bytes]);
      expect(whole).toContainEqual(expect.objectContaining({ _tag: "Text", data: text }));
      const chunked = yield* Effect.forEach(
        Arr.range(1, 9),
        (size) => tokenizeParts(chunks(bytes, size)),
        { concurrency: 1 },
      );
      expect(chunked).toStrictEqual(Arr.replicate(whole, 9));
    }),
  );

  it.effect.each([
    ["UTF-8", utf8(`<?xml version="1.0"?><a>${text}</a>`)],
    ["UTF-16 with a BOM", utf16(`<a>${text}</a>`, true, true)],
    ["UTF-32", utf32(`<?xml version="1.0" encoding="UTF-32"?><a>${text}</a>`, false, false)],
    ["a declaration past the first window", utf8(`<?xml version="1.0"${" ".repeat(200)}?><a/>`)],
    ["a truncated UTF-8 sequence", concat(utf8(`<a>${text}`), new Uint8Array([0xc3]))],
    ["malformed markup before bad bytes", concat(utf8("<a><<b>"), new Uint8Array([0xc3]))],
    ["an odd trailing UTF-16 byte", concat(utf16("<a/>", false, true), new Uint8Array([0x3c]))],
    ["an unknown declared encoding", utf8(`<?xml version="1.0" encoding="x-no-such"?><a/>`)],
    ["a tiny input", utf8("<a")],
  ] as const)("Xml.parseBytes matches parseBytesStream on one chunk: %s", ([_what, bytes]) =>
    Effect.gen(function* () {
      const whole = yield* Effect.result(Xml.parseBytes(bytes));
      const streamed = yield* Effect.result(Stream.make(bytes).pipe(Xml.parseBytesStream()));
      expect(whole).toStrictEqual(streamed);
    }),
  );

  it.effect("Xml.parseBytesStream", () =>
    Effect.gen(function* () {
      const doc = yield* Stream.fromIterable(chunks(utf16(`<a>${text}</a>`, false, true), 3)).pipe(
        Xml.parseBytesStream(),
      );
      expect(doc.root.textContent).toBe(text);
    }),
  );
});

describe("HTML encoding sniffing (WHATWG)", () => {
  it.effect("defaults to windows-1252", () =>
    Effect.gen(function* () {
      expect(yield* para(latin1(htmlPage("")))).toContain("café");
    }),
  );

  it.effect("<meta charset> in the first 1024 bytes", () =>
    Effect.gen(function* () {
      const doc = concat(utf8(`<!doctype html><meta charset="utf-8"><p>`), utf8("café"));
      expect(yield* para(doc)).toContain("café");
    }),
  );

  it.effect("<meta http-equiv content-type>", () =>
    Effect.gen(function* () {
      const doc = utf8(
        `<meta http-equiv="Content-Type" content="text/html; charset=utf-8"><p>café`,
      );
      expect(yield* para(doc)).toContain("café");
    }),
  );

  it.effect("a meta tag inside a comment is ignored", () =>
    Effect.gen(function* () {
      const doc = latin1(`<!-- <meta charset="utf-8"> --><p>caf\xe9`);
      expect(yield* para(doc)).toContain("café");
    }),
  );

  it.effect("the BOM beats the transport hint, which beats <meta>", () =>
    Effect.gen(function* () {
      const doc = latin1(`<meta charset="utf-8"><p>caf\xe9`);
      expect(yield* para(doc, { encoding: "iso-8859-1" })).toContain("café");
      const bom = concat(new Uint8Array([0xef, 0xbb, 0xbf]), utf8(`<p>café`));
      expect(yield* para(bom, { encoding: "iso-8859-1" })).toContain("café");
    }),
  );

  it.effect("invalid bytes decode to U+FFFD", () =>
    Effect.gen(function* () {
      const doc = concat(utf8(`<meta charset="utf-8"><p>`), new Uint8Array([0xff]));
      expect(yield* para(doc)).toContain("�");
    }),
  );

  it.effect("streaming with a meta charset after the first chunk", () =>
    Effect.gen(function* () {
      const doc = utf8(`<!doctype html><meta charset="utf-8"><p>${"x".repeat(2000)}café</p>`);
      const out = yield* Stream.fromIterable(chunks(doc, 7)).pipe(
        Html.parseDocumentBytesStream(),
        Effect.map((d) => d.documentElement.textContent),
      );
      expect(out.endsWith("café")).toBe(true);
    }),
  );
});
