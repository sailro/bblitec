import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    formatMemorySummary,
    parseMemoryArguments,
    parseMemoryProfile,
    summarizeMemoryProfile,
} from "../src/parity-scene.js";

const line = (frame: number, workingSet: number, records: number): string =>
    `[mem][frame] frame=${frame} working_set_mb=${workingSet.toFixed(1)} ` +
    `mesh_records=${records} scene_meshes=40 geometry_records=${records} ` +
    "live_geometries=40 geometry_mb=8.0 gpu_meshes=40 shared_geometries=12 " +
    `shared_geometry_mb=6.5 gc_nodes=${records + 10} gc_allocations=${records * 10}`;

test("parses only complete memory frame lines out of a run's stderr", () => {
    const samples = parseMemoryProfile(
        [
            "[cpu][frame] frame=0 total_ms=1.0",
            line(0, 100, 40),
            "noise",
            "[mem][frame] frame=15 mesh_records=41",
            line(16, Infinity, 41),
            line(17, -1, 41),
            line(18, 0, 41),
            line(19, 100, 41).replace(/ gc_nodes=\d+/, ""),
            line(20, 100, 41).replace(/gc_allocations=\d+/, "gc_allocations=-1"),
            line(30, 104.5, 41),
            "",
        ].join("\r\n"),
    );
    assert.deepEqual(
        samples.map((sample) => sample.frame),
        [0, 30],
    );
    assert.equal(samples[1]?.workingSetMb, 104.5);
    assert.equal(samples[1]?.meshRecords, 41);
    assert.equal(samples[1]?.gcNodes, 51);
    assert.equal(samples[1]?.gcAllocations, 410);
});

test("judges working-set growth and reports object growth after warm-up", () => {
    const samples = parseMemoryProfile(
        [line(0, 100, 40), line(1000, 130, 60), line(2000, 131, 80), line(3000, 132, 100)].join("\n"),
    );
    const summary = summarizeMemoryProfile(samples, 32);
    assert.ok(summary);
    // Warm-up ends a third of the way through the samples (frame 1000).
    assert.equal(summary.settled.frame, 1000);
    assert.equal(summary.growthMb, 2);
    assert.match(formatMemorySummary("demo", summary), /GC nodes 70 -> 110, 400 GC allocations after warm-up/);
    assert.equal(summary.passed, true);
    assert.equal(summarizeMemoryProfile(samples, 1)?.passed, false);
    // Fewer than three samples cannot separate warm-up from the run.
    assert.equal(summarizeMemoryProfile(samples.slice(0, 2), 32), undefined);
    assert.equal(summarizeMemoryProfile([], 32), undefined);
    assert.equal(summarizeMemoryProfile(samples, 32, 6000), undefined,
        "an early exit cannot pass a longer requested observation");
    assert.ok(summarizeMemoryProfile(samples, 32, 3000));
    assert.equal(summarizeMemoryProfile([...samples, samples[0]!], 32), undefined);
});

test("formats a verdict, and names an unmeasured loop instead of passing it", () => {
    const samples = parseMemoryProfile(
        [line(0, 90, 40), line(1000, 100, 40), line(3000, 150, 40)].join("\n"),
    );
    const text = formatMemorySummary("demo", summarizeMemoryProfile(samples, 32));
    assert.match(text, /^demo: FAILED \(> 32 MB\)/);
    assert.match(text, /\+50\.0 MB/);
    assert.match(text, /100\.0 -> 150\.0 MB/);
    assert.match(text, /frames 1000\.\.3000/);
    assert.match(formatMemorySummary("sprite", undefined), /unmeasured/);
});

test("scene entries exceeding engine records do not imply negative retired meshes", () => {
    const samples = parseMemoryProfile([0, 30, 60].map((frame) => line(frame, 90, 20)).join("\n"));
    const text = formatMemorySummary("shared", summarizeMemoryProfile(samples, 32));
    assert.match(text, /20 mesh records, 40 scene mesh entries/);
    assert.doesNotMatch(text, /retired/);
});

test("parses the memory command's flags, defaults and a tape file", (t) => {
    assert.deepEqual(parseMemoryArguments([]), { frames: 6000, maxGrowthMb: 32 });
    assert.deepEqual(
        parseMemoryArguments(["--frames", "12000", "--max-growth-mb", "8", "--replay", "-,-,+KeyW", "--backend", "dawn"]),
        { frames: 12000, maxGrowthMb: 8, replay: "-,-,+KeyW", backend: "dawn" },
    );
    const directory = mkdtempSync(join(tmpdir(), "bblite-memory-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const tape = join(directory, "sprint.tape");
    writeFileSync(tape, "-,-,+ShiftLeft,+KeyW\n");
    assert.equal(parseMemoryArguments(["--replay-file", tape]).replay, "-,-,+ShiftLeft,+KeyW");
    assert.throws(() => parseMemoryArguments(["--frames", "10"]), /--frames/);
    assert.throws(() => parseMemoryArguments(["--max-growth-mb", "-1"]), /--max-growth-mb/);
    assert.throws(() => parseMemoryArguments(["--replay", "-", "--replay-file", tape]), /only one/);
});
