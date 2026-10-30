/**
 * Static errors, as plain data: the `err:` code, a description and the
 * offset in the query text (UTF-16 units) the error is reported at.
 *
 * The grammar raises the few static errors it can recognise while parsing
 * (an end tag that doesn't match, an invalid character reference) as an
 * {@link Issue}, the user error of its parsers; every other syntax failure
 * is `XPST0003`.
 */

/** A static error found while compiling a query. */
export interface StaticError {
  /** The local part of the `err:` QName, e.g. `XPST0003`. */
  readonly code: string;
  readonly description: string;
  readonly offset: number;
}

/** A static error the grammar raises, positioned by the parse failure. */
export interface Issue {
  readonly code: string;
  readonly description: string;
}

/** A static error at `offset`. */
export const staticError = (code: string, description: string, offset: number): StaticError => ({
  code,
  description,
  offset,
});
