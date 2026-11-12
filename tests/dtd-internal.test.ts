/**
 * `dtd: "internal"` reads with the grammars without a DTD, and the scanner,
 * until a DOCTYPE declares an entity (#99). The differential check: against
 * the DTD-aware grammars from the first token (`tokenizeEagerly`, as before),
 * the same events with the same spans, and the same failure, whole and in
 * chunks, strictly and recovering, through `Sax.tokenize` (the lexer) and
 * `Sax.forEach` (the direct read, then the lexer); and on a document without
 * a DOCTYPE, the same as `dtd: "ignore"`. Over the W3C XML conformance suite
 * (read as `tests/xmlconf.test.ts` reads it), every XML document under
 * `tests/fixtures`, and the generated documents of `tests/support/documents.ts`.
 */
import { expect } from "vite-plus/test";
import { layer } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Encoding, Sax, type SaxError } from "../src/index.ts";
import { decodeOptions } from "../src/Sax.ts";
import { splitEvery } from "./support/chunks.ts";
import { documents } from "./support/documents.ts";
import { tokenizeEagerly } from "./support/eager.ts";
import * as Fixtures from "./support/fixtures.ts";
import { readManifest } from "./support/xmlconf.ts";

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * An outcome as text, one JSON line per event with its span resolved (or
 * the failure, with its position): comparing strings keeps the large
 * fixtures quick, and a mismatch still shows as a line diff.
 */
const outcome = (exit: Exit.Exit<Iterable<Sax.SaxEvent>, SaxError>): string =>
  Exit.isSuccess(exit)
    ? Arr.fromIterable(exit.value)
        .map((ev) => toJson(ev))
        .join("\n")
    : Option.match(Cause.findErrorOption(exit.cause), {
        onNone: () => `died: ${String(Cause.squash(exit.cause))}`,
        onSome: (error) => `failed: ${error.message}\n${toJson(error)}`,
      });

/** `Sax.tokenize`'s outcome for `doc` in chunks of `size`. */
const tokenize = (doc: string, options: Sax.SaxOptions, size: number) =>
  Effect.map(
    Effect.exit(
      Stream.fromIterable(splitEvery(doc, size)).pipe(Sax.tokenize(options), Stream.runCollect),
    ),
    outcome,
  );

/** The DTD-aware grammars' outcome for `doc` in chunks of `size`. */
const eagerly = (doc: string, options: Sax.SaxOptions, size: number) =>
  outcome(tokenizeEagerly(splitEvery(doc, size), options));

/** `Sax.forEach`'s outcome for `doc`. */
const each = (doc: string, options: Sax.SaxOptions) =>
  Effect.gen(function* () {
    const events: Array<Sax.SaxEvent> = [];
    const exit = yield* Effect.exit(Sax.forEach(doc, (ev) => events.push(ev), options));
    return outcome(Exit.map(exit, () => events));
  });

const internal = { dtd: "internal" } as const;
const variants: ReadonlyArray<Sax.SaxOptions> = [
  internal,
  { dtd: "internal", recover: true },
  { dtd: "internal", positions: false },
];

/** Whether `doc` might have a DOCTYPE (the grammar reads the keyword in any case). */
const hasDoctype = (doc: string): boolean => /<!doctype/i.test(doc);

/**
 * Every check, for `doc` whole and at the chunk sizes `sizes`, with each of
 * `only` (by default every variant); the outcome read whole, strictly. A
 * document over 8 KiB is read "whole" in 8 KiB chunks by the lexer
 * (`Sax.forEach` still reads it whole): the DTD-aware grammars search the
 * rest of the chunk for the next `&` once per token, quadratic in a chunk's
 * length where none follows.
 */
