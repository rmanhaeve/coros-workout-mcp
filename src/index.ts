#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFileSync } from "node:fs";
import {
  login,
  getValidAuth,
  loadAuth,
  resolveExercises,
  calculateWorkout,
  addWorkout,
  calculateProgram,
  addProgram,
  getAccountZones,
  queryWorkouts,
  queryExerciseCatalog,
  fetchI18nStrings,
  buildCatalogFromRaw,
  getProgramDetail,
  addTrainingPlan,
  executeSubPlan,
  deletePlans,
} from "./coros-api.js";
import {
  buildRunningWorkoutPayload,
  type RunningItemInput,
} from "./running.js";
import {
  buildTrainingPlanPayload,
  dayNoFromDates,
  toHappenDay,
  happenDayFromStart,
  REGION_IDS,
  type PlanPlacement,
} from "./plan.js";

/** "YYYY-MM-DD" label for the date `dayNo` days after an ISO anchor. */
function isoPlusDaysLabel(startISO: string, dayNo: number): string {
  const ymd = happenDayFromStart(startISO, dayNo); // YYYYMMDD
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}
import {
  searchExercises,
  findByName,
  getAllExercises,
  reloadCatalog,
  getCatalogPath,
} from "./exercise-catalog.js";
import type { Region } from "./types.js";

const server = new McpServer({
  name: "coros-workout",
  version: "1.0.0",
});

