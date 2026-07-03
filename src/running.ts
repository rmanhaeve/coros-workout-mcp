// Running-workout payload builder for COROS Training Hub (sportType = 1).
//
// Reverse-engineered from a HAR capture of trainingeu.coros.com (see
// research/create-running-workout-request-all.txt). Unlike strength workouts
// (sportType 4, catalog exercises), running workouts are built from a small
// fixed set of *step templates* (warm-up / work / recovery / cool-down) with
// per-step distance/time targets and pace-range intensity. Intervals are
// modeled as a repeat "group": an isGroup=true marker with sets=N, followed by
// its child steps tagged with that group's id.
//
// Same endpoints as strength: POST /training/program/{calculate,add}.

import { DEFAULT_SOURCE_URL } from "./coros-api.js";
import type { WorkoutPayload } from "./types.js";

// --- Step templates (constants lifted verbatim from the captured payload) ---
// The T-codes / originId / createTimestamp identify COROS's built-in run steps.
// Sending them unchanged is what makes the server accept the workout.
const STEP_TEMPLATES = {
  warmup: {
    exerciseType: 1,
    name: "T1120",
    overview: "sid_run_warm_up_dist",
    originId: "425895398452936705",
    createTimestamp: 1586584068,
    defaultOrder: 1,
    isDefaultAdd: 0,
    intensityCustom: 7,
  },
  work: {
    exerciseType: 2,
    name: "T3001",
    overview: "sid_run_training",
    originId: "426109589008859136",
    createTimestamp: 1587381919,
    defaultOrder: 2,
    isDefaultAdd: 1,
    intensityCustom: 5,
  },
  recovery: {
    exerciseType: 4,
    name: "T1123",
    overview: "sid_run_cool_down_dist",
    originId: "425895398452936705",
    createTimestamp: 1586584214,
    defaultOrder: 3,
    isDefaultAdd: 0,
    intensityCustom: 2,
  },
  cooldown: {
    exerciseType: 3,
    name: "T1122",
    overview: "sid_run_cool_down_dist",
    originId: "425895456971866112",
    createTimestamp: 1586584214,
    defaultOrder: 3,
    isDefaultAdd: 0,
    intensityCustom: 7,
  },
} as const;

export type StepKind = keyof typeof STEP_TEMPLATES;

// --- User-facing input model ---

export interface RunStepInput {
  type: StepKind;
  /** Distance target in meters (targetType 2). Mutually exclusive with timeSeconds. */
  distanceMeters?: number;
  /** Time target in seconds (targetType 5, stored as ms). Mutually exclusive with distanceMeters. */
  timeSeconds?: number;
  /** Fast end of the pace target, "m:ss" per km (e.g. "3:54"). Optional. */
  paceFast?: string;
  /** Slow end of the pace target, "m:ss" per km (e.g. "4:18"). Optional. */
  paceSlow?: string;
  /**
   * COROS running pace zone (1..N). Resolves to that zone's pace band from the
   * athlete's ltspZone. Mutually exclusive with paceFast/paceSlow.
   */
  zone?: number;
}

/** Athlete pace reference used to encode pace targets (from getAccountZones). */
export interface PaceContext {
  /** Lactate-threshold pace, seconds per km. */
  ltsp?: number | null;
  /** Pace-zone boundaries, seconds per km, ordered by zone index (slow→fast). */
  ltspZone?: number[];
}

export interface RepeatBlockInput {
  /** Number of repeats of the child steps. */
  repeat: number;
  /** Rest between repeats in seconds (group restValue). Default 30. */
  restSeconds?: number;
  steps: RunStepInput[];
}

export type RunningItemInput = RunStepInput | RepeatBlockInput;

function isRepeat(item: RunningItemInput): item is RepeatBlockInput {
  return (item as RepeatBlockInput).repeat !== undefined;
}

// --- Encoding helpers ---

