import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type {
  AuthData,
  CatalogExercise,
  ExerciseOverrides,
  ExercisePayload,
  RawExercise,
  Region,
  WorkoutPayload,
} from "./types.js";
import {
  REGION_URLS,
  MuscleCode,
  PartCode,
  EquipmentCode,
} from "./types.js";
import { findByName } from "./exercise-catalog.js";

const CONFIG_DIR = resolve(homedir(), ".config", "coros-workout-mcp");
const AUTH_FILE = resolve(CONFIG_DIR, "auth.json");
export const DEFAULT_SOURCE_URL =
  "https://d31oxp44ddzkyk.cloudfront.net/source/source_default/0/2fbd46e17bc54bc5873415c9fa767bdc.jpg";

// --- Auth ---

function md5(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

export function storeAuth(auth: AuthData): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(AUTH_FILE, JSON.stringify(auth), { mode: 0o600 });
}

export function loadAuth(): AuthData | null {
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
  } catch {
    return null;
  }
}

export async function login(
  email: string,
  password: string,
  region: Region = "eu"
): Promise<AuthData> {
  const apiUrl = REGION_URLS[region];
  const res = await fetch(`${apiUrl}/account/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      account: email,
      accountType: 2,
      pwd: md5(password),
    }),
  });
  const data = await res.json();
  if (data.result !== "0000") {
    throw new Error(`COROS login failed: ${data.message || data.result}`);
  }

  const auth: AuthData = {
    accessToken: data.data.accessToken,
    userId: data.data.userId,
    region,
    timestamp: Date.now(),
  };
  storeAuth(auth);
  return auth;
}

/** Get valid auth from stored file or env vars */
export async function getValidAuth(): Promise<AuthData | null> {
  // Try stored auth first
  const stored = loadAuth();
  if (stored) return stored;

  // Try env vars
  const email = process.env.COROS_EMAIL;
  const password = process.env.COROS_PASSWORD;
  const region = (process.env.COROS_REGION as Region) || "eu";
  if (email && password) {
    return login(email, password, region);
  }

  return null;
}

// --- API helpers ---

function apiHeaders(auth: AuthData): Record<string, string> {
  return {
    "Content-Type": "application/json",
    accesstoken: auth.accessToken,
    yfheader: JSON.stringify({ userId: auth.userId }),
  };
}

async function apiPost(auth: AuthData, path: string, body: unknown): Promise<unknown> {
  const apiUrl = REGION_URLS[auth.region];
  const res = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: apiHeaders(auth),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.result !== "0000") {
    throw new Error(`COROS API error (${path}): ${data.message || data.result}`);
  }
  return data;
}

async function apiGet(
  auth: AuthData,
  path: string,
  params: Record<string, string | number> = {}
): Promise<unknown> {
  const apiUrl = REGION_URLS[auth.region];
  const url = new URL(`${apiUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: apiHeaders(auth),
  });
  const data = await res.json();
  if (data.result !== "0000") {
    throw new Error(`COROS API error (${path}): ${data.message || data.result}`);
  }
  return data;
}

export interface AccountZones {
  /** Lactate-threshold speed/pace (ltsp), seconds per km. null if unset on the profile. */
  ltsp: number | null;
  /** Running pace-zone boundaries, seconds per km, ordered by zone index (slow→fast). */
  ltspZone: number[];
}

/**
 * Fetch the athlete's running pace reference from /account/query.
 * The Training Hub derives pace-target percentages from `ltsp`; we do the same.
 */
export async function getAccountZones(auth: AuthData): Promise<AccountZones> {
  const result = (await apiGet(auth, "/account/query", {})) as {
    data?: { zoneData?: { ltsp?: number; ltspZone?: Array<{ index: number; pace: number }> } };
  };
  const zd = result.data?.zoneData;
  const ltspZone = (zd?.ltspZone ?? [])
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((z) => z.pace);
  return { ltsp: zd?.ltsp ?? null, ltspZone };
}

/** Fetch the full exercise catalog from COROS API */
export async function queryExerciseCatalog(
  auth: AuthData,
  sportType: number = 4
): Promise<RawExercise[]> {
  const result = (await apiGet(auth, "/training/exercise/query", {
    userId: auth.userId,
    sportType,
  })) as { data: RawExercise[] };
  return result.data;
}

