import { Layout } from "./layout";
import { Header } from "./components/Header";
import { StatCard } from "./components/StatCard";
import { EmptyState } from "./components/EmptyState";
import { Table } from "./components/Table";

export const Global = ({ user, globalStats, modelStats }: any) => {
  return (
    <Layout title="Global Statistics">
      <Header title="hackai stats" user={user} showBackToDashboard />

      <div class="max-w-6xl mx-auto px-4 py-8">
        <h2 class="text-xl font-semibold mb-4">
          Global Usage Statistics (All Users)
        </h2>
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard
            value={globalStats.totalRequests?.toLocaleString() || 0}
            label="Total Requests"
          />
          <StatCard
            value={globalStats.totalTokens?.toLocaleString() || 0}
            label="Total Tokens"
          />
          <StatCard
            value={globalStats.totalPromptTokens?.toLocaleString() || 0}
            label="Prompt Tokens"
          />
          <StatCard
            value={globalStats.totalCompletionTokens?.toLocaleString() || 0}
            label="Completion Tokens"
          />
        </div>

        <h2 class="text-xl font-semibold mb-4">Usage by Model</h2>
        {modelStats.length === 0 ? (
          <EmptyState message="No usage data yet." />
        ) : (
          <Table
            columns={[
              {
                header: "Model",
                render: (row) => (
                  <span class="font-medium">{row.model || "Unknown"}</span>
                ),
              },
              {
                header: "Requests",
                render: (row) => row.totalRequests?.toLocaleString() || 0,
              },
              {
                header: "Total Tokens",
                render: (row) => row.totalTokens?.toLocaleString() || 0,
              },
              {
                header: "Prompt Tokens",
                render: (row) => row.totalPromptTokens?.toLocaleString() || 0,
              },
              {
                header: "Completion Tokens",
                render: (row) =>
                  row.totalCompletionTokens?.toLocaleString() || 0,
              },
            ]}
            data={modelStats}
          />
        )}
      </div>
    </Layout>
  );
};
