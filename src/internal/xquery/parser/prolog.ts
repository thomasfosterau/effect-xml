/**
 * XQuery modules and their prologs (XQuery 3.1 §4, A.1 `Module` …
 * `OptionDecl`).
 *
 * The prolog has two parts, and the grammar enforces their order: first
 * the namespace declarations, setters and imports, then the variable,
 * function, context item and option declarations. A setter after a
 * function declaration is therefore a syntax error (`XPST0003`), while a
 * repeated setter is the static analysis's `XQST0055`-style error.
 */
import * as Option from "effect/Option";
import { Parser } from "@thomasfosterau/effect-parse";
import type { Annotation, Decl as DeclT, Module as ModuleT, VersionDecl } from "./ast.ts";
import { Decl, Module } from "./ast.ts";
import { isReserved, type Shared } from "./shared.ts";
import type { P } from "./lexical.ts";
import { syntax } from "./lexical.ts";

const decimalFormatProperties = [
  "decimal-separator",
  "grouping-separator",
  "infinity",
  "minus-sign",
  "NaN",
  "percent",
  "per-mille",
  "zero-digit",
  "digit",
  "pattern-separator",
  "exponent-separator",
] as const;

type Annotated = (annotations: ReadonlyArray<Annotation>, offset: number) => DeclT;

/** The first part of the prolog: namespace declarations, setters and imports. */
const setters = (shared: Shared): P<DeclT> => {
  const { lex } = shared;
  const { kw, tok, at, lexeme, ncname, stringLiteral: uriLiteral, eqname } = lex;
  const name = lexeme(eqname);
  const declare = (...words: ReadonlyArray<string>): P<unknown> =>
    Parser.seq(kw("declare"), ...words.map((w) => kw(w)));
  const decl = <A>(
    head: P<unknown>,
    body: P<A>,
    build: (a: A, offset: number) => DeclT,
  ): P<DeclT> =>
    Parser.map(Parser.seq(at, Parser.preceded(head, Parser.cut(body))), ([offset, a]) =>
      build(a, offset),
    );
  const choice = (a: string, b: string): P<boolean> =>
    Parser.alt(Parser.as(kw(a), true), Parser.as(kw(b), false));
  const atHints = Parser.map(
    Parser.opt(
      Parser.preceded(kw("at"), Parser.cut(Parser.separated(uriLiteral, tok(","), { min: 1 }))),
    ),
    (h) => Option.getOrElse(h, (): ReadonlyArray<string> => []),
  );
  const properties = Parser.repeat(
    Parser.seq(
      Parser.alt(...decimalFormatProperties.map((p) => kw(p))),
      Parser.preceded(Parser.cut(tok("=")), Parser.cut(uriLiteral)),
    ),
  );
  const prefixDecl = Parser.delimited(kw("namespace"), lexeme(ncname), tok("="));
  const schemaPrefix = Parser.alt(
    Parser.map(prefixDecl, (prefix) => ({ prefix: Option.some(prefix), defaultElement: false })),
    Parser.as(Parser.seq(kw("default"), kw("element"), kw("namespace")), {
      prefix: Option.none<string>(),
      defaultElement: true,
    }),
  );
  return Parser.alt(
    decl(declare("default", "element", "namespace"), uriLiteral, (uri, offset) =>
      Decl.DefaultNamespace({ kind: "element", uri, offset }),
    ),
    decl(declare("default", "function", "namespace"), uriLiteral, (uri, offset) =>
      Decl.DefaultNamespace({ kind: "function", uri, offset }),
    ),
    decl(declare("boundary-space"), choice("preserve", "strip"), (preserve, offset) =>
      Decl.BoundarySpace({ preserve, offset }),
    ),
    decl(declare("default", "collation"), uriLiteral, (uri, offset) =>
      Decl.DefaultCollation({ uri, offset }),
    ),
    decl(declare("base-uri"), uriLiteral, (uri, offset) => Decl.BaseURI({ uri, offset })),
    decl(declare("construction"), choice("preserve", "strip"), (preserve, offset) =>
      Decl.Construction({ preserve, offset }),
    ),
    decl(declare("ordering"), choice("ordered", "unordered"), (ordered, offset) =>
      Decl.OrderingMode({ ordered, offset }),
    ),
    decl(declare("default", "order", "empty"), choice("greatest", "least"), (greatest, offset) =>
      Decl.EmptyOrder({ greatest, offset }),
    ),
    decl(
      declare("copy-namespaces"),
      Parser.separatedPair(
        choice("preserve", "no-preserve"),
        tok(","),
        choice("inherit", "no-inherit"),
      ),
      ([preserve, inherit], offset) => Decl.CopyNamespaces({ preserve, inherit, offset }),
    ),
    decl(declare("decimal-format"), Parser.seq(name, properties), ([n, props], offset) =>
      Decl.DecimalFormat({ name: Option.some(n), properties: props, offset }),
    ),
    decl(declare("default", "decimal-format"), properties, (props, offset) =>
      Decl.DecimalFormat({ name: Option.none(), properties: props, offset }),
    ),
    decl(
      declare("namespace"),
      Parser.separatedPair(lexeme(ncname), tok("="), uriLiteral),
      ([prefix, uri], offset) => Decl.Namespace({ prefix, uri, offset }),
    ),
    decl(
      Parser.seq(kw("import"), kw("schema")),
      Parser.seq(Parser.opt(schemaPrefix), uriLiteral, atHints),
      ([p, uri, hints], offset) =>
        Decl.SchemaImport({
          prefix: Option.flatMap(p, (x) => x.prefix),
          defaultElement: Option.exists(p, (x) => x.defaultElement),
          uri,
          at: hints,
          offset,
        }),
    ),
    decl(
      Parser.seq(kw("import"), kw("module")),
      Parser.seq(Parser.opt(prefixDecl), uriLiteral, atHints),
      ([prefix, uri, hints], offset) => Decl.ModuleImport({ prefix, uri, at: hints, offset }),
    ),
  );
};

