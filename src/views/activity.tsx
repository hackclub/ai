import type { DashboardRequestLog, Stats, User } from "../types";
import { EmptyState } from "./components/EmptyState";
import { Header } from "./components/Header";
import { StatCard } from "./components/StatCard";
import { Layout } from "./layout";

type ActivityProps = {
  user: User;
  stats: Stats;
  recentLogs: DashboardRequestLog[];
  hasMoreRecentLogs: boolean;
  dailySpending?: number;
};

export const Activity = ({
  user,
  stats,
  recentLogs,
  hasMoreRecentLogs,
  dailySpending,
}: ActivityProps) => {
  return (
    <Layout title="Activity" includeHtmx user={user}>
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
        <RecentRequestsTable
          recentLogs={recentLogs}
          hasMore={hasMoreRecentLogs}
        />
      </div>
    </Layout>
  );
};

const formatRelativeTime = (timestamp: Date) => {
  const diff = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(timestamp).toLocaleDateString();
};

const formatFullTime = (timestamp: Date) =>
  new Date(timestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });

const formatDuration = (ms: number) => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
};

const hashColor = (value: string) => {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return `oklch(78% 0.16 ${Math.abs(hash) % 360})`;
};

const displayModelName = (name: string) => {
  const afterColon = name.split(":").at(-1)?.trim();
  return afterColon || name;
};

const getErrorMessage = (response: unknown): string | null => {
  if (!response || typeof response !== "object") return null;
  const data = response as Record<string, unknown>;
  const error = data.error;

  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const errorData = error as Record<string, unknown>;
    if (typeof errorData.message === "string") return errorData.message;
    if (typeof errorData.code === "string") return errorData.code;
  }

  if (typeof data.message === "string" && !Array.isArray(data.choices)) {
    return data.message;
  }

  return null;
};

const RecentRequestsTable = ({
  recentLogs,
  hasMore,
}: {
  recentLogs: DashboardRequestLog[];
  hasMore: boolean;
}) => {
  if (recentLogs.length === 0) {
    return <EmptyState message="No requests yet." />;
  }

  return (
    <>
      <div class="overflow-x-auto border-2 border-brand-border bg-brand-surface rounded-2xl shadow-sm transition-colors">
        <table class="w-full border-collapse">
          <thead>
            <tr class="border-b-2 border-brand-border bg-brand-bg/50">
              <th class="text-left py-4 px-4 font-bold text-sm text-brand-heading uppercase tracking-wider">
                Time
              </th>
              <th class="text-left py-4 px-4 font-bold text-sm text-brand-heading uppercase tracking-wider">
                Model
              </th>
              <th class="text-left py-4 px-4 font-bold text-sm text-brand-heading uppercase tracking-wider">
                Tokens
              </th>
              <th class="text-left py-4 px-4 font-bold text-sm text-brand-heading uppercase tracking-wider">
                Result
              </th>
            </tr>
          </thead>
          <tbody id="recent-request-rows">
            <RecentRequestsRows recentLogs={recentLogs} />
          </tbody>
        </table>
      </div>
      <div id="load-more-requests" class="mt-4 flex justify-center">
        {hasMore && <LoadMoreRequestsButton recentLogs={recentLogs} />}
      </div>
    </>
  );
};

export const RecentRequestsRows = ({
  recentLogs,
}: {
  recentLogs: DashboardRequestLog[];
}) => {
  return (
    <>
      {recentLogs.map((row) => {
        const errorMessage = getErrorMessage(row.response);
        const info = `Key: ${row.apiKeyName}\nIP: ${row.ip}`;
        const infoColor = hashColor(`${row.apiKeyName}:${row.ip}`);

        return (
          <tr class="border-b border-brand-border/50 hover:bg-brand-bg/30 transition-colors">
            <td class="py-2 px-4 text-sm text-brand-text font-medium whitespace-nowrap">
              <abbr title={formatFullTime(row.timestamp)}>
                {formatRelativeTime(row.timestamp)}
              </abbr>{" "}
              <span class="text-brand-text/40">•</span>{" "}
              <abbr
                class="cursor-help"
                title={info}
                style={`color: ${infoColor}`}
              >
                i
              </abbr>
            </td>
            <td class="py-2 px-4 text-sm font-medium max-w-64 truncate">
              <a
                href={`/models/${row.model}`}
                class="text-brand-text underline hover:text-brand-primary-hover transition-colors"
              >
                {displayModelName(row.modelName)}
              </a>
            </td>
            <td class="py-2 px-4 text-sm text-brand-text font-medium whitespace-nowrap">
              {errorMessage ? (
                <span class="text-brand-text/60">No usage</span>
              ) : (
                <span>
                  {row.promptTokens.toLocaleString()} in /{" "}
                  {row.completionTokens.toLocaleString()} out
                </span>
              )}
            </td>
            <td class="py-2 px-4 text-sm font-medium whitespace-nowrap">
              <abbr
                class={errorMessage ? "text-red-500" : "text-green-400"}
                title={errorMessage || "Request completed"}
              >
                {errorMessage ? "Error" : "OK"}
              </abbr>
              <span class="text-brand-text/40"> · </span>
              <span class="text-brand-text">
                {formatDuration(row.duration)}
              </span>
            </td>
          </tr>
        );
      })}
    </>
  );
};

export const LoadMoreRequestsButton = ({
  recentLogs,
}: {
  recentLogs: DashboardRequestLog[];
}) => {
  const last = recentLogs.at(-1);
  if (!last) return null;

  return (
    <button
      type="button"
      class="px-4 py-2 rounded-full bg-brand-primary text-white text-sm font-medium hover:bg-brand-primary-hover transition-colors disabled:opacity-60"
      hx-get={`/activity/requests?before=${encodeURIComponent(last.timestamp.toISOString())}&beforeId=${encodeURIComponent(last.id)}`}
      hx-target="#recent-request-rows"
      hx-swap="beforeend"
      hx-disabled-elt="this"
    >
      Load more requests
    </button>
  );
};
