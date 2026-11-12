# Typed errors

Everything fails through typed errors (`Schema.TaggedError`, unioned as `SaxError`), and the pipeline is ordinary `Stream` / `Effect` combinators. Back to the [README](https://github.com/thomasfosterau/effect-xml/blob/trunk/README.md).

Every failure is a tagged class in the `SaxError` union, so it narrows exhaustively:

```ts
import * as Effect from "effect/Effect";
import { Xml } from "@thomasfosterau/effect-xml";

const program = Xml.parse("<a></b>").pipe(
  Effect.catchTags({
    MismatchedEndTag: (e) => Effect.succeed(`expected </${e.expected}>`),
    UnexpectedEndTag: (e) => Effect.succeed(e.message),
    UnboundNamespacePrefix: (e) => Effect.succeed(e.message),
    InvalidNamespace: (e) => Effect.succeed(e.message),
    DuplicateAttribute: (e) => Effect.succeed(e.message),
    InvalidEntity: (e) => Effect.succeed(e.message),
    MalformedDeclaration: (e) => Effect.succeed(e.message),
    UnexpectedCharacter: (e) => Effect.succeed(e.message),
    UnexpectedEndOfInput: (e) => Effect.succeed(e.message),
    InvalidDocumentStructure: (e) => Effect.succeed(e.message),
    LimitExceeded: (e) => Effect.succeed(`over ${e.limit}`),
    UnsupportedEncoding: (e) => Effect.succeed(e.message),
    InvalidByteSequence: (e) => Effect.succeed(e.message),
  }),
);
```

Each error carries a human-readable `message`, and a `position` (`offset` / `line` / `column`) when it has one: the decoding errors report a byte `offset` instead, and `LimitExceeded`'s `position` is an `Option`, `Option.none()` when the limit is hit while decoding bytes. `isSaxError(u)` recognises any of them. `XmlDocument.root` throws `MissingRootElement` only for a hand-built document with no element (the parsers never produce one).
