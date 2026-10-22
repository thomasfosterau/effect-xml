/**
 * Byte input: encoding detection and decoding.
 *
 * XML documents carry their encoding in the bytes themselves. {@link sniffXml}
 * implements XML 1.0 Appendix F: a byte order mark wins, then an external hint
 * (a MIME `charset`, per RFC 7303), then the `encoding` of the XML declaration,
 * read in whichever family (UTF-8/ASCII-compatible, UTF-16, UTF-32) the first
 * four bytes point to, and finally UTF-8. Decoding is strict: a byte sequence
 * that is invalid in the detected encoding is a typed
 * {@link InvalidByteSequence}, never a silent U+FFFD.
 *
 * HTML follows the WHATWG encoding-sniffing algorithm instead
 * ({@link sniffHtml}): byte order mark, transport hint, a `<meta charset>`
 * prescan of the first 1024 bytes, then windows-1252. As browsers do, HTML is
 * decoded leniently, with U+FFFD for invalid bytes.
 *
 * {@link decode} is the streaming stage both use: it buffers just enough of the
 * input to detect the encoding, then decodes chunk by chunk, carrying
 * multi-byte sequences that straddle a chunk boundary over to the next chunk.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import {
  InvalidByteSequence,
  LimitExceeded,
  UnsupportedEncoding,
  type DecodeError,
} from "./Error.ts";

/** `f(0) … f(n - 1)`; unlike `Arr.makeBy`, which clamps `n` to at least 1, empty for `n = 0`. */
const times = <A>(n: number, f: (i: number) => A): Array<A> =>
  Array.from({ length: n }, (_, i) => f(i));

// -----------------------------------------------------------------------------
// Detection
// -----------------------------------------------------------------------------

/** A TextDecoder for any label; `None` for a label it doesn't know (the constructor throws a RangeError). */
const makeTextDecoder: (
  label: string,
  options?: ConstructorParameters<typeof TextDecoder>[1],
) => Option.Option<TextDecoder> = Option.liftThrowable(
  (label: string, options?: ConstructorParameters<typeof TextDecoder>[1]) =>
    new TextDecoder(label, options),
);

/**
 * How the encoding was determined.
 *
 * @since 0.3.0
 * @category models
 */
export type EncodingSource = "bom" | "hint" | "declaration" | "meta" | "default";

/**
 * The result of sniffing: the encoding, and how many leading bytes are a byte order mark.
 *
 * @since 0.3.0
 * @category models
 */
export interface Detected {
  /** A canonical encoding name (a WHATWG name, or `utf-32le`/`utf-32be`). */
  readonly encoding: string;
  readonly bomLength: number;
  readonly source: EncodingSource;
}

/**
 * Sniffing needs more bytes than are available yet.
 *
 * @since 0.3.0
 * @category models
 */
export const NeedMore = { _tag: "NeedMore" } as const;
/**
 * The {@link NeedMore} value's type.
 *
 * @since 0.3.0
 * @category models
 */
export type NeedMore = typeof NeedMore;

/**
 * Options for {@link sniffXml} and {@link sniffHtml}.
 *
 * @since 0.3.0
 * @category options
 */
export interface SniffOptions {
  /**
   * An external encoding hint, such as the `charset` of a `Content-Type`. It
   * overrides the document's own declaration, but not a byte order mark.
   */
  readonly encoding?: string | undefined;
}

const bomOf = (b: Uint8Array): Detected | null => {
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0xfe && b[3] === 0xff)
    return { encoding: "utf-32be", bomLength: 4, source: "bom" };
  if (b[0] === 0xff && b[1] === 0xfe && b[2] === 0x00 && b[3] === 0x00)
    return { encoding: "utf-32le", bomLength: 4, source: "bom" };
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)
    return { encoding: "utf-8", bomLength: 3, source: "bom" };
  if (b[0] === 0xfe && b[1] === 0xff) return { encoding: "utf-16be", bomLength: 2, source: "bom" };
  if (b[0] === 0xff && b[1] === 0xfe) return { encoding: "utf-16le", bomLength: 2, source: "bom" };
  return null;
};

