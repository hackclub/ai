import type { ClickHouseClient } from "@clickhouse/client";
import {
  parseCronItems,
  run,
  runMigrations,
  type Runner,
  type TaskList,
} from "graphile-worker";

import postgres from "postgres";

import type { BillingEngine } from "../billing/engine";
import {
  expireStaleReservations,
  type OpenRouterConfig,
  reconcilePendingReservations,
} from "../billing/reconciliation";
import {
  type RequestEventDrainer,
  startRequestEventDrainer,
} from "./request-events";

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
  /** Pause between outbox passes once it is empty. Default one second. */
  drainIntervalMs?: number;
  /** Enables the periodic billing.reconcile task when provided. */
  reconciliation?: ReconciliationDependencies;
  log?: (message: string) => void;
};

/** Creates the Graphile Worker schema, which the reconcile cron needs. */
export const migrateJobQueue = (connectionString: string) =>
  runMigrations({ connectionString });

export type TaskListOptions = {
  reconciliation?: ReconciliationDependencies;
  log?: (message: string) => void;
};

export const taskList = (resolved: TaskListOptions): TaskList => {
  const tasks: TaskList = {};
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

export type AnalyticsWorker = {
  runner: Runner;
  drainer: RequestEventDrainer;
  stop: () => Promise<void>;
};

/**
 * Starts the outbox drainer that copies finalized request events to
 * ClickHouse and the Graphile Worker runner for the reconcile cron. Stop
 * both with `stop()`.
 */
export const startAnalyticsWorker = async (
  options: AnalyticsWorkerOptions,
): Promise<AnalyticsWorker> => {
  await migrateJobQueue(options.connectionString);
  const sql = postgres(options.connectionString, { max: 1 });
  const drainer = startRequestEventDrainer({
    sql,
    clickhouse: options.clickhouse,
    intervalMs: options.drainIntervalMs,
    onError: (error) =>
      console.error("Failed to deliver request events to ClickHouse:", error),
  });
  const runner = await run({
    connectionString: options.connectionString,
    taskList: taskList({
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
  return {
    runner,
    drainer,
    stop: async () => {
      await drainer.stop();
      await runner.stop();
      await sql.end();
    },
  };
};
