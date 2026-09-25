import { abuseRulesPath } from "../env";
import { log } from "../log";

export type Toolset = { name: string; tools: string[]; minMatches: number };

/**
 * One set of rules. The real rules live in the private `secrets` submodule so
 * they are not published; checkouts without it run with none.
 */
export type AbuseRuleSet = {
  /** Matched against the Referer and X-Title headers. */
  apps: string[];
  userAgents: string[];
  /**
   * Phrases an agent always sends in its own instructions or tool
   * descriptions, grouped by agent. Compared as words: case, punctuation,
   * line breaks, JSON escaping, accents, invisible characters and look-alike
   * letters do not matter. User messages are read only by the
   * `firstUserMessage` detector.
   */
  prompts: Record<string, string[]>;
  /** A request offering at least `minMatches` of an agent's tools is that agent. */
  toolsets: Toolset[];
};

export type DetectorMode = "enforce" | "shadow" | "off";

export type Detectors = {
  /** Instructions containing most of the word triples of a long prompt: a reworded copy of it. */
  similarPrompts: DetectorMode;
  /** A prompt in the first user message of a request that sends no instructions of its own. */
  firstUserMessage: DetectorMode;
  /** The same tool shapes as a request already refused under a current rule, whatever the tools are named. */
  learnedToolsets: DetectorMode;
};

/**
 * The enforced rules refuse a request; `shadow` rules only record their
 * matches, so a new rule can be checked against real traffic first. The
 * detectors start in shadow unless the rules file says otherwise.
 */
export type AbuseRules = AbuseRuleSet & { shadow: AbuseRuleSet; detectors: Detectors };

export type AbuseMatchKind =
  | "app"
  | "user_agent"
  | "prompt"
  | "toolset"
  | "similar_prompt"
  | "user_prompt"
  | "learned_toolset";

/** `rule` is the app, User-Agent, agent, toolset or fingerprint that matched. */
export type AbuseMatch = { kind: AbuseMatchKind; rule: string; enforced: boolean };

export type AbuseVerdict = {
  match: AbuseMatch | null;
  /** The request's toolset fingerprint, or null when it offers too few tools to have one. */
  fingerprint: string | null;
};

const EMPTY_SET: AbuseRuleSet = { apps: [], userAgents: [], prompts: {}, toolsets: [] };
const DEFAULT_DETECTORS: Detectors = { similarPrompts: "shadow", firstUserMessage: "shadow", learnedToolsets: "shadow" };

export const NO_RULES: AbuseRules = {
  ...EMPTY_SET,
  shadow: EMPTY_SET,
  detectors: { similarPrompts: "off", firstUserMessage: "off", learnedToolsets: "off" },
};

export const BLOCKED_MESSAGE =
  "For now, AI coding agents and frontends like SillyTavern aren't allowed to be used with ai.hackclub.com. Join #hackclub-ai on the Hack Club Slack for future updates.";

/** Longest instruction or tool description read; an agent's identity is at its start. */
const TEXT_LIMIT = 256 * 1024;
/** Prompts shorter than this are too generic to match by similarity; they match exactly or not at all. */
const SIMILAR_MIN_WORDS = 8;
/** Share of a prompt's word triples the instructions must contain. One changed word in twelve still matches; two do not. */
const SIMILAR_THRESHOLD = 0.6;
const SIMILAR_WORD_LIMIT = 64 * 1024;
/** Fewer tools with parameters than this are too common a shape to fingerprint. */
const FINGERPRINT_MIN_TOOLS = 5;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

/** Text of a message `content`: a string, or the `text` of each part. */
const textOf = (content: unknown): string[] => {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) =>
    typeof part === "string" ? [part] : isRecord(part) && typeof part.text === "string" ? [part.text] : [],
  );
};

const INSTRUCTION_ROLES = new Set(["system", "developer"]);

export type AgentTool = {
  name: string;
  description: string;
  /**
   * The tool's parameters as sorted `name:type` pairs, `!` marking required
   * ones: what survives an agent renaming its tools.
   */
  shape: string;
};

