const QUOTES: string[] = [
  "what's cooking?",
  "it's time to cheese",
  "talk is cheap, show me the code",
  "running on v3!",
  "now with ai!",
  "code is cheap, show me the talk",
  "the fable of fable",
  "the <u>deep</u> urge to <u>seek</u> something new",
  "from the makers of hack club ai",
  "the new HCAI is my magnum opus",
  "i'm <u>thinking</u> about you",
  "<u>whisper</u> me your secrets",
];

export type PickedQuote = { index: number; text: string };

/** Picks one quote at random, never repeating `excludeIndex` when another is available. */
export const randomQuote = (excludeIndex?: number): PickedQuote => {
  const candidates = QUOTES.map((text, index) => ({ index, text })).filter(
    (quote) => quote.index !== excludeIndex,
  );
  const pool = candidates.length > 0 ? candidates : QUOTES.map((text, index) => ({ index, text }));
  return pool[Math.floor(Math.random() * pool.length)]!;
};
