import type { SessionUser } from "./auth/sessions";
import type { Backend } from "./server";

declare global {
  namespace App {
    interface Locals {
      user: SessionUser | null;
      backend: Backend;
    }
  }
}

export {};
