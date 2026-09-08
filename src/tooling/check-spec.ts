/**
 * The declared interaction check of a scene: `checks/<id>.json`.
 *
 * A check names the phases to render natively (a frame window, an input
 * tape, an environment), the expectations to evaluate over the captures
 * those phases write, and optionally the browser observation that
 * produces the reference the expectations compare against. The driver
 * (`check-run.ts`, `observe-run.ts`) owns everything the phases share:
 * the executable, the twin compile, the environment composition, the
 * backend loop, the log scan, the build-identity gate and the report.
 * Scene-specific arithmetic lives in a plugin module the check names.
 *
 * The file is read through this module only, and every field is checked
 * before the driver spends a native run on it: an unknown key or a
 * mistyped expectation is an error naming the field, never a check that
 * silently asserts nothing.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/** A registry scene's native environment base for every phase. */
export type CheckEnvironmentBase = "registry" | "adhoc" | "fixed" | "none";

export interface CheckPhase {
    id: string;
    /** The zero-based screenshot frame. */
    frame: number;
    /** A floor for `BBLITE_MAX_FRAMES` above `frame + 1`. */
    maxFrames?: number;
    /** `BBLITE_INPUT_REPLAY` entries; `"<entry>*<n>"` repeats one. */
    tape?: string[];
    env?: Record<string, string>;
    /** `BBLITE_ANIMATION_SEEK_SECONDS`. */
    seek?: number;
    /** Whether the run writes a render capture (default: the check's). */
    capture?: boolean;
    /** Free text: why this phase exists. */
    notes?: string;
}

/** A phase id, or `*` for every phase. */
export type PhaseSelector = string;

/**
 * The image another image is compared against: another phase of the same
 * backend, the committed golden, or a browser observation step's
 * screenshot (`browser:<step>`).
 */
export type ImageReference = string;

export type CheckExpectation =
    | {
          kind: "capture-path";
          phase: PhaseSelector;
          /** A capture path (`meshes.length`, `draws[pipeline=shader].order`). */
          path: string;
          equals?: unknown;
          min?: number;
          max?: number;
          /** Every value the path yields must be finite. */
          finite?: boolean;
          notes?: string;
      }
    | {
          kind: "capture-same" | "capture-differs";
          phase: PhaseSelector;
          vs: string;
          path: string;
          notes?: string;
      }
    | {
          kind: "capture-compare";
          phase: PhaseSelector;
          vs: string;
          path: string;
          op: ">" | "<" | ">=" | "<=";
          notes?: string;
      }
    | {
          kind: "camera-delta";
          phase: PhaseSelector;
          vs: string;
          key: string;
          min?: number;
          max?: number;
          notes?: string;
      }
    | {
          kind: "image-mad";
          phase: PhaseSelector;
          vs: ImageReference;
          min?: number;
          max?: number;
          /** The largest channel difference allowed (0 = byte-identical). */
          maxDiff?: number;
          /** At least this many pixels must differ. */
          changedPixelsMin?: number;
          notes?: string;
      }
    | {
          kind: "viewport";
          phase: PhaseSelector;
          equals: [number, number];
          notes?: string;
      }
    | {
          kind: "golden-mad";
          phase: PhaseSelector;
          /** Defaults to the registry golden. */
          reference?: ImageReference;
          max: number;
          foregroundMax?: number;
          /** Defaults to the registry background colour and threshold. */
          background?: [number, number, number];
          threshold?: number;
          notes?: string;
      }
    | {
          kind: "backends-agree";
          phase: PhaseSelector;
          /** Capture paths that must be deep-equal across backends. */
          paths?: string[];
          /** The largest channel difference allowed between the images. */
          imageMaxDiff?: number;
          imageMad?: number;
          notes?: string;
      }
    | {
          kind: "log-match";
          phase: PhaseSelector;
          pattern: string;
          flags?: string;
          /** Exact match count; absent = at least one. */
          count?: number;
          /** The pattern must NOT match. */
          absent?: boolean;
          notes?: string;
      }
    | {
          kind: "plugin";
          /** A module path relative to the repository root. */
          module: string;
          options?: Record<string, unknown>;
          notes?: string;
      };