const agree = (doc: string, sizes: ReadonlyArray<number>, only = variants) =>
  Effect.gen(function* () {
    const whole = Math.max(1, Math.min(doc.length, 8192));
    yield* Effect.forEach(
      only,
      (options) =>
        Effect.gen(function* () {
          const expected = eagerly(doc, options, whole);
          expect(yield* tokenize(doc, options, whole), doc).toBe(expected);
          yield* Effect.forEach(
            sizes,
            (size) =>
              Effect.map(tokenize(doc, options, size), (got) =>
                expect(got, `${doc} in chunks of ${size}`).toBe(eagerly(doc, options, size)),
              ),
            { concurrency: 1, discard: true },
          );
          expect(yield* each(doc, options), `${doc} (Sax.forEach)`).toBe(expected);
        }),
      { concurrency: 1, discard: true },
    );
    return yield* tokenize(doc, internal, whole);
  });

/** On documents without a DOCTYPE, `dtd: "internal"` reads as `"ignore"` does; how many there were. */
const asIgnore = (docs: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const without = docs.filter((doc) => !hasDoctype(doc));
    yield* Effect.forEach(
      without,
      (doc) =>
        Effect.gen(function* () {
          const whole = Math.max(1, Math.min(doc.length, 8192));
          expect(yield* tokenize(doc, internal, whole), `${doc} (as dtd: "ignore")`).toBe(
            yield* tokenize(doc, {}, whole),
          );
        }),
      { concurrency: 1, discard: true },
    );
    return without.length;
  });

/** How many of the outcomes are failures. */
const failures = (outcomes: ReadonlyArray<string>): number =>
  outcomes.filter((o) => o.startsWith("failed:")).length;

// DOCTYPEs that declare nothing, entities (with and without markup, and
// external ones), attribute defaults only, and the references to them.
const doctypes = [
  "",
  "<!DOCTYPE root>",
  '<!-- c --><?pi x?>\n<!DOCTYPE root SYSTEM "r.dtd">\n',
  "<!DOCTYPE root [<!ATTLIST root a CDATA 'd'><!ATTLIST row b NMTOKENS ' x  y '>]>",
  '<!DOCTYPE root [<!ENTITY e "x&amp;y">]>',
  '<!DOCTYPE root [<!ENTITY m "<b>&e;</b>"><!ENTITY e "x">]>',
  '<!DOCTYPE root [<!ENTITY ext SYSTEM "e.xml"><!ENTITY é "acute">]>',
  '<!DOCTYPE root [<!ENTITY % p "x"><!-- only a parameter entity -->]>',
  "<!DOCTYPE root [<!ENTITY bad>]>",
];
const references = ["", "&e;", "&m;", "&ext;", "&é;", "&a-b;", "<row b='&e;'/>", "&#65;&lt;"];

const generated = documents(99, 2400);
const declared = generated.slice(0, 600).map((doc, i) => {
  const doctype = doctypes[i % doctypes.length] ?? "";
  const reference = references[Math.floor(i / doctypes.length) % references.length] ?? "";
  return doctype + doc.replace("<root>", `<root>${reference}`);
});

const FIXTURES = new URL("./fixtures/", import.meta.url);
const XMLCONF = new URL("./fixtures/xmlconf/", import.meta.url);

/** The text of a fixture's bytes, as `Sax.tokenizeBytes` decodes it (none if it does not decode). */
const decoded = (bytes: Uint8Array): Option.Option<string> => {
  const decoder = new Encoding.ByteDecoder(decodeOptions(undefined));
  const first = decoder.write(bytes);
  const rest = decoder.end();
  return P.isString(first) && P.isString(rest) ? Option.some(first + rest) : Option.none();
};

/** The XML documents under `tests/fixtures` (outside xmlconf, read from its manifest). */
const fixtureFiles = Effect.fn("fixtureFiles")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(FIXTURES);
  const files = yield* fs.readDirectory(root, { recursive: true });
  return Arr.sort(
    files.filter((f) => /\.(?:xml|xsd|dtd)$/.test(f) && !f.startsWith("xmlconf")),
    (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0),
  );
});

