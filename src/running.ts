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

/** "m:ss" per km -> milliseconds per km (COROS pace encoding). */
export function paceToMsPerKm(pace: string): number {
  const m = /^(\d+):(\d{1,2})$/.exec(pace.trim());
  if (!m) throw new Error(`Invalid pace "${pace}" (expected "m:ss" per km, e.g. "4:00")`);
  const seconds = Number(m[1]) * 60 + Number(m[2]);
  return seconds * 1000;
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
  groupId: number | string
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

  // Intensity: pace range (intensityType 8) if any pace given, else free (0).
  //
  // KNOWN LIMITATION: COROS's pace model is "%adjustedPace" — when
  // isIntensityPercent=true the intensityPercent/intensityPercentExtend fields
  // (percent of the athlete's threshold pace) are the source of truth, and we
  // currently leave them 0. The absolute intensityValue/intensityValueExtend
  // (ms/km) below are accepted by /calculate (result 0000) and round-trip
  // structurally, but the Training Hub's duration/load ESTIMATE ignores them,
  // and on-watch pace-target display is unconfirmed. To make estimates + watch
  // targets exact, fetch the athlete's threshold ("adjusted") pace and compute
  // the percent fields. Tracked for a follow-up; needs a pace-zones capture.
  const hasPace = input.paceFast !== undefined || input.paceSlow !== undefined;
  const intensityValue = input.paceFast ? paceToMsPerKm(input.paceFast) : 0;
  const intensityValueExtend = input.paceSlow ? paceToMsPerKm(input.paceSlow) : 0;

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
    intensityPercent: 0,
    intensityPercentExtend: 0,
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
export function buildRunningSteps(items: RunningItemInput[]): RunningStepPayload[] {
  const out: RunningStepPayload[] = [];
  let id = 1;
  for (const item of items) {
    if (isRepeat(item)) {
      if (!item.steps.length) throw new Error("Repeat block needs at least one step");
      const groupId = id;
      out.push(buildGroupMarker(id, id, item.repeat, item.restSeconds ?? 30));
      id++;
      for (const child of item.steps) {
        out.push(buildLeafStep(child, id, id, groupId));
        id++;
      }
    } else {
      out.push(buildLeafStep(item, id, id, ""));
      id++;
    }
  }
  return out;
}

/** Build the full running-workout payload for /training/program/{calculate,add}. */
export function buildRunningWorkoutPayload(
  name: string,
  overview: string,
  items: RunningItemInput[]
): WorkoutPayload {
  const steps = buildRunningSteps(items);
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
