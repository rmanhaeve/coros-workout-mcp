import { describe, it, expect } from "vitest";
import {
  paceToMsPerKm,
  buildRunningSteps,
  buildRunningWorkoutPayload,
  type RunningItemInput,
} from "../running.js";

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
