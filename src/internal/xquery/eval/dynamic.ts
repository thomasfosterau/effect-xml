/**
 * The dynamic context of an evaluation, from the host's options: the
 * external variables' values, the current dateTime (from the `Clock` unless
 * given), the implicit timezone, the default language and the environment variables.
 */
import * as BigDecimal from "effect/BigDecimal";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as R from "effect/Record";
import type { Item, Sequence } from "../item.ts";
import { AtomicTypes } from "../types.ts";
import { Resources, type Dynamic } from "./runtime.ts";
import { formatParts, partsAt } from "./temporal.ts";

/** What the host sets of the dynamic context (`XQuery.EvaluateOptions` but the context item and compile options). */
export interface DynamicOptions {
  readonly variables?: Readonly<Record<string, Sequence | Item>> | undefined;
  readonly implicitTimezone?: number | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly currentDateTime?: Date | undefined;
  readonly defaultLanguage?: string;
}

const clarkKey = (name: string): string => (name.startsWith("{") ? name : `{}${name}`);

const isSequence = (v: Sequence | Item): v is Sequence => Array.isArray(v);

/** The current dateTime in the implicit timezone, as a lexical `xs:dateTimeStamp`. */
const nowIn = (millis: number, tz: number): string =>
  formatParts(
    AtomicTypes.dateTimeStamp,
    partsAt(BigDecimal.make(BigInt(Math.round(millis)), 3), tz),
  );

/** The dynamic context for `options`, with `initialContext` as the context item; `canFetch` when the host has a resolver. */
export const dynamicContext = (
  options: DynamicOptions,
  initialContext: Item | undefined,
  canFetch: boolean,
): Effect.Effect<Omit<Dynamic, "globals">> =>
  Effect.map(
    options.currentDateTime === undefined
      ? Clock.currentTimeMillis
      : Effect.succeed(options.currentDateTime.getTime()),
    (millis) => {
      const tz = options.implicitTimezone ?? 0;
      return {
        externals: HashMap.fromIterable(
          R.toEntries(options.variables ?? {}).map(([k, v]): readonly [string, Sequence] => [
            clarkKey(k),
            isSequence(v) ? v : [v],
          ]),
        ),
        initialContext,
        resources: new Resources(canFetch),
        currentDateTime: nowIn(millis, tz),
        implicitTimezone: tz,
        defaultLanguage: options.defaultLanguage ?? "en",
        environment: options.environment ?? {},
      };
    },
  );
