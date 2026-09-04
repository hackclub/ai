import { Layout } from "./layout";

const links = [
  {
    href: "/",
    label: "Home",
    description: "Sign in with Hack Club and grab an API key.",
  },
  {
    href: "https://docs.ai.hackclub.com",
    label: "Documentation",
    description: "Guides and the full API reference.",
  },
  {
    href: "/openapi.json",
    label: "OpenAPI spec",
    description: "Every endpoint this service exposes, as OpenAPI 3.2.",
  },
  {
    href: "/llms.txt",
    label: "llms.txt",
    description: "A map of this site, written for agents.",
  },
];

export const NotFound = ({ path }: { path: string }) => {
  return (
    <Layout title="404 · Hack Club AI">
      <div class="min-h-screen flex flex-col items-center justify-center px-6 py-24 text-center">
        <div class="w-20 h-20 bg-gradient-to-br from-brand-primary to-brand-primary/80 rounded-3xl flex items-center justify-center text-white font-bold text-4xl shadow-2xl shadow-brand-primary/30 transform -rotate-6 mb-8">
          h
        </div>

        <p class="text-sm font-bold uppercase tracking-widest text-brand-primary mb-3">
          404
        </p>

        <h1 class="text-4xl md:text-5xl font-bold text-brand-heading mb-4 tracking-tight">
          Nothing here
        </h1>

        <p class="text-brand-text/70 max-w-xl mb-2">
          There's no page at{" "}
          <code class="font-mono text-sm bg-brand-surface/60 border border-brand-border/60 rounded-md px-2 py-1 text-brand-heading">
            {path}
          </code>
          {"."}
        </p>

        <p class="text-brand-text/50 mb-10 max-w-xl">
          Try one of these instead.
        </p>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-2xl text-left">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              class="bg-brand-surface/30 border border-brand-border/50 rounded-2xl p-5 hover:border-brand-primary/40 hover:bg-brand-surface/50 transition-all"
            >
              <p class="font-semibold text-brand-heading">{link.label}</p>
              <p class="text-sm text-brand-text/60 mt-1">{link.description}</p>
            </a>
          ))}
        </div>
      </div>
    </Layout>
  );
};