export type AgentSurface = {
  instructions: string[];
  tools: AgentTool[];
  /** The first user message, read only when there are no instructions. */
  firstUserMessage: string[];
};

const shapeOf = (definition: Json) => {
  const schema = [definition.parameters, definition.input_schema, definition.inputSchema].find(isRecord);
  if (!schema || !isRecord(schema.properties)) return "";
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(schema.properties)
    .map(([name, property]) => {
      const type = isRecord(property) ? [property.type].flat().filter((t) => typeof t === "string").join("|") : "";
      return `${name}:${type}${required.has(name) ? "!" : ""}`;
    })
    .sort()
    .join(",");
};

/**
 * The parts of a request an agent writes, not its user: system and developer
 * messages (Chat Completions, Responses `input`), Anthropic's `system`,
 * Responses' `instructions`, Replicate's `input.system_prompt`, and the tools.
 */
export const agentSurface = (body: unknown): AgentSurface => {
  if (!isRecord(body)) return { instructions: [], tools: [], firstUserMessage: [] };
  const instructions = [...textOf(body.system), ...textOf(body.instructions)];
  let firstUserMessage: string[] | null = null;
  for (const list of [body.messages, body.input]) {
    if (!Array.isArray(list)) continue;
    for (const message of list) {
      if (!isRecord(message)) continue;
      if (INSTRUCTION_ROLES.has(message.role as string)) instructions.push(...textOf(message.content));
      else if (message.role === "user") firstUserMessage ??= textOf(message.content);
    }
  }
  if (isRecord(body.input)) instructions.push(...textOf(body.input.system_prompt));
  const tools = Array.isArray(body.tools)
    ? body.tools.flatMap((tool): AgentTool[] => {
        if (!isRecord(tool)) return [];
        const definition = isRecord(tool.function) ? tool.function : tool;
        return typeof definition.name === "string"
          ? [
              {
                name: definition.name,
                description: typeof definition.description === "string" ? definition.description : "",
                shape: shapeOf(definition),
              },
            ]
          : [];
      })
    : [];
  return { instructions, tools, firstUserMessage: instructions.length === 0 ? (firstUserMessage ?? []) : [] };
};

/**
 * Letters from other scripts that pass for Latin ones. NFKD already folds
 * fullwidth and mathematical letters; these have no decomposition.
 */
const LOOKALIKES: Record<string, string> = Object.fromEntries(
  [
    // Cyrillic
    "Аa Вb Еe Кk Мm Нh Оo Рp Сc Тt Уy Хx Ѕs Іi Јj Ԁd Ԛq Ԝw Һh Ӏl",
    "аa еe оo рp сc уy хx ѕs іi јj ԁd ԛq ԝw һh ӏl үy",
    // Greek
    "Αa Βb Εe Ζz Ηh Ιi Κk Μm Νn Οo Ρp Τt Υy Χx αa οo ρp ιi κk νv υu χx",
    // Latin letters outside ASCII that NFKD leaves alone
    "ıi ɑa ɡg",
  ]
    .join(" ")
    .split(" ")
    .map((pair) => [pair.slice(0, -1), pair.slice(-1)] as const),
);
const LOOKALIKE = new RegExp(`[${Object.keys(LOOKALIKES).join("")}]`, "gu");
const INVISIBLE = /\p{Cf}/gu;
const HAS_INVISIBLE = /\p{Cf}/u;

const words = (text: string) => ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
const fold = (text: string) =>
  text
    .slice(0, TEXT_LIMIT)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(LOOKALIKE, (letter) => LOOKALIKES[letter] ?? letter);

/**
 * Words only, padded so that a phrase matches whole words: " you are claude code ".
 * Invisible characters are dropped, so they cannot split a word.
 */
export const normalizeText = (text: string) => words(fold(text).replace(INVISIBLE, ""));

/**
 * The normalized forms a request's text is searched in. Text with invisible
 * characters is searched both with them dropped and with them read as spaces,
 * so neither `cl​aude` nor `you​are` hides a phrase.
 */
const searchForms = (text: string) => {
  const folded = fold(text);
  if (!HAS_INVISIBLE.test(folded)) return words(folded);
  return words(folded.replace(INVISIBLE, "")) + words(folded.replace(INVISIBLE, " "));
};

