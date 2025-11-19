import { Layout } from "./layout";
import { env } from "../env";
import { Header } from "./components/Header";
import { StatCard } from "./components/StatCard";
import { Card } from "./components/Card";
import { EmptyState } from "./components/EmptyState";
import { Table } from "./components/Table";
import { Button } from "./components/Button";
import { Modal } from "./components/Modal";
import { IdvBanner } from "./components/IdvBanner";

export const Dashboard = ({
  user,
  apiKeys,
  stats,
  recentLogs,
  allowedLanguageModels,
  allowedEmbeddingModels,
  enforceIdv,
}: any) => {
  const showIdvBanner = enforceIdv && !user.skipIdv && !user.isIdvVerified;

  return (
    <Layout title="Dashboard">
      <Header title="hackai" user={user} showGlobalStats />

      {showIdvBanner && <IdvBanner />}

      <div
        class={`max-w-6xl mx-auto px-4 py-8 ${showIdvBanner && "grayscale opacity-20"}`}
      >
        <h2 class="text-2xl font-bold mb-6 text-brand-heading">
          Usage Statistics
        </h2>
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
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

        <div class="mb-12">
          <h2 class="text-2xl font-bold mb-6 text-brand-heading">
            Allowed Language Models
          </h2>
          <Card class="p-8">
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {allowedLanguageModels.map((model: string) => {
                return (
                  <div class="bg-brand-bg text-brand-heading border-2 border-brand-border px-5 py-4 rounded-xl flex items-center gap-4 transition-all hover:scale-[1.02] hover:shadow-sm">
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
                    <span class="font-bold text-sm truncate">{model}</span>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        <div class="mb-12">
          <h2 class="text-2xl font-bold mb-6 text-brand-heading">
            Allowed Embedding Models
          </h2>
          <Card class="p-8">
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {allowedEmbeddingModels.map((model: string) => {
                return (
                  <div class="bg-brand-bg text-brand-heading border-2 border-brand-border px-5 py-4 rounded-xl flex items-center gap-4 transition-all hover:scale-[1.02] hover:shadow-sm">
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
                        d="M13 10V3L4 14h7v7l9-11h-7z"
                      ></path>
                    </svg>
                    <span class="font-bold text-sm truncate">{model}</span>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        <div class="mb-12">
          <div class="flex justify-between items-center mb-6">
            <h2 class="text-2xl font-bold text-brand-heading">API Keys</h2>
            <Button
              onclick="showCreateKeyModal()"
              variant="primary"
              class="rounded-full px-6"
            >
              Create New Key
            </Button>
          </div>

          {apiKeys.length === 0 ? (
            <EmptyState message="No API keys yet. Create one to get started." />
          ) : (
            <Table
              columns={[
                { header: "Name", key: "name" },
                {
                  header: "Key",
                  render: (row) => (
                    <code class="bg-brand-bg px-2 py-1 rounded-lg text-xs font-mono text-brand-heading border border-brand-border">
                      {row.keyPreview}
                    </code>
                  ),
                },
                {
                  header: "Created",
                  render: (row) => new Date(row.createdAt).toLocaleDateString(),
                },
                {
                  header: "Status",
                  render: (row) => (row.revokedAt ? "Recently Revoked" : "Active"),
                },
                {
                  header: "Actions",
                  render: (row) =>
                    !row.revokedAt && (
                      <Button
                        variant="danger"
                        onclick={`revokeKey('${row.id}')`}
                        class="px-3 text-xs"
                      >
                        Revoke
                      </Button>
                    ),
                },
              ]}
              data={apiKeys}
              rowClass={(row) => (row.revokedAt ? "opacity-50 grayscale" : "")}
            />
          )}
          <a href="/revoked" class="text-sm text-brand-primary hover:underline mt-3 inline-block">
            View revoked keys
          </a>
        </div>

        <h2 class="text-2xl font-bold mb-6 text-brand-heading">
          Recent Requests
        </h2>
        {recentLogs.length === 0 ? (
          <EmptyState message="No requests yet." />
        ) : (
          <Table
            columns={[
              {
                header: "Time",
                render: (row) => {
                  const date = new Date(row.timestamp);
                  const now = new Date();
                  const diffInSeconds = Math.floor(
                    (now.getTime() - date.getTime()) / 1000,
                  );

                  if (diffInSeconds < 60) return "just now";
                  if (diffInSeconds < 3600)
                    return `${Math.floor(diffInSeconds / 60)}m ago`;
                  if (diffInSeconds < 86400)
                    return `${Math.floor(diffInSeconds / 3600)}h ago`;
                  if (diffInSeconds < 604800)
                    return `${Math.floor(diffInSeconds / 86400)}d ago`;
                  return date.toLocaleDateString();
                },
              },
              { header: "Model", key: "model" },
              {
                header: "Tokens",
                render: (row) => row.totalTokens.toLocaleString(),
              },
              {
                header: "Duration",
                render: (row) => `${row.duration}ms`,
              },
              { header: "IP", key: "ip" },
            ]}
            data={recentLogs}
          />
        )}
      </div>

      <Modal id="createKeyModal" title="Create New API Key">
        <div class="mb-6">
          <label class="block text-sm font-bold text-brand-heading mb-2">
            Key Name
          </label>
          <input
            type="text"
            id="keyName"
            class="w-full px-4 py-3 rounded-xl border-2 border-brand-border bg-brand-bg/50 focus:border-brand-primary focus:ring-0 outline-none transition-colors font-medium text-brand-text placeholder-brand-text/50"
            placeholder="e.g. My Project"
          />
        </div>
        <div class="flex justify-end gap-3">
          <Button variant="secondary" onclick="hideCreateKeyModal()">
            Cancel
          </Button>
          <Button onclick="createKey()">Create</Button>
        </div>
      </Modal>

      <Modal id="keyCreatedModal" title="API Key Created">
        <p class="mb-6 text-brand-text">
          Save this key now. You will not be able to see it again.{" "}
          <b>Don't share it or commit it to a public repo!</b>
        </p>
        <div
          class="bg-brand-bg border-2 border-brand-border p-4 mb-6 rounded-xl overflow-x-auto font-mono text-sm break-all text-brand-primary font-bold"
          id="newApiKey"
        ></div>
        <p class="mb-3 text-sm font-bold text-brand-heading">
          Use this key in your requests:
        </p>
        <div class="bg-brand-bg border-2 border-brand-border p-4 mb-6 rounded-xl overflow-x-auto font-mono text-xs text-brand-text leading-relaxed">
          <div class="whitespace-nowrap">
            curl {env.BASE_URL}/proxy/v1/chat/completions \
          </div>
          <div class="whitespace-nowrap pl-4">
            -H "Authorization: Bearer{" "}
            <span id="curlApiKey" class="font-bold text-brand-primary">
              YOUR_API_KEY
            </span>
            " \
          </div>
          <div class="whitespace-nowrap pl-4">
            -H "Content-Type: application/json" \
          </div>
          <div class="whitespace-nowrap pl-4">
            -d '
            {`{"model": "${allowedLanguageModels?.[0] || "gpt-4"}", "messages": [{"role": "user", "content": "Hello"}]}`}
            '
          </div>
        </div>
        <div class="flex justify-end">
          <Button onclick="hideKeyCreatedModal()">Done</Button>
        </div>
      </Modal>

      <script
        dangerouslySetInnerHTML={{
          __html: `
            function showCreateKeyModal() {
              document.getElementById('createKeyModal').style.display = 'flex';
            }

            function hideCreateKeyModal() {
              document.getElementById('createKeyModal').style.display = 'none';
              document.getElementById('keyName').value = '';
            }

            function hideKeyCreatedModal() {
              document.getElementById('keyCreatedModal').style.display = 'none';
              location.reload();
            }

            async function createKey() {
              const name = document.getElementById('keyName').value.trim();
              if (!name) {
                alert('Please enter a key name');
                return;
              }

              try {
                const response = await fetch('/api/keys', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ name }),
                });

                if (!response.ok) {
                  throw new Error('Failed to create key');
                }

                const data = await response.json();
                document.getElementById('newApiKey').textContent = data.key;
                // Update the curl command with the new key
                document.getElementById('curlApiKey').textContent = data.key;
                
                hideCreateKeyModal();
                document.getElementById('keyCreatedModal').style.display = 'flex';
              } catch (error) {
                alert('Error creating API key');
                console.error(error);
              }
            }

            async function revokeKey(keyId) {
              if (!confirm('Are you sure you want to revoke this API key? This action cannot be undone.')) {
                return;
              }

              try {
                const response = await fetch('/api/keys/' + keyId, {
                  method: 'DELETE',
                });

                if (!response.ok) {
                  throw new Error('Failed to revoke key');
                }

                location.reload();
              } catch (error) {
                alert('Error revoking API key');
                console.error(error);
              }
            }
          `,
        }}
      />
    </Layout>
  );
};
