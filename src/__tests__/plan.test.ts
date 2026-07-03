import { describe, it, expect } from "vitest";
import {
  buildTrainingPlanPayload,
  buildPlanUpdatePayload,
  weeklyWorkoutCountRange,
  dayNoFromDates,
  toHappenDay,
  happenDayFromStart,
  DEFAULT_PLAN_SOURCE_ID,
  type ProgramDetail,
} from "../plan.js";

// A stand-in for a /training/program/detail object.
function prog(id: string, name: string): ProgramDetail {
  return { id, name, sportType: 1, exercises: [], duration: 600, distance: 2000 };
}

describe("weeklyWorkoutCountRange", () => {
  it("counts min/max workouts per content-bearing week", () => {
    // week0: days 0,2,4 (3 workouts); week1: day 8 (1 workout)
    expect(weeklyWorkoutCountRange([0, 2, 4, 8])).toEqual({ minWeeks: 1, maxWeeks: 3 });
  });
  it("single week with N workouts -> min==max==N (matches capture: 4 in one week)", () => {
    expect(weeklyWorkoutCountRange([0, 1, 2, 3])).toEqual({ minWeeks: 4, maxWeeks: 4 });
  });
  it("empty -> {0,0}", () => {
    expect(weeklyWorkoutCountRange([])).toEqual({ minWeeks: 0, maxWeeks: 0 });
  });
});

describe("date helpers", () => {
  it("dayNoFromDates is a whole-day difference", () => {
    expect(dayNoFromDates("2026-07-06", "2026-07-06")).toBe(0);
    expect(dayNoFromDates("2026-07-06", "2026-07-08")).toBe(2);
    expect(dayNoFromDates("2026-07-06", "2026-07-13")).toBe(7);
  });
  it("dayNoFromDates spans month boundaries", () => {
    expect(dayNoFromDates("2026-07-30", "2026-08-02")).toBe(3);
  });
  it("toHappenDay strips dashes to YYYYMMDD", () => {
    expect(toHappenDay("2026-07-06")).toBe("20260706");
  });
  it("happenDayFromStart adds offset days", () => {
    expect(happenDayFromStart("2026-07-06", 0)).toBe("20260706");
    expect(happenDayFromStart("2026-07-06", 2)).toBe("20260708");
    expect(happenDayFromStart("2026-07-30", 3)).toBe("20260802");
  });
  it("rejects malformed dates", () => {
    expect(() => toHappenDay("2026/07/06")).toThrow();
    expect(() => dayNoFromDates("bad", "2026-07-06")).toThrow();
  });
});

describe("buildTrainingPlanPayload", () => {
  const placements = [
    { program: prog("100", "Run A"), dayNo: 0 },
    { program: prog("200", "Strength B"), dayNo: 2 },
  ];

  it("assembles the plan/add body shape verified against the capture", () => {
    const p = buildTrainingPlanPayload({ name: "TEST", overview: "ov", placements, region: 3 });
    expect(p.name).toBe("TEST");
    expect(p.region).toBe(3);
    expect(p.pbVersion).toBe(2);
    expect(p.weekStages).toEqual([]);
    expect(p.unit).toBe(0);
    expect(p.sourceId).toBe(DEFAULT_PLAN_SOURCE_ID);
    // totalDay = max(dayNo)+1
    expect(p.totalDay).toBe(3);
    // one week, two workouts
    expect(p.minWeeks).toBe(2);
    expect(p.maxWeeks).toBe(2);
    expect(p.maxIdInPlan).toBe(2);
  });

  it("tags each program with idInPlan + cardType/dataType, keeps original id", () => {
    const p = buildTrainingPlanPayload({ name: "T", placements, region: 3 });
    expect(p.programs[0]).toMatchObject({ idInPlan: 1, cardType: "program", dataType: "program", id: "100" });
    expect(p.programs[1]).toMatchObject({ idInPlan: 2, cardType: "program", dataType: "program", id: "200" });
    // original detail fields survive
    expect(p.programs[0].exercises).toEqual([]);
    expect(p.programs[0].duration).toBe(600);
  });

  it("builds minimal entities linked by idInPlan (happenDay empty by default)", () => {
    const p = buildTrainingPlanPayload({ name: "T", placements, region: 3 });
    expect(p.entities).toEqual([
      { happenDay: "", idInPlan: 1, dayNo: 0, sortNoInSchedule: 1 },
      { happenDay: "", idInPlan: 2, dayNo: 2, sortNoInSchedule: 1 },
    ]);
  });

  it("carries real happenDay dates when supplied", () => {
    const p = buildTrainingPlanPayload({
      name: "T",
      region: 3,
      placements: [
        { program: prog("100", "Run"), dayNo: 0, happenDay: "20260706" },
        { program: prog("200", "Str"), dayNo: 2, happenDay: "20260708" },
      ],
    });
    expect(p.entities.map((e) => e.happenDay)).toEqual(["20260706", "20260708"]);
  });

  it("emits one versionObject per program {id: idInPlan, status: 1}", () => {
    const p = buildTrainingPlanPayload({ name: "T", placements, region: 3 });
    expect(p.versionObjects).toEqual([
      { id: 1, status: 1 },
      { id: 2, status: 1 },
    ]);
  });

  it("rejects empty placements and negative dayNo", () => {
    expect(() => buildTrainingPlanPayload({ name: "T", placements: [], region: 3 })).toThrow();
    expect(() =>
      buildTrainingPlanPayload({ name: "T", region: 3, placements: [{ program: prog("1", "x"), dayNo: -1 }] })
    ).toThrow();
  });
});

describe("buildPlanUpdatePayload", () => {
  const detail = () => ({
    id: "PLAN1",
    name: "N1117",
    overview: "old",
    totalDay: 3,
    minWeeks: 2,
    maxWeeks: 2,
    versionObjects: [],
    entities: [
      { idInPlan: "1", dayNo: 0, planProgramId: "1" },
      { idInPlan: "2", dayNo: 2, planProgramId: "2" },
    ],
  });

  it("moves a workout's day, recomputes totalDay, and marks it status 2", () => {
    const body = buildPlanUpdatePayload(detail(), { moves: [{ fromDay: 2, toDay: 5 }] });
    const ents = body.entities as Array<Record<string, unknown>>;
    expect(ents.find((e) => e.idInPlan === "2")!.dayNo).toBe(5);
    expect(body.totalDay).toBe(6);
    expect(body.versionObjects).toEqual([
      { id: "2", planProgramId: "2", planId: "PLAN1", status: 2, type: 0 },
    ]);
  });

  it("renames without moves (empty versionObjects)", () => {
    const body = buildPlanUpdatePayload(detail(), { name: "New", overview: "desc" });
    expect(body.name).toBe("New");
    expect(body.overview).toBe("desc");
    expect(body.versionObjects).toEqual([]);
  });

  it("does not mutate the input detail", () => {
    const d = detail();
    buildPlanUpdatePayload(d, { moves: [{ fromDay: 2, toDay: 5 }] });
    expect(d.entities[1].dayNo).toBe(2);
  });

  it("throws when a move targets a day with no workout", () => {
    expect(() => buildPlanUpdatePayload(detail(), { moves: [{ fromDay: 4, toDay: 1 }] })).toThrow();
  });
});
