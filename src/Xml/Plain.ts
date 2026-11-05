/**
 * Plain XML trees: elements as plain objects, text as strings.
 *
 * {@link parsePlain} reads a document as strictly as `Xml.parse` with
 * `namespaces: false` (the same well-formedness checks, the same failures)
 * into the lightest tree it can: a {@link PlainElement} is a plain object
 * with the element's name as written, its attributes by name and its
 * children, and character data (CDATA sections included) is strings, with
 * adjacent runs joined. Comments, processing instructions and the DOCTYPE
 * are left out. With none of the DOM's classes, names or methods, it builds
 * about twice as fast as `Xml.parse`: for reading data out of documents
 * rather than editing, querying or writing them back.
 *
 * @since 0.3.0
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import {
  DuplicateAttribute,
  InvalidDocumentStructure,
  MismatchedEndTag,
  type SaxError,
  UnexpectedEndTag,
} from "../Error.ts";
import { exactly } from "../internal/exact.ts";
import {
  type Attributes,
  policy,
  positionAt,
  readLeniently,
  type Visitor,
} from "../internal/lenient.ts";
import { type Chunks, decodeChunks, runChunks } from "../internal/tokenizer.ts";
import type { Limits } from "../Limits.ts";
import { origin, type Position } from "../Position.ts";
import {
  type Attribute,
  decodeOptions,
  type ResolvedOptions,
  resolveSaxOptions,
  type SaxEvent,
} from "../Sax.ts";

/**
 * An element of a plain tree: its name as written (`prefix:local`), its
 * attributes by name as written, and its children.
 *
 * @since 0.3.0
 * @category models
 */
export interface PlainElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: ReadonlyArray<PlainNode>;
}

/**
 * A node of a plain tree: an element, or a run of character data.
 *
 * @since 0.3.0
 * @category models
 */
export type PlainNode = PlainElement | string;

/**
 * Options for {@link parsePlain}: the SAX options that apply to XML, and an
 * external encoding hint for bytes.
 *
 * @since 0.3.0
 * @category options
 */
export interface PlainOptions {
  /** Named entity table override. */
  readonly entities?: Record<string, string> | undefined;
  /** Whitespace handling for text (default `"preserve"`). */
  readonly whitespace?: "preserve" | "collapse" | undefined;
  /** Drop whitespace-only text (default `false`). */
  readonly dropWhitespaceOnlyText?: boolean | undefined;
  /** Resource limits; the ones left out keep their defaults (see {@link Limits}). */
  readonly limits?: Partial<Limits> | undefined;
  /** Interpret the DOCTYPE internal subset (see `Sax.SaxOptions.dtd`); default `"ignore"`. */
  readonly dtd?: "ignore" | "internal" | undefined;
  /** Bytes only: an external encoding hint (see `Sax.SaxBytesOptions.encoding`). */
  readonly encoding?: string | undefined;
  /**
   * With `false`, read leniently, as `Sax.forEach` does (see
   * `Sax.ForEachOptions.strict`): about twice as fast again, for documents
   * known to be well-formed. A well-formed document gives the same tree;
   * tags must still balance and there must be one root. Default `true`.
   */
  readonly strict?: boolean | undefined;
}

/** The children, or attributes, of the (many) elements with none: shared (never written to). */
const NO_CHILDREN: ReadonlyArray<PlainNode> = [];
const NO_ATTRIBUTES: Readonly<Record<string, string>> = {};

const isWhitespace = (s: string): boolean => /^\s*$/.test(s);

/**
 * Folds SAX events (strict reading), or what a lenient pass reads (as its
 * {@link Visitor}), into a plain tree; each step returns its failure, or
 * `null`. A step's position is the event's, or a lenient pass's offset,
 * made a position only for a failure.
 */