/** The first agent whose tools the request offers, or null. */
export const matchToolset = (names: ReadonlySet<string>, toolsets: readonly Toolset[]): Toolset | null =>
  toolsets.find(
    (toolset) => toolset.tools.reduce((count, tool) => count + (names.has(tool) ? 1 : 0), 0) >= toolset.minMatches,
  ) ?? null;

/**
 * The multiset of the tools' parameter shapes, hashed. Tool names and
 * descriptions are left out, so renaming or rewording tools keeps it.
 */
export const toolsetFingerprint = (tools: readonly AgentTool[]): string | null => {
  const shapes = tools.map((tool) => tool.shape).filter((shape) => shape !== "");
  if (shapes.length < FINGERPRINT_MIN_TOOLS) return null;
  return new Bun.CryptoHasher("sha256").update(shapes.sort().join("\n")).digest("hex").slice(0, 32);
};

const triples = (normalized: string, limit = Number.POSITIVE_INFINITY) => {
  const list = normalized.trim().split(" ").slice(0, limit);
  const result = new Set<string>();
  for (let i = 0; i + 2 < list.length; i++) result.add(`${list[i]} ${list[i + 1]} ${list[i + 2]}`);
  return result;
};

const ruleSet = (value: Partial<AbuseRuleSet> = {}): AbuseRuleSet => ({
  apps: value.apps ?? [],
  userAgents: value.userAgents ?? [],
  prompts: value.prompts ?? {},
  toolsets: value.toolsets ?? [],
});

/**
 * A rules file with its defaults filled in. It is not validated here: the
 * ai-secrets CI runs the rules through the tests on every push.
 */
export const parseAbuseRules = (value: unknown): AbuseRules => {
  const rules = value as Partial<AbuseRuleSet> & { shadow?: Partial<AbuseRuleSet>; detectors?: Partial<Detectors> };
  return {
    ...ruleSet(rules),
    shadow: ruleSet(rules.shadow),
    detectors: { ...DEFAULT_DETECTORS, ...rules.detectors },
  };
};

/** The rules at `path`, or null when there is no file there. */
export const loadAbuseRules = async (path: string): Promise<AbuseRules | null> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return parseAbuseRules(await file.json());
};

/**
 * The enforced rules a refusal can be attributed to. Only fingerprints
 * learned under one of these are used, so deleting a rule that misfired
 * also forgets the toolsets it taught.
 */
export const enforcedRuleKeys = (rules: AbuseRules): { kind: AbuseMatchKind; rule: string }[] => {
  const agents = Object.keys(rules.prompts);
  return [
    ...rules.apps.map((rule) => ({ kind: "app" as const, rule: rule.toLowerCase() })),
    ...rules.userAgents.map((rule) => ({ kind: "user_agent" as const, rule: rule.toLowerCase() })),
    ...agents.map((rule) => ({ kind: "prompt" as const, rule })),
    ...rules.toolsets.map((toolset) => ({ kind: "toolset" as const, rule: toolset.name })),
    ...(rules.detectors.similarPrompts === "enforce" ? agents.map((rule) => ({ kind: "similar_prompt" as const, rule })) : []),
    ...(rules.detectors.firstUserMessage === "enforce" ? agents.map((rule) => ({ kind: "user_prompt" as const, rule })) : []),
  ];
};

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    // Not JSON: the route refuses it with 400, and there is no agent surface to read.
    return null;
  }
};

type Phrase = { agent: string; text: string; triples: Set<string> | null };

const compile = (set: AbuseRuleSet) => ({
  apps: set.apps.map((app) => app.toLowerCase()),
  userAgents: set.userAgents.map((agent) => agent.toLowerCase()),
  phrases: Object.entries(set.prompts).flatMap(([agent, prompts]) =>
    // A prompt with no words would match every request.
    [...new Set(prompts.map(normalizeText))].filter((text) => text.trim() !== "").map((text): Phrase => {
      const phraseTriples = triples(text);
      return { agent, text, triples: phraseTriples.size + 2 >= SIMILAR_MIN_WORDS ? phraseTriples : null };
    }),
  ),
  toolsets: set.toolsets,
});

