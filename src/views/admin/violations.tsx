import type { User } from "../../types";
import { Header } from "../components/Header";
import { Layout } from "../layout";
import {
  AdminTabs,
  type AdminViolationWithUser,
  StatusBadge,
} from "./components";

export const AdminViolationsView = ({
  violations,
  status,
  user,
}: {
  violations: AdminViolationWithUser[];
  status: string;
  user: User;
}) => {
  const filterTabs = [
    { key: "all", label: "All" },
    { key: "active", label: "Active" },
    { key: "dismissed", label: "Dismissed" },
  ];

  return (
    <Layout title="Violations" includeHtmx>
      <Header title="Admin" user={user} isAdmin />
      <div class="w-full max-w-7xl mx-auto px-4 py-8">
        <AdminTabs active="violations" />

        <div class="bg-brand-surface border-2 border-brand-border rounded-2xl p-6">
          <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
            <h2 class="text-lg font-bold text-brand-heading">
              Violations ({violations.length})
            </h2>
            <div class="flex gap-1 bg-brand-bg rounded-xl p-1 border border-brand-border">
              {filterTabs.map((tab) => {
                const isActive = tab.key === status;
                return (
                  <a
                    href={`/admin/violations?status=${tab.key}`}
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
          </div>
          {violations.length === 0 ? (
            <p class="text-brand-text text-center py-12">
              {status === "active"
                ? "No active violations"
                : status === "dismissed"
                  ? "No dismissed violations"
                  : "No violations found"}
            </p>
          ) : (
            <div class="space-y-3">
              {violations.map((item) => (
                <div
                  class="p-4 bg-brand-bg border border-brand-border rounded-xl hover:border-brand-primary/30 transition-all"
                  key={item.violation.id}
                >
                  <div class="flex justify-between items-start gap-4">
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2 mb-2 flex-wrap">
                        <span class="text-xs px-2 py-1 rounded-lg bg-brand-primary/20 text-brand-primary font-bold uppercase">
                          {item.violation.category}
                        </span>
                        <span class="text-xs px-2 py-1 rounded-lg bg-blue-500/10 text-blue-400 font-medium">
                          {item.violation.type}
                        </span>
                        {item.user && (
                          <a
                            href={`/admin/users/${item.user.id}`}
                            class="text-xs px-2 py-1 rounded-lg bg-brand-border hover:bg-brand-border/150 transition-colors text-brand-text font-medium"
                          >
                            {item.user.name}
                          </a>
                        )}
                        <StatusBadge
                          status={item.user?.reviewStatus || "normal"}
                        />
                      </div>
                      <p class="text-sm text-brand-text line-clamp-2 mb-2">
                        {item.violation.content || "No content"}
                      </p>
                      <div class="text-xs text-brand-text/70">
                        {new Date(item.violation.createdAt).toLocaleString()}
                      </div>
                    </div>
                    <div class="flex items-start gap-2 ml-2 flex-shrink-0">
                      {item.user && (
                        <a
                          href={`/admin/users/${item.user.id}`}
                          class="px-3 py-2 text-xs font-bold rounded-lg bg-brand-border hover:bg-brand-border/150 transition-colors text-brand-text"
                        >
                          View User
                        </a>
                      )}
                      {item.violation.dismissed ? (
                        <span class="text-xs px-3 py-2 rounded-lg bg-green-500/10 text-green-400 font-medium border border-green-500/30">
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