/** One page action of an observation step, in the vocabulary the driver plays. */
export type ObserveAction =
    | { click: [number, number] }
    | { move: [number, number] }
    | { down: true }
    | { up: true }
    | { drag: [number, number, number, number]; steps?: number }
    | { wheel: number }
    | { resize: [number, number] }
    | { fill: { selector: string; text: string } }
    | { style: string }
    | { wait: number }
    | { frames: number }
    | { evaluate: string; as?: string }
    | { workerEvaluate: string; as?: string }
    | { waitFor: string; timeoutMs?: number };

export interface ObserveStep {
    id: string;
    actions?: ObserveAction[];
    /** Screenshot after the actions: the page (default), the canvas only, or none. */
    screenshot?: "page" | "canvas" | "none";
    /** Evaluate the `state` expression after the actions (default true). */
    state?: boolean;
    /** Frames to let pass after the actions before reading state. */
    settleFrames?: number;
    /** A CSS rule applied before the screenshot and removed after. */
    hideStyle?: string;
    /**
     * Start a fresh page for this step, with the served harness rewritten
     * to this size (the scene reads the canvas size at startup).
     */
    startup?: { viewport: [number, number] };
    notes?: string;
}

export interface ObserveHook {
    /** A source line the scene must contain exactly once. */
    marker: string;
    /** Source injected before or after (default) the marker. */
    inject: string;
    position?: "before" | "after";
}

export interface ObserveSpec {
    /** Source injections into the corpus module before it is served. */
    hooks?: ObserveHook[];
    /** A page init script file (relative to the repository root). */
    initScriptFile?: string;
    /** The page expression the driver evaluates for a step's state. */
    state?: string;
    /**
     * The canvas dataset flag the page raises when the scene is ready
     * (`ready` by default; a recovery scene raises `preLossReady`
     * first); `none` navigates without waiting.
     */
    ready?: string;
    /** Serve the registry host page (default when the registry names one). */
    hostPage?: boolean;
    viewport?: [number, number];
    headless?: boolean;
    /** Navigate with `?captureFrame=<n>` and observe each frozen frame. */
    captureFrames?: number[];
    /**
     * Load the page afresh (at the declared viewport) before every step
     * instead of carrying state from one step to the next, so each step
     * is the control it names applied to the scene's initial state — the
     * way a native phase replays its tape from frame zero.
     */
    reloadEachStep?: boolean;
    /**
     * Whether the first page screenshot must be byte-identical to the
     * registry golden (default true): an observer that changes the image
     * it observes is not evidence. The comparison is recorded either way.
     */
    golden?: boolean;
    steps: ObserveStep[];
    notes?: string;
}

export interface CheckSpec {
    /** The registry scene the check exercises. */
    scene: string;
    /** Run against the byte-identical no-query twin `generated/<id>-live`. */
    twin?: boolean;
    base?: CheckEnvironmentBase;
    env?: Record<string, string>;
    /** `BBLITE_TEST_PASS`; checks run outside a hidden test pass by default
     *  because pointer callbacks only attach there. */
    testPass?: boolean;
    /**
     * The backend's validation layer plus the SDL assertion defusal
     * (`--gpu-debug`), on by default so a failed pass names itself; a
     * timing measurement turns it off because the layer changes the
     * cadence it measures.
     */
    gpuDebug?: boolean;
    timeoutMs?: number;
    /** A floor for every phase's `BBLITE_MAX_FRAMES`. */
    minFrames?: number;
    /** Whether phases write a render capture (default true). */
    capture?: boolean;
    /** The log pattern a phase must not match (default: the shared one). */
    logErrorPattern?: string;
    phases: CheckPhase[];
    expect: CheckExpectation[];
    observe?: ObserveSpec;
    notes?: string;
}

export const CHECKS_DIRECTORY = "checks";