layer(Fixtures.layer)(
  'dtd: "internal" without the DTD-aware grammars until a declaration (#99)',
  (it) => {
    it.effect(
      "agrees on the generated documents, whole and chunked",
      () =>
        Effect.gen(function* () {
          const outcomes = yield* Effect.forEach(
            generated,
            (doc, i) => agree(doc, i < 400 ? [1, 3, 7] : [5]),
            { concurrency: 1 },
          );
          // Documents that parse, and ones that fail.
          expect(failures(outcomes)).toBeGreaterThan(900);
          expect(outcomes.length - failures(outcomes)).toBeGreaterThan(400);
          expect(yield* asIgnore(generated)).toBeGreaterThan(2000);
        }),
      120_000,
    );

    it.effect(
      "agrees on documents with DOCTYPEs and references, whole and chunked",
      () =>
        Effect.gen(function* () {
          expect(declared.filter(hasDoctype).length).toBeGreaterThan(500);
          const outcomes = yield* Effect.forEach(declared, (doc) => agree(doc, [1, 2, 7, 64]), {
            concurrency: 1,
          });
          expect(failures(outcomes)).toBeGreaterThan(200);
          expect(outcomes.length - failures(outcomes)).toBeGreaterThan(25);
        }),
      120_000,
    );

    it.effect(
      "agrees on the W3C XML conformance suite, whole and chunked",
      () =>
        Effect.gen(function* () {
          const texts = yield* readManifest(XMLCONF).pipe(
            Effect.flatMap((tests) =>
              Effect.forEach(tests, (t) => Fixtures.readBytes(XMLCONF, t.uri), { concurrency: 8 }),
            ),
          );
          const docs = Arr.getSomes(texts.map(decoded));
          expect(docs.length).toBeGreaterThan(1700);
          expect(docs.filter(hasDoctype).length).toBeGreaterThan(1000);
          const outcomes = yield* Effect.forEach(docs, (doc) => agree(doc, [1, 7, 256]), {
            concurrency: 1,
          });
          expect(failures(outcomes)).toBeGreaterThan(800);
          expect(outcomes.length - failures(outcomes)).toBeGreaterThan(700);
          expect(yield* asIgnore(docs)).toBeGreaterThan(200);
        }),
      300_000,
    );

    it.effect(
      "agrees on the XML documents under tests/fixtures",
      () =>
        Effect.gen(function* () {
          const texts = yield* fixtureFiles().pipe(
            Effect.flatMap((files) =>
              Effect.forEach(files, (f) => Fixtures.readBytes(FIXTURES, f), { concurrency: 8 }),
            ),
          );
          const docs = Arr.getSomes(texts.map(decoded));
          expect(docs.length).toBeGreaterThan(600);
          const outcomes = yield* Effect.forEach(
            docs,
            (doc) =>
              doc.length <= 8192
                ? agree(doc, [7, 1024])
                : // (The large ones, most of the bytes, strictly only.)
                  agree(doc, doc.length <= 65_536 ? [1024] : [], [internal]),
            { concurrency: 1 },
          );
          expect(outcomes.length - failures(outcomes)).toBeGreaterThan(500);
          expect(yield* asIgnore(docs)).toBeGreaterThan(500);
        }),
      300_000,
    );

    it.effect("keeps the DTD-aware grammars for an entity table with names they alone read", () =>
      Effect.gen(function* () {
        // The grammars without a DTD read an entity name as ASCII letters and
        // digits; with one, up to a delimiter: `&a-b;` decodes only with a DTD.
        const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "a-b": "!" };
        const doc = "<root>&a-b;</root>";
        const options = { dtd: "internal", entities } as const;
        expect(yield* tokenize(doc, options, doc.length)).toBe(eagerly(doc, options, doc.length));
        expect(yield* each(doc, options)).toBe(eagerly(doc, options, doc.length));
        expect(yield* tokenize(doc, options, 1)).toBe(eagerly(doc, options, 1));
        expect(yield* tokenize(doc, options, doc.length)).not.toBe(
          yield* tokenize(doc, { entities }, doc.length),
        );
      }),
    );
  },
);
