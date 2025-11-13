import { Layout } from './layout';
import { Card } from './components/Card';

export const Home = ({ models = [] }: { models?: string[] }) => {
  const displayModels = models.length > 0 ? models : [];
  return (
    <Layout title="AI Proxy">
      <div class="text-center py-16 px-4">
        <h1 class="text-4xl font-semibold mb-4">Hack Club AI</h1>
        <p class="text-lg text-gray-600 dark:text-gray-400 mb-8">Open beta - DM @mahad on the Slack if issues pop up!</p>
        
        <a href="/auth/login" class="inline-block bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 px-4 py-2 rounded-lg hover:bg-gray-700 dark:hover:bg-gray-200 text-sm transition-colors mb-12">
          Sign in with Slack
        </a>

        <h2 class="text-2xl font-semibold mb-6">Featured Models</h2>
        <div class="relative w-full max-w-5xl mx-auto mb-12 overflow-hidden h-40">
          <div class="absolute inset-0 flex items-center gap-4 animate-carousel">
            {[...displayModels, ...displayModels].map((model, idx) => {
              const rotation = (idx % 2 === 0 ? 1 : -1) * (3 + (idx % 3));
              const delay = idx * 0.3;
              const duration = 3 + (idx % 4);
              return (
                <Card key={`${model}-${idx}`} class={`card-${idx} flex-shrink-0 w-52 px-4 py-3 transform hover:scale-105 transition-all duration-300`} style={`--rot: ${rotation}deg; --delay: ${delay}s; --dur: ${duration}s;`}>
                  <div class="text-sm font-medium truncate">{model}</div>
                </Card>
              );
            })}
          </div>
        </div>

        <p class="text-sm text-gray-500 dark:text-gray-400 mt-16">© 2025 Hack Club</p>
      </div>

      <style dangerouslySetInnerHTML={{
        __html: `
          @keyframes carousel {
            0% { transform: translateX(0); }
            100% { transform: translateX(-50%); }
          }
          @keyframes floatRotate {
            0%, 100% { transform: rotate(var(--rot)) translateY(0); }
            25% { transform: rotate(calc(var(--rot) + 6deg)) translateY(-10px); }
            50% { transform: rotate(var(--rot)) translateY(0); }
            75% { transform: rotate(calc(var(--rot) - 6deg)) translateY(10px); }
          }
          .animate-carousel {
            animation: carousel 25s linear infinite;
          }
          .animate-carousel:hover {
            animation-play-state: paused;
          }
          [class^="card-"] {
            animation: floatRotate var(--dur) ease-in-out var(--delay) infinite;
          }
        `
      }} />
    </Layout>
  );
};