export function checkSpecPath(checkId: string): string {
    return resolve(CHECKS_DIRECTORY, `${checkId}.json`);
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(location: string, message: string): never {
    throw new Error(`${location}: ${message}`);
}

function refuseUnknown(record: Json, known: readonly string[], location: string): void {
    for (const key of Object.keys(record)) {
        if (!known.includes(key)) {
            fail(location, `unknown key '${key}' (known: ${known.join(", ")})`);
        }
    }
}

function optionalString(record: Json, key: string, location: string): string | undefined {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") fail(location, `'${key}' must be a string`);
    return value;
}

function requiredString(record: Json, key: string, location: string): string {
    const value = optionalString(record, key, location);
    if (value === undefined || value === "") fail(location, `'${key}' is required`);
    return value;
}

function optionalNumber(record: Json, key: string, location: string): number | undefined {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(location, `'${key}' must be a finite number`);
    }
    return value;
}

function optionalBoolean(record: Json, key: string, location: string): boolean | undefined {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") fail(location, `'${key}' must be true or false`);
    return value;
}

function optionalStringRecord(
    record: Json,
    key: string,
    location: string,
): Record<string, string> | undefined {
    const value = record[key];
    if (value === undefined) return undefined;
    if (!isRecord(value) || !Object.values(value).every((entry) => typeof entry === "string")) {
        fail(location, `'${key}' must map names to strings`);
    }
    return value as Record<string, string>;
}

function optionalStringArray(record: Json, key: string, location: string): string[] | undefined {
    const value = record[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
        fail(location, `'${key}' must be an array of strings`);
    }
    return value as string[];
}

function pair(value: unknown, location: string, key: string): [number, number] {
    if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ) {
        fail(location, `'${key}' must be two numbers`);
    }
    return [value[0] as number, value[1] as number];
}

/** Expand `"<entry>*<n>"` tape shorthands (`"-*20"` = twenty idle frames). */
export function expandTape(tape: readonly string[]): string[] {
    const entries: string[] = [];
    for (const entry of tape) {
        const repeat = /^(.*)\*(\d+)$/.exec(entry);
        if (repeat) {
            entries.push(...Array<string>(Number(repeat[2])).fill(repeat[1]!));
        } else {
            entries.push(entry);
        }
    }
    return entries;
}

function readPhase(value: unknown, location: string): CheckPhase {
    if (!isRecord(value)) fail(location, "must be an object");
    refuseUnknown(value, ["id", "frame", "maxFrames", "tape", "env", "seek", "capture", "notes"], location);
    const frame = optionalNumber(value, "frame", location);
    if (frame === undefined || !Number.isInteger(frame) || frame < 0) {
        fail(location, "'frame' must be a non-negative integer");
    }
    const maxFrames = optionalNumber(value, "maxFrames", location);
    const tape = optionalStringArray(value, "tape", location);
    const env = optionalStringRecord(value, "env", location);
    const seek = optionalNumber(value, "seek", location);
    const capture = optionalBoolean(value, "capture", location);
    const notes = optionalString(value, "notes", location);
    return {
        id: requiredString(value, "id", location),
        frame,
        ...(maxFrames !== undefined ? { maxFrames } : {}),
        ...(tape !== undefined ? { tape } : {}),
        ...(env !== undefined ? { env } : {}),
        ...(seek !== undefined ? { seek } : {}),
        ...(capture !== undefined ? { capture } : {}),
        ...(notes !== undefined ? { notes } : {}),
    };
}

const EXPECTATION_KEYS: Record<CheckExpectation["kind"], readonly string[]> = {
    "capture-path": ["kind", "phase", "path", "equals", "min", "max", "finite", "notes"],
    "capture-same": ["kind", "phase", "vs", "path", "notes"],
    "capture-differs": ["kind", "phase", "vs", "path", "notes"],
    "capture-compare": ["kind", "phase", "vs", "path", "op", "notes"],
    "camera-delta": ["kind", "phase", "vs", "key", "min", "max", "notes"],
    "image-mad": ["kind", "phase", "vs", "min", "max", "maxDiff", "changedPixelsMin", "notes"],
    viewport: ["kind", "phase", "equals", "notes"],
    "golden-mad": ["kind", "phase", "reference", "max", "foregroundMax", "background", "threshold", "notes"],
    "backends-agree": ["kind", "phase", "paths", "imageMaxDiff", "imageMad", "notes"],
    "log-match": ["kind", "phase", "pattern", "flags", "count", "absent", "notes"],
    plugin: ["kind", "module", "options", "notes"],
};