class PlainBuilder implements Visitor {
  /** The open elements' names, attributes, and where their children start in {@link nodes}. */
  private readonly names: Array<string> = [];
  private readonly attributes: Array<Readonly<Record<string, string>>> = [];
  private readonly froms: Array<number> = [];
  /** The children of the open elements, each element's after its parent's. */
  private readonly nodes: Array<PlainNode> = [];
  private count = 0;
  private root: PlainElement | undefined = undefined;
  /** Lenient reading: the input offsets are into, and the whitespace policy. */
  private readonly input: string;
  private readonly opts: ResolvedOptions | undefined;

  constructor(input = "", opts?: ResolvedOptions) {
    this.input = input;
    this.opts = opts;
  }

  // A `switch`, not a `$match` table: this runs once per event (see `vite.config.ts`).
  accept(ev: SaxEvent): SaxError | null {
    switch (ev._tag) {
      case "StartElement": {
        const attributes = Arr.isReadonlyArrayEmpty(ev.attributes)
          ? NO_ATTRIBUTES
          : record(ev.name, ev.attributes);
        if (attributes instanceof DuplicateAttribute) return attributes;
        return this.open(ev.name, attributes, ev.selfClosing, ev.span.start);
      }
      case "EndElement":
        return this.close(ev.name, ev.span.start);
      case "Text":
      case "CData":
        return this.addText(ev.data, ev.span.start);
      default:
        // Comments, processing instructions, the declaration and DOCTYPE.
        return null;
    }
  }

  // The lenient pass's steps (see `internal/lenient.ts`).

  start(
    name: string,
    attributes: Attributes,
    count: number,
    selfClosing: boolean,
    at: number,
  ): SaxError | null {
    const record = count === 0 ? NO_ATTRIBUTES : leniently(attributes, count);
    return this.open(name, record, selfClosing, at);
  }

  end(name: string, at: number): SaxError | null {
    return this.close(name, at);
  }

  text(data: string, at: number): SaxError | null {
    const opts = this.opts;
    const kept =
      opts === undefined ? data : policy(data, opts.whitespace, opts.dropWhitespaceOnlyText);
    return kept === null ? null : this.addText(kept, at);
  }

  cdata(data: string, at: number): SaxError | null {
    return this.addText(data, at);
  }

  comment(): SaxError | null {
    return null;
  }

  pi(): SaxError | null {
    return null;
  }

  declaration(): SaxError | null {
    return null;
  }

  /** The position of a step's `at`. */
  private where(at: Position | number): Position {
    return Predicate.isNumber(at) ? positionAt(this.input, at) : at;
  }

  private open(
    name: string,
    attributes: Readonly<Record<string, string>>,
    selfClosing: boolean,
    at: Position | number,
  ): SaxError | null {
    if (selfClosing) return this.append({ name, attributes, children: NO_CHILDREN }, at);
    this.names.push(name);
    this.attributes.push(attributes);
    this.froms.push(this.count);
    return null;
  }

  private close(name: string, at: Position | number): SaxError | null {
    const open = this.names.pop();
    const attributes = this.attributes.pop();
    const from = this.froms.pop();
    if (open === undefined || attributes === undefined || from === undefined) {
      return new UnexpectedEndTag({ name, position: this.where(at) });
    }
    if (open !== name) {
      return new MismatchedEndTag({ expected: open, actual: name, position: this.where(at) });
    }
    const children = from === this.count ? NO_CHILDREN : exactly(this.nodes, from, this.count);
    this.count = from;
    return this.append({ name, attributes, children }, at);
  }

  private addText(data: string, at: Position | number): SaxError | null {
    if (Arr.isArrayEmpty(this.names)) {
      // Top level: only whitespace.
      return isWhitespace(data)
        ? null
        : new InvalidDocumentStructure({
            position: this.where(at),
            reason: "character data is not allowed outside the root element",
          });
    }
    const last = this.count - 1;
    const prev = this.nodes[last];
    if (last >= (this.froms.at(-1) ?? 0) && Predicate.isString(prev)) {
      this.nodes[last] = prev + data;
    } else {
      this.nodes[this.count++] = data;
    }
    return null;
  }

