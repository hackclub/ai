import { Layout } from "./layout";
import { Header } from "./components/Header";
import { env } from "../env";
import { htmlContent as preRenderedHtml, toc } from "../lib/docs";

export const Docs = ({
  user,
  allowedLanguageModels,
  allowedEmbeddingModels,
}: any) => {
  const exampleModel = allowedLanguageModels?.[0] || "gpt-4";
  const exampleEmbeddingModel =
    allowedEmbeddingModels?.[0] || "text-embedding-3-large";

  // Replace placeholders in the pre-rendered HTML
  const htmlContent = preRenderedHtml
    .replace(/{{BASE_URL}}/g, env.BASE_URL)
    .replace(/{{FIRST_MODEL}}/g, exampleModel)
    .replace(/{{EMBEDDING_MODEL}}/g, exampleEmbeddingModel);

  return (
    <Layout title="API Documentation">
      <Header title="hackai docs" user={user} showBackToDashboard />

      <style dangerouslySetInnerHTML={{
        __html: `
        /* Markdown Alert Styles */
        .markdown-alert {
          padding: 0.5rem 1rem;
          margin-bottom: 1rem;
          border-left-width: 4px;
          border-radius: 0.25rem;
        }
        
        .markdown-alert-title {
          display: flex;
          align-items: center;
          font-weight: 600;
          margin-bottom: 0.25rem;
        }

        .markdown-alert-note { background-color: #eff6ff; border-left-color: #3b82f6; color: #1e40af; }
        .markdown-alert-note .markdown-alert-title { color: #1e40af; }

        .markdown-alert-tip { background-color: #f0fdf4; border-left-color: #22c55e; color: #15803d; }
        .markdown-alert-tip .markdown-alert-title { color: #15803d; }

        .markdown-alert-important { background-color: #faf5ff; border-left-color: #a855f7; color: #7e22ce; }
        .markdown-alert-important .markdown-alert-title { color: #7e22ce; }

        .markdown-alert-warning { background-color: #fefce8; border-left-color: #eab308; color: #854d0e; }
        .markdown-alert-warning .markdown-alert-title { color: #854d0e; }

        .markdown-alert-caution { background-color: #fef2f2; border-left-color: #ef4444; color: #991b1b; }
        .markdown-alert-caution .markdown-alert-title { color: #991b1b; }

        /* Shiki Code Block Styles */
        pre.shiki {
          background-color: #2d2d2d !important;
          padding: 1rem;
          border-radius: 0.5rem;
          overflow-x: auto;
        }
        pre.shiki code {
          background-color: transparent !important;
          color: inherit !important;
        }
      `}} />

      <div class="max-w-7xl mx-auto px-4 py-8 flex flex-col lg:flex-row gap-12">
        {/* Sidebar TOC */}
        <aside class="lg:w-64 flex-shrink-0 hidden lg:block">
          <div class="sticky top-8">
            <h3 class="font-semibold text-brand-heading mb-4">
              On this page
            </h3>
            <nav class="space-y-1">
              {toc.map((item) => (
                <a
                  href={`#${item.id}`}
                  class={`block text-sm hover:text-brand-primary transition-colors ${item.level === 2
                    ? "text-brand-heading font-medium"
                    : "text-brand-text pl-4"
                    }`}
                >
                  {item.text}
                </a>
              ))}
            </nav>
          </div>
        </aside>

        {/* Main Content */}
        <main class="flex-1 min-w-0">
          <div
            class="prose prose-sm sm:prose max-w-none 
              prose-headings:text-brand-heading
              prose-p:text-brand-text
              prose-li:text-brand-text
              prose-strong:text-brand-heading
              prose-code:text-brand-heading
              prose-a:text-brand-primary hover:prose-a:text-brand-primary-hover
              prose-pre:bg-transparent prose-pre:p-0"
            dangerouslySetInnerHTML={{ __html: htmlContent }}
          />
        </main>
      </div>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            function toggleDarkMode() {
              const isDark = document.documentElement.classList.toggle('dark');
              localStorage.setItem('darkMode', isDark);
            }
          `,
        }}
      />
    </Layout>
  );
};
