import type { LanguageRegistration } from "shiki";

export const curlJsonInjection: LanguageRegistration = {
  name: "curl-json-injection",
  scopeName: "source.shell.curl-json",
  injectTo: ["source.shell"],
  injectionSelector: "L:source.shell -comment",
  embeddedLangs: ["json"],
  patterns: [{ include: "#json-data-argument" }],
  repository: {
    "json-data-argument": {
      begin: "(?<=(?:-d|--data|--data-raw|--json)\\s)(')(?=\\s*[\\[{])",
      beginCaptures: { 1: { name: "punctuation.definition.string.begin.shell" } },
      end: "'",
      endCaptures: { 0: { name: "punctuation.definition.string.end.shell" } },
      contentName: "meta.embedded.block.json source.json",
      patterns: [{ include: "source.json" }],
    },
  },
};
