import { describe, it, expect } from "vitest";
import {
  paceToMsPerKm,
  pacePercentOfLtsp,
  buildRunningSteps,
  buildRunningWorkoutPayload,
  type RunningItemInput,
  type PaceContext,
} from "../running.js";

// Robin's captured profile: ltsp 264 s/km, ltspZone slow→fast.
const LTSP = 264;
const CTX: PaceContext = { ltsp: LTSP, ltspZone: [372, 311, 285, 264, 259, 234, 132] };

describe("paceToMsPerKm", () => {
  it("converts m:ss per km to milliseconds", () => {
    expect(paceToMsPerKm("4:00")).toBe(240000);
    expect(paceToMsPerKm("3:54")).toBe(234000);
    expect(paceToMsPerKm("4:18")).toBe(258000);
  });
  it("rejects malformed pace", () => {
    expect(() => paceToMsPerKm("4.00")).toThrow();
    expect(() => paceToMsPerKm("abc")).toThrow();
  });
});

describe("pacePercentOfLtsp", () => {
  it("matches the captured percentages (round(ltsp/pace*100000))", () => {
    // Verified against the real payload: 234s->112800, 372s->70900.
    expect(pacePercentOfLtsp(234, LTSP)).toBe(112821);
    expect(pacePercentOfLtsp(372, LTSP)).toBe(70968);
  });
});

describe("percent-of-threshold encoding", () => {
  it("cross-pairs percent (slow) and percentExtend (fast)", () => {
    const [work] = buildRunningSteps(
      [{ type: "work", timeSeconds: 720, paceFast: "3:54", paceSlow: "4:18" }],
      CTX
    );
    expect(work.intensityValue).toBe(234000); // fast
    expect(work.intensityValueExtend).toBe(258000); // slow
    expect(work.intensityPercentExtend).toBe(pacePercentOfLtsp(234, LTSP)); // fast->extend
    expect(work.intensityPercent).toBe(pacePercentOfLtsp(258, LTSP)); // slow->percent
  });
  it("single-sided (slow only) puts the value in the extend slot", () => {
    const [wu] = buildRunningSteps([{ type: "warmup", distanceMeters: 2000, paceSlow: "6:12" }], CTX);
    expect(wu.intensityValue).toBe(0);
    expect(wu.intensityValueExtend).toBe(372000);
    expect(wu.intensityPercent).toBe(0);
    expect(wu.intensityPercentExtend).toBe(pacePercentOfLtsp(372, LTSP));
  });
  it("leaves percent fields 0 when no ltsp is available", () => {
    const [work] = buildRunningSteps([{ type: "work", timeSeconds: 720, paceFast: "4:00" }]);
    expect(work.intensityValue).toBe(240000);
    expect(work.intensityPercentExtend).toBe(0);
  });
});

describe("zone targets", () => {
  it("resolves a zone to its ltspZone pace band", () => {
    // Zone 5 spans ltspZone[5]=234 (fast) .. ltspZone[4]=259 (slow).
    const [work] = buildRunningSteps([{ type: "work", timeSeconds: 720, zone: 5 }], CTX);
    expect(work.intensityValue).toBe(234000);
    expect(work.intensityValueExtend).toBe(259000);
    expect(work.intensityType).toBe(8);
  });
  it("rejects zone + explicit pace together", () => {
    expect(() =>
      buildRunningSteps([{ type: "work", timeSeconds: 720, zone: 5, paceFast: "4:00" }], CTX)
    ).toThrow();
  });
  it("rejects an out-of-range zone", () => {
    expect(() => buildRunningSteps([{ type: "work", timeSeconds: 720, zone: 9 }], CTX)).toThrow();
  });
});

describe("buildRunningSteps", () => {
  it("encodes distance vs time targets", () => {
    const steps = buildRunningSteps([
      { type: "warmup", distanceMeters: 2000 },
      { type: "work", timeSeconds: 720, paceFast: "3:54", paceSlow: "4:18" },
    ]);
    expect(steps[0].targetType).toBe(2); // distance
    expect(steps[0].targetValue).toBe(2000);
    expect(steps[1].targetType).toBe(5); // time
    expect(steps[1].targetValue).toBe(720000); // ms
    // pace range encoded on the work step
    expect(steps[1].intensityType).toBe(8);
    expect(steps[1].intensityValue).toBe(234000);
    expect(steps[1].intensityValueExtend).toBe(258000);
    expect(steps[1].sportType).toBe(1);
  });

  it("expands a repeat block into a group marker + tagged children", () => {
    const items: RunningItemInput[] = [
      { type: "warmup", distanceMeters: 2000 },
      {
        repeat: 2,
        restSeconds: 180,
        steps: [
          { type: "work", timeSeconds: 720, paceFast: "4:00", paceSlow: "4:10" },
          { type: "recovery", timeSeconds: 180 },
        ],
      },
      { type: "cooldown", distanceMeters: 1000 },
    ];
    const steps = buildRunningSteps(items);
    // warmup, group-marker, work, recovery, cooldown
    expect(steps.map((s) => s.isGroup)).toEqual([false, true, false, false, false]);
    const group = steps[1];
    expect(group.sets).toBe(2);
    expect(group.restValue).toBe(180);
    // children tagged with the group id
    expect(steps[2].groupId).toBe(group.id);
    expect(steps[3].groupId).toBe(group.id);
    // ids are sequential and unique
    expect(steps.map((s) => s.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects steps with no target or both targets", () => {
    expect(() => buildRunningSteps([{ type: "work" }])).toThrow();
    expect(() =>
      buildRunningSteps([{ type: "work", distanceMeters: 1000, timeSeconds: 60 }])
    ).toThrow();
  });
});

describe("buildRunningWorkoutPayload", () => {
  it("sets running-specific workout envelope", () => {
    const p = buildRunningWorkoutPayload("Q2", "threshold", [
      { type: "warmup", distanceMeters: 2000 },
    ]);
    expect(p.sportType).toBe(1);
    expect(p.fastIntensityTypeName).toBe("%adjustedPace");
    expect(p.referExercise).toEqual({ intensityType: 8, hrType: 0, valueType: 2 });
    expect(p.exercises).toHaveLength(1);
  });
});
