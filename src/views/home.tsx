import { Layout } from "./layout";

export const Home = ({ models = [] }: { models?: string[] }) => {
  return (
    <Layout title="Hack Club AI">
      <div class="min-h-screen">
        {/* Hero Section */}
        <div class="relative overflow-hidden">
          {/* Gradient background
          <div class="absolute inset-0 bg-gradient-to-br from-brand-primary/20 via-brand-bg to-brand-bg" />
          <div class="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[600px] bg-brand-primary/10 rounded-full blur-3xl" /> */}

          <div class="relative px-6 py-24 md:py-32 max-w-5xl mx-auto text-center">
            {/* Logo */}
            <div class="mb-8 inline-block">
              <div class="w-24 h-24 bg-gradient-to-br from-brand-primary to-brand-primary/80 rounded-3xl flex items-center justify-center text-white font-bold text-5xl shadow-2xl shadow-brand-primary/30 transform -rotate-6 hover:rotate-0 transition-transform duration-300">
                h
              </div>
            </div>

            <h1 class="text-5xl md:text-7xl font-bold text-brand-heading mb-6 tracking-tight">
              Hack Club AI
            </h1>

            <p class="text-xl md:text-2xl text-brand-text/80 mb-4 max-w-2xl mx-auto leading-relaxed">
              Free AI access for Hack Clubbers.
            </p>

            <p class="text-brand-text/60 mb-10 max-w-xl mx-auto">
              Use Gemini, GPT-5.2, Kimi K2 and 30+ other models through an
              OpenAI-compatible API. Build projects, learn and experiment - for
              free!
            </p>

            <a
              href="/auth/login"
              class="inline-flex items-center gap-3 bg-brand-primary text-white px-10 py-4 rounded-2xl text-lg font-bold hover:tracking-wider transition-all"
            >
              Sign in with Hack Club
            </a>

            <p class="mt-4 text-sm text-brand-text/50">
              DM @mahad on Slack for support.
            </p>
          </div>
        </div>

        {/* Features Section */}
        <div class="px-6 py-20 max-w-6xl mx-auto">
          <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
            {/* Card 1: Code snippet style */}
            <div class="relative bg-gradient-to-br from-emerald-500/10 to-transparent border border-emerald-500/20 rounded-2xl p-8 overflow-hidden group hover:border-emerald-500/40 transition-all">
              <div class="absolute top-4 right-4 flex gap-1.5">
                <div class="w-2.5 h-2.5 rounded-full bg-emerald-500/40" />
                <div class="w-2.5 h-2.5 rounded-full bg-emerald-500/30" />
                <div class="w-2.5 h-2.5 rounded-full bg-emerald-500/20" />
              </div>
              <h3 class="text-xl font-bold text-brand-heading mb-3">
                OpenAI Compatible
              </h3>
              <p class="text-brand-text/70 leading-relaxed">
                Works with any SDK, library or tool. Just swap your base URL.
              </p>
              <div class="mt-6 font-mono text-xs text-emerald-400/60 bg-emerald-500/5 rounded-lg p-3 border border-emerald-500/10">
                base_url = "ai.hackclub.com/proxy/v1"
              </div>
            </div>

            {/* Card 2: Big bold number */}
            <div class="relative bg-gradient-to-br from-brand-primary/10 to-transparent border border-brand-primary/20 rounded-2xl p-8 overflow-hidden group hover:border-brand-primary/40 transition-all">
              <div class="absolute -top-4 -right-4 text-[120px] font-black text-brand-primary/10 leading-none select-none">
                $0
              </div>
              <div class="relative">
                <div class="inline-block px-3 py-1 rounded-full text-xs font-bold bg-brand-primary/20 text-brand-primary mb-4">
                  ALWAYS FREE
                </div>
                <h3 class="text-xl font-bold text-brand-heading mb-3">
                  100% Free
                </h3>
                <p class="text-brand-text/70 leading-relaxed">
                  No credit card, no catch. Just sign in with your Hack Club
                  account.
                </p>
              </div>
            </div>

            {/* Card 3: Floating model badges */}
            <div class="relative bg-gradient-to-br from-violet-500/10 to-transparent border border-violet-500/20 rounded-2xl p-8 overflow-hidden group hover:border-violet-500/40 transition-all">
              <div class="text-5xl font-black text-violet-400/80 mb-2">30+</div>
              <h3 class="text-xl font-bold text-brand-heading mb-3">Models</h3>
              <p class="text-brand-text/70 leading-relaxed">
                Gemini 3 Pro, GPT-5.2, Kimi K2, GLM-4.7 and many more.
              </p>
            </div>
          </div>
        </div>

        <div class="px-6 py-16 max-w-6xl mx-auto">
          <h2 class="text-2xl font-bold text-brand-heading mb-8 text-center">
            Featured Models
          </h2>

          <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {models.map((model) => {
              const [provider, ...nameParts] = model.split("/");
              const name = nameParts.join("/");
              const shortName = name.split(":")[0];

              return (
                <div
                  key={model}
                  class="bg-brand-surface/30 border border-brand-border/50 rounded-xl p-4 hover:border-brand-primary/30 hover:bg-brand-surface/50 transition-all group"
                >
                  <span class="text-xs font-medium text-brand-primary/80 uppercase tracking-wide">
                    {provider}
                  </span>
                  <p class="text-sm font-semibold text-brand-heading mt-1 truncate group-hover:text-brand-primary transition-colors">
                    {shortName}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div class="px-6 py-12 border-t border-brand-border/50">
          <div class="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 bg-brand-primary rounded-lg flex items-center justify-center text-white font-bold text-sm">
                h
              </div>
              <span class="text-brand-text/60 font-medium">
                &copy; 2025-2026 Hack Club
              </span>
            </div>
            <div class="flex items-center gap-6 text-sm">
              <a
                href="https://hackclub.com"
                target="_blank"
                rel="noopener"
                class="text-brand-text/60 hover:text-brand-heading transition-colors"
              >
                Hack Club
              </a>
              <a
                href="https://hackclub.com/slack"
                target="_blank"
                rel="noopener"
                class="text-brand-text/60 hover:text-brand-heading transition-colors"
              >
                Slack
              </a>
              <a
                href="https://github.com/hackclub/ai"
                target="_blank"
                rel="noopener"
                class="text-brand-text/60 hover:text-brand-heading transition-colors"
              >
                GitHub
              </a>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
};