type Inspected = {
  headers: { referer: string; title: string; userAgent: string } | null;
  instructions: string;
  firstUserMessage: string;
  toolNames: Set<string>;
};

type Found = Omit<AbuseMatch, "enforced">;

const matchRules = (set: ReturnType<typeof compile>, request: Inspected): Found | null => {
  if (request.headers) {
    const { referer, title, userAgent } = request.headers;
    const app = set.apps.find((app) => referer.includes(app) || title.includes(app));
    if (app) return { kind: "app", rule: app };
    const agent = set.userAgents.find((agent) => userAgent.includes(agent));
    if (agent) return { kind: "user_agent", rule: agent };
  }
  const phrase = set.phrases.find((phrase) => request.instructions.includes(phrase.text));
  if (phrase) return { kind: "prompt", rule: phrase.agent };
  const toolset = matchToolset(request.toolNames, set.toolsets);
  if (toolset) return { kind: "toolset", rule: toolset.name };
  return null;
};

/**
 * Inspects a request and reports the first rule it matches: enforced rules,
 * then enforcing detectors, then shadow rules, then shadow detectors. Pass
 * `headers: null` when the headers were already inspected for this request.
 * Learned toolsets need the database, so the screen checks them.
 */
export const createAbuseFilter = (rules: AbuseRules) => {
  const enforced = compile(rules);
  const shadow = compile(rules.shadow);
  const similar = enforced.phrases.filter((phrase) => phrase.triples !== null);
  const { similarPrompts, firstUserMessage } = rules.detectors;

  const similarPrompt = (request: Inspected): Found | null => {
    if (similar.length === 0 || request.instructions === "") return null;
    const present = triples(request.instructions, SIMILAR_WORD_LIMIT);
    const phrase = similar.find((phrase) => {
      let found = 0;
      for (const triple of phrase.triples!) if (present.has(triple)) found++;
      return found >= phrase.triples!.size * SIMILAR_THRESHOLD;
    });
    return phrase ? { kind: "similar_prompt", rule: phrase.agent } : null;
  };
  const userPrompt = (request: Inspected): Found | null => {
    if (request.firstUserMessage === "") return null;
    const phrase = enforced.phrases.find((phrase) => request.firstUserMessage.includes(phrase.text));
    return phrase ? { kind: "user_prompt", rule: phrase.agent } : null;
  };
  const detect = (mode: DetectorMode, request: Inspected) =>
    (similarPrompts === mode ? similarPrompt(request) : null) ?? (firstUserMessage === mode ? userPrompt(request) : null);

  return (headers: Headers | null, body: string | null): AbuseVerdict => {
    const surface = agentSurface(body ? parseJson(body) : null);
    const request: Inspected = {
      headers: headers && {
        referer: (headers.get("referer") ?? headers.get("http-referer") ?? "").toLowerCase(),
        title: (headers.get("x-title") ?? "").toLowerCase(),
        userAgent: (headers.get("user-agent") ?? "").toLowerCase(),
      },
      // Each piece is normalized on its own, so a long system prompt cannot push tool descriptions out.
      instructions: [...surface.instructions, ...surface.tools.map((tool) => tool.description)].map(searchForms).join(""),
      firstUserMessage: surface.firstUserMessage.map(searchForms).join(""),
      toolNames: new Set(surface.tools.map((tool) => tool.name)),
    };
    const fingerprint = toolsetFingerprint(surface.tools);
    const refused = matchRules(enforced, request) ?? detect("enforce", request);
    if (refused) return { match: { ...refused, enforced: true }, fingerprint };
    const recorded = matchRules(shadow, request) ?? detect("shadow", request);
    return { match: recorded && { ...recorded, enforced: false }, fingerprint };
  };
};

const path = abuseRulesPath();
const loaded = await loadAbuseRules(path);
if (!loaded) log.warn({ path }, "no abuse rules found; requests are not screened for blocked clients");

export const abuseRules = loaded ?? NO_RULES;
