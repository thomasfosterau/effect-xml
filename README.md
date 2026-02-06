# effect-sax

Message-based reactive XML processing built with Effect ecosystem and Bun runtime.

## Philosophy

effect-sax uses a unique **message-passing architecture** where XML parsing generates typed messages that flow through Effect Streams. This reactive approach enables efficient processing of large documents with full type safety.

## Features

- 🎯 **Message-Based**: XML elements become strongly-typed messages
- 🌊 **Reactive Streams**: Built on Effect's powerful Stream API
- 🔒 **Type-Safe**: Effect Schema classes for compile-time and runtime safety
- ⚡ **Bun-Powered**: Optimized for Bun runtime
- 📍 **Position Tracking**: Every message includes byte offset and unique ID
- 🎨 **Composable**: Functional reactive operations

## Installation

```bash
bun add effect-sax effect @effect/schema @effect/platform
```

## Quick Start

```typescript
import * as Effect from "effect/Effect";
import { collectMessages, ElementStart } from "effect-sax";

const markup = `
  <catalog>
    <product sku="123">
      <itemName>Laptop</itemName>
      <retailPrice>999</retailPrice>
    </product>
  </catalog>
`;

const program = Effect.gen(function* (_) {
  const messages = yield* _(collectMessages(markup));
  
  for (const msg of messages) {
    if (msg instanceof ElementStart) {
      console.log(`Element: ${msg.tagIdentifier}`, msg.propertyBag);
    }
  }
});

Effect.runPromise(program);
```

## Message Types

All messages are Effect Schema classes:

- **`ElementStart`** - Opening tag with `tagIdentifier`, `propertyBag`, and `standalone` flag
- **`ElementEnd`** - Closing tag with `tagIdentifier`
- **`ContentChunk`** - Text content with `payload`
- **`MarkupNote`** - XML comment with `noteText`
- **`RawDataSection`** - CDATA with `rawContent`
- **`MetaInstruction`** - Processing instruction with `instructionTag` and `instructionPayload`
- **`TypeDeclaration`** - DOCTYPE with `declarationBody`

Each message includes:
- `messageId` - Unique identifier
- `byteOffset` - Position in input stream

## Reactive Operations

### Create Message Streams

```typescript
import { createMessageStream } from "effect-sax";

const msgFlow = createMessageStream(markup, {
  collapseWhitespace: true,
  preserveEmptyText: false
});
```

### Isolate Message Types

```typescript
import { isolateStarts, isolateContent } from "effect-sax";

const openings = isolateStarts(msgFlow);
const textContent = isolateContent(msgFlow);
```

### Harvest Content

```typescript
import { harvestTagContent } from "effect-sax";

const program = Effect.gen(function* (_) {
  const msgFlow = createMessageStream(markup);
  const productNames = harvestTagContent(msgFlow, "itemName");
  
  yield* _(
    productNames,
    Stream.runForEach((name) =>
      Effect.sync(() => console.log("Product:", name))
    )
  );
});
```

## API Reference

### Core Functions

- `createMessageStream(markup, config?)` - Generate reactive message stream
- `collectMessages(markup, config?)` - Parse and collect all messages
- `processMarkup(input)` - Low-level processor returning Chunk

### Stream Isolators

- `isolateStarts(stream)` - Filter to ElementStart messages
- `isolateEnds(stream)` - Filter to ElementEnd messages
- `isolateContent(stream)` - Filter to ContentChunk messages

### Stream Selectors

- `selectByTag(stream, tagId)` - Select messages matching tag identifier
- `harvestTagContent(stream, tagId)` - Extract text between matching tags

### Aggregators

- `quantifyTag(stream, tagId)` - Count occurrences of tag
- `aggregateProperties(stream, tagId)` - Collect property bags

### Utilities

- `transformStream(stream, mapper)` - Apply custom transformation
- `foldMessages(stream, initial, reducer)` - Fold/reduce messages
- `applyValidation(schema)` - Validate with custom Schema

## Examples

Run the included example:

```bash
bun run example
```

## Testing

```bash
bun test
```

## License

MIT