/** "m:ss" per km -> seconds per km. */
export function paceToSecPerKm(pace: string): number {
  const m = /^(\d+):(\d{1,2})$/.exec(pace.trim());
  if (!m) throw new Error(`Invalid pace "${pace}" (expected "m:ss" per km, e.g. "4:00")`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** "m:ss" per km -> milliseconds per km (COROS pace encoding). */
export function paceToMsPerKm(pace: string): number {
  return paceToSecPerKm(pace) * 1000;
}

/**
 * COROS pace-target percentage of threshold: round(ltsp / paceSec * 100000).
 * ltsp and paceSec are both seconds per km. Verified against captured payloads.
 */
export function pacePercentOfLtsp(paceSec: number, ltsp: number): number {
  return Math.round((ltsp / paceSec) * 100000);
}

/** Resolve a step's pace target to fast/slow bounds in seconds per km (0 = open). */
function resolvePaceBounds(
  input: RunStepInput,
  ctx: PaceContext
): { fastSec: number; slowSec: number } {
  const hasExplicit = input.paceFast !== undefined || input.paceSlow !== undefined;
  if (input.zone !== undefined) {
    if (hasExplicit) {
      throw new Error(`Step "${input.type}" cannot set both zone and paceFast/paceSlow`);
    }
    const zones = ctx.ltspZone;
    if (!zones || zones.length < 2) {
      throw new Error(`zone target needs pace zones; none available (fetch account zones first)`);
    }
    // Zone Z spans ltspZone[Z] (fast) .. ltspZone[Z-1] (slow). Z in 1..len-1.
    if (input.zone < 1 || input.zone > zones.length - 1) {
      throw new Error(`zone ${input.zone} out of range (1..${zones.length - 1})`);
    }
    return { fastSec: zones[input.zone], slowSec: zones[input.zone - 1] };
  }
  return {
    fastSec: input.paceFast ? paceToSecPerKm(input.paceFast) : 0,
    slowSec: input.paceSlow ? paceToSecPerKm(input.paceSlow) : 0,
  };
}

interface RunningStepPayload {
  access: number;
  createTimestamp: number;
  defaultOrder: number;
  equipment: number[];
  exerciseType: number;
  groupId: number | string;
  hrType: number;
  id: number;
  intensityCustom: number;
  intensityDisplayUnit: string;
  intensityMultiplier: number;
  intensityPercent: number;
  intensityPercentExtend: number;
  intensityType: number;
  intensityValue: number;
  intensityValueExtend: number;
  isDefaultAdd: number;
  isGroup: boolean;
  isIntensityPercent: boolean;
  name: string;
  originId: string;
  overview: string;
  part: number[];
  programId?: string;
  restType: number;
  restValue: number;
  sets: number;
  sortNo: number;
  sourceId: string;
  sourceUrl: string;
  sportType: number;
  subType: number;
  targetDisplayUnit: number | string;
  targetType: number | string;
  targetValue: number;
  userId: number;
  videoUrl: string;
}

function buildLeafStep(
  input: RunStepInput,
  id: number,
  sortNo: number,
  groupId: number | string,
  ctx: PaceContext
): RunningStepPayload {
  const tpl = STEP_TEMPLATES[input.type];
  if (input.distanceMeters === undefined && input.timeSeconds === undefined) {
    throw new Error(`Step "${input.type}" needs either distanceMeters or timeSeconds`);
  }
  if (input.distanceMeters !== undefined && input.timeSeconds !== undefined) {
    throw new Error(`Step "${input.type}" cannot set both distanceMeters and timeSeconds`);
  }

  // Target: distance -> targetType 2 (meters); time -> targetType 5 (ms).
  let targetType: number;
  let targetValue: number;
  let targetDisplayUnit: number;
  if (input.distanceMeters !== undefined) {
    targetType = 2;
    targetValue = input.distanceMeters;
    targetDisplayUnit = 0;
  } else {
    targetType = 5;
    targetValue = input.timeSeconds! * 1000;
    targetDisplayUnit = 2;
  }

  // Intensity: pace target (intensityType 8) if a pace/zone is given, else free.
  // Encoding (verified against captured payloads):
  //   intensityValue        = fast bound (ms/km), 0 if open
  //   intensityValueExtend  = slow bound (ms/km), 0 if open
  //   intensityPercentExtend = %-of-ltsp for the FAST bound (or the single bound)
  //   intensityPercent       = %-of-ltsp for the SLOW bound (only when two-sided)
  // where % = round(ltsp / paceSec * 100000). ltsp comes from getAccountZones;
  // if absent, the % fields stay 0 (still accepted, estimates less exact).
  const { fastSec, slowSec } = resolvePaceBounds(input, ctx);
  const hasPace = fastSec > 0 || slowSec > 0;
  const intensityValue = fastSec * 1000;
  const intensityValueExtend = slowSec * 1000;
  const ltsp = ctx.ltsp ?? null;
  const primaryFastSec = fastSec > 0 ? fastSec : slowSec; // fall back for single-sided
  const intensityPercentExtend = ltsp && primaryFastSec > 0 ? pacePercentOfLtsp(primaryFastSec, ltsp) : 0;
  const intensityPercent = ltsp && fastSec > 0 && slowSec > 0 ? pacePercentOfLtsp(slowSec, ltsp) : 0;

  return {
    access: 0,
    createTimestamp: tpl.createTimestamp,
    defaultOrder: tpl.defaultOrder,
    equipment: [1],
    exerciseType: tpl.exerciseType,
    groupId,
    hrType: 0,
    id,
    intensityCustom: tpl.intensityCustom,
    intensityDisplayUnit: hasPace ? "1" : "0",
    intensityMultiplier: hasPace ? 1000 : 0,
    intensityPercent,
    intensityPercentExtend,
    intensityType: hasPace ? 8 : 0,
    intensityValue,
    intensityValueExtend,
    isDefaultAdd: tpl.isDefaultAdd,
    isGroup: false,
    isIntensityPercent: hasPace,
    name: tpl.name,
    originId: tpl.originId,
    overview: tpl.overview,
    part: [0],
    restType: 3,
    restValue: 0,
    sets: 1,
    sortNo,
    sourceId: "0",
    sourceUrl: "",
    sportType: 1,
    subType: 0,
    targetDisplayUnit,
    targetType,
    targetValue,
    userId: 0,
    videoUrl: "",
  };
}

function buildGroupMarker(
  id: number,
  sortNo: number,
  repeat: number,
  restSeconds: number
): RunningStepPayload {
  return {
    access: 0,
    createTimestamp: 0,
    defaultOrder: 0,
    equipment: [],
    exerciseType: 0,
    groupId: "",
    hrType: 0,
    id,
    intensityCustom: 0,
    intensityDisplayUnit: "",
    intensityMultiplier: 0,
    intensityPercent: 0,
    intensityPercentExtend: 0,
    intensityType: 0,
    intensityValue: 0,
    intensityValueExtend: 0,
    isDefaultAdd: 0,
    isGroup: true,
    isIntensityPercent: false,
    name: "",
    originId: "",
    overview: "",
    part: [],
    programId: "",
    restType: 0,
    restValue: restSeconds,
    sets: repeat,
    sortNo,
    sourceId: "0",
    sourceUrl: "",
    sportType: 0,
    subType: 0,
    targetDisplayUnit: 0,
    targetType: "",
    targetValue: 0,
    userId: 0,
    videoUrl: "",
  };
}

/** Flatten the nested input model into the flat exercises[] array COROS expects. */
export function buildRunningSteps(
  items: RunningItemInput[],
  ctx: PaceContext = {}
): RunningStepPayload[] {
  const out: RunningStepPayload[] = [];
  let id = 1;
  for (const item of items) {
    if (isRepeat(item)) {
      if (!item.steps.length) throw new Error("Repeat block needs at least one step");
      const groupId = id;
      out.push(buildGroupMarker(id, id, item.repeat, item.restSeconds ?? 30));
      id++;
      for (const child of item.steps) {
        out.push(buildLeafStep(child, id, id, groupId, ctx));
        id++;
      }
    } else {
      out.push(buildLeafStep(item, id, id, "", ctx));
      id++;
    }
  }
  return out;
}

/** Build the full running-workout payload for /training/program/{calculate,add}. */
export function buildRunningWorkoutPayload(
  name: string,
  overview: string,
  items: RunningItemInput[],
  ctx: PaceContext = {}
): WorkoutPayload {
  const steps = buildRunningSteps(items, ctx);
  return {
    access: 1,
    authorId: "0",
    createTimestamp: 0,
    distance: 0,
    duration: 0,
    essence: 0,
    estimatedType: 0,
    estimatedValue: 0,
    exerciseNum: 0,
    // Running steps have their own field shape; cast at the payload boundary.
    exercises: steps as unknown as WorkoutPayload["exercises"],
    headPic: "",
    id: "0",
    idInPlan: "0",
    name,
    nickname: "",
    originEssence: 0,
    overview,
    pbVersion: 2,
    planIdIndex: 0,
    poolLength: 2500,
    profile: "",
    // Running form-reference: pace-based (intensityType 8), valueType 2.
    referExercise: { intensityType: 8, hrType: 0, valueType: 2 },
    sex: 0,
    shareUrl: "",
    simple: false,
    sourceUrl: DEFAULT_SOURCE_URL,
    sportType: 1,
    star: 0,
    subType: 65535,
    targetType: 0,
    targetValue: 0,
    thirdPartyId: 0,
    totalSets: 0,
    trainingLoad: 0,
    type: 0,
    unit: 0,
    userId: "0",
    version: 0,
    videoCoverUrl: "",
    videoUrl: "",
    fastIntensityTypeName: "%adjustedPace",
    poolLengthId: 1,
    poolLengthUnit: 2,
    sourceId: "425846071290413056",
  };
}
