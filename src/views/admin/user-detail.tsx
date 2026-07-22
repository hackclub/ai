import type { User } from "../../types";
import { Header } from "../components/Header";
import { StatCard } from "../components/StatCard";
import { Layout } from "../layout";
import {
  type AdminUserDetail,
  type AdminUserStats,
  type AdminViolationWithLog,
  StatusBadge,
} from "./components";

export const AdminUserView = ({
  user,
  violations,
  stats,
  currentUser,
}: {
  user: AdminUserDetail;
  violations: AdminViolationWithLog[];
  stats: AdminUserStats;
  currentUser: User;
}) => {
  return (
    <Layout title={`User: ${user.name}`} includeHtmx includeAlpine>
      <Header title="Admin" user={currentUser} isAdmin />
      <div class="w-full max-w-7xl mx-auto px-4 py-8">
        {/* Breadcrumbs */}
        <div class="flex items-center gap-2 text-sm text-brand-text mb-6">
          <a href="/admin" class="hover:text-brand-primary transition-colors">
            Dashboard
          </a>
          <span class="text-brand-border">/</span>
          <a
            href="/admin/users"
            class="hover:text-brand-primary transition-colors"
          >
            Users
          </a>
          <span class="text-brand-border">/</span>
          <span class="text-brand-heading font-medium">{user.name}</span>
        </div>

        {/* User Header */}
        <div class="bg-brand-surface border-2 border-brand-border rounded-2xl p-6 mb-8">
          <div class="flex justify-between items-start mb-4">
            <div>
              <h1 class="text-2xl font-bold text-brand-heading">{user.name}</h1>
              <p class="text-brand-text text-sm mt-1">{user.email}</p>
              {user.slackId && (
                <p class="text-brand-text text-sm">Slack: {user.slackId}</p>
              )}
            </div>
            {user.reviewStatus === "banned" ? (
              <form
                method="post"
                action={`/admin/users/${user.id}/unban`}
                class="inline"
                onsubmit="return confirm('Are you sure you want to unban this user?')"
              >
                <button
                  type="submit"
                  class="px-6 py-3 text-sm font-bold rounded-xl bg-green-500/10 text-green-400 hover:bg-green-500/20 transition-colors border border-green-500/30 hover:border-green-500/50 cursor-pointer"
                >
                  Unban User
                </button>
              </form>
            ) : (
              <form
                method="post"
                action={`/admin/users/${user.id}/ban`}
                class="inline"
                onsubmit="return confirm('Are you sure you want to ban this user? This will prevent them from using the service.')"
              >
                <button
                  type="submit"
                  class="px-6 py-3 text-sm font-bold rounded-xl bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors border border-red-500/30 hover:border-red-500/50 cursor-pointer"
                >
                  Ban User
                </button>
              </form>
            )}
          </div>
          <div class="flex flex-wrap gap-3 mt-4">
            <StatusBadge status={user.reviewStatus} />
            <span class="text-xs px-2.5 py-1.5 rounded-lg bg-brand-border text-brand-text font-medium">
              Joined: {new Date(user.createdAt).toLocaleDateString()}
            </span>
          </div>
        </div>

        {/* Stats Grid */}
        <h2 class="text-lg font-bold text-brand-heading mb-4">
          Violation Statistics
        </h2>
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-6 mb-8">
          <StatCard
            value={stats.totalViolations ?? violations.length}
            label="Total Violations"
          />
          <StatCard value={stats.violationsThisWeek} label="This Week" />
          <StatCard value={stats.violationsThisMonth} label="This Month" />
          <div class="border-2 border-brand-border bg-brand-surface p-6 rounded-2xl shadow-sm">
            <div class="text-2xl sm:text-3xl font-bold mb-2 text-brand-heading">
              <StatusBadge status={stats.reviewStatus} />
            </div>
            <div class="text-xs sm:text-sm font-medium text-brand-text uppercase tracking-wide">
              Current Status
            </div>
          </div>
        </div>

        {/* Violations List */}
        <div class="bg-brand-surface border-2 border-brand-border rounded-2xl p-6">
          <h2 class="text-lg font-bold text-brand-heading mb-6">
            Violation History ({violations.length})
          </h2>
          {violations.length === 0 ? (
            <p class="text-brand-text text-center py-12">
              No violations on record
            </p>
          ) : (
            <div class="space-y-3">
              {violations.map((item, idx: number) => (
                <div
                  x-data={`{ open${idx}: false }`}
                  key={item.violation.id}
                  class="bg-brand-bg border border-brand-border rounded-xl overflow-hidden"
                >
                  <button
                    type="button"
                    x-on:click={`open${idx} = !open${idx}`}
                    class="w-full px-4 py-3 flex justify-between items-center hover:bg-brand-bg/80 transition-colors text-left"
                  >
                    <div class="flex-1">
                      <div class="flex items-center gap-2 mb-1">
                        <span class="text-xs px-2 py-1 rounded-lg font-semibold bg-brand-primary/20 text-brand-primary uppercase">
                          {item.violation.category}
                        </span>
                        <span class="text-xs px-2 py-1 rounded-lg bg-blue-500/10 text-blue-400 font-medium">
                          {item.violation.type}
                        </span>
                      </div>
                      <p class="text-xs text-brand-text line-clamp-1">
                        {item.violation.content || "No content"}
                      </p>
                      <p class="text-xs text-brand-text/70 mt-1">
                        {new Date(item.violation.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <span
                      x-text={`open${idx} ? '▼' : '▶'`}
                      class="text-brand-text ml-2"
                    ></span>
                  </button>

                  <div
                    x-show={`open${idx}`}
                    class="px-4 py-3 bg-brand-bg/50 border-t border-brand-border/50 space-y-2"
                  >
                    <div>
                      <p class="text-xs font-bold text-brand-text uppercase tracking-wide block mb-1">
                        Flagged Content
                      </p>
                      <p class="text-xs text-brand-text bg-brand-bg rounded px-3 py-2 break-words">
                        {item.violation.content || "(No content stored)"}
                      </p>
                    </div>
                    <div class="grid grid-cols-2 gap-2 text-xs">
                      <div class="bg-brand-bg rounded px-3 py-2">
                        <span class="font-bold text-brand-text">Type:</span>
                        <p class="text-brand-text/70 mt-1">
                          {item.violation.type}
                        </p>
                      </div>
                      <div class="bg-brand-bg rounded px-3 py-2">
                        <span class="font-bold text-brand-text">Category:</span>
                        <p class="text-brand-text/70 mt-1">
                          {item.violation.category}
                        </p>
                      </div>
                      <div class="bg-brand-bg rounded px-3 py-2 col-span-2">
                        <span class="font-bold text-brand-text">
                          Timestamp:
                        </span>
                        <p class="text-brand-text/70 mt-1">
                          {new Date(item.violation.createdAt).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    <div class="mt-2">
                      {item.violation.dismissed ? (
                        <span class="text-xs px-2 py-1 rounded-lg bg-green-500/10 text-green-400 font-medium">
                          Dismissed
                        </span>
                      ) : (
                        <form
                          method="post"
                          action={`/admin/violations/${item.violation.id}/dismiss`}
                        >
                          <button
                            type="submit"
                            class="px-3 py-2 text-xs font-medium rounded-lg bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20 transition-colors border border-yellow-500/30 cursor-pointer"
                          >
                            Dismiss
                          </button>
                        </form>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
};
