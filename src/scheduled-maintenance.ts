import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { INDEX_DIR } from "./ingest.js";
import { optimizeIndex, type OptimizeIndexResult } from "./store.js";
import {
  readGraphMaintenanceAudit,
  refreshGraphMaintenanceAudit,
  type GraphMaintenanceAudit,
  type SlugKind,
} from "./graph-maintenance.js";

export const MAINTENANCE_STATE_PATH = join(INDEX_DIR, "maintenance-state.json");

export type MaintenanceStatus = "never" | "running" | "success" | "error";

export interface ScheduledMaintenanceState {
  status: MaintenanceStatus;
  lastStarted?: string;
  lastFinished?: string;
  error?: string;
  cleanupOlderThanDays?: number;
  durationMs?: number;
  optimize?: OptimizeIndexResult;
  suggestionCounts?: Record<SlugKind, number>;
  auditGeneratedAt?: string;
}

export interface MaintenanceSnapshot {
  state: ScheduledMaintenanceState;
  audit: GraphMaintenanceAudit | null;
  running: boolean;
  nextRunAt: string | null;
  intervalMs: number;
}

type LogFn = (level: "info" | "warn" | "error", message: string, fields?: Record<string, string | number | boolean | undefined>) => void;

const DEFAULT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_STARTUP_DELAY_MS = 2500;
const DEFAULT_CLEANUP_DAYS = 7;

let running: Promise<ScheduledMaintenanceState> | null = null;
let timer: NodeJS.Timeout | null = null;

function envNumber(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

function maintenanceIntervalMs(): number {
  return envNumber("MEMORY_UI_MAINTENANCE_INTERVAL_MS", DEFAULT_INTERVAL_MS, 60_000);
}

function startupDelayMs(): number {
  return envNumber("MEMORY_UI_MAINTENANCE_STARTUP_DELAY_MS", DEFAULT_STARTUP_DELAY_MS, 0);
}

function cleanupOlderThanDays(): number {
  return envNumber("MEMORY_UI_MAINTENANCE_CLEANUP_DAYS", DEFAULT_CLEANUP_DAYS, 1);
}

function emptyState(): ScheduledMaintenanceState {
  return { status: "never" };
}

export async function readMaintenanceState(): Promise<ScheduledMaintenanceState> {
  try {
    return JSON.parse(await readFile(MAINTENANCE_STATE_PATH, "utf8")) as ScheduledMaintenanceState;
  } catch {
    return emptyState();
  }
}

async function writeMaintenanceState(state: ScheduledMaintenanceState): Promise<void> {
  await mkdir(INDEX_DIR, { recursive: true });
  await writeFile(MAINTENANCE_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

function weekKey(date: Date): string {
  const utc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const d = new Date(utc);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function successfulThisWeek(state: ScheduledMaintenanceState, now = new Date()): boolean {
  if (state.status !== "success" || !state.lastFinished) return false;
  return weekKey(new Date(state.lastFinished)) === weekKey(now);
}

function nextRunAtFor(state: ScheduledMaintenanceState, now = new Date()): string | null {
  if (running) return null;
  const intervalMs = maintenanceIntervalMs();
  if (state.status === "success" && state.lastFinished) {
    const target = new Date(state.lastFinished).getTime() + intervalMs;
    return new Date(Math.max(target, now.getTime())).toISOString();
  }
  return now.toISOString();
}

async function executeMaintenance(startedAt: string, previous: ScheduledMaintenanceState, log?: LogFn): Promise<ScheduledMaintenanceState> {
  const startedMs = Date.now();
  const cleanupDays = cleanupOlderThanDays();
  try {
    const [optimize, audit] = await Promise.all([
      optimizeIndex(cleanupDays),
      refreshGraphMaintenanceAudit(),
    ]);
    const state: ScheduledMaintenanceState = {
      ...previous,
      status: "success",
      lastStarted: startedAt,
      lastFinished: new Date().toISOString(),
      cleanupOlderThanDays: cleanupDays,
      durationMs: Date.now() - startedMs,
      optimize,
      suggestionCounts: audit.suggestionCounts,
      auditGeneratedAt: audit.generatedAt,
    };
    delete state.error;
    await writeMaintenanceState(state);
    log?.("info", "maintenance complete", {
      duration_ms: state.durationMs,
      people_suggestions: audit.suggestionCounts.person,
      team_suggestions: audit.suggestionCounts.team,
      tag_suggestions: audit.suggestionCounts.tag,
      optimized: optimize.tableExists,
    });
    return state;
  } catch (err) {
    const state: ScheduledMaintenanceState = {
      ...previous,
      status: "error",
      lastStarted: startedAt,
      lastFinished: new Date().toISOString(),
      cleanupOlderThanDays: cleanupDays,
      durationMs: Date.now() - startedMs,
      error: err instanceof Error ? err.message : String(err),
    };
    await writeMaintenanceState(state);
    log?.("error", "maintenance failed", { error: state.error });
    return state;
  } finally {
    running = null;
  }
}

export async function launchMaintenanceRun(log?: LogFn): Promise<boolean> {
  if (running) return false;
  const previous = await readMaintenanceState();
  const startedAt = new Date().toISOString();
  await writeMaintenanceState({
    ...previous,
    status: "running",
    lastStarted: startedAt,
    cleanupOlderThanDays: cleanupOlderThanDays(),
  });
  log?.("info", "maintenance started");
  running = executeMaintenance(startedAt, previous, log);
  return true;
}

export async function getMaintenanceSnapshot(): Promise<MaintenanceSnapshot> {
  const [state, audit] = await Promise.all([readMaintenanceState(), readGraphMaintenanceAudit()]);
  return {
    state,
    audit,
    running: Boolean(running),
    nextRunAt: nextRunAtFor(state),
    intervalMs: maintenanceIntervalMs(),
  };
}

function scheduleNext(log?: LogFn): void {
  if (timer) clearTimeout(timer);
  const intervalMs = maintenanceIntervalMs();
  const delay = Math.min(intervalMs, 2_147_483_647);
  timer = setTimeout(() => {
    void runIfDue(log).finally(() => scheduleNext(log));
  }, delay);
}

async function runIfDue(log?: LogFn): Promise<void> {
  const state = await readMaintenanceState();
  if (successfulThisWeek(state)) {
    log?.("info", "maintenance run skipped", { reason: "already_ran_this_week" });
    return;
  }
  await launchMaintenanceRun(log);
}

export function startMaintenanceScheduler(log?: LogFn): void {
  scheduleNext(log);
  setTimeout(() => {
    void runIfDue(log);
  }, startupDelayMs());
}