/** The second part of the prolog: variables, functions, the context item and options. */
const declarations = (shared: Shared): P<DeclT> => {
  const { lex, exprSingle, varName, optionalType, annotations, paramList, enclosedExpr, types } =
    shared;
  const { kw, tok, at, lexeme, eqname, stringLiteral } = lex;
  const name = lexeme(eqname);
  const varValue = Parser.preceded(tok(":="), Parser.cut(exprSingle));
  const initializer = Parser.alt(
    Parser.map(varValue, (value) => ({ value: Option.some(value), external: false })),
    Parser.map(Parser.preceded(kw("external"), Parser.opt(varValue)), (value) => ({
      value,
      external: true,
    })),
  );
  const varDecl: P<Annotated> = Parser.map(
    Parser.preceded(kw("variable"), Parser.cut(Parser.seq(varName, optionalType, initializer))),
    ([n, type, init]): Annotated =>
      (annots, offset) =>
        Decl.Variable({ annotations: annots, name: n, type, ...init, offset }),
  );
  const functionDecl: P<Annotated> = Parser.map(
    Parser.preceded(
      kw("function"),
      Parser.cut(
        Parser.seq(
          Parser.alt(
            Parser.filter(name, (n) => !isReserved(n)),
            syntax("a reserved function name can't name a declared function"),
          ),
          paramList,
          Parser.opt(Parser.preceded(kw("as"), types.sequenceType)),
          Parser.alt(
            Parser.as(kw("external"), Option.none()),
            Parser.map(enclosedExpr, Option.some),
          ),
        ),
      ),
    ),
    ([n, params, returnType, body]): Annotated =>
      (annots, offset) =>
        Decl.Function({ annotations: annots, name: n, params, returnType, body, offset }),
  );
  return Parser.alt(
    Parser.map(
      Parser.seq(
        at,
        Parser.preceded(kw("declare"), Parser.seq(annotations, Parser.alt(varDecl, functionDecl))),
      ),
      ([offset, [annots, build]]) => build(annots, offset),
    ),
    Parser.map(
      Parser.seq(
        at,
        Parser.preceded(
          Parser.seq(kw("declare"), kw("context"), kw("item")),
          Parser.cut(
            Parser.seq(Parser.opt(Parser.preceded(kw("as"), types.itemType)), initializer),
          ),
        ),
      ),
      ([offset, [type, init]]) => Decl.ContextItem({ type, ...init, offset }),
    ),
    Parser.map(
      Parser.seq(
        at,
        Parser.preceded(
          Parser.seq(kw("declare"), kw("option")),
          Parser.cut(Parser.seq(name, stringLiteral)),
        ),
      ),
      ([offset, [n, value]]) => Decl.Option({ name: n, value, offset }),
    ),
  );
};

/** Builds the `Module` parser: an optional version declaration, then a library or main module. */
export const prolog = (shared: Shared): P<ModuleT> => {
  const { lex, expr } = shared;
  const { kw, tok, at, ws, lexeme, ncname, stringLiteral } = lex;
  const separator = Parser.cut(tok(";"));
  const prologDecls: P<ReadonlyArray<DeclT>> = Parser.map(
    Parser.seq(
      Parser.repeat(Parser.terminated(setters(shared), separator)),
      Parser.repeat(Parser.terminated(declarations(shared), separator)),
    ),
    ([first, second]) => [...first, ...second],
  );
  const versionDecl: P<VersionDecl> = Parser.map(
    Parser.seq(
      at,
      Parser.preceded(
        kw("xquery"),
        Parser.alt(
          Parser.map(Parser.preceded(kw("encoding"), Parser.cut(stringLiteral)), (encoding) => ({
            version: Option.none<string>(),
            encoding: Option.some(encoding),
          })),
          Parser.map(
            Parser.preceded(
              kw("version"),
              Parser.cut(
                Parser.seq(
                  stringLiteral,
                  Parser.opt(Parser.preceded(kw("encoding"), stringLiteral)),
                ),
              ),
            ),
            ([version, encoding]) => ({ version: Option.some(version), encoding }),
          ),
        ),
      ),
      separator,
    ),
    ([offset, v]) => ({ ...v, offset }),
  );
  type Build = (version: Option.Option<VersionDecl>) => ModuleT;
  const libraryModule: P<Build> = Parser.map(
    Parser.seq(
      at,
      Parser.preceded(
        Parser.seq(kw("module"), kw("namespace")),
        Parser.cut(
          Parser.terminated(
            Parser.separatedPair(lexeme(ncname), tok("="), stringLiteral),
            separator,
          ),
        ),
      ),
      prologDecls,
    ),
    ([offset, [prefix, uri], decls]): Build =>
      (version) =>
        Module.Library({ version, prefix, uri, prolog: decls, offset }),
  );
  const mainModule: P<Build> = Parser.map(
    Parser.seq(prologDecls, expr),
    ([decls, body]): Build =>
      (version) =>
        Module.Main({ version, prolog: decls, body }),
  );
  return Parser.map(
    Parser.preceded(
      ws,
      Parser.terminated(
        Parser.seq(Parser.opt(versionDecl), Parser.alt(libraryModule, mainModule)),
        Parser.eof,
      ),
    ),
    ([version, build]) => build(version),
  );
};
