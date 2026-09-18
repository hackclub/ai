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
  type ReplicateReconcileConfig,
} from "../billing/reconciliation";
import {
  type RequestEventDrainer,
  startRequestEventDrainer,
  stripParkedBodies,
} from "./request-events";

export const RECONCILE_TASK = "billing.reconcile";
export const OUTBOX_RETENTION_TASK = "analytics.strip_parked_bodies";

export type ReconciliationDependencies = {
  sql: postgres.Sql;
  billing: BillingEngine;
  openRouter: OpenRouterConfig;
  replicate?: ReplicateReconcileConfig;
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
  sql: postgres.Sql;
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
        replicate: deps.replicate,
        log,
      });
      helpers.logger.info(
        `billing.reconcile: expired=${expired.released} finalized=${reconciled.finalized} released=${reconciled.released} skipped=${reconciled.skipped} failed=${reconciled.failed + expired.failed}`,
      );
    };
  }
  tasks[OUTBOX_RETENTION_TASK] = async (_payload, helpers) => {
    const stripped = await stripParkedBodies(resolved.sql);
    helpers.logger.info(`analytics.strip_parked_bodies: stripped=${stripped}`);
  };
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
    // The drainer's max: 1 pool is shared with the retention task below; the
    // retention statement is short and runs once a day, so contention with
    // the once-a-second drain loop is negligible.
    taskList: taskList({
      sql,
      reconciliation: options.reconciliation,
      log: options.log,
    }),
    concurrency: options.concurrency ?? 8,
    noHandleSignals: true,
    parsedCronItems: parseCronItems([
      {
        task: OUTBOX_RETENTION_TASK,
        match: "17 3 * * *",
        identifier: OUTBOX_RETENTION_TASK,
        options: { queueName: OUTBOX_RETENTION_TASK, maxAttempts: 3, backfillPeriod: 0 },
      },
      ...(options.reconciliation
        ? [
            {
              task: RECONCILE_TASK,
              match: "*/5 * * * *",
              identifier: RECONCILE_TASK,
              // One reconcile at a time; a slow run never stacks up.
              options: { queueName: RECONCILE_TASK, maxAttempts: 3, backfillPeriod: 0 },
            },
          ]
        : []),
    ]),
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
