/**
 * URI reference resolution as RFC 3986 §5.2 specifies it, on the text as
 * written: nothing is normalized or percent-encoded, as `URL` does, so an IRI
 * resolves to an IRI (F&O 3.1 `fn:resolve-uri` and the base URIs of nodes).
 */
import * as Option from "effect/Option";

/** RFC 3986 appendix B: scheme, authority, path, query, fragment. */
const parts = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s;

const scheme = /^[A-Za-z][A-Za-z0-9+.-]*$/;

interface Parts {
  readonly scheme: string | undefined;
  readonly authority: string | undefined;
  readonly path: string;
  readonly query: string | undefined;
  readonly fragment: string | undefined;
}

const split = (uri: string): Parts => {
  // The pattern matches every string (all its groups are optional or total).
  const m = parts.exec(uri);
  return {
    scheme: m?.[1],
    authority: m?.[2],
    path: m?.[3] ?? "",
    query: m?.[4],
    fragment: m?.[5],
  };
};

/** Whether `uri` begins with a scheme (`scheme ":"`), as an absolute URI does. */
export const hasScheme = (uri: string): boolean => {
  const s = split(uri).scheme;
  return s !== undefined && scheme.test(s);
};

/**
 * Whether `reference` is a URI reference as far as its structure goes: a
 * relative-path reference's first segment may not hold a ":" (it would read as
 * a scheme), a scheme must be well formed and a "%" must begin an escape.
 */
export const isReference = (reference: string): boolean => {
  if (/%(?![0-9A-Fa-f]{2})/.test(reference)) return false;
  const p = split(reference);
  if (p.scheme !== undefined) return scheme.test(p.scheme);
  return (
    p.authority !== undefined || p.path.startsWith("/") || !p.path.split("/")[0]?.includes(":")
  );
};

/** RFC 3986 §5.2.4: drop "." and ".." segments from a path. */
const removeDotSegments = (path: string): string => {
  const out: Array<string> = [];
  const segments = path.split("/");
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    if (segment === ".") {
      if (last) out.push("");
    } else if (segment === "..") {
      if (out.length > 1 || (out.length === 1 && out[0] !== "")) out.pop();
      if (last) out.push("");
    } else out.push(segment);
  });
  return out.join("/");
};

/** RFC 3986 §5.2.3: merge a relative path with the base's. */
const merge = (base: Parts, path: string): string =>
  base.authority !== undefined && base.path === ""
    ? `/${path}`
    : `${base.path.slice(0, base.path.lastIndexOf("/") + 1)}${path}`;

const recompose = (p: Parts): string =>
  `${p.scheme === undefined ? "" : `${p.scheme}:`}${p.authority === undefined ? "" : `//${p.authority}`}${p.path}${p.query === undefined ? "" : `?${p.query}`}${p.fragment === undefined ? "" : `#${p.fragment}`}`;

/**
 * RFC 3986 §5.2.2: resolve `reference` against `base`; an absolute reference is
 * returned as written. `None` if the reference is not one (see {@link isReference}) or the base has no scheme.
 */
export const resolveReference = (reference: string, base: string): Option.Option<string> => {
  if (!isReference(reference)) return Option.none();
  const r = split(reference);
  // An absolute reference stands as written (F&O 3.1 `fn:resolve-uri`).
  if (r.scheme !== undefined) return Option.some(reference);
  const b = split(base);
  if (!isReference(base) || b.scheme === undefined || !scheme.test(b.scheme)) return Option.none();
  const target = (): Parts => {
    if (r.authority !== undefined) {
      return { ...r, scheme: b.scheme, path: removeDotSegments(r.path) };
    }
    if (r.path === "") {
      return { ...b, query: r.query ?? b.query, fragment: r.fragment };
    }
    const path = r.path.startsWith("/")
      ? removeDotSegments(r.path)
      : removeDotSegments(merge(b, r.path));
    return { scheme: b.scheme, authority: b.authority, path, query: r.query, fragment: r.fragment };
  };
  return Option.some(recompose(target()));
};
