import type { Violation } from "../db/schema";
import type { User } from "../types";
import { Header } from "./components/Header";
import { Layout } from "./layout";

type ViolationsViewProps = {
  user: User;
  stats: {
    reviewStatus: string;
    violationsThisWeek: number;
    violationsThisMonth: number;
    totalViolations?: number;
    weeklyThreshold: number;
    strictThreshold: number;
    monthlyThreshold: number;
  };
  violations: Violation[];
  flagSettings: {
    optInForcedReview: boolean;
  };
};

export const ViolationsView = ({
  user,
  stats,
  violations,
  flagSettings,
}: ViolationsViewProps) => {
  const getStatusColor = (status: string) => {
    switch (status) {
      case "normal":
        return "text-green-400";
      case "flagged":
        return "text-yellow-400";
      case "strict":
        return "text-orange-400";
      case "banned":
        return "text-red-400";
      default:
        return "text-gray-400";
    }
  };

  const getCategoryBadgeColor = (category: string) => {
    switch (category) {
      case "sexual":
      case "sexual/minors":
        return "bg-pink-100 text-pink-800";
      case "violence":
        return "bg-red-100 text-red-800";
      case "harassment":
      case "hate":
        return "bg-orange-100 text-orange-800";
      case "self-harm":
        return "bg-purple-100 text-purple-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  return (
    <Layout title="Violations" includeAlpine includeHtmx user={user}>
      <Header title="hackai" user={user} />
      <div
        x-data={`{
          forcedReviewEnabled: ${flagSettings.optInForcedReview},
          updatingForcedReview: false,

          async setForcedReview(nextValue) {
            const previousValue = this.forcedReviewEnabled;
            this.forcedReviewEnabled = nextValue;
            this.updatingForcedReview = true;

            try {
              const res = await fetch('/api/violations/flag-settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ optInForcedReview: nextValue }),
              });

              if (!res.ok) {
                throw new Error('Failed to update forced review setting');
              }
            } catch (error) {
              this.forcedReviewEnabled = previousValue;
              console.error(error);
            } finally {
              this.updatingForcedReview = false;
            }
          },
        }`}
        class="w-full max-w-6xl mx-auto px-4 py-8"
      >
        <h2 class="text-2xl font-bold mb-6 text-brand-heading">
          Content Violations
        </h2>

        <div class="bg-brand-surface border-2 border-brand-border p-6 rounded-2xl mb-8">
          <h3 class="text-lg font-semibold mb-4 text-brand-heading">
            Your Review Status
          </h3>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div class="bg-brand-bg p-4 rounded-xl">
              <div class="text-sm text-brand-text mb-1">Current Status</div>
              <div
                class={`text-xl font-bold capitalize ${getStatusColor(stats.reviewStatus)}`}
              >
                {stats.reviewStatus}
              </div>
            </div>
            <div class="bg-brand-bg p-4 rounded-xl">
              <div class="text-sm text-brand-text mb-1">This Week</div>
              <div class="text-xl font-bold text-brand-heading">
                {stats.violationsThisWeek} / {stats.weeklyThreshold}
              </div>
              <div class="text-xs text-brand-text mt-1">
                {stats.violationsThisWeek >= stats.weeklyThreshold
                  ? "Flagged"
                  : "safe"}
              </div>
            </div>
            <div class="bg-brand-bg p-4 rounded-xl">
              <div class="text-sm text-brand-text mb-1">This Month</div>
              <div class="text-xl font-bold text-brand-heading">
                {stats.violationsThisMonth} / {stats.monthlyThreshold}
              </div>
              <div class="text-xs text-brand-text mt-1">
                {stats.violationsThisMonth >= stats.monthlyThreshold
                  ? "Banned"
                  : "safe"}
              </div>
            </div>
            <div class="bg-brand-bg p-4 rounded-xl">
              <div class="text-sm text-brand-text mb-1">Review Mode</div>
              <div
                class="text-xl font-bold text-brand-heading capitalize"
                x-text="forcedReviewEnabled ? 'Forced' : 'Standard'"
              >
                {flagSettings.optInForcedReview ? "Forced" : "Standard"}
              </div>
              <div
                class="text-xs text-brand-text mt-1"
                x-text="forcedReviewEnabled ? 'All requests reviewed' : 'Sampled'"
              >
                {flagSettings.optInForcedReview
                  ? "All requests reviewed"
                  : "Sampled"}
              </div>
            </div>
          </div>

          <div class="border-t border-brand-border pt-4">
            <h4 class="text-sm font-medium text-brand-heading mb-2">
              Enable Forced Review
            </h4>
            <p class="text-sm text-brand-text mb-3">
              When enabled, all your requests will be reviewed before being
              processed. Flagged content will be blocked and notifications sent
              to your application. Violations here don't count against your
              account thresholds.
            </p>
            <label class="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                id="forced-review-toggle"
                class="sr-only peer"
                x-bind:checked="forcedReviewEnabled"
                x-bind:disabled="updatingForcedReview"
                x-on:change="setForcedReview($event.target.checked)"
              />
              <div class="w-11 h-6 bg-brand-border rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-primary"></div>
              <span
                class="ml-3 text-sm font-medium text-brand-text"
                x-text="forcedReviewEnabled ? 'Forced review enabled' : 'Forced review disabled'"
              >
                {flagSettings.optInForcedReview
                  ? "Forced review enabled"
                  : "Forced review disabled"}
              </span>
            </label>
          </div>
        </div>

        <div class="bg-brand-surface border-2 border-brand-border p-6 rounded-2xl">
          <h3 class="text-lg font-semibold mb-4 text-brand-heading">
            Recent Violations
          </h3>
          {violations.length === 0 ? (
            <div class="text-center py-8 text-brand-text">
              <svg
                class="w-12 h-12 mx-auto mb-3 text-green-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                role="img"
              >
                <title>No violations found</title>
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <p>No violations found. Great job keeping it clean!</p>
            </div>
          ) : (
            <div class="space-y-3">
              {violations.map((violation) => (
                <div
                  key={violation.id}
                  class="bg-brand-bg p-4 rounded-xl flex items-center justify-between"
                >
                  <div class="flex items-center gap-4">
                    <div
                      class={`w-2 h-2 rounded-full ${violation.category === "sexual" || violation.category === "sexual/minors" ? "bg-pink-500" : violation.category === "violence" ? "bg-red-500" : "bg-orange-500"}`}
                    />
                    <div>
                      <div class="flex items-center gap-2">
                        <span
                          class={`text-xs px-2 py-0.5 rounded-full capitalize ${getCategoryBadgeColor(violation.category)}`}
                        >
                          {violation.category}
                        </span>
                        <span class="text-xs text-brand-text capitalize">
                          {violation.type}
                        </span>
                      </div>
                      <div class="text-xs text-brand-text mt-1">
                        {new Date(violation.createdAt).toLocaleString()}
                      </div>
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
