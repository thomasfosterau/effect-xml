/**
 * The evaluator's one exception boundary.
 *
 * Evaluation is synchronous and deeply nested (an expression's code calls its
 * operands' code), and almost every step can fail with a dynamic or type
 * error. Threading a `Result` through every call allocated a wrapper per
 * item and made every caller branch on it; instead the evaluator throws the
 * {@link XQueryError} where it is raised and {@link attempt} turns it back
 * into a value at the boundary, once per evaluation (and once per call of a
 * function item from outside). A plain `try` costs nothing on the path that
 * doesn't throw, as in `internal/unwind.ts`.
 *
 * Besides errors, evaluation can stop to ask for a resource (a document, a
 * collection, a text) the host must fetch with an effect: it throws a
 * {@link Suspend}, the caller fetches the resource and evaluates again with
 * it cached. Evaluation is deterministic, so the rerun reaches the same
 * point and finds the resource.
 */
import * as Result from "effect/Result";
import { QName } from "../../../Name.ts";
import { ImplementationNamespace, XQueryError, xqueryError } from "../../../XQuery/Error.ts";

/** A resource evaluation needs from the host before it can go on. */
export interface ResourceRequest {
  readonly kind: "document" | "collection" | "text";
  /** The absolute URI; `""` for the default collection. */
  readonly uri: string;
  /** The encoding asked for, for a text. */
  readonly encoding: string | undefined;
}

/** Thrown to stop evaluation until the host has fetched a resource. */
export class Suspend {
  readonly request: ResourceRequest;

  constructor(request: ResourceRequest) {
    this.request = request;
  }
}

/** `error`, given `offset` when it has none of its own. */
const withOffset = (error: XQueryError, offset: number | undefined): XQueryError =>
  error.offset !== undefined || offset === undefined
    ? error
    : new XQueryError({
        code: error.code,
        description: error.description,
        offset,
        value: error.value,
      });

/** Fail evaluation with an error the specifications define, by its local name. */
export const raise = (code: string, description: string, offset?: number): never => {
  throw xqueryError(code, description, offset);
};

/** Fail evaluation with `error`, positioned at `offset` if it has no position yet. */
const raiseError = (error: XQueryError, offset?: number): never => {
  throw withOffset(error, offset);
};

/** Fail evaluation because the evaluator does not implement `what` yet. */
export const notImplemented = (what: string, offset?: number): never => {
  throw new XQueryError({
    code: new QName({ prefix: null, local: "NotImplemented", namespace: ImplementationNamespace }),
    description: `${what} is not implemented yet`,
    offset,
  });
};

/** A `Result`'s success, or evaluation fails with its error (positioned at `offset`). */
export const unwrap = <A>(result: Result.Result<A, XQueryError>, offset?: number): A =>
  Result.isSuccess(result) ? result.success : raiseError(result.failure, offset);

/**
 * Run evaluation code inside the boundary: its value, the {@link XQueryError}
 * it raised, or the {@link Suspend} asking for a resource. A query that
 * recurses deeper than the JavaScript stack allows fails with
 * `err:XPDY0130` (an implementation limit) instead of crashing.
 */
export const attempt = <A>(run: () => A): Result.Result<A, XQueryError | Suspend> => {
  try {
    return Result.succeed(run());
  } catch (e) {
    if (e instanceof XQueryError || e instanceof Suspend) return Result.fail(e);
    // The engine's own call stack ran out.
    if (e instanceof RangeError && e.message.includes("call stack"))
      return Result.fail(xqueryError("XPDY0130", "the query recursed too deeply"));
    throw e;
  }
};

/** {@link attempt} where no resource can be fetched: a {@link Suspend} becomes `err:FODC0002`. */
export const attemptSync = <A>(run: () => A): Result.Result<A, XQueryError> =>
  Result.mapError(attempt(run), (e) =>
    e instanceof Suspend
      ? xqueryError("FODC0002", `${e.request.uri} cannot be fetched outside an evaluation`)
      : e,
  );

/** `run`'s value, or `handle`'s if it raises an {@link XQueryError} (a {@link Suspend} still stops evaluation). */
export const catching = <A>(run: () => A, handle: (error: XQueryError) => A): A => {
  try {
    return run();
  } catch (e) {
    if (e instanceof XQueryError) return handle(e);
    throw e;
  }
};

/** Whether `run` completes without an {@link XQueryError}. */
export const succeeds = (run: () => void): boolean =>
  catching(
    () => {
      run();
      return true;
    },
    () => false,
  );

/** `run`'s value, or `fallback` if it raises an {@link XQueryError}. */
export const orElse = <A>(run: () => A, fallback: A): A => catching(run, () => fallback);
