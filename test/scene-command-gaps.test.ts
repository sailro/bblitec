import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
    captureNativePaths,
    captureSeekBracketDirectory,
    formatStabilityReport,
    parseParityArguments,
    parseStabilityArguments,
    seekBracketPlan,
    withoutVariable,
    type StabilityRunComparison,
} from "../src/parity-scene.js";

// The TL-gaps rungs' parseable pieces: the shared native-capture path
// trio, the seek-bracket plan, the `--without` composition rules, and
// the stability arguments and verdict text.

test("spells the native-capture path trio once for writer and reader", () => {
    // capture-native.ts writes these and scene-command's diff arm reads
    // them back; before the helper each kept its own matching literals.
    const directory = join("artifacts", "capture", "scene1");
    const paths = captureNativePaths(directory, "gpu");
    assert.equal(paths.capture, join(directory, "native-gpu.json"));
    assert.equal(paths.screenshot, join(directory, "native-gpu.png"));
    assert.equal(paths.meta, join(directory, "native-gpu.meta.json"));
    // The one-transition legacy spelling is the same helper with the
    // backend as the token.
    assert.equal(
        captureNativePaths(directory, "sdl_gpu").capture,
        join(directory, "native-sdl_gpu.json"),
    );
});

test("seek brackets land in seek-minus1/seek-plus1 beside the exact capture", () => {
    assert.equal(
        captureSeekBracketDirectory("cap", -1),
        join("cap", "seek-minus1"),
    );
    assert.equal(
        captureSeekBracketDirectory("cap", 1),
        join("cap", "seek-plus1"),
    );
});

test("seekBracketPlan steps one frame each way and refuses impossible plans", () => {
    const plan = seekBracketPlan(2, 60);
    assert.equal(plan.seekSeconds, 2);
    assert.equal(plan.frameStep, 1 / 60);
    assert.ok(Math.abs(plan.minus - (2 - 1 / 60)) < 1e-12);
    assert.ok(Math.abs(plan.plus - (2 + 1 / 60)) < 1e-12);
    // A static pose has no one-frame motion scale to bracket.
    assert.throws(
        () => seekBracketPlan(undefined, 60),
        /needs a pose to bracket/,
    );
    // Clamping the minus arm to zero would measure a different step than
    // the plus arm, so the plan refuses instead.
    assert.throws(() => seekBracketPlan(0.001, 60), /back past zero/);
    assert.throws(() => seekBracketPlan(2, 0), /positive frame rate/);
});

test("parity --without takes ground|background and nothing else", () => {
    assert.equal(
        parseParityArguments(["scene33", "--without", "ground"]).without,
        "ground",
    );
    assert.equal(
        parseParityArguments(["scene33", "--without", "background"]).without,
        "background",
    );
    assert.equal(parseParityArguments(["scene33"]).without, undefined);
    assert.throws(
        () => parseParityArguments(["scene33", "--without", "skybox"]),
        /--without must be ground\|background/,
    );
    assert.equal(withoutVariable("ground"), "BBLITE_GROUND");
    assert.equal(withoutVariable("background"), "BBLITE_BACKGROUND");
});

test("parity --without refuses companions that would measure something else", () => {
    // --actual skips the native run there would be nothing to suppress in.
    assert.throws(
        () =>
            parseParityArguments([
                "s",
                "--without",
                "ground",
                "--actual",
                "x.png",
            ]),
        /no native run for --without/,
    );
    // The golden keeps the element; recapturing it suppressed would poison
    // every later comparison.
    assert.throws(
        () =>
            parseParityArguments([
                "s",
                "--without",
                "background",
                "--recapture-reference",
            ]),
        /the golden keeps it/,
    );
    // The differential fan-out forwards only --gpu-debug.
    assert.throws(
        () =>
            parseParityArguments([
                "s",
                "--without",
                "ground",
                "--differential",
            ]),
        /--differential measures both GPU backends[\s\S]*--without/,
    );
});

test("stability arguments: five runs by default, strict overrides", () => {
    assert.deepEqual(parseStabilityArguments([]), {
        runs: 5,
        singleSample: false,
        gpuDebug: false,
    });
    const parsed = parseStabilityArguments([
        "--runs",
        "3",
        "--single-sample",
        "--backend",
        "gpu",
    ]);
    assert.equal(parsed.runs, 3);
    assert.equal(parsed.singleSample, true);
    assert.equal(parsed.backend, "sdl_gpu");
    assert.throws(
        () => parseStabilityArguments(["--runs", "1"]),
        /--runs must be an integer >= 2/,
    );
    assert.throws(
        () => parseStabilityArguments(["--runs", "many"]),
        /--runs must be an integer >= 2/,
    );
    assert.throws(
        () => parseStabilityArguments(["--recapture"]),
        /Unknown stability argument/,
    );
});

test("stability always prints the run-to-run and golden columns together", () => {
    const runs: StabilityRunComparison[] = [
        { run: 1, vsGolden: { mad: 0.037, maxDiff: 3 } },
        {
            run: 2,
            vsFirst: { mad: 0, maxDiff: 0 },
            vsGolden: { mad: 0.037, maxDiff: 3 },
        },
        {
            run: 3,
            vsFirst: { mad: 0, maxDiff: 0 },
            vsGolden: { mad: 0.037, maxDiff: 3 },
        },
    ];
    const text = formatStabilityReport("Scene 9", "dawn", false, runs);
    assert.match(
        text,
        /run 2: vs run 1 MAD=0\.000 max=0 {2}\| {2}vs golden MAD=0\.037 max=3/,
    );
    assert.match(text, /Bit-stable: every run is byte-identical to run 1/);
    // The never-vs-golden trap, said out loud: runs that agree with each
    // other while all differing from the golden are a stable-but-wrong
    // image, which comparing runs only against each other would hide.
    assert.match(text, /Stable but not golden/);
});

test("stability names wobble, and single-sample keeps the golden column as context", () => {
    const runs: StabilityRunComparison[] = [
        { run: 1, vsGolden: { mad: 0.4, maxDiff: 30 } },
        {
            run: 2,
            vsFirst: { mad: 0.0001, maxDiff: 1 },
            vsGolden: { mad: 0.4, maxDiff: 30 },
        },
    ];
    const text = formatStabilityReport("Scene 37", "dawn", true, runs);
    assert.match(text, /Wobble: 1 of 1 re-runs differ from run 1/);
    // The goldens are multisampled, so a single-sample run reads worse
    // against them by construction; the column still prints, flagged.
    assert.match(text, /Golden column is context only under --single-sample/);
    assert.match(text, /vs golden MAD=0\.400 max=30/);
});