const startsWith = (b: Uint8Array, prefix: ReadonlyArray<number>): boolean =>
  prefix.every((x, i) => b[i] === x);

type Family = "utf-8" | "utf-16le" | "utf-16be" | "utf-32le" | "utf-32be";

/** The encoding family the first bytes of an XML document (`<?xml` or `<`) point to. */
const familyOf = (b: Uint8Array): Family | "ebcdic" => {
  if (startsWith(b, [0x00, 0x00, 0x00, 0x3c])) return "utf-32be";
  if (startsWith(b, [0x3c, 0x00, 0x00, 0x00])) return "utf-32le";
  if (startsWith(b, [0x00, 0x3c, 0x00, 0x3f])) return "utf-16be";
  if (startsWith(b, [0x3c, 0x00, 0x3f, 0x00])) return "utf-16le";
  if (startsWith(b, [0x4c, 0x6f, 0xa7, 0x94])) return "ebcdic";
  return "utf-8";
};

const unitSize = (family: Family): number =>
  family.startsWith("utf-32") ? 4 : family.startsWith("utf-16") ? 2 : 1;

/**
 * Read code units of a family as characters, enough to parse the (ASCII-only)
 * XML declaration. Non-ASCII units become U+FFFD; they cannot occur in a
 * well-formed declaration.
 */
const readAscii = (b: Uint8Array, family: Family, from: number): string => {
  const size = unitSize(family);
  const little = family.endsWith("le");
  const count = Math.max(0, Math.floor((b.length - from) / size));
  const byte = (i: number): number => b[i] ?? 0;
  // The code unit at `i`, from `size` bytes in the family's byte order.
  const unitAt = (i: number): number =>
    size === 1
      ? byte(i)
      : size === 2
        ? little
          ? byte(i) + byte(i + 1) * 0x100
          : byte(i) * 0x100 + byte(i + 1)
        : little
          ? byte(i) + byte(i + 1) * 0x100 + byte(i + 2) * 0x10000 + byte(i + 3) * 0x1000000
          : byte(i) * 0x1000000 + byte(i + 1) * 0x10000 + byte(i + 2) * 0x100 + byte(i + 3);
  return times(count, (n) => {
    const unit = unitAt(from + n * size);
    return unit < 0x80 ? String.fromCharCode(unit) : "\uFFFD";
  }).join("");
};

/** How far into the input the XML declaration may run before we stop looking. */
const DECLARATION_WINDOW = 4096;

