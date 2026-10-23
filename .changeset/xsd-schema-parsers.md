---
"@thomasfosterau/effect-xml": minor
---

Add XML Schema support (`@thomasfosterau/effect-xml/Xsd`): compile an XSD 1.0 schema (with its includes and imports) into a serializable `Model`, validate documents against it as they stream, failing at the first violation with a typed `XsdValidationError` (rule, path and position), and get typed values back (`Xsd.parse`, `parseStream`, `parseBytes`, `decode`, `validate`, `parser`). `Xsd.generate` writes a TypeScript module from a schema: an interface or alias per type, the compiled model, and a typed parser per global element.
