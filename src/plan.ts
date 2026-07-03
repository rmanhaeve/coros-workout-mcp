// Training-plan (schedule) payload builder for COROS Training Hub.
//
// COROS has NO "assign one workout to a date" endpoint. Scheduling is done by
// POSTing a multi-week PLAN container to /training/plan/add. Reverse-engineered
// from a HAR capture of trainingeu.coros.com's /schedule-plan/add page (see
// research/schedule-plan-request-all.txt).
//
// Payload model (decoded from the page's savePlan()):
//   programs[]      full program-detail objects (as returned by
//                   /training/program/detail) each tagged with `idInPlan`,
//                   `cardType:"program"`, `dataType:"program"`. The server
//                   clones + re-ids them into the plan.
//   entities[]      placement records: {happenDay:"", idInPlan, dayNo,
//                   sortNoInSchedule}. dayNo is a 0-based day offset
//                   (dayNo = 7*weekIndex + dayOfWeek). happenDay is always ""
//                   in this surface — placement is purely by dayNo.
//   versionObjects  {id: idInPlan, status: 1} per program.
//   totalDay        max(dayNo) + 1.
//   minWeeks/maxWeeks  MISNOMER: these are the MIN/MAX number of workouts in a
//                   single week, across weeks that contain at least one workout
//                   (COROS's own savePlan computes them this way).
//   weekStages      sent empty ([]); the server recomputes per-week summaries.
//
// This module is pure (no network); the caller supplies already-fetched program
// detail objects. Orchestration (fetch details, POST plan) lives in coros-api.ts.

import { DEFAULT_SOURCE_URL } from "./coros-api.js";

/** A program/detail object as returned by GET /training/program/detail. */
export type ProgramDetail = Record<string, unknown> & { id?: string; name?: string };

export interface PlanPlacement {
  /** Full program-detail object to schedule. */
  program: ProgramDetail;
  /** 0-based day offset within the plan (dayNo = 7*week + dayOfWeek). */
  dayNo: number;
  /**
   * Real calendar date this workout happens, "YYYYMMDD". Optional. The COROS
   * plan builder always sends "" (pure day-offset template), but the server
   * stores a real happenDay when supplied — the date the entity binds to.
   */
  happenDay?: string;
  /** Order among multiple workouts on the same day. Default 1. */
  sortNoInSchedule?: number;
}

/** COROS numeric region ids. eu=3 verified from capture; us is best-effort. */
export const REGION_IDS: Record<string, number> = { eu: 3, us: 2 };

/** Plan source thumbnail (lifted from the captured plan/add body). */
export const DEFAULT_PLAN_SOURCE_ID = "425868133463670784";

interface PlanEntity {
  happenDay: string;
  idInPlan: number;
  dayNo: number;
  sortNoInSchedule: number;
}

interface PlanVersionObject {
  id: number;
  status: number;
}

export interface TrainingPlanPayload {
  name: string;
  overview: string;
  entities: PlanEntity[];
  programs: ProgramDetail[];
  versionObjects: PlanVersionObject[];
  weekStages: unknown[];
  maxIdInPlan: number;
  totalDay: number;
  minWeeks: number;
  maxWeeks: number;
  pbVersion: number;
  region: number;
  sourceId: string;
  sourceUrl: string;
  unit: number;
}

export interface BuildPlanOptions {
  name: string;
  overview?: string;
  placements: PlanPlacement[];
  /** Numeric COROS region id (eu=3). */
  region: number;
  sourceId?: string;
  sourceUrl?: string;
  unit?: number;
}

/**
 * Min/max workouts-per-week across weeks that hold at least one workout.
 * Mirrors COROS savePlan(): collect per-week counts (weeks with content only),
 * sort ascending, take first (min) and last (max). Empty -> {0,0}.
 */
export function weeklyWorkoutCountRange(dayNos: number[]): { minWeeks: number; maxWeeks: number } {
  const perWeek = new Map<number, number>();
  for (const d of dayNos) {
    const week = Math.floor(d / 7);
    perWeek.set(week, (perWeek.get(week) ?? 0) + 1);
  }
  const counts = [...perWeek.values()].sort((a, b) => a - b);
  return { minWeeks: counts[0] ?? 0, maxWeeks: counts[counts.length - 1] ?? 0 };
}

/**
 * Whole-day difference targetISO - startISO, both "YYYY-MM-DD". Used to turn
 * a calendar date into a plan dayNo relative to the plan's day-0 anchor.
 */
export function dayNoFromDates(startISO: string, targetISO: string): number {
  const start = parseISODate(startISO);
  const target = parseISODate(targetISO);
  const MS_PER_DAY = 86_400_000;
  return Math.round((target.getTime() - start.getTime()) / MS_PER_DAY);
}

