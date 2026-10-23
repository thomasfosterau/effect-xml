---
"@thomasfosterau/effect-xml": minor
---

Require `@thomasfosterau/effect-parse` `^0.2.0` (the peer range was `^0.1.0`): a consumer on effect-parse 0.1 must upgrade it alongside this release. The lexer, raw-text, entity and name grammars are now compiled with effect-parse's JIT and run through `Parser.run`, which roughly doubles SAX throughput. Events, spans and errors are unchanged.