// --- Tool: authenticate_coros ---
server.tool(
  "authenticate_coros",
  "Log in to COROS Training Hub. Stores auth token for subsequent calls. Also checks COROS_EMAIL/COROS_PASSWORD env vars for auto-login. WARNING: Logging in via API invalidates the web app session.",
  {
    email: z.string().email().optional().describe("COROS account email (optional if env vars set)"),
    password: z.string().optional().describe("COROS account password (optional if env vars set)"),
    region: z.enum(["us", "eu"]).default("eu").describe("API region: 'us' or 'eu'"),
  },
  async ({ email, password, region }) => {
    try {
      // Use provided credentials or fall back to env vars
      const loginEmail = email || process.env.COROS_EMAIL;
      const loginPassword = password || process.env.COROS_PASSWORD;
      const loginRegion = (region || process.env.COROS_REGION || "eu") as Region;

      if (!loginEmail || !loginPassword) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No credentials provided. Set COROS_EMAIL and COROS_PASSWORD environment variables, or provide email and password parameters.",
            },
          ],
        };
      }

      const auth = await login(loginEmail, loginPassword, loginRegion);
      return {
        content: [
          {
            type: "text" as const,
            text: `Authenticated successfully. User ID: ${auth.userId}, Region: ${auth.region}. Token stored at ~/.config/coros-workout-mcp/auth.json`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Authentication failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// --- Tool: check_coros_auth ---
server.tool(
  "check_coros_auth",
  "Check if COROS authentication is available (from stored token or env vars).",
  {},
  async () => {
    const auth = await getValidAuth();
    if (auth) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Authenticated. User ID: ${auth.userId}, Region: ${auth.region}`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: "Not authenticated. Use authenticate_coros tool or set COROS_EMAIL/COROS_PASSWORD env vars.",
        },
      ],
    };
  }
);

// --- Tool: search_exercises ---
server.tool(
  "search_exercises",
  "Search the COROS exercise catalog (~383 strength exercises). Filter by name, muscle group, body part, and/or equipment. Returns exercise names, muscles, equipment, and default sets/reps.",
  {
    query: z.string().optional().describe("Search by exercise name (partial match, e.g. 'bench press')"),
    muscle: z.string().optional().describe("Filter by muscle group (e.g. 'chest', 'biceps', 'glutes', 'quadriceps')"),
    bodyPart: z.string().optional().describe("Filter by body part (e.g. 'legs', 'arms', 'core', 'chest', 'back', 'shoulders')"),
    equipment: z.string().optional().describe("Filter by equipment (e.g. 'bodyweight', 'dumbbells', 'barbells', 'kettlebell', 'bands')"),
    limit: z.number().int().min(1).max(50).default(20).describe("Max results to return"),
  },
  async ({ query, muscle, bodyPart, equipment, limit }) => {
    const results = searchExercises({ query, muscle, bodyPart, equipment });
    const limited = results.slice(0, limit);

    if (limited.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No exercises found matching your search criteria.",
          },
        ],
      };
    }

    const formatted = limited.map((e) => {
      const lines = [
        `**${e.name}**`,
        `  Muscles: ${e.muscleText}${e.secondaryMuscleText ? ` (secondary: ${e.secondaryMuscleText})` : ""}`,
        `  Body parts: ${e.partText}`,
        `  Equipment: ${e.equipmentText}`,
        `  Defaults: ${e.sets} sets x ${e.targetValue} ${e.targetType === 3 ? "reps" : "seconds"}, ${e.restValue}s rest`,
      ];
      return lines.join("\n");
    });

    const header = `Found ${results.length} exercises${results.length > limit ? ` (showing first ${limit})` : ""}:\n`;
    return {
      content: [
        {
          type: "text" as const,
          text: header + formatted.join("\n\n"),
        },
      ],
    };
  }
);

// --- Tool: create_workout ---
const ExerciseInputSchema = z.object({
  name: z.string().describe("Exercise name (must match catalog exactly, e.g. 'Push-ups', 'Squats')"),
  sets: z.number().int().min(1).optional().describe("Number of sets (defaults to catalog value)"),
  reps: z.number().int().min(1).optional().describe("Reps per set (defaults to catalog value)"),
  duration: z.number().int().min(1).optional().describe("Duration in seconds per set (alternative to reps)"),
  restSeconds: z.number().int().min(0).optional().describe("Rest between sets in seconds (defaults to catalog value)"),
  weightKg: z.number().min(0).optional().describe("Weight in kg (e.g. 20 for 20kg)"),
});

server.tool(
  "create_workout",
  "Create a strength workout on COROS Training Hub. Resolves exercise names from the catalog, builds the full API payload, calculates metrics, and saves the workout. The workout will sync to the user's COROS watch.",
  {
    name: z.string().describe("Workout name (e.g. 'Upper Body Push')"),
    overview: z.string().default("").describe("Workout description"),
    exercises: z.array(ExerciseInputSchema).min(1).describe("Array of exercises with optional overrides"),
  },
  async ({ name, overview, exercises }) => {
    try {
      const auth = await getValidAuth();
      if (!auth) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Not authenticated. Use authenticate_coros first.",
            },
          ],
          isError: true,
        };
      }

      // Validate all exercise names first
      const missing: string[] = [];
      for (const ex of exercises) {
        if (!findByName(ex.name)) {
          missing.push(ex.name);
        }
      }
      if (missing.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Exercises not found in catalog: ${missing.map((n) => `"${n}"`).join(", ")}. Use search_exercises to find the correct names.`,
            },
          ],
          isError: true,
        };
      }

      // Build payloads
      const exercisePayloads = resolveExercises(exercises);

      // Calculate metrics
      const calculated = await calculateWorkout(
        auth,
        name,
        overview,
        exercisePayloads
      );

      // Create the workout
      await addWorkout(auth, name, overview, exercisePayloads, calculated);

      const totalSets = exercises.reduce(
        (sum, ex) => sum + (ex.sets ?? findByName(ex.name)!.sets),
        0
      );
      const exerciseSummary = exercises
        .map((ex) => {
          const catalog = findByName(ex.name)!;
          const sets = ex.sets ?? catalog.sets;
          const target = ex.reps ?? ex.duration ?? catalog.targetValue;
          const unit = (ex.reps || (!ex.duration && catalog.targetType === 3)) ? "reps" : "s";
          const weight = ex.weightKg ? ` @ ${ex.weightKg}kg` : "";
          return `  ${ex.name}: ${sets}x${target}${unit}${weight}`;
        })
        .join("\n");

      const durationMin = Math.round(calculated.duration / 60);

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Workout "${name}" created successfully!`,
              `Duration: ~${durationMin} min | Sets: ${calculated.totalSets} | Training load: ${calculated.trainingLoad}`,
              ``,
              `Exercises:`,
              exerciseSummary,
              ``,
              `The workout will sync to your COROS watch.`,
            ].join("\n"),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to create workout: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// --- Tool: create_running_workout ---
const RunStepSchema = z.object({
  type: z
    .enum(["warmup", "work", "recovery", "cooldown"])
    .describe("Step role: warmup, work, recovery (between reps), or cooldown"),
  distanceMeters: z.number().positive().optional().describe("Distance target in meters (e.g. 2000)"),
  timeSeconds: z.number().positive().optional().describe("Time target in seconds (e.g. 720 for 12 min)"),
  paceFast: z.string().optional().describe('Fast end of pace target, "m:ss" per km (e.g. "3:54")'),
  paceSlow: z.string().optional().describe('Slow end of pace target, "m:ss" per km (e.g. "4:18")'),
  zone: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("COROS running pace zone (1..6); resolves to that zone's pace band. Alternative to paceFast/paceSlow."),
});
const RepeatBlockSchema = z.object({
  repeat: z.number().int().min(1).describe("Number of times to repeat the child steps"),
  restSeconds: z.number().int().min(0).optional().describe("Rest between repeats in seconds (default 30)"),
  steps: z.array(RunStepSchema).min(1).describe("Steps inside the repeat block (e.g. work + recovery)"),
});

server.tool(
  "create_running_workout",
  "Create a structured RUNNING workout on COROS Training Hub (sportType 1). Steps are warmup/work/recovery/cooldown with distance or time targets and optional pace-range targets (COROS adjusted-pace). Intervals use repeat blocks. Set calculateOnly=true to validate the payload against COROS without saving. Syncs to the watch when saved.",
  {
    name: z.string().describe("Workout name (e.g. 'Q2 Threshold — 2x12min')"),
    overview: z.string().default("").describe("Workout description"),
    steps: z
      .array(z.union([RepeatBlockSchema, RunStepSchema]))
      .min(1)
      .describe("Ordered list of steps and/or repeat blocks"),
    calculateOnly: z
      .boolean()
      .default(false)
      .describe("If true, validate + compute metrics via /calculate but do NOT save the workout"),
  },
  async ({ name, overview, steps, calculateOnly }) => {
    try {
      const auth = await getValidAuth();
      if (!auth) {
        return {
          content: [{ type: "text" as const, text: "Not authenticated. Use authenticate_coros first." }],
          isError: true,
        };
      }

      // Fetch the athlete's pace reference so pace/zone targets encode exactly
      // (percent-of-threshold). Non-fatal: fall back to absolute-only if unavailable.
      let paceCtx: { ltsp?: number | null; ltspZone?: number[] } = {};
      try {
        paceCtx = await getAccountZones(auth);
      } catch {
        paceCtx = {};
      }

      const payload = buildRunningWorkoutPayload(
        name,
        overview,
        steps as RunningItemInput[],
        paceCtx
      );
      const calculated = await calculateProgram(auth, payload);

      if (!calculateOnly) {
        await addProgram(auth, payload, calculated);
      }

      const durationMin = Math.round((calculated.duration || 0) / 60);
      // calculated.distance is COROS-native centimeters (meters*100).
      const distanceKm = calculated.distance ? (calculated.distance / 100000).toFixed(2) : "?";
      const header = calculateOnly
        ? `Validated running workout "${name}" (NOT saved — calculateOnly).`
        : `Running workout "${name}" created successfully!`;

      return {
        content: [
          {
            type: "text" as const,
            text: [
              header,
              `Duration: ~${durationMin} min | Distance: ${distanceKm} km | Training load: ${calculated.trainingLoad}`,
              calculateOnly ? "" : "The workout will sync to your COROS watch.",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to create running workout: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// --- Tool: update_exercises ---
server.tool(
  "update_exercises",
  "Fetch the latest exercise catalog from COROS APIs and rebuild the local catalog. Requires authentication. Fetches exercises from the COROS API and i18n strings for human-readable names.",
  {
    sportType: z
      .number()
      .int()
      .default(4)
      .describe("Sport type to fetch exercises for (default 4 = strength)"),
  },
  async ({ sportType }) => {
    try {
      const auth = await getValidAuth();
      if (!auth) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Not authenticated. Use authenticate_coros first.",
            },
          ],
          isError: true,
        };
      }

      // Get current catalog for comparison and as fallback for names
      let oldExercises: ReturnType<typeof getAllExercises> = [];
      let oldNames: Set<string>;
      try {
        oldExercises = getAllExercises();
        oldNames = new Set(oldExercises.map((e) => e.name));
      } catch {
        oldNames = new Set();
      }

      // Fetch exercises and i18n in parallel
      const [rawExercises, i18n] = await Promise.all([
        queryExerciseCatalog(auth, sportType),
        fetchI18nStrings(),
      ]);

      // Build catalog (pass existing catalog for name fallback)
      const { catalog, i18nMisses } = buildCatalogFromRaw(
        rawExercises,
        i18n,
        oldExercises
      );

      // Compare with old catalog
      const newNames = new Set(catalog.map((e) => e.name));
      const added = [...newNames].filter((n) => !oldNames.has(n));
      const removed = [...oldNames].filter((n) => !newNames.has(n));

      // Write to disk
      const catalogPath = getCatalogPath();
      writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));

      // Reload in-memory cache
      reloadCatalog();

      // Build summary
      const lines = [
        `Exercise catalog updated successfully.`,
        `Total exercises: ${catalog.length}`,
      ];
      if (added.length > 0) {
        lines.push(`New exercises (${added.length}): ${added.join(", ")}`);
      }
      if (removed.length > 0) {
        lines.push(
          `Removed exercises (${removed.length}): ${removed.join(", ")}`
        );
      }
      if (added.length === 0 && removed.length === 0) {
        lines.push("No changes in exercise list.");
      }
      if (i18nMisses.length > 0) {
        lines.push(
          `i18n misses (${i18nMisses.length}): ${i18nMisses.slice(0, 10).join(", ")}${i18nMisses.length > 10 ? "..." : ""}`
        );
      }
      lines.push(`Catalog written to: ${catalogPath}`);

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to update exercises: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// --- Tool: list_workouts ---
server.tool(
  "list_workouts",
  "List workouts from COROS Training Hub.",
  {
    name: z.string().default("").describe("Filter by workout name (optional)"),
    sportType: z.number().int().default(0).describe("Filter by sport type (0=all, 4=strength)"),
    limit: z.number().int().min(1).max(50).default(10).describe("Number of workouts to return"),
  },
  async ({ name, sportType, limit }) => {
    try {
      const auth = await getValidAuth();
      if (!auth) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Not authenticated. Use authenticate_coros first.",
            },
          ],
          isError: true,
        };
      }

      const result = (await queryWorkouts(auth, {
        name,
        sportType,
        limitSize: limit,
      })) as { data: Array<{ name: string; overview: string; sportType: number; duration: number; totalSets: number; exerciseNum: number; estimatedTime: number }> };

      const workouts = result.data || [];
      if (workouts.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No workouts found.",
            },
          ],
        };
      }

      const formatted = workouts
        .map((w) => {
          const durationMin = Math.round((w.estimatedTime || w.duration || 0) / 60);
          return `- **${w.name}** (${durationMin} min, ${w.totalSets || 0} sets, ${w.exerciseNum || 0} exercises)${w.overview ? `\n  ${w.overview}` : ""}`;
        })
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${workouts.length} workout(s):\n\n${formatted}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to list workouts: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// --- Tool: schedule_workouts ---
// COROS has no "assign a workout to a date" call. Scheduling onto the calendar
// is a three-step flow, all reverse-engineered from the hub:
//   1. POST /training/plan/add           build a multi-week plan TEMPLATE,
//                                         placing workouts by dayNo (0-based).
//   2. schedule/executeSubPlan?startDay= bind that template onto the calendar
//                                         starting at startDay; each workout
//                                         lands on startDay + its dayNo. THIS is
//                                         what puts them on the calendar/watch.
//   3. plan/delete [templateId]          drop the now-redundant template (the
//                                         calendar copy is independent, verified).
// Placement is purely by dayNo + startDay (entity happenDay is left "" — a stale
// happenDay that disagrees with startDay+dayNo misplaces the workout).
const ScheduledItemSchema = z
  .object({
    workoutId: z
      .string()
      .optional()
      .describe("Id of an existing COROS program to schedule (from list_workouts / a prior create)."),
    running: z
      .object({
        name: z.string().describe("Name for the inline running workout"),
        overview: z.string().default("").describe("Description"),
        steps: z
          .array(z.union([RepeatBlockSchema, RunStepSchema]))
          .min(1)
          .describe("Running steps/repeat blocks (same shape as create_running_workout)"),
      })
      .optional()
      .describe("Inline running workout to create and schedule (alternative to workoutId)."),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Calendar date "YYYY-MM-DD" to place this workout on (recommended).'),
    dayOffset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("0-based day offset from the plan start (alternative to date)."),
  })
  .describe("One scheduled workout: a source (workoutId OR running) + a placement (date OR dayOffset).");

server.tool(
  "schedule_workouts",
  "Schedule workouts onto the COROS CALENDAR (so they sync to the watch). Each item is an existing workout (workoutId) or an inline running spec, placed on a calendar date or a relative dayOffset. Provide startDate to anchor day 0. Internally: builds a plan template, binds it to the calendar (executeSubPlan), then deletes the template. Set keepAsTemplate=true to skip calendar binding and just leave a reusable plan under Plans.",
  {
    name: z.string().describe("Plan name (e.g. 'Week of Jul 6 — GE100k')"),
    overview: z.string().default("").describe("Plan description"),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Calendar date "YYYY-MM-DD" for day 0. Required unless every item has its own date, or keepAsTemplate=true.'),
    workouts: z.array(ScheduledItemSchema).min(1).describe("Workouts to place."),
    keepAsTemplate: z
      .boolean()
      .default(false)
      .describe("If true, only create a reusable Plans-library template (do NOT bind to the calendar)."),
  },
  async ({ name, overview, startDate, workouts, keepAsTemplate }) => {
    try {
      const auth = await getValidAuth();
      if (!auth) {
        return {
          content: [{ type: "text" as const, text: "Not authenticated. Use authenticate_coros first." }],
          isError: true,
        };
      }

      // Validate each item: exactly one source, exactly one placement.
      for (const [i, w] of workouts.entries()) {
        const hasSource = Number(!!w.workoutId) + Number(!!w.running);
        if (hasSource !== 1) {
          throw new Error(`workouts[${i}]: provide exactly one of workoutId or running`);
        }
        const hasPlacement = Number(w.date !== undefined) + Number(w.dayOffset !== undefined);
        if (hasPlacement !== 1) {
          throw new Error(`workouts[${i}]: provide exactly one of date or dayOffset`);
        }
      }

      // Anchor date = day 0 of the plan (the executeSubPlan startDay). Explicit
      // startDate wins, else the earliest per-item date. Required to reach the
      // calendar; without it we can only leave a template.
      const usedDates = workouts.map((w) => w.date).filter((d): d is string => !!d).sort();
      const anchorISO = startDate ?? usedDates[0];
      if (!anchorISO && !keepAsTemplate) {
        throw new Error(
          "Provide startDate (or a date on each workout) to schedule onto the calendar, or set keepAsTemplate=true."
        );
      }

      // Fetch pace reference once if any inline running workout is present.
      let paceCtx: { ltsp?: number | null; ltspZone?: number[] } = {};
      if (workouts.some((w) => w.running)) {
        try {
          paceCtx = await getAccountZones(auth);
        } catch {
          paceCtx = {};
        }
      }

      const placements: PlanPlacement[] = [];
      const summaries: string[] = [];
      for (const w of workouts) {
        // Placement -> dayNo (relative to the anchor). happenDay stays "" — the
        // calendar date is decided by executeSubPlan's startDay + dayNo.
        let dayNo: number;
        if (w.date !== undefined) {
          dayNo = anchorISO ? dayNoFromDates(anchorISO, w.date) : 0;
          if (dayNo < 0) {
            throw new Error(`Date ${w.date} is before the plan start (${anchorISO}); adjust startDate.`);
          }
        } else {
          dayNo = w.dayOffset!;
        }

        // Source -> a full program-detail object to embed.
        let programId: string;
        let label: string;
        if (w.workoutId) {
          programId = w.workoutId;
          label = `workout ${w.workoutId}`;
        } else {
          const spec = w.running!;
          const payload = buildRunningWorkoutPayload(
            spec.name,
            spec.overview,
            spec.steps as RunningItemInput[],
            paceCtx
          );
          const calculated = await calculateProgram(auth, payload);
          programId = await addProgram(auth, payload, calculated);
          label = `run "${spec.name}"`;
        }
        const program = await getProgramDetail(auth, programId);
        placements.push({ program, dayNo });

        const when = anchorISO
          ? isoPlusDaysLabel(anchorISO, dayNo)
          : `day ${dayNo}`;
        summaries.push(`  ${when}: ${program.name ?? label}`);
      }

      const planPayload = buildTrainingPlanPayload({
        name,
        overview,
        placements,
        region: REGION_IDS[auth.region] ?? 3,
      });
      const planId = await addTrainingPlan(auth, planPayload);

      // Bind to the calendar unless the caller only wants a template.
      if (!keepAsTemplate && anchorISO) {
        await executeSubPlan(auth, planId, toHappenDay(anchorISO));
        // The template is now redundant; the calendar copy is independent.
        // Best-effort cleanup so we don't litter the Plans library.
        try {
          await deletePlans(auth, [planId]);
        } catch {
          /* leave the template if cleanup fails; calendar is already set */
        }
      }

      const header = keepAsTemplate || !anchorISO
        ? `Plan template "${name}" created (id ${planId}) — under Plans, NOT on the calendar.`
        : `Scheduled "${name}" onto your calendar (starts ${anchorISO}).`;

      return {
        content: [
          {
            type: "text" as const,
            text: [
              header,
              `${placements.length} workout(s) across ${planPayload.totalDay} day(s):`,
              ...summaries,
              ``,
              keepAsTemplate || !anchorISO
                ? `Re-run with a startDate to place it on the calendar.`
                : `These will sync to your COROS watch. Verify on the hub calendar.`,
            ].join("\n"),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to schedule workouts: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});
