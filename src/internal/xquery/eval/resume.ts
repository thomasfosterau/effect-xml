/**
 * Evaluation that stops for resources: run synchronous evaluation code
 * until it no longer asks for one, fetching each through the host's
 * resolver (or parsing it, for `fn:parse-xml`) and running it again with
 * the resource cached. Evaluation is deterministic, so each rerun reaches
 * the same point and finds what it asked for.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type { ResourceResolver } from "../../../XQuery/Evaluate.ts";
import { type XQueryError, xqueryError } from "../../../XQuery/Error.ts";
import type { Sequence } from "../item.ts";
import { parseXmlRequest } from "./parseXml.ts";
import { attempt, Suspend, type ResourceRequest } from "./raise.ts";
import { resourceKey, type Resources } from "./runtime.ts";

const fetchWith = (
  resolver: ResourceResolver,
  request: ResourceRequest,
): Effect.Effect<Sequence | string, XQueryError> =>
  request.kind === "document"
    ? Effect.map(resolver.document(request.uri), (node): Sequence => [node])
    : request.kind === "collection"
      ? resolver.collection(request.uri)
      : resolver.text(request.uri, Option.fromUndefinedOr(request.encoding));

/** What a {@link Suspend} asked for, fetched (or parsed) and cached in `resources`. */
export const fetchFor = (
  suspended: Suspend,
  resources: Resources,
  resolver: Option.Option<ResourceResolver>,
): Effect.Effect<void, XQueryError> => {
  const { request } = suspended;
  if (request.kind === "xml" || request.kind === "xml-fragment")
    return parseXmlRequest(request).pipe(
      Effect.result,
      Effect.map((parsed) => resources.set(resourceKey(request), parsed)),
    );
  return Option.match(resolver, {
    onNone: () => Effect.fail(xqueryError("FODC0002", `${request.uri} is not available`)),
    onSome: (r) =>
      fetchWith(r, request).pipe(
        Effect.result,
        Effect.map((fetched) => resources.set(resourceKey(request), fetched)),
      ),
  });
};

/** Run evaluation code until it needs nothing more from the resolver. */
export const resume = (
  run: () => Sequence,
  resources: Resources,
  resolver: Option.Option<ResourceResolver>,
): Effect.Effect<Sequence, XQueryError> =>
  Effect.suspend(() => {
    const outcome = attempt(run);
    if (Result.isSuccess(outcome)) return Effect.succeed(outcome.success);
    const failure = outcome.failure;
    if (!(failure instanceof Suspend)) return Effect.fail(failure);
    return Effect.flatMap(fetchFor(failure, resources, resolver), () =>
      resume(run, resources, resolver),
    );
  });
