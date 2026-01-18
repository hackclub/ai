import type { PremiumModelConfig } from "../lib/premium";
import { formatDonationAmount } from "../lib/premium";
import type { User } from "../types";
import { Header } from "./components/Header";
import { Layout } from "./layout";

type PremiumRequest = {
  id: string;
  userId: string;
  modelId: string;
  status: string;
  referenceCode: string;
  requestedAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  notes: string | null;
  userName: string | null;
  userEmail: string | null;
  userSlackId: string;
};

type AdminDashboardProps = {
  user: User;
  pendingRequests: PremiumRequest[];
  recentReviewed: PremiumRequest[];
  premiumModels: PremiumModelConfig[];
};

export const AdminDashboard = ({
  user,
  pendingRequests,
  recentReviewed,
  premiumModels,
}: AdminDashboardProps) => {
  return (
    <Layout title="Admin Dashboard - Hack Club AI" includeHtmx includeAlpine>
      <div
        x-data={`{
          async approveRequest(id) {
            if (!confirm('Approve this request?')) return;
            const res = await fetch('/admin/requests/' + id + '/approve', { method: 'POST' });
            if (res.ok) {
              htmx.trigger('#pending-requests', 'refresh');
            } else {
              alert('Failed to approve');
            }
          },
          async rejectRequest(id) {
            const notes = prompt('Rejection reason (optional):');
            const res = await fetch('/admin/requests/' + id + '/reject', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ notes })
            });
            if (res.ok) {
              htmx.trigger('#pending-requests', 'refresh');
            } else {
              alert('Failed to reject');
            }
          }
        }`}
      >
        <Header title="hackai" user={user} />

        <div class="w-full max-w-6xl mx-auto px-4 py-8">
          <div class="flex items-center gap-3 mb-8">
            <h1 class="text-3xl font-bold text-brand-heading">Admin Dashboard</h1>
            <span class="px-3 py-1 text-xs font-medium rounded-full bg-brand-primary/10 text-brand-primary border border-brand-primary/30">
              Admin
            </span>
          </div>

          {/* Premium Models Info */}
          <div class="mb-12">
            <h2 class="text-2xl font-bold mb-4 text-brand-heading">Premium Models</h2>
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {premiumModels.map((model) => (
                <div class="bg-brand-surface border-2 border-brand-border rounded-xl p-4">
                  <h3 class="font-bold text-brand-heading mb-2">{model.displayName}</h3>
                  <code class="text-xs font-mono text-brand-primary">{model.modelId}</code>
                  <div class="mt-3 flex items-center gap-2">
                    <span class="text-sm text-brand-text">Required donation:</span>
                    <span class="font-bold text-amber-400">
                      {formatDonationAmount(model.requiredDonationCents)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Pending Requests */}
          <div class="mb-12">
            <div class="flex justify-between items-center mb-4">
              <h2 class="text-2xl font-bold text-brand-heading">
                Pending Requests
                {pendingRequests.length > 0 && (
                  <span class="ml-2 px-2 py-0.5 text-sm font-medium rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/30">
                    {pendingRequests.length}
                  </span>
                )}
              </h2>
            </div>
            <div
              id="pending-requests"
              hx-get="/admin/requests/partial"
              hx-trigger="refresh"
              hx-swap="innerHTML"
            >
              <PendingRequestsTable requests={pendingRequests} />
            </div>
          </div>

          {/* Recent Approved */}
          <div class="mb-12">
            <h2 class="text-2xl font-bold mb-4 text-brand-heading">Recently Approved</h2>
            {recentReviewed.length === 0 ? (
              <div class="text-center py-8 text-brand-text bg-brand-surface border-2 border-brand-border rounded-2xl">
                No approved requests yet
              </div>
            ) : (
              <div class="overflow-x-auto border-2 border-brand-border bg-brand-surface rounded-2xl">
                <table class="w-full border-collapse">
                  <thead>
                    <tr class="border-b-2 border-brand-border bg-brand-bg/50">
                      <th class="text-left py-4 px-4 font-bold text-sm text-brand-heading uppercase tracking-wider">
                        User
                      </th>
                      <th class="text-left py-4 px-4 font-bold text-sm text-brand-heading uppercase tracking-wider">
                        Model
                      </th>
                      <th class="text-left py-4 px-4 font-bold text-sm text-brand-heading uppercase tracking-wider">
                        Reference
                      </th>
                      <th class="text-left py-4 px-4 font-bold text-sm text-brand-heading uppercase tracking-wider">
                        Approved
                      </th>
                      <th class="text-left py-4 px-4 font-bold text-sm text-brand-heading uppercase tracking-wider">
                        By
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentReviewed.map((req) => (
                      <tr class="border-b border-brand-border/50 hover:bg-brand-bg/30 transition-colors">
                        <td class="py-3 px-4 text-sm text-brand-text">
                          <div class="font-medium">{req.userName || "Unknown"}</div>
                          <div class="text-xs text-brand-text/70">{req.userEmail}</div>
                        </td>
                        <td class="py-3 px-4 text-sm font-mono text-brand-primary">
                          {req.modelId}
                        </td>
                        <td class="py-3 px-4">
                          <code class="bg-brand-bg px-2 py-1 rounded text-xs font-mono text-green-400 border border-green-500/30">
                            {req.referenceCode}
                          </code>
                        </td>
                        <td class="py-3 px-4 text-sm text-brand-text">
                          {req.reviewedAt ? new Date(req.reviewedAt).toLocaleDateString() : "-"}
                        </td>
                        <td class="py-3 px-4 text-sm text-brand-text">
                          {req.reviewedBy || "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
};

const PendingRequestsTable = ({
  requests,
}: {
  requests: PremiumRequest[];
}) => {
  if (requests.length === 0) {
    return (
      <div class="text-center py-8 text-brand-text bg-brand-surface border-2 border-brand-border rounded-2xl">
        No pending requests
      </div>
    );
  }

  return (
    <div class="overflow-x-auto border-2 border-brand-border bg-brand-surface rounded-2xl">
      <table class="w-full border-collapse">
        <thead>
          <tr class="border-b-2 border-brand-border bg-brand-bg/50">
            <th class="text-left py-4 px-4 font-bold text-sm text-brand-heading uppercase tracking-wider">
              User
            </th>
            <th class="text-left py-4 px-4 font-bold text-sm text-brand-heading uppercase tracking-wider">
              Model
            </th>
            <th class="text-left py-4 px-4 font-bold text-sm text-brand-heading uppercase tracking-wider">
              Reference Code
            </th>
            <th class="text-left py-4 px-4 font-bold text-sm text-brand-heading uppercase tracking-wider">
              Requested
            </th>
            <th class="text-left py-4 px-4 font-bold text-sm text-brand-heading uppercase tracking-wider">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {requests.map((req) => (
            <tr class="border-b border-brand-border/50 hover:bg-brand-bg/30 transition-colors">
              <td class="py-3 px-4 text-sm text-brand-text">
                <div class="font-medium">{req.userName || "Unknown"}</div>
                <div class="text-xs text-brand-text/70">{req.userEmail || req.userSlackId}</div>
              </td>
              <td class="py-3 px-4 text-sm font-mono text-brand-primary">
                {req.modelId}
              </td>
              <td class="py-3 px-4">
                <code class="bg-brand-bg px-2 py-1 rounded text-xs font-mono text-amber-400 border border-amber-500/30">
                  {req.referenceCode}
                </code>
              </td>
              <td class="py-3 px-4 text-sm text-brand-text">
                {new Date(req.requestedAt).toLocaleDateString()}
              </td>
              <td class="py-3 px-4">
                <div class="flex gap-2">
                  <button
                    type="button"
                    x-on:click={`approveRequest('${req.id}')`}
                    class="px-3 py-1.5 text-xs font-medium rounded-full bg-green-500/10 text-green-400 border border-green-500/30 hover:bg-green-500/20 transition-all"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    x-on:click={`rejectRequest('${req.id}')`}
                    class="px-3 py-1.5 text-xs font-medium rounded-full bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 transition-all"
                  >
                    Reject
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
