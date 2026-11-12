---
"@thomasfosterau/effect-xml": minor
---

Optional members and parameters are spelled `x?: T`, no longer `x?: T | undefined` (#68). The package compiles with `exactOptionalPropertyTypes`, so the old spelling accepted an explicit `undefined` and the new one does not.

**Breaking:** a caller can no longer pass `undefined` explicitly to an optional option (`{ limits: maybeLimits }` where `maybeLimits` may be `undefined`); it omits the key instead. Passing the options object through unchanged, or building it so the key is only present when there is a value, needs no other change. At runtime nothing differs: an explicit `undefined` is still read as absent.

The public types affected, by module (import by subpath):

- `Sax`: `SaxOptions`, `SaxBytesOptions` and `ForEachOptions`.
- `Xml`: `ParseOptions` and `ParseBytesOptions`, `BuildOptions`, `PlainOptions`, `CursorOptions`, `C14nOptions`, `WriterOptions` and `WriterEvent` (`StartElement.inline`, and the `start` constructor's `inline` parameter), `XPath.CompileOptions` and `XPath.EvaluateOptions`, and in `Bind` `FieldBinding`, `ElementName`, `NameOptions`, `ElementOptions`, `DecodeOptions` and `EncodeOptions`.
- `Html`: `HtmlBytesOptions`, `HtmlFragmentOptions` and the options of `buildFragment`.
- `Xsd`: `ParseOptions` and `ValidateOptions` (`Validate`), `CompileOptions`, `GenerateOptions`, and the compiled `Model` types `ElementParticle`, `AnyParticle`, `GroupParticle`, `Facets`, `SimpleType`, `AttributeUse`, `ComplexType`, `ElementDeclaration` and `IdentityConstraint`. A `Model` built by hand must leave a member out rather than set it to `undefined`.
- `XQuery`: `CompileOptions` (and the static-context options it extends), `EvaluateOptions` (and the dynamic-context options it extends), `StaticResources` and `ResourceResolver`.
- `Encoding`: `DecodeOptions` and `SniffOptions`.
- `Limits`: unchanged.
