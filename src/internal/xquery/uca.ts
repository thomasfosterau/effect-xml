/**
 * The UCA collation URIs of F&O 3.1 §5.3.3
 * (`http://www.w3.org/2013/collation/UCA?lang=en;strength=primary;…`), mapped
 * onto `Intl.Collator`.
 *
 * `Intl.Collator` exposes the Unicode Collation Algorithm through a handful of
 * options and nothing else (no sort keys, no collation elements), so a URI is
 * supported exactly when its parameters have an `Intl.Collator` equivalent:
 *
 * | parameter | supported values | `Intl.Collator` |
 * | --- | --- | --- |
 * | `lang` | any BCP 47 tag the runtime has collation data for (default `en`) | locale |
 * | `strength` | `primary`, `secondary`, `tertiary` (default), `identical`; `quaternary` as `tertiary` unless `alternate=shifted` | `sensitivity` `base`, `accent`, `variant` |
 * | `caseLevel` | `no`; `yes` with `strength=primary` | `sensitivity: "case"` |
 * | `alternate` | `non-ignorable` (default), `blanked`, `shifted` (not with `quaternary`; `identical` only with `non-ignorable` or `blanked`) | `ignorePunctuation` |
 * | `maxVariable` | any, but only `punct` when `alternate` is not `non-ignorable` | none (the runtime's default is `punct`) |
 * | `caseFirst` | `upper`, `lower`, `no` | `caseFirst` |
 * | `numeric` | `yes`, `no` | `numeric` |
 * | `backwards` | `no` | none |
 * | `normalization` | `yes`, `no` (the runtime always normalizes, which only differs for text that is not in FCD form) | none |
 *
 * `strength=identical` adds the final level of the UCA, the code points of the
 * strings in NFD, on top of the tertiary comparison. `reorder`, `version`,
 * `backwards=yes` and the other combinations are not supported.
 *
 * A parameter with no equivalent, a value the runtime does not support or an
 * unknown parameter is ignored under `fallback=yes` (the default) and makes
 * the collation unsupported (`err:FOCH0002`, or `err:XQST0038` in a
 * declaration) under `fallback=no`. A repeated parameter, or a `fallback`
 * that is neither `yes` nor `no`, is never accepted.
 *
 * @internal
 */
import * as Arr from "effect/Array";
import * as HashSet from "effect/HashSet";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Result from "effect/Result";

/** The URI of the UCA collation family, before its `?` and parameters. */
const ucaBase = "http://www.w3.org/2013/collation/UCA";

/** Whether a (resolved) URI names a UCA collation: the base, with or without parameters. */
export const isUcaUri = (uri: string): boolean => uri === ucaBase || uri.startsWith(`${ucaBase}?`);

/** A UCA collation: how two strings order, negative, zero or positive. */
export interface UcaCollation {
  readonly compare: (a: string, b: string) => number;
  /** Whether runs of digits compare as numbers, so a substring match must not cut one. */
  readonly numeric: boolean;
}

type Params = Readonly<Record<string, string>>;

/** The `name=value` pairs of a UCA URI's query, or why they are malformed. */
const decode = (s: string): string =>
  Result.getOrElse(
    Result.try(() => decodeURIComponent(s)),
    () => s,
  );

