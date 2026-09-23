import type { SessionUser } from "./auth/sessions";
import type { DashboardReadModel } from "./dashboard/read-model";

declare global {
  namespace App {
    interface Locals {
      user: SessionUser | null;
      dashboard: DashboardReadModel;
    }
  }
}

export {};
