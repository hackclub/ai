import type { DashboardRequestLog, Stats, User } from "../types";
import { EmptyState } from "./components/EmptyState";
import { Header } from "./components/Header";
import { StatCard } from "./components/StatCard";
import { Table } from "./components/Table";
import { Layout } from "./layout";

type ActivityProps = {
  user: User;
  stats: Stats;
  recentLogs: DashboardRequestLog[];
  dailySpending?: number;
};

export const Activity = ({
  user,
  stats,
  recentLogs,
  dailySpending,
}: ActivityProps) => {
  return (
    <Layout title="Activity" user={user}>
      <Header title="hackai" user={user} dailySpending={dailySpending} />

      <div class="w-full max-w-6xl mx-auto px-4 py-8">
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

        <h2 class="text-2xl font-bold mb-6 text-brand-heading">
          Recent Requests
        </h2>
        <RecentRequestsTable recentLogs={recentLogs} />
      </div>
    </Layout>
  );
};

const RecentRequestsTable = ({
  recentLogs,
}: {
  recentLogs: DashboardRequestLog[];
}) => {
  if (recentLogs.length === 0) {
    return <EmptyState message="No requests yet." />;
  }

  return (
    <Table
      columns={[
        {
          header: "Time",
          render: (row) => {
            const diff = Math.floor(
              (Date.now() - new Date(row.timestamp).getTime()) / 1000,
            );
            if (diff < 60) return "just now";
            if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
            if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
            if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
            return new Date(row.timestamp).toLocaleDateString();
          },
        },
        { header: "Model", key: "model" },
        { header: "Tokens", render: (row) => row.totalTokens.toLocaleString() },
        { header: "Duration", render: (row) => `${row.duration}ms` },
        { header: "IP", key: "ip" },
      ]}
      data={recentLogs}
    />
  );
};