/** "YYYY-MM-DD" -> COROS "YYYYMMDD" happenDay format. */
export function toHappenDay(iso: string): string {
  parseISODate(iso); // validate
  return iso.trim().replace(/-/g, "");
}

/** COROS "YYYYMMDD" happenDay for the date `dayNo` days after startISO. */
export function happenDayFromStart(startISO: string, dayNo: number): string {
  const d = parseISODate(startISO);
  d.setUTCDate(d.getUTCDate() + dayNo);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function parseISODate(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) throw new Error(`Invalid date "${iso}" (expected "YYYY-MM-DD")`);
  // Construct in UTC to avoid DST/timezone drift in day arithmetic.
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** In-place edits to an existing plan (see buildPlanUpdatePayload). */
export interface PlanEdits {
  /** Move every workout on `fromDay` (0-based dayNo) to `toDay`. */
  moves?: Array<{ fromDay: number; toDay: number }>;
  /** New plan name. */
  name?: string;
  /** New plan description. */
  overview?: string;
}

/**
 * Build a /training/plan/update body from a plan's stored detail document plus
 * a set of edits. plan/update is a full-document PUT: we echo `detail` back with
 * modifications, recompute totalDay/min/maxWeeks, and mark each changed entity
 * in versionObjects as status 2 (existing/modified) — the form the server
 * accepts (verified against a live move-a-day edit).
 */
export function buildPlanUpdatePayload(
  detail: Record<string, unknown>,
  edits: PlanEdits
): Record<string, unknown> {
  const body = JSON.parse(JSON.stringify(detail)) as Record<string, unknown>;
  const entities = (body.entities as Array<Record<string, unknown>>) ?? [];
  if (entities.length === 0) throw new Error("Plan has no entities to edit");

  const changed = new Set<string>();
  for (const m of edits.moves ?? []) {
    if (!Number.isInteger(m.toDay) || m.toDay < 0) {
      throw new Error(`toDay must be a non-negative integer (got ${m.toDay})`);
    }
    let matched = false;
    for (const e of entities) {
      if (Number(e.dayNo) === m.fromDay) {
        e.dayNo = m.toDay;
        changed.add(String(e.idInPlan));
        matched = true;
      }
    }
    if (!matched) throw new Error(`No workout found on day ${m.fromDay}`);
  }

  if (edits.name !== undefined) body.name = edits.name;
  if (edits.overview !== undefined) body.overview = edits.overview;

  const dayNos = entities.map((e) => Number(e.dayNo));
  body.totalDay = Math.max(...dayNos) + 1;
  const { minWeeks, maxWeeks } = weeklyWorkoutCountRange(dayNos);
  body.minWeeks = minWeeks;
  body.maxWeeks = maxWeeks;

  body.versionObjects = [...changed].map((id) => {
    const e = entities.find((x) => String(x.idInPlan) === id)!;
    return {
      id: String(id),
      planProgramId: String(e.planProgramId ?? id),
      planId: body.id,
      status: 2,
      type: 0,
    };
  });

  return body;
}

/** Assemble the /training/plan/add body from placed program-detail objects. */
export function buildTrainingPlanPayload(opts: BuildPlanOptions): TrainingPlanPayload {
  const { placements } = opts;
  if (placements.length === 0) {
    throw new Error("A training plan needs at least one placed workout");
  }
  for (const p of placements) {
    if (!Number.isInteger(p.dayNo) || p.dayNo < 0) {
      throw new Error(`dayNo must be a non-negative integer (got ${p.dayNo})`);
    }
  }

  const entities: PlanEntity[] = [];
  const programs: ProgramDetail[] = [];
  const versionObjects: PlanVersionObject[] = [];

  placements.forEach((placement, index) => {
    const idInPlan = index + 1;
    // Program-detail object + the three fields the plan builder adds.
    programs.push({
      ...placement.program,
      idInPlan,
      cardType: "program",
      dataType: "program",
    });
    entities.push({
      happenDay: placement.happenDay ?? "",
      idInPlan,
      dayNo: placement.dayNo,
      sortNoInSchedule: placement.sortNoInSchedule ?? 1,
    });
    versionObjects.push({ id: idInPlan, status: 1 });
  });

  const dayNos = placements.map((p) => p.dayNo);
  const totalDay = Math.max(...dayNos) + 1;
  const { minWeeks, maxWeeks } = weeklyWorkoutCountRange(dayNos);

  return {
    name: opts.name,
    overview: opts.overview ?? "",
    entities,
    programs,
    versionObjects,
    weekStages: [],
    maxIdInPlan: placements.length,
    totalDay,
    minWeeks,
    maxWeeks,
    pbVersion: 2,
    region: opts.region,
    sourceId: opts.sourceId ?? DEFAULT_PLAN_SOURCE_ID,
    sourceUrl: opts.sourceUrl ?? DEFAULT_SOURCE_URL,
    unit: opts.unit ?? 0,
  };
}
