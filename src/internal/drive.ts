/**
 * The lexer's drive loop.
 *
 * Every driver pulls the lexer one token at a time and reacts to each output
 * before the next token is read (the HTML tree builder switches raw text off
 * inside foreign content; the SAX layer stops at a resource limit). This runs
 * once per token of every document, so it is a plain loop: an `Arr.unfold`
 * here allocates per token and measurably slows every parser.
 */

/**
 * Pull batches until `pull` returns `null`, handing each item to `f` in order;
 * stop at the first item `f` returns `false` for.
 */
export const drive = <A>(pull: () => ReadonlyArray<A> | null, f: (item: A) => boolean): void => {
  for (let batch = pull(); batch !== null; batch = pull()) {
    for (const item of batch) if (!f(item)) return;
  }
};
