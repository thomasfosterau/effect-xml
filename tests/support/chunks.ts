/**
 * Splitting test input into chunks, for checking that chunk boundaries never
 * change the output.
 */

/** `s` in pieces of `size` characters (the last may be shorter); none for `""`. */
export const splitEvery = (s: string, size: number): ReadonlyArray<string> =>
  Array.from({ length: Math.ceil(s.length / size) }, (_, i) => s.slice(i * size, i * size + size));

/** `bytes` in pieces of `size` bytes (the last may be shorter); none when empty. */
export const splitBytes = (bytes: Uint8Array, size: number): ReadonlyArray<Uint8Array> =>
  Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) =>
    bytes.subarray(i * size, i * size + size),
  );

/** The bytes of `parts`, in order, as one array. */
export const concatBytes = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((offset, p) => {
    out.set(p, offset);
    return offset + p.length;
  }, 0);
  return out;
};
