import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    formatMemorySummary,
    parseMemoryArguments,
    parseMemoryProfile,
    summarizeMemoryProfile,
} from "../src/parity-scene.js";
import { readMemoryTape } from "../src/tooling/check-spec.js";
import { applicationScenes } from "../src/scene-registry.js";

interface Line {
    frame: number;
    workingSet?: number;
    meshRecords?: number;
    sceneMeshes?: number;
    transformNodeRecords?: number;
    geometryRecords?: number;
    liveGeometries?: number;
    gcNodes?: number;
    gcAllocations?: number;
}

const line = (sample: Line): string =>
    `[mem][frame] frame=${sample.frame} working_set_mb=${(sample.workingSet ?? 100).toFixed(1)} ` +
    `mesh_records=${sample.meshRecords ?? 40} scene_meshes=${sample.sceneMeshes ?? 40} ` +
    `transform_node_records=${sample.transformNodeRecords ?? 3} ` +
    `gc_nodes=${sample.gcNodes ?? 500} gc_allocations=${sample.gcAllocations ?? 1000} ` +
    `geometry_records=${sample.geometryRecords ?? 40} live_geometries=${sample.liveGeometries ?? 40} ` +
    "geometry_mb=8.0 gpu_meshes=40 shared_geometries=12 shared_geometry_mb=6.5";

/** Twelve samples every 30 frames: warm-up ends at frame 120. */
const run = (sample: (index: number) => Omit<Line, "frame">): string =>
    Array.from({ length: 12 }, (_, index) =>
        line({ frame: index * 30, ...sample(index) }),
    ).join("\n");

test("parses only complete memory frame lines out of a run's stderr", () => {
    const samples = parseMemoryProfile(
        [
            "[cpu][frame] frame=0 total_ms=1.0",
            line({ frame: 0 }),
            "noise",
            "[mem][frame] frame=15 mesh_records=41",
            line({ frame: 16, workingSet: Infinity }),
            line({ frame: 17, workingSet: -1 }),
            line({ frame: 18, workingSet: 0 }),
            line({ frame: 19 }).replace(/ gc_nodes=\d+/, ""),
            line({ frame: 20 }).replace(/ live_geometries=\d+/, ""),
            line({ frame: 21 }).replace(
                /gc_allocations=\d+/,
                "gc_allocations=-1",
            ),
            line({ frame: 22, meshRecords: 1.5 }),
            line({
                frame: 30,
                workingSet: 104.5,
                meshRecords: 41,
                geometryRecords: 43,
                liveGeometries: 39,
                gcNodes: 51,
                gcAllocations: 410,
            }),
            "",
        ].join("\r\n"),
    );
    assert.deepEqual(
        samples.map((sample) => sample.frame),
        [0, 30],
    );
    assert.deepEqual(samples[1], {
        frame: 30,
        workingSetMb: 104.5,
        meshRecords: 41,
        sceneMeshes: 40,
        transformNodeRecords: 3,
        geometryRecords: 43,
        liveGeometries: 39,
        geometryMb: 8,
        gcNodes: 51,
        gcAllocations: 410,
    });
});

test("passes a settled run and reports its trend after warm-up", () => {
    const samples = parseMemoryProfile(
        run((index) => ({
            // A sawtooth: working set and GC nodes rise between
            // collections and fall back, and a retired mesh is rebuilt.
            workingSet: 100 + (index % 2),
            gcNodes: 500 + (index % 3) * 40,
            meshRecords: 40 + (index % 2),
            gcAllocations: index * 100,
        })),
    );
    const summary = summarizeMemoryProfile(samples, 2, 330);
    assert.ok(summary);
    // Warm-up ends a third of the way through the samples (frame 120).
    assert.equal(summary.settled.frame, 120);
    assert.equal(summary.last.frame, 330);
    assert.deepEqual(summary.failures, []);
    assert.equal(summary.passed, true);
    assert.ok(Math.abs(summary.slopeMbPer1000Frames) < 2);
    const text = formatMemorySummary("demo", summary);
    assert.match(text, /^demo: ok -- working set/);
    assert.match(text, /trend [+-]\d+\.\d{2} MB per 1,000 frames/);
    assert.match(text, /41 mesh records for 40 scene mesh entries/);
    assert.match(text, /40 geometry records for 40 live/);
    assert.match(text, /700 GC allocations after warm-up/);
});

test("fails a working set that trends upward past the slope", () => {
    // +1 MB every 30 frames: 33 MB per 1,000 frames.
    const samples = parseMemoryProfile(
        run((index) => ({ workingSet: 100 + index })),
    );
    const summary = summarizeMemoryProfile(samples, 2);
    assert.ok(summary);
    assert.equal(summary.passed, false);
    assert.match(
        formatMemorySummary("demo", summary),
        /FAILED: working set trends \+33\.33 MB per 1,000 frames \(> 2\)/,
    );
    assert.equal(summarizeMemoryProfile(samples, 40)?.passed, true);
});

