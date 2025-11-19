import { Layout } from "./layout";

export const Home = ({ models = [] }: { models?: string[] }) => {
  const displayModels = models.length > 0 ? models : [];
  return (
    <Layout title="hackai!">
      <div class="text-center py-16 px-4">
        <h1 class="text-4xl font-semibold mb-4">Hack Club AI</h1>
        <p class="text-lg text-gray-600 dark:text-mocha-subtext0 mb-8">
          Open beta - DM @mahad on the Slack if issues pop up!
        </p>

        <a
          href="/auth/login"
          class="inline-block bg-gray-900 dark:bg-mocha-text text-white dark:text-mocha-base px-4 py-2 hover:bg-gray-700 dark:hover:bg-mocha-text text-sm transition-colors mb-12"
        >
          Sign in with Slack
        </a>

        <h2 class="text-2xl font-semibold mb-2">Featured Models</h2>
        <div class="relative w-full max-w-5xl mx-auto mb-12 overflow-hidden h-40">
          <div class="absolute inset-0 flex items-center gap-4 animate-carousel">
            {[...displayModels, ...displayModels].map((model, idx) => {
              const delay = idx * 0.3;
              const duration = 3 + (idx % 4);
              const colors = [
                "bg-blue-100 dark:bg-mocha-blue/30 text-blue-800 dark:text-mocha-blue border-blue-200 dark:border-mocha-blue",
                "bg-purple-100 dark:bg-mocha-mauve/30 text-purple-800 dark:text-mocha-mauve border-purple-200 dark:border-mocha-mauve",
                "bg-green-100 dark:bg-mocha-green/30 text-green-800 dark:text-mocha-green border-green-200 dark:border-mocha-green",
                "bg-orange-100 dark:bg-mocha-peach/30 text-orange-800 dark:text-mocha-peach border-orange-200 dark:border-mocha-peach",
                "bg-pink-100 dark:bg-mocha-pink/30 text-pink-800 dark:text-mocha-pink border-pink-200 dark:border-mocha-pink",
                "bg-indigo-100 dark:bg-mocha-lavender/30 text-indigo-800 dark:text-mocha-lavender border-indigo-200 dark:border-mocha-lavender",
              ];
              const colorClass = colors[idx % colors.length];
              return (
                <div
                  key={`${model}-${idx}`}
                  class={`card-${idx} flex-shrink-0 ${colorClass} border px-4 py-3 flex items-center gap-3 transition-colors transform hover:scale-105`}
                  style={`--delay: ${delay}s; --dur: ${duration}s;`}
                >
                  <svg
                    class="w-5 h-5 flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                    ></path>
                  </svg>
                  <span class="font-medium text-sm truncate">{model}</span>
                </div>
              );
            })}
          </div>
        </div>

        <p class="text-sm text-gray-500 dark:text-mocha-subtext0 mt-16">
          © 2025 Hack Club
        </p>
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
