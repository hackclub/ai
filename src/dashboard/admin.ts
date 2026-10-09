import type postgres from "postgres";

import { type AdminUserDetail, type AdminUserRow, AdminUsers } from "../admin/users";
import type { AccountSpend, AnalyticsQueries, RecentRequest, ServedBy } from "../analytics/queries";
import type { Discount, DiscountBook } from "../billing/discounts";
import { type GlobalPolicy, GlobalPolicies } from "../billing/policies";
import type { ModelCatalog } from "../models/catalog";

export type { AdminUserDetail, AdminUserRow, AccountSpend, Discount, GlobalPolicy, RecentRequest, ServedBy };

export type AdminUserPage = { user: AdminUserDetail; spend: AccountSpend; recent: RecentRequest[] };

export type AdminDiscountsPage = { discounts: Discount[]; servedBy: ServedBy[]; models: string[] };

/** What the `/admin` pages read. Pages check `isAdmin` before calling any of it. */
export class AdminReadModel {
  private readonly users: AdminUsers;
  private readonly policies: GlobalPolicies;

  constructor(
    sql: postgres.Sql,
    private readonly analytics: AnalyticsQueries,
    private readonly catalog: ModelCatalog,
    private readonly discountBook: DiscountBook,
  ) {
    this.users = new AdminUsers(sql);
    this.policies = new GlobalPolicies(sql);
  }

  searchUsers(query: string): Promise<AdminUserRow[]> {
    return this.users.search(query);
  }

  async user(userId: string): Promise<AdminUserPage | null> {
    const user = await this.users.detail(userId);
    if (!user) return null;
    const [spend, recent] = await Promise.all([
      this.analytics.accountSpend(user.billingAccountId),
      this.analytics.recentRequests(user.billingAccountId, { pageSize: 25 }),
    ]);
    return { user, spend, recent: recent.requests };
  }

  globalPolicies(): Promise<GlobalPolicy[]> {
    return this.policies.list();
  }

  async discounts(): Promise<AdminDiscountsPage> {
    const [discounts, servedBy, models] = await Promise.all([
      this.discountBook.list(),
      this.analytics.servedBy(),
      Promise.all([this.catalog.list("language"), this.catalog.list("embedding")])
        .then((lists) => lists.flat().map((model) => model.id).sort())
        .catch(() => []),
    ]);
    return { discounts, servedBy, models };
  }
}
