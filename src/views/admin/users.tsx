import type { User } from "../../types";
import { Header } from "../components/Header";
import { Layout } from "../layout";
import {
  AdminTabs,
  type AdminUserSearchResult,
  StatusBadge,
} from "./components";

export const AdminUsersView = ({
  query,
  status,
  results,
  user,
}: {
  query: string;
  status: string;
  results: AdminUserSearchResult[];
  user: User;
}) => {
  const statusTabs = [
    { key: "all", label: "All" },
    { key: "flagged", label: "Flagged" },
    { key: "strict", label: "Strict" },
    { key: "banned", label: "Banned" },
  ];

  const showDefault = !query && status === "all";

  return (
    <Layout title="Users" includeHtmx>
      <Header title="Admin" user={user} isAdmin />
      <div class="w-full max-w-7xl mx-auto px-4 py-8">
        <AdminTabs active="users" />

        <div class="bg-brand-surface border-2 border-brand-border rounded-2xl p-6">
          <h2 class="text-lg font-bold text-brand-heading mb-6">
            {query ? `Search: "${query}"` : "Users"}
          </h2>

          <form method="get" action="/admin/users" class="mb-4">
            <div class="flex gap-2">
              <input
                name="q"
                defaultValue={query}
                placeholder="Search by email, name, or Slack ID..."
                class="flex-1 px-4 py-3 rounded-xl bg-brand-bg border-2 border-brand-border text-brand-text focus:border-brand-primary outline-none transition-colors"
              />
              <button
                class="px-6 py-3 rounded-xl bg-brand-primary text-white font-bold hover:bg-brand-primary-hover transition-all"
                type="submit"
              >
                Search
              </button>
            </div>
          </form>

          {/* Status Filters */}
          <div class="flex gap-1 mb-6 bg-brand-bg rounded-xl p-1 border border-brand-border w-fit">
            {statusTabs.map((tab) => {
              const isActive = tab.key === status;
              return (
                <a
                  href={`/admin/users?status=${tab.key}`}
                  class={`px-3 py-2 text-xs font-bold rounded-lg transition-colors ${
                    isActive
                      ? "bg-brand-primary text-white"
                      : "text-brand-text hover:text-brand-heading"
                  }`}
                >
                  {tab.label}
                </a>
              );
            })}
          </div>

          {showDefault && (
            <p class="text-brand-text text-sm mb-4">
              Showing users with recent activity or non-normal status. Use the
              filters above or search to find specific users.
            </p>
          )}

          {query && results.length === 0 ? (
            <p class="text-brand-text text-center py-12">
              No users found matching "{query}"
            </p>
          ) : results.length === 0 ? (
            <p class="text-brand-text text-center py-12 text-sm">
              No users found with the selected filter.
            </p>
          ) : (
            <div class="space-y-2">
              {results.map((u) => (
                <div
                  class="flex justify-between items-center p-4 bg-brand-bg border border-brand-border rounded-xl hover:border-brand-primary/30 transition-all group"
                  key={u.id}
                >
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1">
                      <a
                        href={`/admin/users/${u.id}`}
                        class="font-bold text-brand-heading text-sm hover:text-brand-primary transition-colors"
                      >
                        {u.name}
                      </a>
                      <StatusBadge status={u.reviewStatus} />
                    </div>
                    <div class="text-xs text-brand-text">{u.email}</div>
                    {(u.violationCountWeek > 0 ||
                      u.violationCountMonth > 0) && (
                      <div class="flex gap-2 mt-2">
                        <span class="text-xs px-2 py-1 rounded-lg bg-red-500/10 text-red-400 font-medium">
                          Week: {u.violationCountWeek}
                        </span>
                        <span class="text-xs px-2 py-1 rounded-lg bg-orange-500/10 text-orange-400 font-medium">
                          Month: {u.violationCountMonth}
                        </span>
                      </div>
                    )}
                  </div>
                  <a
                    class="px-4 py-2 text-xs font-bold rounded-lg bg-brand-border hover:bg-brand-border/150 transition-colors text-brand-text"
                    href={`/admin/users/${u.id}`}
                  >
                    View Profile
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
};
