/**
 * Resource limits for untrusted input.
 *
 * Every parser in the library enforces a {@link Limits} record and fails with a
 * typed {@link LimitExceeded} as soon as the input exceeds one of them, so a
 * hostile document (deeply nested, with huge names or text, or simply endless)
 * costs bounded time and memory instead of exhausting the stack or the heap.
 *
 * Options take a `Partial<Limits>`: the fields you leave out keep their
 * {@link defaultLimits}. Pass `Infinity` to switch a limit off, or
 * {@link unlimited} to switch them all off for trusted input.
 */

export interface Limits {
  /** Maximum element nesting depth. */
  readonly maxDepth: number
  /** Maximum number of attributes on one element. */
  readonly maxAttributes: number
  /** Maximum length of an element name, attribute name or PI target. */
  readonly maxNameLength: number
  /**
   * Maximum length of any single run of character data: a text node, CDATA
   * section, comment, attribute value, PI body or DOCTYPE internal subset.
   * While streaming, this also bounds how much of one unfinished token is
   * buffered.
   */
  readonly maxTextLength: number
  /**
   * Maximum size of the whole input: bytes for byte input, UTF-16 code units
   * for string input.
   */
  readonly maxTotalBytes: number
}

/**
 * Conservative defaults, close to libxml2's: generous for real documents
 * (OOXML, ODF, EPUB, RDF/XML), small enough to stop hostile ones early.
 */
export const defaultLimits: Limits = {
  maxDepth: 1024,
  maxAttributes: 1024,
  maxNameLength: 10_000,
  maxTextLength: 10_000_000,
  maxTotalBytes: 1024 * 1024 * 1024,
}

/** No limits at all. Only for trusted input. */
export const unlimited: Limits = {
  maxDepth: Infinity,
  maxAttributes: Infinity,
  maxNameLength: Infinity,
  maxTextLength: Infinity,
  maxTotalBytes: Infinity,
}

/** Fill in the limits a caller left out with the defaults. */
export const resolveLimits = (limits: Partial<Limits> | undefined): Limits =>
  limits === undefined ? defaultLimits : { ...defaultLimits, ...limits }
