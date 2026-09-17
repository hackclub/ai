import { createHighlighter, type Highlighter, type ThemeRegistration } from "shiki";

import ayuLight from "./shiki/ayu-light.json" with { type: "json" };
import { curlJsonInjection } from "./shiki/curl-json-injection";

export type CodeLang = "bash" | "javascript" | "python";

/** Highlighted source: the raw text for copying plus Shiki's HTML for display. */
export type HighlightedCode = { code: string; html: string };

const LANGS: CodeLang[] = ["bash", "javascript", "python"];

// One highlighter per module instance: loading grammars and themes is the slow
// part. Module scope (not globalThis) so Vite's SSR hot reload rebuilds it when
// this file or a grammar changes.
let instance: Promise<Highlighter> | undefined;
const highlighter = () =>
  (instance ??= createHighlighter({
    themes: ["ayu-dark", ayuLight as ThemeRegistration],
    // The injection must be registered before the grammar it injects into.
    langs: [curlJsonInjection, "json", ...LANGS],
  }));

/**
 * Renders code with Ayu Light and Ayu Dark as CSS variables (`--shiki-light`
 * and `--shiki-dark`); src/app.css picks one based on the `.dark` class.
 */
export async function highlight(code: string, lang: CodeLang): Promise<HighlightedCode> {
  const html = (await highlighter()).codeToHtml(code, {
    lang,
    themes: { light: "ayu-light", dark: "ayu-dark" },
    defaultColor: false,
  });
  return { code, html };
}