/** Fetch i18n strings from the COROS static CDN (no auth needed) */
export async function fetchI18nStrings(): Promise<Record<string, string>> {
  const url = "https://static.coros.com/locale/coros-traininghub-v2/en-US.prod.js";
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch i18n strings: ${res.status} ${res.statusText}`);
  }
  let text = await res.text();
  // Strip "window.en_US=" prefix and trailing semicolon
  text = text.replace(/^window\.en_US\s*=\s*/, "").replace(/;\s*$/, "");
  return JSON.parse(text);
}

/**
 * Transform raw exercises + i18n map into CatalogExercise[].
 * Name resolution order: i18n[codeName] → existingCatalog[codeName].name → codeName
 * The i18n file only covers ~100 of ~383 exercises, so the existing catalog
 * provides names for exercises that predate the i18n system.
 */
export function buildCatalogFromRaw(
  rawExercises: RawExercise[],
  i18n: Record<string, string>,
  existingCatalog: CatalogExercise[] = []
): { catalog: CatalogExercise[]; i18nMisses: string[] } {
  const i18nMisses: string[] = [];
  const catalog: CatalogExercise[] = [];

  // Build lookup from existing catalog by codeName for fallback
  const existingByCode = new Map<string, CatalogExercise>();
  for (const e of existingCatalog) {
    existingByCode.set(e.codeName, e);
  }

  for (const r of rawExercises) {
    // Resolve human-readable name:
    // 1. i18n (code name key, e.g. "T1300" → "Weighted Jump Squats")
    // 2. Existing catalog entry (for older exercises without i18n)
    // 3. Fall back to raw code name
    let humanName = i18n[r.name];
    if (!humanName) {
      const existing = existingByCode.get(r.name);
      if (existing) {
        humanName = existing.name;
      } else {
        humanName = r.name;
        i18nMisses.push(r.name);
      }
    }

    // Resolve description from i18n
    const desc = i18n[r.name + "_desc"] || "";

    // Build text fields from numeric codes
    const muscle = r.muscle || [];
    const muscleRelevance = r.muscleRelevance || [];
    const part = r.part || [];
    const equipment = r.equipment || [];
    const primaryMuscle = muscle[0];
    const secondaryMuscles = muscleRelevance.filter((m) => m !== primaryMuscle);
    const muscleText = primaryMuscle
      ? (MuscleCode as Record<number, string>)[primaryMuscle] || String(primaryMuscle)
      : "";
    const secondaryMuscleText = secondaryMuscles
      .map((m) => (MuscleCode as Record<number, string>)[m] || String(m))
      .join(",");
    const partText = part
      .map((p) => (PartCode as Record<number, string>)[p] || String(p))
      .join(",");
    const equipmentText = equipment
      .map((e) => (EquipmentCode as Record<number, string>)[e] || String(e))
      .join(",");

    catalog.push({
      id: r.id,
      name: humanName.trim(),
      codeName: r.name,
      overview: r.overview,
      animationId: r.animationId,
      muscle,
      muscleRelevance,
      part,
      equipment,
      exerciseType: r.exerciseType,
      targetType: r.targetType,
      targetValue: r.targetValue,
      intensityType: r.intensityType,
      intensityValue: r.intensityValue,
      restType: r.restType,
      restValue: r.restValue,
      sets: r.sets,
      sortNo: r.sortNo,
      sportType: r.sportType,
      status: r.status,
      createTimestamp: r.createTimestamp,
      thumbnailUrl: r.thumbnailUrl || "",
      sourceUrl: r.sourceUrl,
      videoUrl: r.videoUrl,
      coverUrlArrStr: r.coverUrlArrStr,
      videoUrlArrStr: r.videoUrlArrStr,
      videoInfos: r.videoInfos,
      muscleText,
      secondaryMuscleText,
      partText,
      equipmentText,
      desc,
    });
  }

  // Sort alphabetically by name
  catalog.sort((a, b) => a.name.localeCompare(b.name));

  return { catalog, i18nMisses };
}

// --- Payload construction ---

export function buildExercisePayload(
  exercise: CatalogExercise,
  sortNo: number,
  overrides: Partial<ExerciseOverrides> = {}
): ExercisePayload {
  const sets = overrides.sets ?? exercise.sets;
  let targetType = exercise.targetType;
  let targetValue = exercise.targetValue;
  if (overrides.reps !== undefined) {
    targetType = 3;
    targetValue = overrides.reps;
  } else if (overrides.duration !== undefined) {
    targetType = 2;
    targetValue = overrides.duration;
  }

  const restValue = overrides.restSeconds ?? exercise.restValue;

  let intensityType = exercise.intensityType;
  let intensityValue = exercise.intensityValue;
  if (overrides.weightGrams !== undefined) {
    intensityType = 1;
    intensityValue = overrides.weightGrams;
  } else if (overrides.weightKg !== undefined) {
    intensityType = 1;
    intensityValue = overrides.weightKg * 1000;
  }

  // Build text fields from codes
  const primaryMuscle = exercise.muscle[0];
  const secondaryMuscles = (exercise.muscleRelevance || []).filter(
    (m) => m !== primaryMuscle
  );
  const muscleText =
    exercise.muscleText ||
    (primaryMuscle
      ? (MuscleCode as Record<number, string>)[primaryMuscle] || ""
      : "");
  const secondaryMuscleText =
    exercise.secondaryMuscleText ||
    secondaryMuscles
      .map((m) => (MuscleCode as Record<number, string>)[m] || "")
      .filter(Boolean)
      .join(",");
  const partText =
    exercise.partText ||
    exercise.part
      .map((p) => (PartCode as Record<number, string>)[p] || "")
      .filter(Boolean)
      .join(",");
  const equipmentText =
    exercise.equipmentText ||
    exercise.equipment
      .map((e) => (EquipmentCode as Record<number, string>)[e] || "")
      .filter(Boolean)
      .join(",");

  return {
    access: 0,
    animationId: exercise.animationId ?? 0,
    coverUrlArrStr: exercise.coverUrlArrStr,
    createTimestamp: exercise.createTimestamp,
    defaultOrder: 0,
    equipment: exercise.equipment,
    exerciseType: exercise.exerciseType,
    id: sortNo, // sequential 1-based index used in API
    intensityCustom: 0,
    intensityType,
    intensityValue,
    isDefaultAdd: 0,
    isGroup: false,
    isIntensityPercent: false,
    muscle: exercise.muscle,
    muscleRelevance: exercise.muscleRelevance || [],
    name: exercise.codeName,
    overview: exercise.overview,
    part: exercise.part,
    restType: 1,
    restValue,
    sets,
    sortNo,
    sourceUrl: exercise.sourceUrl,
    sportType: 4,
    status: 1,
    targetType,
    targetValue,
    thumbnailUrl: exercise.thumbnailUrl,
    userId: 0,
    videoInfos: exercise.videoInfos,
    videoUrl: exercise.videoUrl,
    videoUrlArrStr: exercise.videoUrlArrStr,
    nameText: exercise.name,
    desc: exercise.desc,
    descText: exercise.desc,
    partText,
    muscleText,
    secondaryMuscleText,
    equipmentText,
    groupId: "",
    originId: exercise.id,
    targetDisplayUnit: 0,
    hrType: 0,
    intensityValueExtend: 0,
    intensityMultiplier: 0,
    intensityPercent: 0,
    intensityPercentExtend: 0,
    intensityDisplayUnit: "6",
  };
}

export function buildWorkoutPayload(
  name: string,
  overview: string,
  exercisePayloads: ExercisePayload[]
): WorkoutPayload {
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
    exercises: exercisePayloads,
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
    referExercise: { intensityType: 1, hrType: 0, valueType: 1 },
    sex: 0,
    shareUrl: "",
    simple: false,
    sourceUrl: DEFAULT_SOURCE_URL,
    sportType: 4,
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
    fastIntensityTypeName: "weight",
    poolLengthId: 1,
    poolLengthUnit: 2,
    sourceId: "425868133463670784",
  };
}

/** Resolve exercise overrides to catalog entries and build payloads */
export function resolveExercises(
  exercises: ExerciseOverrides[]
): ExercisePayload[] {
  return exercises.map((override, index) => {
    const catalog = findByName(override.name);
    if (!catalog) {
      throw new Error(`Exercise not found in catalog: "${override.name}"`);
    }
    return buildExercisePayload(catalog, index + 1, override);
  });
}

// --- Workout API ---

export interface CalculateResult {
  /** Seconds. */
  duration: number;
  totalSets: number;
  trainingLoad: number;
  /** COROS-native distance in CENTIMETERS (meters*100); undefined for strength. */
  distance?: number;
}

/**
 * Compute load/duration/distance for a prebuilt program payload
 * (strength or running — same /calculate endpoint).
 */
export async function calculateProgram(
  auth: AuthData,
  payload: WorkoutPayload
): Promise<CalculateResult> {
  // /calculate returns two shapes: strength uses duration/totalSets/trainingLoad/
  // distance; running uses planDuration/planSets/planTrainingLoad/planDistance.
  // Accept either so both sports report real totals (not NaN/0).
  const result = (await apiPost(auth, "/training/program/calculate", payload)) as {
    data: {
      duration?: number;
      totalSets?: number;
      trainingLoad?: number;
      distance?: number | string;
      planDuration?: number;
      planSets?: number;
      planTrainingLoad?: number;
      planDistance?: number | string;
    };
  };
  const d = result.data;
  const num = (v: number | string | undefined): number | undefined =>
    v === undefined ? undefined : Number(v);
  return {
    duration: d.duration ?? d.planDuration ?? 0,
    totalSets: d.totalSets ?? d.planSets ?? 0,
    trainingLoad: d.trainingLoad ?? d.planTrainingLoad ?? 0,
    distance: num(d.distance ?? d.planDistance),
  };
}

/**
 * Persist a prebuilt program payload (strength or running — same /add endpoint).
 * Returns the new program's id (the API's `data` field).
 */
export async function addProgram(
  auth: AuthData,
  payload: WorkoutPayload,
  calculated: CalculateResult
): Promise<string> {
  // Apply calculated values. distance is a string in /add (number in /calculate).
  payload.duration = calculated.duration;
  payload.totalSets = calculated.totalSets;
  payload.distance = String(calculated.distance ?? 0);
  payload.sets = calculated.totalSets;
  payload.pitch = 0;
  const result = (await apiPost(auth, "/training/program/add", payload)) as {
    data: string;
  };
  return result.data;
}

export async function calculateWorkout(
  auth: AuthData,
  name: string,
  overview: string,
  exercisePayloads: ExercisePayload[]
): Promise<CalculateResult> {
  return calculateProgram(auth, buildWorkoutPayload(name, overview, exercisePayloads));
}

export async function addWorkout(
  auth: AuthData,
  name: string,
  overview: string,
  exercisePayloads: ExercisePayload[],
  calculated: CalculateResult
): Promise<unknown> {
  return addProgram(
    auth,
    buildWorkoutPayload(name, overview, exercisePayloads),
    calculated
  );
}

/**
 * Fetch a single program's full detail (used to embed a workout into a plan).
 * Returns the raw `data` object as COROS stores it — includes exercises[],
 * exerciseBarChart, duration/distance/trainingLoad, etc.
 */
export async function getProgramDetail(
  auth: AuthData,
  id: string
): Promise<Record<string, unknown>> {
  const result = (await apiGet(auth, "/training/program/detail", {
    supportRestExercise: 1,
    id,
  })) as { data: Record<string, unknown> };
  return result.data;
}

/**
 * Create a multi-week training plan (schedule) that places workouts on days.
 * POST /training/plan/add. Returns the new plan id (the API's `data` field).
 *
 * NOTE: this only creates a Plans-library TEMPLATE (inSchedule 0, no dates).
 * Call executeSubPlan() to bind it to real calendar dates.
 */
export async function addTrainingPlan(
  auth: AuthData,
  payload: unknown
): Promise<string> {
  const result = (await apiPost(auth, "/training/plan/add", payload)) as {
    data: string;
  };
  return result.data;
}

/**
 * Bind a plan template onto the calendar starting at `startDay` ("YYYYMMDD").
 * POST /training/schedule/executeSubPlan?startDay=&subPlanId= (empty body).
 * Each plan workout lands on startDay + its dayNo. This is what actually puts
 * workouts on the calendar (and syncs them to the watch).
 */
export async function executeSubPlan(
  auth: AuthData,
  subPlanId: string,
  startDay: string
): Promise<void> {
  const path = `/training/schedule/executeSubPlan?startDay=${encodeURIComponent(
    startDay
  )}&subPlanId=${encodeURIComponent(subPlanId)}`;
  await apiPost(auth, path, {});
}

/**
 * Remove an executed sub-plan from the calendar ("exit plan").
 * POST /training/schedule/quitSubPlan?subPlanId= (empty body). The id is the
 * CALENDAR sub-plan instance id (a scheduled entity's planId), NOT the library
 * plan id. This is distinct from deletePlans(): quitting clears calendar
 * entries; deleting only removes the reusable template.
 */
export async function quitSubPlan(
  auth: AuthData,
  subPlanId: string
): Promise<void> {
  const path = `/training/schedule/quitSubPlan?subPlanId=${encodeURIComponent(
    subPlanId
  )}`;
  await apiPost(auth, path, {});
}

/**
 * Read the calendar between two "YYYYMMDD" dates. Returns the schedule `data`
 * object (its `entities[]` are the scheduled workouts, each with a `planId`
 * that can be passed to quitSubPlan()).
 */
export async function querySchedule(
  auth: AuthData,
  startDate: string,
  endDate: string
): Promise<{ entities?: Array<Record<string, unknown>> } & Record<string, unknown>> {
  const result = (await apiGet(auth, "/training/schedule/query", {
    startDate,
    endDate,
    supportRestExercise: 1,
  })) as { data: { entities?: Array<Record<string, unknown>> } & Record<string, unknown> };
  return result.data;
}

/**
 * Delete one or more plan templates. POST /training/plan/delete with a JSON
 * array of plan ids.
 */
export async function deletePlans(
  auth: AuthData,
  planIds: string[]
): Promise<void> {
  await apiPost(auth, "/training/plan/delete", planIds);
}

export interface QueryOptions {
  name?: string;
  sportType?: number;
  startNo?: number;
  limitSize?: number;
}

export async function queryWorkouts(
  auth: AuthData,
  options: QueryOptions = {}
): Promise<unknown> {
  const body = {
    name: options.name || "",
    supportRestExercise: 1,
    startNo: options.startNo ?? 0,
    limitSize: options.limitSize ?? 10,
    sportType: options.sportType ?? 0,
  };
  return apiPost(auth, "/training/program/query", body);
}