function readExpectation(value: unknown, location: string): CheckExpectation {
    if (!isRecord(value)) fail(location, "must be an object");
    const kind = requiredString(value, "kind", location);
    if (!(kind in EXPECTATION_KEYS)) {
        fail(location, `unknown expectation kind '${kind}' (known: ${Object.keys(EXPECTATION_KEYS).join(", ")})`);
    }
    const known = EXPECTATION_KEYS[kind as CheckExpectation["kind"]];
    refuseUnknown(value, known, location);
    const notes = optionalString(value, "notes", location);
    const withNotes = <T extends object>(expectation: T): T & { notes?: string } =>
        notes === undefined ? expectation : { ...expectation, notes };
    const phase = (): string => requiredString(value, "phase", location);
    const min = optionalNumber(value, "min", location);
    const max = optionalNumber(value, "max", location);
    switch (kind as CheckExpectation["kind"]) {
        case "capture-path": {
            const finite = optionalBoolean(value, "finite", location);
            return withNotes({
                kind: "capture-path",
                phase: phase(),
                path: requiredString(value, "path", location),
                ...("equals" in value ? { equals: value.equals } : {}),
                ...(min !== undefined ? { min } : {}),
                ...(max !== undefined ? { max } : {}),
                ...(finite !== undefined ? { finite } : {}),
            });
        }
        case "capture-same":
        case "capture-differs":
            return withNotes({
                kind: kind as "capture-same" | "capture-differs",
                phase: phase(),
                vs: requiredString(value, "vs", location),
                path: requiredString(value, "path", location),
            });
        case "capture-compare": {
            const op = requiredString(value, "op", location);
            if (![">", "<", ">=", "<="].includes(op)) fail(location, "'op' must be one of > < >= <=");
            return withNotes({
                kind: "capture-compare",
                phase: phase(),
                vs: requiredString(value, "vs", location),
                path: requiredString(value, "path", location),
                op: op as ">" | "<" | ">=" | "<=",
            });
        }
        case "camera-delta":
            return withNotes({
                kind: "camera-delta",
                phase: phase(),
                vs: requiredString(value, "vs", location),
                key: requiredString(value, "key", location),
                ...(min !== undefined ? { min } : {}),
                ...(max !== undefined ? { max } : {}),
            });
        case "image-mad": {
            const maxDiff = optionalNumber(value, "maxDiff", location);
            const changedPixelsMin = optionalNumber(value, "changedPixelsMin", location);
            return withNotes({
                kind: "image-mad",
                phase: phase(),
                vs: requiredString(value, "vs", location),
                ...(min !== undefined ? { min } : {}),
                ...(max !== undefined ? { max } : {}),
                ...(maxDiff !== undefined ? { maxDiff } : {}),
                ...(changedPixelsMin !== undefined ? { changedPixelsMin } : {}),
            });
        }
        case "viewport":
            return withNotes({
                kind: "viewport",
                phase: phase(),
                equals: pair(value.equals, location, "equals"),
            });
        case "golden-mad": {
            const reference = optionalString(value, "reference", location);
            const foregroundMax = optionalNumber(value, "foregroundMax", location);
            const threshold = optionalNumber(value, "threshold", location);
            const background = value.background;
            if (
                background !== undefined &&
                (!Array.isArray(background) ||
                    background.length !== 3 ||
                    !background.every((entry) => typeof entry === "number"))
            ) {
                fail(location, "'background' must be three numbers");
            }
            if (max === undefined) fail(location, "'max' is required");
            return withNotes({
                kind: "golden-mad",
                phase: phase(),
                max,
                ...(reference !== undefined ? { reference } : {}),
                ...(foregroundMax !== undefined ? { foregroundMax } : {}),
                ...(background !== undefined
                    ? { background: background as [number, number, number] }
                    : {}),
                ...(threshold !== undefined ? { threshold } : {}),
            });
        }
        case "backends-agree": {
            const paths = optionalStringArray(value, "paths", location);
            const imageMaxDiff = optionalNumber(value, "imageMaxDiff", location);
            const imageMad = optionalNumber(value, "imageMad", location);
            return withNotes({
                kind: "backends-agree",
                phase: phase(),
                ...(paths !== undefined ? { paths } : {}),
                ...(imageMaxDiff !== undefined ? { imageMaxDiff } : {}),
                ...(imageMad !== undefined ? { imageMad } : {}),
            });
        }
        case "log-match": {
            const flags = optionalString(value, "flags", location);
            const count = optionalNumber(value, "count", location);
            const absent = optionalBoolean(value, "absent", location);
            return withNotes({
                kind: "log-match",
                phase: phase(),
                pattern: requiredString(value, "pattern", location),
                ...(flags !== undefined ? { flags } : {}),
                ...(count !== undefined ? { count } : {}),
                ...(absent !== undefined ? { absent } : {}),
            });
        }
        case "plugin": {
            const options = value.options;
            if (options !== undefined && !isRecord(options)) fail(location, "'options' must be an object");
            return withNotes({
                kind: "plugin",
                module: requiredString(value, "module", location),
                ...(options !== undefined ? { options } : {}),
            });
        }
    }
}

