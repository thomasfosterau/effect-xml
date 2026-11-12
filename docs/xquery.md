# XPath 3.1 and XQuery 3.1

The `XQuery` layer: XPath 3.1 and XQuery 3.1, in progress. So far the XDM 3.1 data model (nodes over the `Xml` DOM, typed atomic values, maps, arrays and function items), `XQueryError`, the compiler front end (`XQuery.compile` / `XQuery.XPath.compile`: the full grammar and the static checks) and the evaluator (`XQuery.evaluate`), with direct and computed node constructors. Back to the [README](https://github.com/thomasfosterau/effect-xml/blob/trunk/README.md).

## XQuery data model

`XQuery` is growing into an XPath 3.1 and XQuery 3.1 engine, tested against the W3C QT3 suite. Its first part is the XQuery and XPath Data Model (XDM 3.1) the engine evaluates over: `XdmNode`s are handles on places in an `Xml` DOM, with identity, parents and document order (text and CDATA merge into XDM text nodes, namespace declarations become in-scope namespaces); `AtomicValue`s carry their `xs:` type from the `AtomicTypes` hierarchy; `MapItem`, `ArrayItem` and `FunctionItem` complete the items, and a `Sequence` is an array of them.

```ts
import * as Effect from "effect/Effect";
import { Xml, XQuery } from "@thomasfosterau/effect-xml";

const doc = XQuery.XdmNode.fromDocument(Effect.runSync(Xml.parse(`<n a="1">4<![CDATA[2]]></n>`)));
doc.children[0]?.children.length; // 1: the text and the CDATA are one text node, "42"
XQuery.atomize([doc]); // Success([xs:untypedAtomic "42"])
XQuery.effectiveBooleanValue([XQuery.AtomicValue.string("")]); // Success(false)
XQuery.fromLexical(XQuery.AtomicTypes.decimal, "01.50"); // Success(xs:decimal 1.5)
XQuery.atomicString(XQuery.AtomicValue.double(1e7)); // "1.0E7"
```

Failures are `XQueryError`s: an `err:` QName `code` (`err:FORG0001`, `err:FOTY0013`, …), a `description`, an `offset` into the query and, from `fn:error`, a `value`.

### Compiling queries

`XQuery.compile` parses an XQuery 3.1 module (the whole grammar of Appendix A: the prolog, FLWOR with windows and grouping, direct, computed and string constructors, `switch`, `typeswitch`, `try`, maps, arrays, lookups and arrows) and checks it statically; `XQuery.XPath.compile` does the same for XPath 3.1. Either returns a `Result`: a `Query` (the syntax tree and its static context, for the evaluator to come), or the first static error with its offset:

```ts
import * as Result from "effect/Result";
import { XQuery } from "@thomasfosterau/effect-xml";

XQuery.compile("for $b in //book where $b/price < 10 return <cheap>{ $b/title }</cheap>"); // Success(Query)
XQuery.compile("1 + $x"); // Failure(err:XPST0008 at offset 4: the variable $x is not declared)
XQuery.compile("1 + $x", { variables: ["x"] }); // Success(Query)
XQuery.XPath.compile("<a/>"); // Failure(err:XPST0003 at offset 0: …): constructors are XQuery's
```

The static checks are the ones that need no schema: syntax (`XPST0003`), unbound prefixes (`XPST0081`), undeclared variables (`XPST0008`), unknown functions and arities (`XPST0017`, against the Functions and Operators 3.1 library), unknown types (`XPST0051`, `XPST0080`), and the prolog's and constructors' `XQST` errors. Options set the static context: `namespaces`, `defaultElementNamespace`, `defaultFunctionNamespace`, `variables` and `functions` (by Clark name, `{uri}local`), `baseUri`, `collations`, and `opaqueNamespaces` for imported modules and schemas the compiler can't see into.

### Evaluating queries

`XQuery.evaluate` runs a compiled `Query` (or XQuery text, compiled first) against a context item and external variables, and returns an `Effect` of the result sequence; a query compiled once can be evaluated many times. The context may be any XDM item or a parsed `XmlDocument` / `XmlElement`; variables are keyed by Clark name and take a sequence or a single item:

```ts
import * as Effect from "effect/Effect";
import { Xml, XQuery } from "@thomasfosterau/effect-xml";

const doc = Effect.runSync(Xml.parse(`<items><i n="1">a</i><i n="2">b</i><i n="3">c</i></items>`));
const query = XQuery.XPath.compile("//i[@n > $min]/string()", { variables: ["min"] });

Effect.runSync(
  Effect.flatMap(Effect.fromResult(query), (q) =>
    XQuery.evaluate(q, { context: doc, variables: { min: XQuery.AtomicValue.integer(1n) } }),
  ),
); // [xs:string "b", xs:string "c"]
Effect.runSync(XQuery.evaluate("for $x in 1 to 3 return $x * $x")); // [1, 4, 9]
```

Evaluation itself is synchronous. It is an `Effect` because `fn:doc`, `fn:collection` and `fn:unparsed-text` go through the `XQuery.Resolver` service when one is provided (`XQuery.staticResolver` serves documents, collections and texts from memory); without one those functions find nothing. Errors are `XQueryError`s with the specifications' codes (`err:XPTY0004`, `err:FOAR0001`, …) and the offset of the expression that raised them. The evaluator covers the expression language (paths and axes but the optional namespace axis, operators, comparisons, FLWOR expressions with every clause (`for` with `at` and `allowing empty`, `let`, tumbling and sliding `window`s, `where`, `group by`, `order by` with `stable`, empty least / greatest and the codepoint, HTML ASCII case-insensitive and UCA collations, `count`), quantifiers, conditionals, `switch`, `typeswitch`, `try`, sequence types and casts, function items and closures, maps, arrays and lookups, node constructors) and the prolog's variables and functions; of Functions and Operators 3.1, the core built-ins so far. The UCA collation URIs (`http://www.w3.org/2013/collation/UCA?lang=en;strength=primary`) run on `Intl.Collator`: `lang`, `strength` (primary to identical), `caseLevel` with primary, `alternate`, `caseFirst`, `numeric` and `normalization` map onto it, `fallback=no` turns what it can't honour (`reorder`, `version`, `backwards=yes`, unknown parameters) into `err:FOCH0002`, and `fn:collation-key` fails with `err:FOCH0004` for them, since `Intl` has no sort keys; the `XQuery.evaluate` doc comment has the full table. A construct or function that isn't implemented yet (most of the function library) fails with the code `NotImplemented` in `XQuery.ImplementationNamespace`.

### Library modules

`import module` loads library modules from `CompileOptions.modules` (sources by target namespace URI: compiling then checks the imported names, and `%private` functions and variables stay private), or, when a query was compiled without them, through the `Resolver`'s optional `module` method as the query is evaluated. Modules may import each other in cycles; a namespace with no module is `err:XQST0059`:

```ts
import * as Effect from "effect/Effect";
import { XQuery } from "@thomasfosterau/effect-xml";

const resolver: XQuery.ResourceResolver = {
  ...XQuery.staticResolver({}),
  module: (uri) =>
    Effect.succeed(
      uri === "urn:math"
        ? [{ text: `module namespace m = "urn:math"; declare function m:square($x) { $x * $x };` }]
        : [],
    ),
};
Effect.runSync(
  XQuery.evaluate(`import module namespace m = "urn:math"; m:square(7)`).pipe(
    Effect.provideService(XQuery.Resolver, resolver),
  ),
); // [49]
```

### Constructing nodes

Direct constructors (`<a x="{…}">…</a>`, comments, processing instructions) and computed ones (`element`, `attribute`, `text`, `document`, `comment`, `processing-instruction`, `namespace`) build new `Xml` DOM values, so their results are XDM nodes with a fresh identity, and nodes in their content are copied. An element's in-scope namespaces are its namespace declarations plus the bindings its name and attributes use; the prolog's `boundary-space`, `construction` and `copy-namespaces` declarations are honoured. The DOM behind a constructed element is an ordinary `XmlElement`, ready for `Xml.serialize`, `Xml.Writer` or `Xml.C14n`:

```ts
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Xml, XQuery } from "@thomasfosterau/effect-xml";

const doc = Effect.runSync(Xml.parse(`<items><i n="1">a</i><i n="2">b</i></items>`));
const [list] = Effect.runSync(
  XQuery.evaluate(
    `<ul class="items">{ for $i in //i return <li id="i{ $i/@n }">{ $i/string() }</li> }</ul>`,
    {
      context: doc,
    },
  ),
);
if (list !== undefined && XQuery.isNode(list)) console.log(Option.map(list.element, Xml.serialize)); // Some(<ul class="items"><li id="i1">a</li><li id="i2">b</li></ul>)
```

### Streaming queries

`XQuery.stream(query, options?)` evaluates a query over a stream of SAX events instead of a parsed document. Each subtree the query's path selects is built when its end tag arrives, the rest of the query runs on it, and the resulting XDM items stream out in document order: equal to what `XQuery.evaluate` gives for the parsed document, in memory bounded by the largest match.

```ts
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Sax, XQuery } from "@thomasfosterau/effect-xml";

