import { Layout } from './layout';

export const Home = () => {
  return (
    <Layout title="AI Proxy">
      <div class="text-center py-16 px-4">
        <h1 class="text-4xl font-semibold mb-4">Hack Club AI</h1>
        <p class="text-lg text-gray-600 dark:text-gray-400 mb-8">Open beta - DM @mahad on the Slack if issues pop up!</p>
        <a href="/auth/login" class="inline-block bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 px-4 py-2 rounded-lg hover:bg-gray-700 dark:hover:bg-gray-200 text-sm transition-colors">
          Sign in with Slack
        </a>
      </div>
    </Layout>
  );
};