const ACTION_KEYS = [
    "click", "move", "down", "up", "drag", "steps", "wheel", "resize", "fill",
    "style", "wait", "frames", "evaluate", "workerEvaluate", "as", "waitFor", "timeoutMs",
] as const;

function readAction(value: unknown, location: string): ObserveAction {
    if (!isRecord(value)) fail(location, "must be an object");
    refuseUnknown(value, ACTION_KEYS, location);
    if ("click" in value) return { click: pair(value.click, location, "click") };
    if ("move" in value) return { move: pair(value.move, location, "move") };
    if ("down" in value) return { down: true };
    if ("up" in value) return { up: true };
    if ("drag" in value) {
        const drag = value.drag;
        if (
            !Array.isArray(drag) ||
            drag.length !== 4 ||
            !drag.every((entry) => typeof entry === "number")
        ) {
            fail(location, "'drag' must be [x0, y0, x1, y1]");
        }
        const steps = optionalNumber(value, "steps", location);
        return {
            drag: drag as [number, number, number, number],
            ...(steps !== undefined ? { steps } : {}),
        };
    }
    if ("wheel" in value) {
        const wheel = optionalNumber(value, "wheel", location);
        if (wheel === undefined) fail(location, "'wheel' must be a number");
        return { wheel };
    }
    if ("resize" in value) return { resize: pair(value.resize, location, "resize") };
    if ("fill" in value) {
        const fill = value.fill;
        if (!isRecord(fill)) fail(location, "'fill' must be { selector, text }");
        refuseUnknown(fill, ["selector", "text"], `${location}.fill`);
        return {
            fill: {
                selector: requiredString(fill, "selector", `${location}.fill`),
                text: optionalString(fill, "text", `${location}.fill`) ?? "",
            },
        };
    }
    if ("style" in value) return { style: requiredString(value, "style", location) };
    if ("wait" in value) {
        const wait = optionalNumber(value, "wait", location);
        if (wait === undefined) fail(location, "'wait' must be a number of milliseconds");
        return { wait };
    }
    if ("frames" in value) {
        const frames = optionalNumber(value, "frames", location);
        if (frames === undefined) fail(location, "'frames' must be a number");
        return { frames };
    }
    if ("evaluate" in value || "workerEvaluate" in value) {
        const as = optionalString(value, "as", location);
        if ("evaluate" in value) {
            return {
                evaluate: requiredString(value, "evaluate", location),
                ...(as !== undefined ? { as } : {}),
            };
        }
        return {
            workerEvaluate: requiredString(value, "workerEvaluate", location),
            ...(as !== undefined ? { as } : {}),
        };
    }
    if ("waitFor" in value) {
        const timeoutMs = optionalNumber(value, "timeoutMs", location);
        return {
            waitFor: requiredString(value, "waitFor", location),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        };
    }
    fail(location, `an action needs one of ${ACTION_KEYS.join(", ")}`);
}