const declarationEncoding =
  /^<\?xml[ \t\r\n][^?>]*?\bencoding[ \t\r\n]*=[ \t\r\n]*(["'])([A-Za-z][A-Za-z0-9._-]*)\1/;

/**
 * Canonical name of an encoding label, or null when it is not one we can decode.
 *
 * @since 0.3.0
 * @category sniffing
 */
export const canonicalEncoding = (label: string): string | null => {
  const l = label.trim().toLowerCase();
  if (l === "utf-32" || l === "ucs-4" || l === "iso-10646-ucs-4") return "utf-32";
  if (l === "utf-16" || l === "iso-10646-ucs-2" || l === "ucs-2" || l === "csunicode")
    return "utf-16";
  if (l === "utf-32le" || l === "utf-32be") return l;
  if (HashSet.has(LATIN1_LABELS, l)) return "iso-8859-1";
  if (HashSet.has(ASCII_LABELS, l)) return "us-ascii";
  return Option.getOrNull(Option.map(makeTextDecoder(l), (d) => d.encoding));
};

// WHATWG folds these into windows-1252, which differs from them in 0x80-0x9F.
// XML means what they say, so they are decoded exactly.
const LATIN1_LABELS = HashSet.make(
  "iso-8859-1",
  "iso_8859-1",
  "iso8859-1",
  "latin1",
  "l1",
  "iso-ir-100",
  "cp819",
  "ibm819",
  "csisolatin1",
  "iso_8859-1:1987",
);
const ASCII_LABELS = HashSet.make(
  "us-ascii",
  "ascii",
  "ansi_x3.4-1968",
  "iso-ir-6",
  "iso646-us",
  "us",
  "ibm367",
  "cp367",
  "csascii",
);

const isUtf16 = (e: string): boolean => e === "utf-16" || e === "utf-16le" || e === "utf-16be";
const isUtf32 = (e: string): boolean => e === "utf-32" || e === "utf-32le" || e === "utf-32be";

/** Whether a declared encoding agrees with the family the bytes are in (and the byte order mark, if any). */
const agrees = (declared: string, family: Family, bom: boolean): boolean => {
  // A UTF-8 byte order mark means UTF-8, not just "ASCII-compatible".
  if (bom && family === "utf-8") return declared === "utf-8";
  if (family.startsWith("utf-16")) return declared === "utf-16" || declared === family;
  if (family.startsWith("utf-32")) return declared === "utf-32" || declared === family;
  return !isUtf16(declared) && !isUtf32(declared);
};

const unsupported = (encoding: string, reason: string) =>
  new UnsupportedEncoding({ encoding, reason });

const resolveHint = (hint: string, family: Family): Detected | UnsupportedEncoding => {
  const encoding = canonicalEncoding(hint);
  if (encoding === null) return unsupported(hint, "unknown encoding label");
  if (encoding === "utf-16" || encoding === "utf-32") {
    // The byte order comes from the first bytes, as for a declaration.
    if (!family.startsWith(encoding))
      return unsupported(hint, `the document's first bytes indicate ${family}`);
    return { encoding: family, bomLength: 0, source: "hint" };
  }
  return { encoding, bomLength: 0, source: "hint" };
};

/**
 * Detect the encoding of an XML document from its first bytes (XML 1.0
 * Appendix F). Returns {@link NeedMore} until enough bytes are available;
 * pass `final` once `head` is the whole input.
 *
 * @since 0.3.0
 * @category sniffing
 */
export const sniffXml = (
  head: Uint8Array,
  final: boolean,
  options?: SniffOptions,
): Detected | NeedMore | UnsupportedEncoding => {
  if (head.length < 4 && !final) return NeedMore;
  const bom = bomOf(head);
  // SAFETY: `bomOf` only ever reports one of the five `Family` encodings.
  const family: Family | "ebcdic" = bom !== null ? (bom.encoding as Family) : familyOf(head);
  if (family === "ebcdic") return unsupported("EBCDIC", "EBCDIC encodings are not supported");
  if (bom === null && options?.encoding !== undefined) return resolveHint(options.encoding, family);

  // Read the declaration in the detected family, once it is complete.
  const text = readAscii(head, family, bom?.bomLength ?? 0);
  if (!final && text.length < 6 && text === "<?xml".slice(0, text.length)) return NeedMore;
  if (!/^<\?xml[ \t\r\n]/.test(text))
    return bom ?? { encoding: family, bomLength: 0, source: "default" };
  const end = text.indexOf("?>");
  if (end === -1 && !final && head.length < DECLARATION_WINDOW) return NeedMore;
  const match = declarationEncoding.exec(end === -1 ? text : text.slice(0, end));
  if (match === null) {
    // No encoding declared: UTF-8, or UTF-16/32 recognised from the bytes.
    return bom ?? { encoding: family, bomLength: 0, source: "default" };
  }
  // The pattern's second group is the label; it is always present on a match.
  const [, , label = ""] = match;
  const declared = canonicalEncoding(label);
  if (declared === null) return unsupported(label, "unknown encoding label");
  if (!agrees(declared, family, bom !== null)) {
    const what = bom !== null ? "the byte order mark" : "the document's first bytes";
    return unsupported(
      label,
      `the declared encoding contradicts ${what}, which indicate ${family}`,
    );
  }
  if (bom !== null) return bom;
  if (family !== "utf-8") return { encoding: family, bomLength: 0, source: "declaration" };
  return { encoding: declared, bomLength: 0, source: "declaration" };
};

/** How much of an HTML document the `<meta>` prescan looks at. */
const PRESCAN_WINDOW = 1024;

/**
 * Detect the encoding of an HTML document (the WHATWG encoding-sniffing
 * algorithm): byte order mark, transport hint, `<meta charset>` prescan of the
 * first 1024 bytes, then windows-1252.
 *
 * @since 0.3.0
 * @category sniffing
 */
export const sniffHtml = (
  head: Uint8Array,
  final: boolean,
  options?: SniffOptions,
): Detected | NeedMore | UnsupportedEncoding => {
  if (head.length < 3 && !final) return NeedMore;
  // WHATWG knows only the UTF-8 and UTF-16 byte order marks.
  if (startsWith(head, [0xef, 0xbb, 0xbf]))
    return { encoding: "utf-8", bomLength: 3, source: "bom" };
  if (startsWith(head, [0xfe, 0xff])) return { encoding: "utf-16be", bomLength: 2, source: "bom" };
  if (startsWith(head, [0xff, 0xfe])) return { encoding: "utf-16le", bomLength: 2, source: "bom" };
  if (options?.encoding !== undefined) {
    const hint = htmlEncoding(options.encoding);
    if (hint === null) return unsupported(options.encoding, "unknown encoding label");
    return { encoding: hint, bomLength: 0, source: "hint" };
  }
  if (head.length < PRESCAN_WINDOW && !final) return NeedMore;
  const meta = prescan(head.subarray(0, PRESCAN_WINDOW));
  if (meta !== null) return { encoding: meta, bomLength: 0, source: "meta" };
  return { encoding: "windows-1252", bomLength: 0, source: "default" };
};

/** An encoding label as HTML resolves it (WHATWG "get an encoding"). */
const htmlEncoding = (label: string): string | null =>
  Option.getOrNull(Option.map(makeTextDecoder(label.trim()), (d) => d.encoding));

/**
 * The WHATWG `<meta>` prescan, simplified to a scan over the bytes as Latin-1:
 * comments are skipped, and the first `<meta>` with a usable `charset`, or an
 * `http-equiv="content-type"` with a `content` naming one, decides.
 */
const prescan = (bytes: Uint8Array): string | null => {
  // At most PRESCAN_WINDOW bytes, so one `fromCharCode` call takes them all.
  const text = String.fromCharCode(...bytes);
  const tag = /<!--[\s\S]*?-->|<meta(?=[\s/])([^>]*)>?/gi;
  return Option.getOrNull(
    Arr.findFirst(Arr.fromIterable(text.matchAll(tag)), (m) =>
      m[1] === undefined ? Option.none() : Option.fromNullishOr(metaEncoding(m[1])),
    ),
  );
};

/** The encoding one `<meta>` tag's attributes declare, if it declares a usable one. */
const metaEncoding = (attributes: string): string | null => {
  const attr = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"?|'([^']*)'?|([^\s>]*)))?/g;
  // The first occurrence of an attribute wins.
  const attrs = Arr.reduce(
    Arr.fromIterable(attributes.matchAll(attr)),
    HashMap.empty<string, string>(),
    (acc, a) => {
      const name = (a[1] ?? "").toLowerCase();
      return HashMap.has(acc, name) ? acc : HashMap.set(acc, name, a[2] ?? a[3] ?? a[4] ?? "");
    },
  );
  const charset = HashMap.get(attrs, "charset");
  const content = HashMap.get(attrs, "content");
  const label = Option.isSome(charset)
    ? charset.value
    : Option.getOrUndefined(HashMap.get(attrs, "http-equiv"))?.toLowerCase() === "content-type" &&
        Option.isSome(content)
      ? charsetFromContent(content.value)
      : null;
  if (label === null) return null;
  const encoding = htmlEncoding(label);
  if (encoding === null) return null;
  // A document that got this far in ASCII can't be UTF-16 (WHATWG prescan).
  if (encoding === "utf-16le" || encoding === "utf-16be") return "utf-8";
  if (encoding === "x-user-defined") return "windows-1252";
  return encoding;
};

/** WHATWG "extracting a character encoding from a meta element". */
const charsetFromContent = (content: string): string | null => {
  const m = /charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;"']+))/i.exec(content);
  return m === null ? null : (m[1] ?? m[2] ?? m[3] ?? null);
};

// -----------------------------------------------------------------------------
// Decoders
// -----------------------------------------------------------------------------

/** A stateful decoder: `decode` returns the text of the bytes so far, or the byte offset of invalid input. */
interface Decoder {
  decode(bytes: Uint8Array, final: boolean): string | number;
}

/** TextDecoder, with the failing chunk's starting offset as the error offset. */
const textDecoder = (decoder: TextDecoder): Decoder => {
  let offset = 0;
  // A fatal TextDecoder throws a TypeError on invalid input.
  const decodeChunk = Option.liftThrowable((bytes: Uint8Array, final: boolean) =>
    decoder.decode(bytes, { stream: !final }),
  );
  return {
    decode(bytes, final) {
      return Option.match(decodeChunk(bytes, final), {
        onNone: () => offset,
        onSome: (out) => {
          offset += bytes.length;
          return out;
        },
      });
    },
  };
};

/** ISO-8859-1 (exactly, not windows-1252) or strict US-ASCII. */
const singleByte = (max: number): Decoder => {
  let offset = 0;
  return {
    decode(bytes) {
      const bad = bytes.findIndex((b) => b > max);
      if (bad !== -1) return offset + bad;
      // `fromCharCode` in slices of 8192, under the engines' argument-count limit.
      const out = times(Math.ceil(bytes.length / 8192), (n) =>
        String.fromCharCode(...bytes.subarray(n * 8192, (n + 1) * 8192)),
      ).join("");
      offset += bytes.length;
      return out;
    },
  };
};

/** UTF-32, which TextDecoder doesn't support. */
const utf32 = (little: boolean): Decoder => {
  let offset = 0;
  let carry = new Uint8Array(0);
  return {
    decode(bytes, final) {
      const all = carry.byteLength === 0 ? bytes : concat(carry, bytes);
      const whole = all.byteLength - (all.byteLength % 4);
      if (final && whole !== all.byteLength) return offset + whole;
      const view = new DataView(all.buffer, all.byteOffset, whole);
      const codePoints = times(whole / 4, (n) => view.getUint32(n * 4, little));
      const bad = codePoints.findIndex((cp) => cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff));
      if (bad !== -1) return offset + bad * 4;
      // `fromCodePoint` in slices of 8192, under the engines' argument-count limit.
      const out = times(Math.ceil(codePoints.length / 8192), (n) =>
        String.fromCodePoint(...codePoints.slice(n * 8192, (n + 1) * 8192)),
      ).join("");
      offset += whole;
      carry = all.slice(whole);
      return out;
    },
  };
};

/** The encodings decoded here rather than by TextDecoder. */
interface OwnDecoders {
  readonly [encoding: string]: () => Decoder;
}
const OWN_DECODERS: OwnDecoders = {
  "iso-8859-1": () => singleByte(0xff),
  "us-ascii": () => singleByte(0x7f),
  "utf-32le": () => utf32(true),
  "utf-32be": () => utf32(false),
};

/**
 * The decoder for a canonical encoding name. Sniffing only reports names that
 * `canonicalEncoding` / TextDecoder accept, so the TextDecoder always exists.
 */
const decoderFor = (encoding: string, fatal: boolean): Decoder => {
  const own = OWN_DECODERS[encoding];
  if (own !== undefined) return own();
  return Option.match(makeTextDecoder(encoding, { fatal, ignoreBOM: true }), {
    onNone: (): Decoder => ({ decode: () => 0 }),
    onSome: textDecoder,
  });
};

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

// -----------------------------------------------------------------------------
// Streaming
// -----------------------------------------------------------------------------

/**
 * Options for {@link decode} and {@link decodeBytes}.
 *
 * @since 0.3.0
 * @category options
 */
export interface DecodeOptions extends SniffOptions {
  /** `"xml"` (default) sniffs per XML 1.0 Appendix F and decodes strictly; `"html"` per WHATWG, leniently. */
  readonly mode?: "xml" | "html" | undefined;
  /** Fail with {@link LimitExceeded} once the input is longer than this many bytes. */
  readonly maxTotalBytes?: number | undefined;
}

/** @internal The decoding state machine behind {@link decode}. */
export class ByteDecoder {
  private head: Uint8Array = new Uint8Array(0);
  private decoder: Decoder | null = null;
  private encoding = "";
  private total = 0;
  /** Bytes dropped as a byte order mark, so error offsets count from the start of the input. */
  private skipped = 0;

  private readonly options: DecodeOptions;

  constructor(options: DecodeOptions = {}) {
    this.options = options;
  }

  /** The detected encoding, once known. */
  get detected(): string | null {
    return this.decoder === null ? null : this.encoding;
  }

  write(bytes: Uint8Array): string | DecodeError | LimitExceeded {
    this.total += bytes.length;
    const max = this.options.maxTotalBytes ?? Infinity;
    if (this.total > max) return new LimitExceeded({ limit: "maxTotalBytes", max, position: null });
    return this.decoder === null
      ? this.sniff(concat(this.head, bytes), false)
      : this.run(bytes, false);
  }

  end(): string | DecodeError {
    return this.decoder === null ? this.sniff(this.head, true) : this.run(new Uint8Array(0), true);
  }

  private sniff(head: Uint8Array, final: boolean): string | DecodeError {
    const sniffer = this.options.mode === "html" ? sniffHtml : sniffXml;
    const found = sniffer(head, final, this.options);
    if (found instanceof UnsupportedEncoding) return found;
    if ("_tag" in found) {
      this.head = head;
      return "";
    }
    this.head = new Uint8Array(0);
    this.encoding = found.encoding;
    this.skipped = found.bomLength;
    const decoder = decoderFor(found.encoding, this.options.mode !== "html");
    this.decoder = decoder;
    return this.runWith(decoder, head.subarray(found.bomLength), final);
  }

  private run(bytes: Uint8Array, final: boolean): string | DecodeError {
    // Only called once sniffing has chosen a decoder.
    return this.decoder === null ? "" : this.runWith(this.decoder, bytes, final);
  }

  private runWith(decoder: Decoder, bytes: Uint8Array, final: boolean): string | DecodeError {
    const out = decoder.decode(bytes, final);
    return Predicate.isNumber(out)
      ? new InvalidByteSequence({ encoding: this.encoding, offset: out + this.skipped })
      : out;
  }
}

/**
 * Decode a stream of bytes into a stream of text, detecting the encoding from
 * the input (see {@link sniffXml} and {@link sniffHtml}). Chunks may split
 * multi-byte sequences anywhere.
 *
 * @since 0.3.0
 * @category decoding
 */
export const decode =
  (options?: DecodeOptions) =>
  <E, R>(
    input: Stream.Stream<Uint8Array, E, R>,
  ): Stream.Stream<string, E | DecodeError | LimitExceeded, R> =>
    Stream.suspend(() => {
      const decoder = new ByteDecoder(options);
      const lift = (out: string | DecodeError | LimitExceeded) =>
        Predicate.isString(out) ? Effect.succeed(out) : Effect.fail(out);
      const body = input.pipe(Stream.mapEffect((chunk) => lift(decoder.write(chunk))));
      const tail = Stream.fromEffect(Effect.suspend(() => lift(decoder.end())));
      return Stream.concat(body, tail).pipe(Stream.filter(Str.isNonEmpty));
    });

/**
 * Decode a complete byte array into text, detecting the encoding.
 *
 * @since 0.3.0
 * @category decoding
 */
export const decodeBytes = (
  bytes: Uint8Array,
  options?: DecodeOptions,
): Effect.Effect<string, DecodeError | LimitExceeded> =>
  Effect.suspend(() => {
    const decoder = new ByteDecoder(options);
    const first = decoder.write(bytes);
    if (!Predicate.isString(first)) return Effect.fail(first);
    const rest = decoder.end();
    return Predicate.isString(rest) ? Effect.succeed(first + rest) : Effect.fail(rest);
  });
