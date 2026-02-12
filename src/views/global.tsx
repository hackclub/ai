import type { Stats, User } from "../types";
import { EmptyState } from "./components/EmptyState";
import { Header } from "./components/Header";
import { StatCard } from "./components/StatCard";
import { Table } from "./components/Table";
import { Layout } from "./layout";

type ModelStats = Stats & { model: string };

type GlobalProps = {
  user: User;
  globalStats: Stats;
  modelStats: ModelStats[];
  dailySpending?: number;
};

export const Global = ({
  user,
  globalStats,
  modelStats,
  dailySpending,
}: GlobalProps) => {
  return (
    <Layout title="Global Statistics" user={user}>
      <Header title="hackai stats" user={user} dailySpending={dailySpending} />

      <div class="w-full max-w-6xl mx-auto px-4 py-8">
        <h2 class="text-2xl font-bold mb-6 text-brand-heading">
          Global Usage Statistics (All Users)
        </h2>
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-6 mb-12">
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

        <h2 class="text-2xl font-bold mb-6 text-brand-heading">
          Usage by Model
        </h2>
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
