import { Marked, Renderer } from "marked";
import markedAlert from "marked-alert";
import markedShiki from "marked-shiki";
import { createHighlighter } from "shiki";
import { readFileSync } from "fs";
import { join } from "path";
import {
  transformerNotationDiff,
  transformerNotationHighlight,
  transformerNotationWordHighlight,
  transformerNotationFocus,
  transformerNotationErrorLevel,
  transformerMetaHighlight,
  transformerMetaWordHighlight,
} from "@shikijs/transformers";
import { env, allowedEmbeddingModels, allowedLanguageModels } from "../env";

const highlighter = await createHighlighter({
  langs: ["bash", "javascript", "json", "markdown", "python", "typescript"],
  themes: ["github-dark-dimmed"],
});

const docsPath = join(process.cwd(), "src", "docs.md");
const exampleModel = allowedLanguageModels[0];
const exampleEmbeddingModel = allowedEmbeddingModels[0];
const markdownContent = readFileSync(docsPath, "utf-8")
  .replace(/{{BASE_URL}}/g, env.BASE_URL)
  .replace(/{{FIRST_LANGUAGE_MODEL}}/g, exampleModel)
  .replace(/{{FIRST_EMBEDDING_MODEL}}/g, exampleEmbeddingModel);

const toc: { id: string; text: string; level: number }[] = [];
const tocRenderer = new Renderer();
tocRenderer.heading = ({ text, depth }: { text: string; depth: number }) => {
  const id = text.toLowerCase().replace(/[^\w]+/g, "-");
  if (depth > 1 && depth < 4) {
    toc.push({ id, text, level: depth });
  }
  return `<h${depth} id="${id}">${text}</h${depth}>`;
};

const markedInstance = new Marked().use(markedAlert()).use(
  markedShiki({
    highlight(code, lang, props) {
      return highlighter.codeToHtml(code, {
        lang,
        theme: "github-dark-dimmed",
        meta: { __raw: props.join(" ") },
        transformers: [
          transformerNotationDiff({ matchAlgorithm: "v3" }),
          transformerNotationHighlight({ matchAlgorithm: "v3" }),
          transformerNotationWordHighlight({ matchAlgorithm: "v3" }),
          transformerNotationFocus({ matchAlgorithm: "v3" }),
          transformerNotationErrorLevel({ matchAlgorithm: "v3" }),
          transformerMetaHighlight(),
          transformerMetaWordHighlight(),
        ],
      });
    },
  }),
);

markedInstance.use({ renderer: tocRenderer });

const htmlContent = await markedInstance.parse(markdownContent);

export { htmlContent, toc };
