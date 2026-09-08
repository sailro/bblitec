import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runCheck } from "../src/tooling/check-run.js";
import { getScene } from "../src/scene-registry.js";
import { measuredStampPath, runMeasured } from "../src/tooling/native-run.js";

// The check driver's report and plugin dispatch, over an offline check
// (no phases) so no native run is spent; the native gate itself refuses
// a missing executable before composing anything.

test("runs an offline check's plugins and records the verdict in its report", async () => {
    const pluginDirectory = resolve(".cache", "check-run-test");
    mkdirSync(pluginDirectory, { recursive: true });
    const passing = resolve(pluginDirectory, "passing.mjs");
    const failing = resolve(pluginDirectory, "failing.mjs");
    writeFileSync(passing, "export function check(context) { context.log('seen ' + context.options.label); return { details: { label: context.options.label } }; }\n");
    writeFileSync(failing, "import assert from 'node:assert/strict'; export function check() { assert.equal(1, 2, 'one is not two'); }\n");
    const checkId = "check-run-test";
    const outputDirectory = resolve("artifacts", "check", checkId);
    rmSync(outputDirectory, { recursive: true, force: true });
    try {
        const scene = getScene("scene1");
        const verdict = await runCheck({
            checkId,
            scene,
            spec: {
                scene: "scene1",
                phases: [],
                expect: [
                    { kind: "plugin", module: passing, options: { label: "offline" } },
                    { kind: "plugin", module: failing },
                    { kind: "viewport", phase: "*", equals: [1, 1] },
                ],
            },
            target: { output: scene.output, buildDirectory: scene.buildDirectory, executable: "missing.exe" },
        });
        assert.equal(verdict.ok, false);
        assert.deepEqual(verdict.results.map((entry) => entry.ok), [true, false, true]);
        assert.match(verdict.results[1]!.detail, /one is not two/);
        assert.match(verdict.results[2]!.detail, /skipped/);
        assert.ok(existsSync(verdict.reportPath));
        const report = JSON.parse(readFileSync(verdict.reportPath, "utf8")) as { tool: string; status: string; expectations: unknown[] };
        assert.equal(report.tool, "check");
        assert.equal(report.status, "failed");
        assert.equal(report.expectations.length, 3);
    } finally {
        rmSync(pluginDirectory, { recursive: true, force: true });
        rmSync(outputDirectory, { recursive: true, force: true });
    }
});

test("a measured run refuses a missing executable and names its stamp beside its outputs", () => {
    assert.throws(() => runMeasured(resolve(".cache", "no-such-bblite_native.exe"), { frame: 0 }), /Native executable not found/);
    assert.equal(measuredStampPath({ screenshot: "out/shot.png" }), resolve("out/shot.png.build-stamp"));
    assert.equal(measuredStampPath({ capture: "out/native.json" }), resolve("out/native.json.build-stamp"));
    assert.equal(measuredStampPath({}), undefined);
});
