/**
 * Parsing benchmarks. Run with `vp run bench` (or `vp exec tsx bench/parse.ts
 * [megabytes]`).
 *
 * The input is a generated SpreadsheetML worksheet (the shape of a large
 * XLSX `sheet1.xml`, about 8 MB by default). effect-xml is measured as a SAX
 * stream (whole string and 64 KiB chunks), as bytes, as a DOM, with
 * streaming selection of rows, and validated against a schema for the
 * worksheet (as events, and as typed values). HTML is measured with
 * `Html.parseDocument` and `Html.parseFragment` on a generated page that
 * exercises formatting elements, implied end tags, tables, foreign content,
 * entities and CRLF line ends (the input of #13).
 *
 * Other parsers are compared when they are installed, without being
 * dependencies of this package: `pnpm add -D saxes sax fast-xml-parser`
 * (and revert `package.json`, `pnpm-workspace.yaml` and `pnpm-lock.yaml`
 * afterwards) to include them.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Stream from "effect/Stream";
import { Html, Sax, Xml, Xsd } from "../src/index.ts";

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

/** The part of the SpreadsheetML schema the generated worksheet uses. */
const worksheetSchema = `
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns="${SML}" targetNamespace="${SML}"
           elementFormDefault="qualified">
  <xs:simpleType name="ST_CellType"><xs:restriction base="xs:string">
    <xs:enumeration value="b"/><xs:enumeration value="n"/><xs:enumeration value="e"/>
    <xs:enumeration value="s"/><xs:enumeration value="str"/><xs:enumeration value="inlineStr"/>
  </xs:restriction></xs:simpleType>
  <xs:complexType name="CT_Cell">
    <xs:sequence><xs:element name="v" type="xs:string" minOccurs="0"/></xs:sequence>
    <xs:attribute name="r" type="xs:string"/>
    <xs:attribute name="s" type="xs:unsignedInt" default="0"/>
    <xs:attribute name="t" type="ST_CellType" default="n"/>
  </xs:complexType>
  <xs:complexType name="CT_Row">
    <xs:sequence><xs:element name="c" type="CT_Cell" minOccurs="0" maxOccurs="unbounded"/></xs:sequence>
    <xs:attribute name="r" type="xs:unsignedInt"/>
    <xs:attribute name="spans" type="xs:string"/>
  </xs:complexType>
  <xs:element name="worksheet"><xs:complexType><xs:sequence>
    <xs:element name="sheetData"><xs:complexType><xs:sequence>
      <xs:element name="row" type="CT_Row" minOccurs="0" maxOccurs="unbounded"/>
    </xs:sequence></xs:complexType></xs:element>
  </xs:sequence></xs:complexType></xs:element>
</xs:schema>`;

const input = sheet(megabytes * 1024 * 1024);
const bytes = new TextEncoder().encode(input);
const chunks = input.match(/[\s\S]{1,65536}/g) ?? [];

const time = async (
  name: string,
  run: () => void | Promise<void>,
  runs = 5,
  size = input.length,
) => {
  await run(); // warm up
  const samples: Array<number> = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  const median = Arr.sort(samples, Order.Number)[Math.floor(samples.length / 2)] ?? 0;
  const mbps = size / 1024 / 1024 / (median / 1000);
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

await time("effect-xml SAX (string)", () =>
  Effect.runPromise(Sax.tokenizeString(input).pipe(Stream.runDrain)),
);
await time("effect-xml SAX (64 KiB chunks)", () =>
  Effect.runPromise(Stream.fromIterable(chunks).pipe(Sax.tokenize(), Stream.runDrain)),
);
await time("effect-xml SAX (bytes)", () =>
  Effect.runPromise(Stream.make(bytes).pipe(Sax.tokenizeBytes(), Stream.runDrain)),
);
await time("effect-xml DOM (Xml.parse)", () => Effect.runPromise(Effect.asVoid(Xml.parse(input))));
await time("effect-xml rows (Sax.select)", () =>
  Effect.runPromise(
    Stream.make(input).pipe(
      Sax.tokenize(),
      Sax.select("//x:row", { namespaces: { x: SML } }),
      Stream.runDrain,
    ),
  ),
);

const model = await Effect.runPromise(Xsd.compile(worksheetSchema));
await time("effect-xml XSD events (Xsd.validate)", () =>
  Effect.runPromise(
    Stream.fromIterable(chunks).pipe(Sax.tokenize(), Xsd.validate(model), Stream.runDrain),
  ),
);
await time("effect-xml XSD values (Xsd.parse)", () =>
  Effect.runPromise(Effect.asVoid(Xsd.parse(model, input))),
);

// The same megabytes of HTML: a block that runs the adoption agency
// (misnested <b>/<i>), implied end tags (<p>, <td>), table insertion modes,
// SVG foreign content, a character reference and CRLF line ends.
const htmlBlock = (n: number): string =>
  `<div class="x"><p>Hello <b>world <i>${n}</b> &amp; more</i></p>` +
  `<table><tr><td>x<td>y</table><svg><rect/></svg></div>\r\n`;
const html = ((): string => {
  const blocks: Array<string> = [];
  let size = 0;
  for (let n = 0; size < megabytes * 1024 * 1024; n++) {
    const block = htmlBlock(n);
    blocks.push(block);
    size += block.length;
  }
  return `<!DOCTYPE html><html><head><title>bench</title></head><body>${blocks.join("")}</body></html>`;
})();
console.log("");
await time(
  "effect-xml HTML (Html.parseDocument)",
  () => Effect.runPromise(Effect.asVoid(Html.parseDocument(html))),
  5,
  html.length,
);
await time(
  "effect-xml HTML (Html.parseFragment)",
  () => Effect.runPromise(Effect.asVoid(Html.parseFragment(html))),
  5,
  html.length,
);

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