function readStep(value: unknown, location: string): ObserveStep {
    if (!isRecord(value)) fail(location, "must be an object");
    refuseUnknown(
        value,
        ["id", "actions", "screenshot", "state", "settleFrames", "hideStyle", "startup", "notes"],
        location,
    );
    const actions = value.actions;
    if (actions !== undefined && !Array.isArray(actions)) fail(location, "'actions' must be an array");
    const screenshot = optionalString(value, "screenshot", location);
    if (screenshot !== undefined && screenshot !== "page" && screenshot !== "canvas" && screenshot !== "none") {
        fail(location, "'screenshot' must be 'page', 'canvas' or 'none'");
    }
    const state = optionalBoolean(value, "state", location);
    const settleFrames = optionalNumber(value, "settleFrames", location);
    const hideStyle = optionalString(value, "hideStyle", location);
    const notes = optionalString(value, "notes", location);
    const startup = value.startup;
    if (startup !== undefined) {
        if (!isRecord(startup)) fail(location, "'startup' must be { viewport }");
        refuseUnknown(startup, ["viewport"], `${location}.startup`);
    }
    return {
        id: requiredString(value, "id", location),
        ...(actions !== undefined
            ? {
                  actions: (actions as unknown[]).map((action, index) =>
                      readAction(action, `${location}.actions[${index}]`),
                  ),
              }
            : {}),
        ...(screenshot !== undefined ? { screenshot } : {}),
        ...(state !== undefined ? { state } : {}),
        ...(settleFrames !== undefined ? { settleFrames } : {}),
        ...(hideStyle !== undefined ? { hideStyle } : {}),
        ...(startup !== undefined
            ? {
                  startup: {
                      viewport: pair(
                          (startup as Json).viewport,
                          `${location}.startup`,
                          "viewport",
                      ),
                  },
              }
            : {}),
        ...(notes !== undefined ? { notes } : {}),
    };
}

function readObserve(value: unknown, location: string): ObserveSpec {
    if (!isRecord(value)) fail(location, "must be an object");
    refuseUnknown(
        value,
        ["hooks", "initScriptFile", "state", "ready", "hostPage", "viewport", "headless", "captureFrames", "reloadEachStep", "golden", "steps", "notes"],
        location,
    );
    const hooks = value.hooks;
    if (hooks !== undefined && !Array.isArray(hooks)) fail(location, "'hooks' must be an array");
    const steps = value.steps;
    if (!Array.isArray(steps)) fail(location, "'steps' must be an array");
    const captureFrames = value.captureFrames;
    if (
        captureFrames !== undefined &&
        (!Array.isArray(captureFrames) ||
            !captureFrames.every((entry) => Number.isInteger(entry) && (entry as number) >= 0))
    ) {
        fail(location, "'captureFrames' must be an array of non-negative integers");
    }
    const initScriptFile = optionalString(value, "initScriptFile", location);
    const state = optionalString(value, "state", location);
    const ready = optionalString(value, "ready", location);
    const hostPage = optionalBoolean(value, "hostPage", location);
    const headless = optionalBoolean(value, "headless", location);
    const reloadEachStep = optionalBoolean(value, "reloadEachStep", location);
    const golden = optionalBoolean(value, "golden", location);
    const notes = optionalString(value, "notes", location);
    return {
        ...(hooks !== undefined
            ? {
                  hooks: (hooks as unknown[]).map((hook, index) => {
                      const where = `${location}.hooks[${index}]`;
                      if (!isRecord(hook)) fail(where, "must be an object");
                      refuseUnknown(hook, ["marker", "inject", "position"], where);
                      const position = optionalString(hook, "position", where);
                      if (position !== undefined && position !== "before" && position !== "after") {
                          fail(where, "'position' must be 'before' or 'after'");
                      }
                      return {
                          marker: requiredString(hook, "marker", where),
                          inject: requiredString(hook, "inject", where),
                          ...(position !== undefined ? { position } : {}),
                      };
                  }),
              }
            : {}),
        ...(initScriptFile !== undefined ? { initScriptFile } : {}),
        ...(state !== undefined ? { state } : {}),
        ...(ready !== undefined ? { ready } : {}),
        ...(hostPage !== undefined ? { hostPage } : {}),
        ...(value.viewport !== undefined
            ? { viewport: pair(value.viewport, location, "viewport") }
            : {}),
        ...(headless !== undefined ? { headless } : {}),
        ...(captureFrames !== undefined ? { captureFrames: captureFrames as number[] } : {}),
        ...(reloadEachStep !== undefined ? { reloadEachStep } : {}),
        ...(golden !== undefined ? { golden } : {}),
        steps: (steps as unknown[]).map((step, index) =>
            readStep(step, `${location}.steps[${index}]`),
        ),
        ...(notes !== undefined ? { notes } : {}),
    };
}

