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
      <Header title="AI Proxy" user={user} showGlobalStats />

      {showIdvBanner && <IdvBanner />}

      <div
        class={`max-w-6xl mx-auto px-4 py-8 ${showIdvBanner && "grayscale opacity-20"}`}
      >
        <h2 class="text-xl font-semibold mb-4">Usage Statistics</h2>
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
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

        <div class="mb-8">
          <h2 class="text-xl font-semibold mb-4">Allowed Language Models</h2>
          <Card class="p-6">
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {allowedLanguageModels.map((model: string, index: number) => {
                const colors = [
                  "bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 border-blue-200 dark:border-blue-800",
                  "bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-300 border-purple-200 dark:border-purple-800",
                  "bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 border-green-200 dark:border-green-800",
                  "bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-300 border-orange-200 dark:border-orange-800",
                  "bg-pink-100 dark:bg-pink-900/30 text-pink-800 dark:text-pink-300 border-pink-200 dark:border-pink-800",
                  "bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800",
                ];
                const colorClass = colors[index % colors.length];
                return (
                  <div
                    class={`${colorClass} border rounded-lg px-4 py-3 flex items-center gap-3 transition-colors`}
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
          </Card>
        </div>

        <div class="mb-8">
          <h2 class="text-xl font-semibold mb-4">Allowed Embedding Models</h2>
          <Card class="p-6">
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {allowedEmbeddingModels.map((model: string, index: number) => {
                const colors = [
                  "bg-teal-100 dark:bg-teal-900/30 text-teal-800 dark:text-teal-300 border-teal-200 dark:border-teal-800",
                  "bg-cyan-100 dark:bg-cyan-900/30 text-cyan-800 dark:text-cyan-300 border-cyan-200 dark:border-cyan-800",
                  "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800",
                  "bg-sky-100 dark:bg-sky-900/30 text-sky-800 dark:text-sky-300 border-sky-200 dark:border-sky-800",
                  "bg-violet-100 dark:bg-violet-900/30 text-violet-800 dark:text-violet-300 border-violet-200 dark:border-violet-800",
                  "bg-fuchsia-100 dark:bg-fuchsia-900/30 text-fuchsia-800 dark:text-fuchsia-300 border-fuchsia-200 dark:border-fuchsia-800",
                ];
                const colorClass = colors[index % colors.length];
                return (
                  <div
                    class={`${colorClass} border rounded-lg px-4 py-3 flex items-center gap-3 transition-colors`}
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
                        d="M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7c0-2-1-3-3-3H7C5 4 4 5 4 7zm4 0h8m-8 4h8m-8 4h5"
                      ></path>
                    </svg>
                    <span class="font-medium text-sm truncate">{model}</span>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        <div class="mb-8">
          <div class="flex justify-between items-center mb-4">
            <h2 class="text-xl font-semibold">API Keys</h2>
            <Button onclick="showCreateKeyModal()">Create New Key</Button>
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
                    <code class="bg-gray-100 dark:bg-gray-900 px-2 py-1 rounded text-xs">
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
                  render: (row) => (row.revokedAt ? "Revoked" : "Active"),
                },
                {
                  header: "Actions",
                  render: (row) =>
                    !row.revokedAt && (
                      <Button
                        variant="danger"
                        onclick={`revokeKey('${row.id}')`}
                        class="px-3 py-1"
                      >
                        Revoke
                      </Button>
                    ),
                },
              ]}
              data={apiKeys}
              rowClass={(row) => (row.revokedAt ? "opacity-50" : "")}
            />
          )}
        </div>

        <h2 class="text-xl font-semibold mb-4">Recent Requests</h2>
        {recentLogs.length === 0 ? (
          <EmptyState message="No requests yet." />
        ) : (
          <Table
            columns={[
              {
                header: "Time",
                render: (row) => new Date(row.timestamp).toLocaleString(),
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

      <Modal id="createKeyModal" title="Create API Key">
        <div class="mb-4">
          <label for="keyName" class="block text-sm font-medium mb-2">
            Key Name
          </label>
          <input
            type="text"
            id="keyName"
            placeholder="My API Key"
            class="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 rounded-lg text-sm focus:outline-none focus:border-gray-900 dark:focus:border-gray-500"
          />
        </div>
        <div class="flex gap-2 justify-end">
          <Button variant="secondary" onclick="hideCreateKeyModal()">
            Cancel
          </Button>
          <Button onclick="createKey()">Create</Button>
        </div>
      </Modal>

      <div
        id="keyCreatedModal"
        class="fixed inset-0 bg-black bg-opacity-50 dark:bg-opacity-70 z-50 items-center justify-center"
        style="display: none;"
      >
        <div class="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6 max-w-2xl w-11/12">
          <h3 class="text-lg font-semibold mb-3">API Key Created</h3>
          <p class="mb-4 text-sm text-gray-600 dark:text-gray-400">
            Save this key now. You will not be able to see it again.
          </p>
          <div
            class="bg-gray-100 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-3 mb-4 overflow-x-auto font-mono text-sm break-all"
            id="newApiKey"
          ></div>
          <p class="mb-2 text-sm text-gray-600 dark:text-gray-400">
            Use this key in your requests:
          </p>
          <div class="bg-gray-100 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-3 mb-4 overflow-x-auto font-mono text-xs">
            curl {env.BASE_URL}/proxy/v1/chat/completions \<br />
            {"  "}-H "Authorization: Bearer YOUR_API_KEY" \<br />
            {"  "}-H "Content-Type: application/json" \<br />
            {"  "}-d '
            {`{"model": "${allowedLanguageModels?.[0] || "gpt-4"}", "messages": [{"role": "user", "content": "Hello"}]}`}
            '
          </div>
          <Button onclick="hideKeyCreatedModal()">Done</Button>
        </div>
      </div>

      <script
        dangerouslySetInnerHTML={{
          __html: `
            function toggleDarkMode() {
              const isDark = document.documentElement.classList.toggle('dark');
              localStorage.setItem('darkMode', isDark);
            }

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
