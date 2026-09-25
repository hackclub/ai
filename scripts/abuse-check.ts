// bun run abuse:check body.json -H "user-agent: opencode/1.2"
// pbpaste | bun run abuse:check - -H "x-title: Some App"
import { abuseRules, createAbuseFilter } from "../src/gateway/abuse";

const args = process.argv.slice(2);
const headers = new Headers();
let source: string | null = null;
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "-H" || arg === "--header") {
    const header = args[++i] ?? "";
    const colon = header.indexOf(":");
    if (colon < 1) throw new Error(`Header ${JSON.stringify(header)} is not "name: value"`);
    headers.append(header.slice(0, colon).trim(), header.slice(colon + 1).trim());
  } else {
    source = arg;
  }
}

const body = source === null ? null : source === "-" ? await Bun.stdin.text() : await Bun.file(source).text();
const { match, fingerprint } = createAbuseFilter(abuseRules)(headers, body);
const outcome = !match ? "allowed" : match.enforced ? "refused (403)" : "allowed, recorded by a shadow rule or detector";
console.log(JSON.stringify({ outcome, match, fingerprint }, null, 2));