const parameters = (uri: string): Result.Result<Params, string> => {
  const query = uri.slice(ucaBase.length + 1).replace(/#.*$/s, "");
  const pairs = query
    .split(";")
    .filter((p) => p !== "")
    .map((p): readonly [string, string] => {
      const at = p.indexOf("=");
      return at < 0 ? [decode(p), ""] : [decode(p.slice(0, at)), decode(p.slice(at + 1))];
    });
  const repeated = Arr.findFirst(pairs, ([name], i) => pairs.findIndex(([n]) => n === name) !== i);
  return Option.match(repeated, {
    onNone: () => Result.succeed(R.fromEntries(pairs)),
    onSome: ([name]) => Result.fail(`the parameter ${name} is repeated`),
  });
};

/** A value and the problems found reading it: parameters this implementation cannot honour. */
type Read<A> = readonly [A, ReadonlyArray<string>];

/** A parameter that is one of `allowed`, else `otherwise` and a problem. */
const choice = <const A extends string>(
  params: Params,
  name: string,
  allowed: ReadonlyArray<A>,
  otherwise: A,
): Read<A> =>
  Option.match(R.get(params, name), {
    onNone: (): Read<A> => [otherwise, []],
    onSome: (v): Read<A> =>
      Option.match(
        Arr.findFirst(allowed, (a) => a === v),
        {
          onNone: () => [otherwise, [`${name}=${v} is not one of ${allowed.join(", ")}`]],
          onSome: (a) => [a, []],
        },
      ),
  });

const yesNo = ["yes", "no"] as const;
const known = HashSet.make(
  "fallback",
  "lang",
  "strength",
  "maxVariable",
  "alternate",
  "backwards",
  "normalization",
  "caseLevel",
  "caseFirst",
  "numeric",
  "reorder",
  "version",
);

/** The locale `lang` asks for (`en` without it), if the runtime has collation data for it. */
const locale = (params: Params): Read<string> =>
  Option.match(R.get(params, "lang"), {
    onNone: (): Read<string> => ["en", []],
    onSome: (lang): Read<string> => {
      if (lang === "") return ["en", []];
      const canonical = Result.try(() => Intl.getCanonicalLocales(lang)[0]);
      return Option.match(
        Option.filter(
          Result.getSuccess(canonical).pipe(Option.flatMap(Option.fromNullishOr)),
          (tag) =>
            Arr.isReadonlyArrayNonEmpty(
              Intl.Collator.supportedLocalesOf([tag], { localeMatcher: "lookup" }),
            ),
        ),
        {
          onNone: () => ["en", [`lang=${lang} is not a language this runtime can collate`]],
          onSome: (tag) => [tag, []],
        },
      );
    },
  });

/** Code points of a string's NFD form, the UCA's identical level. */
const identicalOrder = (a: string, b: string): number => {
  const x = Array.from(a.normalize("NFD"), (c) => c.codePointAt(0) ?? 0);
  const y = Array.from(b.normalize("NFD"), (c) => c.codePointAt(0) ?? 0);
  return Arr.findFirst(x, (c, i) =>
    c === y[i] ? Option.none() : Option.some(c - (y[i] ?? -1)),
  ).pipe(Option.getOrElse(() => x.length - y.length));
};

/** What a URI's parameters ask for, and the problems found reading them. */
interface Settings {
  readonly tag: string;
  readonly strength: string;
  readonly alternate: string;
  readonly caseLevel: string;
  readonly caseFirst: string;
  readonly numeric: string;
  readonly backwards: string;
  readonly maxVariable: string;
  readonly problems: ReadonlyArray<string>;
}

const settings = (params: Params): Settings => {
  const [tag, langProblems] = locale(params);
  const [strength, strengthProblems] = choice(
    params,
    "strength",
    ["primary", "secondary", "tertiary", "quaternary", "identical"],
    "tertiary",
  );
  const [alternate, alternateProblems] = choice(
    params,
    "alternate",
    ["non-ignorable", "blanked", "shifted"],
    "non-ignorable",
  );
  const [caseLevel, caseLevelProblems] = choice(params, "caseLevel", yesNo, "no");
  const [caseFirst, caseFirstProblems] = choice(
    params,
    "caseFirst",
    ["upper", "lower", "no"],
    "no",
  );
  const [numeric, numericProblems] = choice(params, "numeric", yesNo, "no");
  const [backwards, backwardsProblems] = choice(params, "backwards", yesNo, "no");
  const [, normalizationProblems] = choice(params, "normalization", yesNo, "no");
  const [maxVariable, maxVariableProblems] = choice(
    params,
    "maxVariable",
    ["space", "punct", "symbol", "currency"],
    "punct",
  );
  return {
    tag,
    strength,
    alternate,
    caseLevel,
    caseFirst,
    numeric,
    backwards,
    maxVariable,
    problems: [
      ...langProblems,
      ...strengthProblems,
      ...alternateProblems,
      ...caseLevelProblems,
      ...caseFirstProblems,
      ...numericProblems,
      ...backwardsProblems,
      ...normalizationProblems,
      ...maxVariableProblems,
    ],
  };
};

/**
 * The strength this runtime gives for one asked: it has no fourth level
 * (variable elements), so `quaternary` is tertiary and `identical` or
 * `quaternary` with `alternate=shifted` fall back to tertiary.
 */
const effectiveStrength = (s: Settings): string =>
  s.strength === "quaternary" || (s.strength === "identical" && s.alternate === "shifted")
    ? "tertiary"
    : s.strength;

/** What the parameters ask for that this runtime cannot do. */
const unsupported = (s: Settings, params: Params): ReadonlyArray<string> => {
  const effective = effectiveStrength(s);
  return [
    ...(s.backwards === "yes" ? ["backwards=yes"] : []),
    ...(s.alternate === "shifted" && s.strength === "quaternary"
      ? ["strength=quaternary with alternate=shifted"]
      : []),
    ...(s.alternate === "shifted" && s.strength === "identical"
      ? ["strength=identical with alternate=shifted"]
      : []),
    ...(s.caseLevel === "yes" && effective !== "primary"
      ? [`caseLevel=yes with strength=${effective}`]
      : []),
    ...(s.alternate !== "non-ignorable" && s.maxVariable !== "punct"
      ? [`maxVariable=${s.maxVariable} with alternate=${s.alternate}`]
      : []),
    ...(Option.exists(R.get(params, "reorder"), (v) => v !== "") ? ["reorder"] : []),
    ...(R.has(params, "version") ? ["version"] : []),
    ...R.keys(params)
      .filter((name) => !HashSet.has(known, name))
      .map((name) => `the parameter ${name}`),
  ].map((what) => `${what} is not supported`);
};

/** The `Intl.Collator` for settings (a combination it can't do having been dropped). */
const collatorOf = (s: Settings): Result.Result<UcaCollation, string> => {
  const effective = effectiveStrength(s);
  const sensitivity: Intl.CollatorOptions["sensitivity"] =
    effective === "primary"
      ? s.caseLevel === "yes"
        ? "case"
        : "base"
      : effective === "secondary"
        ? "accent"
        : "variant";
  return Result.try({
    try: () => {
      const collator = new Intl.Collator(s.tag, {
        usage: "sort",
        sensitivity,
        ignorePunctuation: s.alternate !== "non-ignorable",
        numeric: s.numeric === "yes",
        caseFirst: s.caseFirst === "no" ? "false" : s.caseFirst === "upper" ? "upper" : "lower",
      });
      return {
        numeric: s.numeric === "yes",
        compare:
          effective === "identical"
            ? (a: string, b: string) => collator.compare(a, b) || identicalOrder(a, b)
            : (a: string, b: string) => collator.compare(a, b),
      };
    },
    catch: () => "the runtime rejected the collation options",
  });
};

const build = (params: Params): Result.Result<UcaCollation, string> => {
  const [fallback, fallbackProblems] = choice(params, "fallback", ["yes", "no"], "yes");
  // A `fallback` that is not a boolean cannot be told what to fall back to.
  if (Arr.isReadonlyArrayNonEmpty(fallbackProblems))
    return Result.fail(fallbackProblems.join("; "));
  const asked = settings(params);
  const problems = [...asked.problems, ...unsupported(asked, params)];
  return fallback === "no" && Arr.isReadonlyArrayNonEmpty(problems)
    ? Result.fail(problems.join("; "))
    : collatorOf(asked);
};

/** Collations already built, by URI: a collator costs more to make than to use. */
const built = /*#__PURE__*/ MutableHashMap.empty<string, Result.Result<UcaCollation, string>>();

/**
 * The UCA collation a URI names (see the module comment for what is
 * supported), or why it is not supported.
 */
export const ucaCollation = (uri: string): Result.Result<UcaCollation, string> =>
  Option.getOrElse(MutableHashMap.get(built, uri), () => {
    const made = Result.flatMap(parameters(uri), build);
    // Bounded: a query can make up URIs without end.
    if (MutableHashMap.size(built) >= 64) MutableHashMap.clear(built);
    MutableHashMap.set(built, uri, made);
    return made;
  });
