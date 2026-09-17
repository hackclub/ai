import type { ClickHouseClient } from "@clickhouse/client";
import type postgres from "postgres";
import {
  parseCronItems,
  run,
  runMigrations,
  type Runner,
  type TaskList,
} from "graphile-worker";

import { type BillingEngine, REQUEST_EVENT_TASK } from "../billing/engine";
import {
  expireStaleReservations,
  type OpenRouterConfig,
  reconcilePendingReservations,
} from "../billing/reconciliation";
import { makeRequestEventTask } from "./request-event-task";

export const RECONCILE_TASK = "billing.reconcile";

export type ReconciliationDependencies = {
  sql: postgres.Sql;
  billing: BillingEngine;
  openRouter: OpenRouterConfig;
};

export type AnalyticsWorkerOptions = {
  connectionString: string;
  clickhouse: ClickHouseClient;
  concurrency?: number;
  /** Enables the periodic billing.reconcile task when provided. */
  reconciliation?: ReconciliationDependencies;
  log?: (message: string) => void;
};

/**
 * Creates the Graphile Worker schema if needed. Must run before the first
 * finalization, which calls graphile_worker.add_job.
 */
export const migrateJobQueue = (connectionString: string) =>
  runMigrations({ connectionString });

export type TaskListOptions = {
  clickhouse: ClickHouseClient;
  reconciliation?: ReconciliationDependencies;
  log?: (message: string) => void;
};

export const taskList = (
  options: ClickHouseClient | TaskListOptions,
): TaskList => {
  const resolved: TaskListOptions =
    "clickhouse" in options ? options : { clickhouse: options };
  const tasks: TaskList = {
    [REQUEST_EVENT_TASK]: makeRequestEventTask(resolved.clickhouse),
  };
  const deps = resolved.reconciliation;
  if (deps) {
    tasks[RECONCILE_TASK] = async (_payload, helpers) => {
      const log = resolved.log ?? ((message: string) => helpers.logger.info(message));
      const expired = await expireStaleReservations({
        sql: deps.sql,
        billing: deps.billing,
        log,
      });
      const reconciled = await reconcilePendingReservations({
        sql: deps.sql,
        billing: deps.billing,
        openRouter: deps.openRouter,
        log,
      });
      helpers.logger.info(
        `billing.reconcile: expired=${expired.released} finalized=${reconciled.finalized} released=${reconciled.released} skipped=${reconciled.skipped} failed=${reconciled.failed + expired.failed}`,
      );
    };
  }
  return tasks;
};

/** Starts the in-process job runner. Stop it with `runner.stop()`. */
export const startAnalyticsWorker = async (
  options: AnalyticsWorkerOptions,
): Promise<Runner> => {
  await migrateJobQueue(options.connectionString);
  return run({
    connectionString: options.connectionString,
    taskList: taskList({
      clickhouse: options.clickhouse,
      reconciliation: options.reconciliation,
      log: options.log,
    }),
    concurrency: options.concurrency ?? 8,
    noHandleSignals: true,
    parsedCronItems: parseCronItems(
      options.reconciliation
        ? [
            {
              task: RECONCILE_TASK,
              match: "*/5 * * * *",
              identifier: RECONCILE_TASK,
              // One reconcile at a time; a slow run never stacks up.
              options: { queueName: RECONCILE_TASK, maxAttempts: 3, backfillPeriod: 0 },
            },
          ]
        : [],
    ),
  });
};
