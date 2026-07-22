import type { User } from "../../types";
import { Header } from "../components/Header";
import { StatCard } from "../components/StatCard";
import { Layout } from "../layout";
import {
  type AdminBannedUser,
  AdminTabs,
  type ModerationStats,
} from "./components";

export const AdminView = ({
  moderationStats,
  bannedUsers,
  user,
}: {
  moderationStats: ModerationStats;
  bannedUsers: AdminBannedUser[];
  user: User;
}) => {
  return (
    <Layout title="Admin Dashboard">
      <Header title="Admin" user={user} isAdmin />
      <div class="w-full max-w-7xl mx-auto px-4 py-8">
        <AdminTabs active="dashboard" />

        {/* Quick Actions */}
        <div class="flex flex-wrap gap-3 mb-8">
          <a
            href="/admin/violations"
            class="px-5 py-3 rounded-xl bg-brand-primary text-white font-bold text-sm hover:bg-brand-primary-hover transition-all inline-flex items-center gap-2"
          >
            <span>Browse Violations</span>
            {moderationStats.activeViolations > 0 && (
              <span class="bg-white/20 px-2 py-0.5 rounded-lg text-xs">
                {moderationStats.activeViolations} active
              </span>
            )}
          </a>
          <a
            href="/admin/users"
            class="px-5 py-3 rounded-xl bg-brand-surface border-2 border-brand-border text-brand-heading font-bold text-sm hover:border-brand-primary transition-all inline-flex items-center gap-2"
          >
            <span>Search Users</span>
          </a>
        </div>

        {/* Moderation Stats */}
        <h2 class="text-lg font-bold text-brand-heading mb-4">
          Moderation Overview
        </h2>
        <div class="grid grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-6 mb-12">
          <StatCard
            value={moderationStats.totalViolations.toLocaleString()}
            label="Total Violations"
          />
          <StatCard
            value={moderationStats.activeViolations.toLocaleString()}
            label="Active Violations"
          />
          <StatCard
            value={moderationStats.bannedUsers.toLocaleString()}
            label="Banned Users"
          />
          <StatCard
            value={moderationStats.flaggedUsers.toLocaleString()}
            label="Flagged / Strict"
          />
          <StatCard
            value={moderationStats.totalUsers.toLocaleString()}
            label="Total Users"
          />
        </div>

        {/* Recently Banned */}
        <div class="bg-brand-surface border-2 border-brand-border rounded-2xl p-6">
          <div class="flex justify-between items-center mb-6">
            <h2 class="text-lg font-bold text-brand-heading">
              Recently Banned Users ({bannedUsers.length})
            </h2>
            {bannedUsers.length > 10 && (
              <a
                href="/admin/users?q="
                class="text-sm font-medium text-brand-primary hover:text-brand-primary-hover transition-colors"
              >
                View all
              </a>
            )}
          </div>
          {bannedUsers.length === 0 ? (
            <p class="text-brand-text text-sm py-8 text-center">
              No banned users
            </p>
          ) : (
            <div class="space-y-3">
              {bannedUsers.slice(0, 10).map((u) => (
                <div
                  class="flex justify-between items-center p-3 bg-brand-bg border border-brand-border rounded-xl hover:border-brand-primary/30 transition-all"
                  key={u.id}
                >
                  <div class="flex-1 min-w-0">
                    <a
                      href={`/admin/users/${u.id}`}
                      class="font-medium text-brand-heading text-sm hover:text-brand-primary transition-colors"
                    >
                      {u.name}
                    </a>
                    <div class="text-xs text-brand-text mt-1">{u.email}</div>
                    <div class="flex gap-2 mt-2">
                      <span class="text-xs px-2 py-1 rounded-lg bg-red-500/10 text-red-400 font-medium">
                        Week: {u.violationCountWeek}
                      </span>
                      <span class="text-xs px-2 py-1 rounded-lg bg-orange-500/10 text-orange-400 font-medium">
                        Month: {u.violationCountMonth}
                      </span>
                    </div>
                  </div>
                  <div class="flex gap-2 ml-4 flex-shrink-0">
                    <a
                      class="px-3 py-2 text-xs font-medium rounded-lg bg-brand-border hover:bg-brand-border/150 transition-colors text-brand-text"
                      href={`/admin/users/${u.id}`}
                    >
                      Details
                    </a>
                    <form
                      method="post"
                      action={`/admin/users/${u.id}/unban`}
                      class="inline"
                    >
                      <button
                        type="submit"
                        class="px-3 py-2 text-xs font-medium rounded-lg bg-green-500/10 text-green-400 hover:bg-green-500/20 transition-colors border border-green-500/30"
                      >
                        Unban
                      </button>
                    </form>
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