const SPREADSHEETML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const sheet = Stream.make(
  `<worksheet xmlns="${SPREADSHEETML}"><sheetData>` +
    `<row r="1"><c><v>1</v></c><c><v>2</v></c></row><row r="2" hidden="1"/><row r="3"><c><v>5</v></c></row>` +
    `</sheetData></worksheet>`,
);

const rows = sheet.pipe(
  Sax.tokenize(),
  XQuery.stream("//x:row[not(@hidden = '1')] ! concat('row ', @r, ': ', sum(x:c/x:v))", {
    compile: { namespaces: { x: SPREADSHEETML } },
  }),
  Stream.map((item) => XQuery.atomicString(item as XQuery.AtomicValue)),
  Stream.runCollect,
);
Effect.runSync(rows); // ["row 1: 3", "row 3: 5"]
```

A streamable query is a _selection_ followed by _operations_ on each match. `XQuery.compileStream(query, options?)` checks a query (text, or a compiled `Query`) and compiles it once for any number of streams; `XQuery.stream` takes the result, a `Query` or text.

- **The selection** is a path (`/…`, `//…`, or relative to the document node) of `child`, `descendant`, `self` and `descendant-or-self` steps with element tests (a name, `*`, `p:*`, `*:local`, `element(…)`). Its predicates are decided at each start tag: they may read the element's attributes, its name (`local-name()`, `name()`, `namespace-uri()`, `node-name()`), variables, literals and functions of those, and on a `child` step (`//x` included) its position among the siblings seen so far (`[1]`, `[position() < 3]`). `last()` would need the siblings still to come.
- **The operations** are the rest: the path's later steps (`/x:c/x:v`, `/@r`, `/text()`), predicates of the selection's last step that read its content (`row[x:c]`, which must not depend on positions), and the right-hand side of each `!`. They may do anything that stays within the match: not the `parent`, `ancestor`, `preceding` or `following` axes (nor `-sibling` and `-or-self`), paths from the root, `fn:root`, `fn:path`, `fn:id`, `fn:idref`, `fn:element-with-id`, `fn:generate-id` or `fn:function-lookup`, and not `position()` or `last()` of the matches.
- **An XQuery prolog** may declare namespaces, options, functions (whose bodies follow the operations' rules) and variables (whose initializers can't read the context item); not a context item, and no module imports.

A match nested in another match (`//s` inside an `s`) is selected too, after the outer one, as `evaluate` would. Nodes in the results belong to their match, whose ancestors are copies that keep only their names, attributes and namespaces, so `fn:lang`, `fn:base-uri` and in-scope namespaces are the document's. A query outside the subset fails with an `XQueryError` whose code is `XQuery.NotStreamableCode` (`NotStreamable` in `XQuery.ImplementationNamespace`), with a description of what can't be streamed and its offset; dynamic errors fail the stream after the items before them, and well-formedness errors fail it as `Sax.select`'s do. `Sax.select` and `Xsd.select` go through the same analysis, keeping to its `child` / `descendant` steps with predicates on attributes and names.
