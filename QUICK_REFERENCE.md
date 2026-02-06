# Quick Reference Guide

## Installation

```bash
bun add effect-sax effect @effect/schema @effect/platform
```

## Import

```typescript
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  // Core
  createMessageStream,
  collectMessages,
  
  // Message types
  ElementStart,
  ElementEnd,
  ContentChunk,
  MarkupNote,
  RawDataSection,
  MetaInstruction,
  TypeDeclaration,
  
  // Operations
  isolateStarts,
  isolateEnds,
  isolateContent,
  selectByTag,
  harvestTagContent,
  quantifyTag,
  aggregateProperties,
  transformStream,
  foldMessages,
} from "effect-sax";
```

## Basic Usage

```typescript
// Parse to array
const program = Effect.gen(function* (_) {
  const messages = yield* _(collectMessages(markup));
  for (const msg of messages) {
    console.log(msg);
  }
});

Effect.runPromise(program);
```

## Streaming Usage

```typescript
// Create stream
const msgFlow = createMessageStream(markup, {
  collapseWhitespace: true,
  preserveEmptyText: false
});

// Process stream
yield* _(
  msgFlow,
  Stream.runForEach((msg) => Effect.sync(() => console.log(msg)))
);
```

## Common Patterns

### Extract all opening tags

```typescript
const openings = isolateStarts(msgFlow);
```

### Extract text content from specific tags

```typescript
const titles = harvestTagContent(msgFlow, "title");
yield* _(
  titles,
  Stream.runForEach((title) => Effect.sync(() => console.log(title)))
);
```

### Count elements

```typescript
const count = yield* _(quantifyTag(msgFlow, "product"));
```

### Get all attributes from tags

```typescript
const attrs = yield* _(aggregateProperties(msgFlow, "product"));
// Returns: Array<Record<string, string>>
```

### Filter by tag

```typescript
const productMsgs = selectByTag(msgFlow, "product");
```

### Transform messages

```typescript
const transformed = transformStream(msgFlow, (msg) => {
  if (msg instanceof ElementStart) {
    return { name: msg.tagIdentifier, attrs: msg.propertyBag };
  }
  return null;
});
```

### Fold/reduce messages

```typescript
const result = yield* _(
  foldMessages(
    msgFlow,
    { count: 0 },
    (state, msg) => {
      if (msg instanceof ElementStart) {
        return { count: state.count + 1 };
      }
      return state;
    }
  )
);
```

## Message Types

All messages extend base with `messageId` and `byteOffset`.

### ElementStart
```typescript
{
  messageId: string,
  byteOffset: number,
  tagIdentifier: string,
  propertyBag: Record<string, string>,
  standalone: boolean
}
```

### ElementEnd
```typescript
{
  messageId: string,
  byteOffset: number,
  tagIdentifier: string
}
```

### ContentChunk
```typescript
{
  messageId: string,
  byteOffset: number,
  payload: string
}
```

### MarkupNote (Comment)
```typescript
{
  messageId: string,
  byteOffset: number,
  noteText: string
}
```

### RawDataSection (CDATA)
```typescript
{
  messageId: string,
  byteOffset: number,
  rawContent: string
}
```

### MetaInstruction (Processing Instruction)
```typescript
{
  messageId: string,
  byteOffset: number,
  instructionTag: string,
  instructionPayload: string
}
```

### TypeDeclaration (DOCTYPE)
```typescript
{
  messageId: string,
  byteOffset: number,
  declarationBody: string
}
```

## Configuration

```typescript
interface ProcessorConfig {
  collapseWhitespace?: boolean;    // Trim & normalize (default: true)
  preserveEmptyText?: boolean;     // Keep empty chunks (default: false)
  strictValidation?: boolean;      // Strict mode (default: false)
}
```

## Running Examples

```bash
bun run example
```

## Running Tests

```bash
bun test
```