test("fails retired mesh and geometry records that pile up while the working set holds", () => {
    // The GC-1 shape: the scene keeps 40 meshes while every rebuild
    // appends a record, and the working set barely moves.
    const samples = parseMemoryProfile(
        run((index) => ({
            meshRecords: 40 + index * 25,
            geometryRecords: 40 + index * 25,
        })),
    );
    const summary = summarizeMemoryProfile(samples, 2);
    assert.ok(summary);
    assert.equal(summary.passed, false);
    const text = formatMemorySummary("doom", summary);
    assert.match(
        text,
        /FAILED: mesh records the scene no longer draws pile up: 100 -> 275 \(floors 100 \/ 150 \/ 250\)/,
    );
    assert.match(text, /FAILED: geometry records without vertices pile up/);
    // A scene that grows its own mesh list keeps the surplus level.
    const growing = parseMemoryProfile(
        run((index) => ({
            meshRecords: 40 + index * 5,
            sceneMeshes: 40 + index * 5,
        })),
    );
    assert.equal(summarizeMemoryProfile(growing, 2)?.passed, true);
    // The line counts occupied records: a program that retires what it
    // stops drawing holds as many as it draws, however its count moves.
    const pooled = parseMemoryProfile(
        run((index) => {
            const drawn = index % 3 === 0 ? 44 : 40;
            return {
                meshRecords: drawn,
                sceneMeshes: drawn,
                geometryRecords: drawn,
                liveGeometries: drawn,
            };
        }),
    );
    assert.equal(summarizeMemoryProfile(pooled, 2)?.passed, true);
    // A leak that refills retired slots keeps the table's size level, but
    // its occupied records still outgrow what the scene draws.
    const refilling = parseMemoryProfile(
        run((index) => ({
            meshRecords: 44 + index * 3,
            sceneMeshes: index === 5 ? 44 : 40,
        })),
    );
    assert.match(
        formatMemorySummary("demo", summarizeMemoryProfile(refilling, 2)),
        /FAILED: mesh records the scene no longer draws pile up/,
    );
});

test("fails GC nodes that rise steadily, not a collection sawtooth", () => {
    const rising = parseMemoryProfile(
        run((index) => ({ gcNodes: 10_000 + index * 200 })),
    );
    assert.match(
        formatMemorySummary("demo", summarizeMemoryProfile(rising, 2)),
        /FAILED: GC nodes rise steadily: floors/,
    );
    // Below the minimum rise the floors may creep without failing.
    const creeping = parseMemoryProfile(
        run((index) => ({ gcNodes: 10_000 + index * 5 })),
    );
    assert.equal(summarizeMemoryProfile(creeping, 2)?.passed, true);
});

test("names an unmeasured loop instead of passing it", () => {
    const samples = parseMemoryProfile(run(() => ({})));
    // Too few post-warm-up samples to split into thirds.
    assert.equal(summarizeMemoryProfile(samples.slice(0, 6), 2), undefined);
    assert.equal(summarizeMemoryProfile([], 2), undefined);
    assert.equal(
        summarizeMemoryProfile(samples, 2, 6000),
        undefined,
        "an early exit cannot pass a longer requested observation",
    );
    assert.equal(
        summarizeMemoryProfile([...samples, samples[0]!], 2),
        undefined,
    );
    assert.match(formatMemorySummary("sprite", undefined), /unmeasured/);
});

test("parses the memory command's flags, defaults and a tape file", (t) => {
    assert.deepEqual(parseMemoryArguments([]), {
        frames: 6000,
        maxSlopeMb: 2,
    });
    assert.deepEqual(
        parseMemoryArguments([
            "--frames",
            "12000",
            "--max-slope-mb",
            "0.5",
            "--replay",
            "-,-,+KeyW",
            "--backend",
            "dawn",
        ]),
        {
            frames: 12000,
            maxSlopeMb: 0.5,
            replay: "-,-,+KeyW",
            backend: "dawn",
        },
    );
    const directory = mkdtempSync(join(tmpdir(), "bblite-memory-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const tape = join(directory, "sprint.tape");
    writeFileSync(tape, "-,-,+ShiftLeft,+KeyW\n");
    assert.equal(
        parseMemoryArguments(["--replay-file", tape]).replay,
        "-,-,+ShiftLeft,+KeyW",
    );
    assert.throws(() => parseMemoryArguments(["--frames", "10"]), /--frames/);
    assert.throws(
        () => parseMemoryArguments(["--max-slope-mb", "-1"]),
        /--max-slope-mb/,
    );
    assert.throws(
        () => parseMemoryArguments(["--max-growth-mb", "8"]),
        /Unknown memory argument '--max-growth-mb'/,
    );
    assert.throws(
        () => parseMemoryArguments(["--replay", "-", "--replay-file", tape]),
        /only one/,
    );
});

test("every default memory tape belongs to an application demo and fills a run", () => {
    const applications = new Set(applicationScenes.map((scene) => scene.id));
    const tapes = readdirSync(join("checks", "memory"))
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length));
    assert.ok(tapes.includes("doom"), "doom plays a tape");
    for (const id of tapes) {
        assert.ok(applications.has(id), `${id} is an application demo`);
        const tape = readMemoryTape(id, 6000);
        assert.ok(tape, id);
        assert.equal(tape.path, `checks/memory/${id}.json`);
        assert.equal(tape.tape.length, 6000);
        assert.ok(
            tape.tape.some((entry) => entry !== "-"),
            `${id} plays input`,
        );
    }
    assert.equal(readMemoryTape("scene1", 6000), undefined);
});
