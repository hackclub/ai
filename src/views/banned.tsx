import type { User } from "../types";
import { Slack, Warning } from "./components/Icons";
import { Layout } from "./layout";

type BannedViolation = {
  id: string;
  category: string;
  type: string;
  content: string | null;
  createdAt: Date | string | null;
};

type BannedViewProps = {
  user: User;
  violations: BannedViolation[];
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

const ViolationCard = ({ violation }: { violation: BannedViolation }) => {
  return (
    <div class="bg-brand-bg p-4 rounded-xl flex items-center justify-between">
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
            {violation.createdAt
              ? new Date(violation.createdAt).toLocaleString()
              : "Unknown date"}
          </div>
          {violation.content && (
            <div class="mt-2 text-xs text-brand-text/70 bg-brand-surface/50 rounded p-2 max-h-32 overflow-y-auto break-words font-mono">
              {violation.content}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export const BannedView = ({ user, violations }: BannedViewProps) => {
  return (
    <Layout title="Banned - Hack Club AI">
      <div class="min-h-screen flex items-center justify-center px-4 py-12">
        <div class="w-full max-w-2xl">
          <div class="text-center mb-8">
            <div class="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
              <Warning class="w-10 h-10" title="Warning" aria-hidden />
            </div>
            <h1 class="text-4xl font-bold text-brand-heading mb-4">
              You have been banned
            </h1>
            <p class="text-xl text-brand-text/90 mb-4">Hi, {user.name}</p>
            <p class="text-lg text-brand-text/80 mb-2">
              Your account has been banned from using Hack Club AI due to
              content policy violations.
            </p>
          </div>

          <div class="bg-brand-surface border-2 border-brand-border p-6 rounded-2xl mb-6">
            <h2 class="text-xl font-semibold mb-4 text-brand-heading">
              Recent Violations
            </h2>
            {violations.length === 0 ? (
              <p class="text-brand-text">No violation records found.</p>
            ) : (
              <div class="space-y-3">
                {violations.map((violation) => (
                  <ViolationCard key={violation.id} violation={violation} />
                ))}
              </div>
            )}
          </div>

          <div class="bg-brand-surface border-2 border-brand-border p-6 rounded-2xl text-center">
            <h2 class="text-xl font-semibold mb-3 text-brand-heading">
              Think this is a mistake?
            </h2>
            <p class="text-brand-text mb-4">
              You can appeal your ban by contacting Mahad on the Hack Club
              Slack. Please explain why you were banned and include your
              username ({user.name}).
            </p>
            <a
              href="https://hackclub.slack.com/app_redirect?channel=U059VC0UDEU"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-2 bg-brand-primary text-white px-6 py-3 rounded-xl font-semibold hover:bg-brand-primary-hover transition-colors"
            >
              <Slack class="w-5 h-5" title="Slack" />
              DM @mahad on Slack
            </a>
          </div>
        </div>
      </div>
    </Layout>
  );
};
