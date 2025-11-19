import { Layout } from "./layout";

export const Home = ({ models = [] }: { models?: string[] }) => {
  const displayModels = models.length > 0 ? models : [];
  return (
    <Layout title="hackai!">
      <div class="text-center py-20 px-4 min-h-[80vh] flex flex-col justify-center items-center">
        <div class="mb-8 inline-block">
          <div class="w-20 h-20 bg-brand-primary rounded-2xl flex items-center justify-center text-white font-bold text-4xl transform -rotate-6">
            h
          </div>
        </div>

        <h1 class="text-5xl md:text-7xl font-bold text-brand-heading mb-6 tracking-tight">
          Hack Club AI
        </h1>

        <p class="text-xl md:text-2xl text-brand-text mb-12 max-w-2xl mx-auto leading-relaxed">
          Open beta - DM @mahad on Slack if issues pop up!
        </p>

        <a
          href="/auth/login"
          class="inline-block bg-brand-primary text-white px-8 py-4 rounded-full text-lg font-bold hover:bg-brand-primary-hover hover:shadow-sm hover:-translate-y-1 transition-all duration-300 mb-20"
        >
          Sign in with Slack
        </a>

        <h2 class="text-3xl font-bold mb-10 text-brand-heading">
          Featured Models
        </h2>

        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 w-full max-w-6xl mx-auto mb-20">
          {displayModels.map((model, idx) => {
            const [provider, ...nameParts] = model.split("/");
            const name = nameParts.join("/");

            const tilts = ["rotate-1", "-rotate-1", "rotate-2", "-rotate-2"];
            const tiltClass = tilts[idx % tilts.length];

            return (
              <div
                key={model}
                class={`
                  ${tiltClass} hover:rotate-0
                  bg-white border-2 border-brand-border/50 rounded-2xl p-6
                  transition-all duration-300 ease-out
                  group flex flex-col items-start gap-3
                `}
              >
                <div class="flex items-center gap-2 w-full">
                  <span class="px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-brand-bg text-brand-primary border border-brand-primary/20">
                    {provider}
                  </span>
                  <div class="flex-grow" />
                  <svg
                    class="w-5 h-5 text-brand-text/40 group-hover:text-brand-primary transition-colors"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="M13 10V3L4 14h7v7l9-11h-7z"
                    />
                  </svg>
                </div>

                <h3 class="text-xl font-bold text-brand-heading break-all">
                  {name}
                </h3>
              </div>
            );
          })}
        </div>

        <p class="text-brand-text/60 font-medium">© 2025 Hack Club</p>
      </div>
    </Layout>
  );
};
