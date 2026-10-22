/**
 * Parsing benchmarks. Run with `bun bench/parse.ts [megabytes]`.
 *
 * The input is a generated SpreadsheetML worksheet (the shape of a large
 * XLSX `sheet1.xml`, about 8 MB by default). effect-sax is measured as a SAX
 * stream (whole string and 64 KiB chunks), as bytes, as a DOM, and with
 * streaming selection of rows.
 *
 * Other parsers are compared when they are installed, without being
 * dependencies of this package: `bun add -d saxes sax fast-xml-parser`
 * (and remove them again) to include them.
 */
import { Effect, Stream } from "effect";
import { Sax, Xml } from "../src/index.ts";

const SML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const megabytes = Number(process.argv[2] ?? 8);

const sheet = (bytes: number): string => {
  const rows: Array<string> = [];
  let size = 0;
  for (let r = 1; size < bytes; r++) {
    let row = `<row r="${r}" spans="1:8">`;
    for (let c = 0; c < 8; c++) {
      const ref = `${String.fromCharCode(65 + c)}${r}`;
      row +=
        c % 3 === 0
          ? `<c r="${ref}" t="s"><v>${(r * 7 + c) % 1000}</v></c>`
          : `<c r="${ref}" s="1"><v>${(r * c) / 7}</v></c>`;
    }
    row += "</row>";
    rows.push(row);
    size += row.length;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${SML}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>${rows.join("")}</sheetData></worksheet>`;
};

const input = sheet(megabytes * 1024 * 1024);
const bytes = new TextEncoder().encode(input);
const chunks = input.match(/[\s\S]{1,65536}/g)!;

const time = async (name: string, run: () => unknown | Promise<unknown>, runs = 5) => {
  await run(); // warm up
  const samples: Array<number> = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)]!;
  const mbps = input.length / 1024 / 1024 / (median / 1000);
  console.log(
    `${name.padEnd(36)} ${median.toFixed(0).padStart(6)} ms  ${mbps.toFixed(1).padStart(6)} MB/s`,
  );
};

const optional = async (pkg: string): Promise<any> => {
  try {
    return await import(pkg);
  } catch {
    return undefined;
  }
};

console.log(`input: ${(input.length / 1024 / 1024).toFixed(1)} MB worksheet\n`);

await time("effect-sax SAX (string)", () =>
  Effect.runPromise(Sax.tokenizeString(input).pipe(Stream.runDrain)),
);
await time("effect-sax SAX (64 KiB chunks)", () =>
  Effect.runPromise(Stream.fromIterable(chunks).pipe(Sax.tokenize(), Stream.runDrain)),
);
await time("effect-sax SAX (bytes)", () =>
  Effect.runPromise(Stream.make(bytes).pipe(Sax.tokenizeBytes(), Stream.runDrain)),
);
await time("effect-sax DOM (Xml.parse)", () => Effect.runPromise(Xml.parse(input)));
if ("select" in Sax) {
  await time("effect-sax rows (Sax.select)", () =>
    Effect.runPromise(
      Stream.make(input).pipe(
        Sax.tokenize(),
        (Sax as any).select("//x:row", { namespaces: { x: SML } }),
        Stream.runDrain,
      ) as Effect.Effect<void>,
    ),
  );
}

const saxes = await optional("saxes");
if (saxes) {
  await time("saxes (SAX)", () => {
    const p = new saxes.SaxesParser({ xmlns: true });
    p.on("opentag", () => {});
    p.write(input).close();
  });
}
const sax = await optional("sax");
if (sax) {
  await time("sax (SAX)", () => {
    const p = sax.parser(true, { xmlns: true });
    p.onopentag = () => {};
    p.write(input).close();
  });
}
const fxp = await optional("fast-xml-parser");
if (fxp) {
  await time("fast-xml-parser (DOM)", () =>
    new fxp.XMLParser({ ignoreAttributes: false }).parse(input),
  );
}
