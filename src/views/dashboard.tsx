import type { Child } from "hono/jsx";
import { allowedLanguageModels, env } from "../env";
import type { Stats, User } from "../types";
import { Header } from "./components/Header";
import { IdvBanner } from "./components/IdvBanner";
import { StatCard } from "./components/StatCard";
import { Layout } from "./layout";

type DashboardProps = {
  user: User;
  stats: Stats;
  enforceIdv: boolean;
  replicateEnabled: boolean;
};

export const Dashboard = ({
  user,
  stats,
  enforceIdv,
  replicateEnabled,
}: DashboardProps) => {
  const showIdvBanner = enforceIdv && !user.skipIdv && !user.isIdvVerified;

  return (
    <Layout title="Dashboard" includeAlpine user={user}>
      <div>
        <Header title="hackai" user={user} replicateEnabled={replicateEnabled} />

        {showIdvBanner && <IdvBanner />}

        <div
          class={`w-full max-w-6xl mx-auto px-4 py-8 ${showIdvBanner ? "grayscale opacity-20 pointer-events-none select-none" : ""}`}
        >
          <h2 class="text-2xl font-bold mb-6 text-brand-heading">
            Usage Statistics
          </h2>
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-6 mb-12">
            <StatCard
              value={stats.totalRequests?.toLocaleString() || 0}
              label="Total Requests"
            />
            <StatCard
              value={stats.totalTokens?.toLocaleString() || 0}
              label="Total Tokens"
            />
            <StatCard
              value={stats.totalPromptTokens?.toLocaleString() || 0}
              label="Prompt Tokens"
            />
            <StatCard
              value={stats.totalCompletionTokens?.toLocaleString() || 0}
              label="Completion Tokens"
            />
          </div>

          {/*<SurveyBanner />*/}

          <h2 class="text-2xl font-bold mb-6 text-brand-heading">
            Quick Links
          </h2>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6 mb-12">
            <QuickLinkCard
              href="/keys"
              title="API Keys"
              description="Create and manage your API keys for authentication."
              icon={
                <svg
                  class="w-8 h-8"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
                  />
                </svg>
              }
            />
            <QuickLinkCard
              href="/models"
              title="Models"
              description="Browse available language, image and embedding models."
              icon={
                <svg
                  class="w-8 h-8"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                  />
                </svg>
              }
            />
            <QuickLinkCard
              href="/activity"
              title="Activity"
              description="View your recent API requests and usage history."
              icon={
                <svg
                  class="w-8 h-8"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                  />
                </svg>
              }
            />
            {replicateEnabled && (
              <QuickLinkCard
                href="/replicate"
                title="Replicate"
                description="Remove backgrounds, use STT/TTS, upscale images and more with Replicate models."
                icon={
                  <svg
                    class="w-8 h-8"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"
                    />
                  </svg>
                }
              />
            )}
          </div>

          <h2 class="text-2xl font-bold mb-6 text-brand-heading">
            Quickstart Guide
          </h2>
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 mb-12">
            <QuickstartCard
              step={1}
              title="Get your API key"
              description="Create a new API key from the Keys page. Keep it secure and never share it publicly."
            >
              <a
                href="/keys"
                class="inline-block px-4 py-2 text-sm font-medium rounded-full bg-brand-primary text-white hover:bg-brand-primary-hover transition-all"
              >
                Create API Key
              </a>
            </QuickstartCard>

            <div className="hidden sm:block">
              <QuickstartCard
                step={2}
                title="Make your first request"
                description="Use curl or your favorite HTTP client to make a request:"
              >
                <div class="bg-brand-bg border border-brand-border p-4 rounded-xl font-mono text-xs text-brand-text leading-relaxed overflow-x-auto select-text">
                  <div>curl {env.BASE_URL}/proxy/v1/chat/completions \</div>
                  <div class="pl-4">
                    -H "Authorization: Bearer YOUR_API_KEY" \
                  </div>
                  <div class="pl-4">-H "Content-Type: application/json" \</div>
                  <div class="pl-4">
                    -d '
                    {`{"model": "${allowedLanguageModels[0]}", "messages": [{"role": "user", "content": "Hi"}]}`}
                    '
                  </div>
                </div>
              </QuickstartCard>
            </div>

            <div className="sm:hidden">
              <ExploreModelsCard stepNum={2} />
            </div>
            <div className="sm:hidden">
              <ReadDocsCard stepNum={3} />
            </div>

            <div className="hidden sm:block">
              <ExploreModelsCard stepNum={3} />
            </div>
            <div className="hidden sm:block">
              <ReadDocsCard stepNum={4} />
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
};

const QuickLinkCard = ({
  href,
  title,
  description,
  icon,
}: {
  href: string;
  title: string;
  description: string;
  icon: Child;
}) => {
  return (
    <a
      href={href}
      class="block bg-brand-surface border-2 border-brand-border p-6 rounded-2xl hover:border-brand-primary/50 hover:shadow-lg transition-all group"
    >
      <div class="flex items-start gap-4">
        {icon}
        <div class="flex-1 min-w-0">
          <h3 class="font-bold text-lg text-brand-heading mb-1">{title}</h3>
          <p class="text-sm text-brand-text">{description}</p>
        </div>
        <svg
          class="w-5 h-5 text-brand-text/40 group-hover:text-brand-primary transition-colors flex-shrink-0 mt-1"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          stroke-width="2"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M9 5l7 7-7 7"
          />
        </svg>
      </div>
    </a>
  );
};

const QuickstartCard = ({
  step,
  title,
  description,
  children,
}: {
  step: number;
  title: string;
  description: string;
  children?: Child;
}) => {
  return (
    <div class="bg-brand-surface border-2 border-brand-border p-6 rounded-2xl">
      <div class="flex items-start gap-4">
        <div class="flex-shrink-0 w-10 h-10 bg-brand-primary rounded-full flex items-center justify-center text-white font-bold text-lg">
          {step}
        </div>
        <div class="flex-1">
          <h3 class="font-bold text-lg text-brand-heading mb-2">{title}</h3>
          <p class="text-sm text-brand-text mb-4">{description}</p>
          {children}
        </div>
      </div>
    </div>
  );
};

const ExploreModelsCard = ({ stepNum }: { stepNum: number }) => {
  return (
    <QuickstartCard
      step={stepNum}
      title="Explore available models"
      description="Browse our collection of language, image and embedding models to find the right one for your project."
    >
      <a
        href="/models"
        class="inline-block px-4 py-2 text-sm font-medium rounded-full bg-brand-primary text-white hover:bg-brand-primary-hover transition-all"
      >
        Browse Models
      </a>
    </QuickstartCard>
  );
}

const ReadDocsCard = ({ stepNum }: { stepNum: number }) => {
  return (
    <QuickstartCard
      step={stepNum}
      title="Read the documentation"
      description="Learn about all the available endpoints, parameters and best practices for using the API."
    >
      <a
        href="/docs"
        class="inline-block px-4 py-2 text-sm font-medium rounded-full bg-brand-primary text-white hover:bg-brand-primary-hover transition-all"
      >
        View Docs
      </a>
    </QuickstartCard>
  );
}