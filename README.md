# effect-sax

Type-safe streaming XML parser built with the Effect ecosystem and powered by Bun.

## Overview

effect-sax provides a fully type-safe, streaming XML parser that leverages Effect's powerful Stream and Schema capabilities. Parse XML documents efficiently with composable, functional operations.

## Key Features

- 🎯 **Type Safety**: Full TypeScript types using Effect Schema classes
- 🌊 **Streaming**: Memory-efficient processing with Effect Streams
- ⚡ **Fast**: Optimized for Bun runtime
- 🔧 **Composable**: Functional API built on Effect primitives
- 🎨 **Flexible**: Filter, transform, and extract data with ease

## Installation

```bash
bun add effect-sax effect @effect/schema @effect/platform
```

## Quick Start

### Basic Parsing

```typescript
import * as Eff from "effect/Effect";
import { gatherSignals, TagOpened } from "effect-sax";

const xmlDoc = `
  <catalog>
    <product id="123">
      <name>Laptop</name>
      <price>999</price>
    </product>
  </catalog>
`;

const program = Eff.gen(function* (_) {
  const signals = yield* _(gatherSignals(xmlDoc));
  
  for (const sig of signals) {
    if (sig instanceof TagOpened) {
      console.log(`Element: ${sig.elementName}`, sig.attrs);
    }
  }
});

Eff.runPromise(program);
```

### Streaming Operations

```typescript
import * as Eff from "effect/Effect";
import * as Str from "effect/Stream";
import { generateSignalStream, captureElementText } from "effect-sax";

const program = Eff.gen(function* (_) {
  const flow = generateSignalStream(xmlDoc);
  const productNames = captureElementText(flow, "name");
  
  yield* _(
    productNames,
    Str.runForEach((name) =>
      Eff.sync(() => console.log("Product:", name))
    )
  );
});
```

### Filtering Signals

```typescript
import { generateSignalStream, keepOpenings } from "effect-sax";

const flow = generateSignalStream(xmlDoc);
const openTags = keepOpenings(flow);

// Process only opening tags
Str.runForEach(openTags, (tag) =>
  Eff.sync(() => console.log(`<${tag.elementName}>`, tag.attrs))
);
```

## API Reference

### Core Functions

#### `generateSignalStream(xmlInput, config?)`
Create a stream of XML signals from a string.

```typescript
const flow = generateSignalStream(xmlDoc, {
  trimWhitespace: true,
  normalizeSpaces: true
});
```

#### `gatherSignals(xmlInput, config?)`
Parse XML and collect all signals into an array.

```typescript
const signals = await Eff.runPromise(gatherSignals(xmlDoc));
```

### Stream Filters

- **`keepOpenings(flow)`** - Filter to only tag opening signals
- **`keepClosings(flow)`** - Filter to only tag closing signals
- **`keepCharData(flow)`** - Filter to only character data signals
- **`selectByElement(flow, elemId)`** - Select signals matching element name
- **`captureElementText(flow, elemId)`** - Extract text content from elements

### Utility Functions

- **`countElement(flow, elemId)`** - Count occurrences of an element
- **`gatherElementAttrs(flow, elemId)`** - Collect attributes from matching elements

## Signal Types

All signals are Effect Schema classes for full type safety:

- **`TagOpened`** - Element opening with name, attributes, and self-closing flag
- **`TagClosed`** - Element closing with name
- **`CharData`** - Text content
- **`Annotation`** - XML comment
- **`CDataBlock`** - CDATA section
- **`Directive`** - Processing instruction (e.g., `<?xml ... ?>`)
- **`DocumentTypeDecl`** - DOCTYPE declaration

## Configuration

```typescript
interface StreamConfig {
  trimWhitespace?: boolean;    // Remove leading/trailing spaces (default: true)
  normalizeSpaces?: boolean;   // Collapse multiple spaces (default: true)
  enforceStrict?: boolean;     // Strict XML validation (default: false)
}
```

## Examples

Check the `demo/` directory for complete examples:

```bash
bun run demo
```

## Testing

Run the test suite:

```bash
bun test
```

## Development

Built with Bun and Effect:

```bash
# Install dependencies
bun install

# Run demonstrations
bun run demo/showcase.ts

# Run tests
bun test spec/
```

## Architecture

effect-sax uses a scanner-based architecture:

1. **Scanner** - Tokenizes raw XML into signal chunks
2. **Streaming** - Processes signals through Effect Streams
3. **Schema** - Validates and types signals with Effect Schema

This design enables efficient memory usage for large XML documents through streaming, while maintaining full type safety.

## License

MIT
