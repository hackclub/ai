export type AdminBannedUser = {
  id: string;
  email: string | null;
  name: string | null;
  reviewStatus: string;
  violationCountWeek: number;
  violationCountMonth: number;
};

export type AdminUserSummary = {
  id: string;
  email: string | null;
  name: string | null;
  reviewStatus: string;
};

export type AdminViolation = {
  id: string;
  category: string;
  type: string;
  content: string | null;
  createdAt: Date | string;
  dismissed: boolean;
};

export type AdminViolationWithUser = {
  violation: AdminViolation;
  user: AdminUserSummary | null;
};

export type AdminViolationWithLog = {
  violation: AdminViolation;
  requestLog: unknown;
};

export type AdminUserSearchResult = {
  id: string;
  email: string | null;
  name: string | null;
  reviewStatus: string;
  violationCountWeek: number;
  violationCountMonth: number;
};

export type AdminUserDetail = {
  id: string;
  email: string | null;
  name: string | null;
  slackId: string | null;
  createdAt: Date | string;
  reviewStatus: string;
};

export type AdminUserStats = {
  reviewStatus: string;
  violationsThisWeek: number;
  violationsThisMonth: number;
  totalViolations?: number;
};

export type ModerationStats = {
  totalViolations: number;
  activeViolations: number;
  bannedUsers: number;
  flaggedUsers: number;
  totalUsers: number;
};

export const StatusBadge = ({ status }: { status: string }) => {
  const colors: Record<string, { bg: string; text: string; label: string }> = {
    normal: { bg: "bg-green-500/10", text: "text-green-400", label: "Normal" },
    flagged: {
      bg: "bg-yellow-500/10",
      text: "text-yellow-400",
      label: "Flagged",
    },
    strict: {
      bg: "bg-orange-500/10",
      text: "text-orange-400",
      label: "Strict",
    },
    banned: { bg: "bg-red-500/10", text: "text-red-400", label: "Banned" },
  };
  const color = colors[status] || colors.normal;
  return (
    <span
      class={`text-xs px-2 py-1 rounded-lg font-medium ${color.bg} ${color.text}`}
    >
      {color.label}
    </span>
  );
};

export const AdminTabs = ({
  active,
}: {
  active: "dashboard" | "violations" | "users";
}) => {
  const tabs = [
    { href: "/admin", label: "Dashboard", key: "dashboard" },
    { href: "/admin/violations", label: "Violations", key: "violations" },
    { href: "/admin/users", label: "Users", key: "users" },
  ];

  return (
    <div class="flex gap-2 mb-8 pb-2 border-b-2 border-brand-border overflow-x-auto">
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        return (
          <a
            href={tab.href}
            class={`px-4 py-3 whitespace-nowrap ${
              isActive
                ? "font-bold text-brand-heading border-b-2 border-brand-primary -mb-[2px]"
                : "font-medium text-brand-text hover:text-brand-heading transition-colors"
            }`}
            {...(isActive ? { "aria-current": "page" } : {})}
          >
            {tab.label}
          </a>
        );
      })}
    </div>
  );
};
