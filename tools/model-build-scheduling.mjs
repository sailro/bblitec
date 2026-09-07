// Read-only list-scheduling model. Run `npm run build` before invoking it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scenes } from "../dist/src/scene-registry.js";
import { ninjaBuildCostMs, orderByHistoricalCost } from "../dist/src/build-scheduling.js";
import { readCacheConfiguration } from "../dist/src/build-stamp.js";

const [workspace, workersText, ...rest] = process.argv.slice(2);
if (!workspace || !workersText || rest.length || !/^[1-9]\d*$/.test(workersText)) {
    throw new Error("Usage: node tools/model-build-scheduling.mjs <workspace> <concurrent-scenes>");
}
const workers = Number(workersText);
if (!Number.isSafeInteger(workers)) throw new Error("Concurrent scenes must be a positive safe integer.");
const root = resolve(workspace);
const started = performance.now();
const measurements = scenes.map((scene) => {
    const directory = join(root, scene.buildDirectory);
    if (readCacheConfiguration(directory)?.CMAKE_GENERATOR !== "Ninja") {
        throw new Error(`${scene.id}: the model requires a Ninja history for every selected scene.`);
    }
    const contents = readFileSync(join(directory, ".ninja_log"), "utf8");
    const costMs = ninjaBuildCostMs(contents);
    if (costMs === undefined) throw new Error(`${scene.id}: missing or invalid Ninja timing samples.`);
    // Remove each output's newest row to rank by older retained samples.
    // These are individual command observations, not whole previous runs.
    const lines = contents.trimEnd().split(/\r?\n/);
    const header = lines.shift();
    const last = new Map(lines.map((line, index) => [line.split("\t")[3], index]));
    const older = lines.filter((line, index) => last.get(line.split("\t")[3]) !== index);
    const olderCostMs = ninjaBuildCostMs(`${header}\n${older.join("\n")}\n`);
    return { id: scene.id, costMs, olderCostMs, logBytes: Buffer.byteLength(contents),
        logSha256: createHash("sha256").update(contents).digest("hex") };
});
const readHistoryMs = performance.now() - started;

function model(queue) {
    const slots = Array(Math.min(workers, queue.length)).fill(0);
    const jobs = queue.map(({ id, costMs }) => {
        const startMs = Math.min(...slots);
        const slot = slots.indexOf(startMs);
        const endMs = startMs + costMs;
        slots[slot] = endMs;
        return { id, slot, startMs, endMs };
    });
    return { makespanMs: Math.max(0, ...slots), jobs };
}

console.log(JSON.stringify({
    kind: "historical-command-cost-model", workspace: root, workers,
    assumptions: "One job per scene; command durations stay fixed when launch order changes. Includes retained commands that may be clean next time; excludes configure/process overhead.",
    sceneCount: measurements.length,
    logBytes: measurements.reduce((sum, row) => sum + row.logBytes, 0), readHistoryMs,
    olderSampleCount: measurements.filter((row) => row.olderCostMs !== undefined).length,
    registry: model(measurements),
    historical: model(orderByHistoricalCost(measurements, (row) => row.costMs)),
    olderHistorical: model(orderByHistoricalCost(measurements, (row) => row.olderCostMs)),
    measurements,
}, null, 2));
