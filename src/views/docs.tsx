import { html } from "hono/html";
import { htmlContent as preRenderedHtml, toc } from "../lib/docs";
import type { User } from "../types";
import { Header } from "./components/Header";
import { Layout } from "./layout";

export const Docs = ({ user }: { user: User | null }) => {
  return (
    <Layout title="API Documentation">
      {user && <Header title="hackai docs" user={user} showBackToDashboard />}

      {html`
      <style>
      /* codeblock styles */
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
      </style>`}

      <div class="max-w-7xl mx-auto px-4 py-8 flex flex-col lg:flex-row gap-12">
        {/* Sidebar TOC */}
        <aside class="lg:w-64 flex-shrink-0 hidden lg:block">
          <div class="sticky top-8">
            <h3 class="font-semibold text-brand-heading mb-4">On this page</h3>
            <nav class="space-y-1">
              {toc.map((item) => (
                <a
                  href={`#${item.id}`}
                  class={`block text-sm hover:text-brand-primary transition-colors ${
                    item.level === 2
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
            dangerouslySetInnerHTML={{ __html: preRenderedHtml }}
          />
        </main>
      </div>
    </Layout>
  );
};