/** Parse and validate a check spec's JSON text; `location` names it in errors. */
export function parseCheckSpec(text: string, location: string): CheckSpec {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        fail(location, `not valid JSON: ${(error as Error).message}`);
    }
    if (!isRecord(value)) fail(location, "must be a JSON object");
    refuseUnknown(
        value,
        ["scene", "twin", "base", "env", "testPass", "gpuDebug", "timeoutMs", "minFrames", "capture", "logErrorPattern", "phases", "expect", "observe", "notes"],
        location,
    );
    const base = optionalString(value, "base", location);
    if (base !== undefined && !["registry", "adhoc", "fixed", "none"].includes(base)) {
        fail(location, "'base' must be registry, adhoc, fixed or none");
    }
    const phases = value.phases;
    if (!Array.isArray(phases)) fail(location, "'phases' must be an array (empty for an offline check)");
    const expect = value.expect;
    if (!Array.isArray(expect)) fail(location, "'expect' must be an array");
    const twin = optionalBoolean(value, "twin", location);
    const env = optionalStringRecord(value, "env", location);
    const testPass = optionalBoolean(value, "testPass", location);
    const gpuDebug = optionalBoolean(value, "gpuDebug", location);
    const timeoutMs = optionalNumber(value, "timeoutMs", location);
    const minFrames = optionalNumber(value, "minFrames", location);
    const capture = optionalBoolean(value, "capture", location);
    const logErrorPattern = optionalString(value, "logErrorPattern", location);
    const notes = optionalString(value, "notes", location);
    const spec: CheckSpec = {
        scene: requiredString(value, "scene", location),
        ...(twin !== undefined ? { twin } : {}),
        ...(base !== undefined ? { base: base as CheckEnvironmentBase } : {}),
        ...(env !== undefined ? { env } : {}),
        ...(testPass !== undefined ? { testPass } : {}),
        ...(gpuDebug !== undefined ? { gpuDebug } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(minFrames !== undefined ? { minFrames } : {}),
        ...(capture !== undefined ? { capture } : {}),
        ...(logErrorPattern !== undefined ? { logErrorPattern } : {}),
        phases: (phases as unknown[]).map((phase, index) =>
            readPhase(phase, `${location}.phases[${index}]`),
        ),
        expect: (expect as unknown[]).map((expectation, index) =>
            readExpectation(expectation, `${location}.expect[${index}]`),
        ),
        ...(value.observe !== undefined
            ? { observe: readObserve(value.observe, `${location}.observe`) }
            : {}),
        ...(notes !== undefined ? { notes } : {}),
    };
    const ids = new Set<string>();
    for (const phase of spec.phases) {
        if (ids.has(phase.id)) fail(location, `phase '${phase.id}' is declared twice`);
        ids.add(phase.id);
    }
    for (const [index, expectation] of spec.expect.entries()) {
        const where = `${location}.expect[${index}]`;
        if ("phase" in expectation && expectation.phase !== "*" && !ids.has(expectation.phase)) {
            fail(where, `names phase '${expectation.phase}', which is not declared`);
        }
        if ("vs" in expectation && expectation.kind !== "image-mad" && !ids.has(expectation.vs)) {
            fail(where, `names phase '${expectation.vs}' (vs), which is not declared`);
        }
    }
    return spec;
}

/** Read `checks/<id>.json`, or throw naming what is missing. */
export function readCheckSpec(checkId: string): CheckSpec {
    const path = checkSpecPath(checkId);
    if (!existsSync(path)) {
        throw new Error(
            `No check is declared for '${checkId}': ${path} does not exist. ` +
                "Declared checks: " +
                listCheckIds().join(", "),
        );
    }
    return parseCheckSpec(readFileSync(path, "utf8"), path);
}

/** Every declared check id (the file stems under `checks/`). */
export function listCheckIds(): string[] {
    const directory = resolve(CHECKS_DIRECTORY);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length))
        .sort();
}
