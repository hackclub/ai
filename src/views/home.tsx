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
          class="inline-block bg-brand-primary text-white px-8 py-4 rounded-full text-lg font-bold hover:bg-brand-primary-hover shadow-lg hover:shadow-xl hover:-translate-y-1 transition-all duration-300 mb-20"
        >
          Sign in with Slack
        </a>

        <h2 class="text-3xl font-bold mb-10 text-brand-heading">
          Featured Models
        </h2>
        <div class="relative w-full max-w-6xl mx-auto mb-20 overflow-hidden h-48">
          <div class="absolute inset-0 flex items-center gap-6 animate-carousel">
            {[...displayModels, ...displayModels].map((model, idx) => {
              const delay = idx * 0.3;
              const duration = 3 + (idx % 4);
              const colors = [
                "bg-blue-50 text-blue-700 border-blue-200",
                "bg-purple-50 text-purple-700 border-purple-200",
                "bg-green-50 text-green-700 border-green-200",
                "bg-orange-50 text-orange-700 border-orange-200",
                "bg-pink-50 text-pink-700 border-pink-200",
                "bg-indigo-50 text-indigo-700 border-indigo-200",
              ];
              const colorClass = colors[idx % colors.length];
              return (
                <div
                  key={`${model}-${idx}`}
                  class={`flex-shrink-0 ${colorClass} border-2 px-6 py-4 rounded-2xl flex items-center gap-4 transition-all transform hover:scale-105 hover:shadow-md`}
                  style={`--delay: ${delay}s; --dur: ${duration}s;`}
                >
                  <svg
                    class="w-6 h-6 flex-shrink-0 text-brand-primary"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    stroke-width="2.5"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                    ></path>
                  </svg>
                  <span class="font-bold text-lg truncate">{model}</span>
                </div>
              );
            })}
          </div>
        </div>

        <p class="text-brand-text/60 font-medium">© 2025 Hack Club</p>
      </div>

      <style
        dangerouslySetInnerHTML={{
          __html: `
          @keyframes carousel {
            0% { transform: translateX(0); }
            100% { transform: translateX(-50%); }
          }
          @keyframes float {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-10px); }
          }
          .animate-carousel {
            animation: carousel 12s linear infinite;
          }
          .animate-carousel:hover {
            animation-play-state: paused;
          }
          [class^="card-"] {
            animation: float var(--dur) ease-in-out var(--delay) infinite;
          }
        `,
        }}
      />
    </Layout>
  );
};