  private append(element: PlainElement, at: Position | number): SaxError | null {
    if (Arr.isArrayNonEmpty(this.names)) {
      this.nodes[this.count++] = element;
      return null;
    }
    if (this.root !== undefined) {
      return new InvalidDocumentStructure({
        position: this.where(at),
        reason: "multiple root elements",
      });
    }
    this.root = element;
    return null;
  }

  finish(at: Position | number): Result.Result<PlainElement, SaxError> {
    const open = this.names.at(-1);
    if (open !== undefined) {
      return Result.fail(
        new InvalidDocumentStructure({
          position: this.where(at),
          reason: `unexpected end of input: <${open}> was never closed`,
        }),
      );
    }
    return this.root === undefined
      ? Result.fail(
          new InvalidDocumentStructure({
            position: this.where(at),
            reason: "document has no root element",
          }),
        )
      : Result.succeed(this.root);
  }
}

/** A lenient pass's first `count` attributes by name (a repeated name: the last value). */
const leniently = (attributes: Attributes, count: number) => {
  const out: Record<string, string> = {};
  for (let k = 0; k < count; k++) set(out, attributes.names[k] ?? "", attributes.values[k] ?? "");
  return out;
};

/** Set an attribute (`__proto__` would set the prototype rather than an attribute). */
const set = (out: Record<string, string>, name: string, value: string): void => {
  if (name === "__proto__") {
    Object.defineProperty(out, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else out[name] = value;
};

/** A start tag's attributes by name, or the first one that repeats a name. */
const record = (
  element: string,
  attributes: ReadonlyArray<Attribute>,
): Readonly<Record<string, string>> | DuplicateAttribute => {
  const out: Record<string, string> = {};
  for (const a of attributes) {
    if (Object.hasOwn(out, a.name)) {
      return new DuplicateAttribute({ element, attribute: a.name, position: a.span.start });
    }
    set(out, a.name, a.value);
  }
  return out;
};

/** One pass over `chunks`, with or without positions (see {@link parsePlain}). */
const plainPass = (
  chunks: Chunks,
  options: PlainOptions | undefined,
  positions: boolean,
): Result.Result<PlainElement, SaxError> => {
  const builder = new PlainBuilder();
  let last: Position = origin;
  const failure = runChunks(
    chunks,
    resolveSaxOptions({ ...options, mode: "xml", positions }),
    (ev) => {
      last = ev.span.end;
      return builder.accept(ev);
    },
    !positions,
  );
  return failure === null ? builder.finish(last) : Result.fail(failure);
};

/**
 * Parse a complete document, as text or bytes, into a plain tree (see the
 * module's description): its root element. It fails as `Xml.parse` with
 * `namespaces: false` fails.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { Xml } from "@thomasfosterau/effect-xml"
 *
 * const root = Effect.runSync(Xml.parsePlain(`<order id="7"><item>Widget</item></order>`))
 * console.log(root.attributes.id) // "7"
 * console.log(root.children) // [{ name: "item", attributes: {}, children: ["Widget"] }]
 * ```
 *
 * @since 0.3.0
 * @category parsing
 */
export const parsePlain = (
  input: string | Uint8Array,
  options?: PlainOptions,
): Effect.Effect<PlainElement, SaxError> =>
  Effect.suspend(() => {
    const chunks: Chunks = Predicate.isString(input)
      ? { chunks: [input] }
      : decodeChunks(input, decodeOptions({ ...options, mode: "xml" }));
    const opts = resolveSaxOptions({ ...options, mode: "xml" });
    if (options?.strict === false && opts.dtd === "ignore") {
      if (chunks.failure !== undefined) return Effect.fail(chunks.failure);
      const text = chunks.chunks.join("");
      const builder = new PlainBuilder(text, opts);
      const failure = readLeniently(text, builder, opts);
      return Effect.fromResult(
        failure === null ? builder.finish(text.length) : Result.fail(failure),
      );
    }
    // The builder reads positions only to report a failure: build without,
    // and report one from a second pass with them, which fails the same way.
    const lean = plainPass(chunks, options, false);
    return Result.isSuccess(lean)
      ? Effect.succeed(lean.success)
      : Effect.fromResult(plainPass(chunks, options, true));
  });
