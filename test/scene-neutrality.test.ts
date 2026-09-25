import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { getScene } from "../src/scene-registry.js";

const moduleUrl = new URL("../src/scene-neutrality.js", import.meta.url).href;
const report = { goldenVersusDawn: { full: { mad: 0, max: 0 } } };

for (const fixture of [
    {
        name: "live timing text",
        expected: 0,
        message: /GPU timing total: 1\/602 pixel\(s\) changed/,
    },
    {
        name: "stable pixel movement despite unchanged report cells",
        stable: true,
        sameReport: true,
        expected: 1,
        message: /1 stable pixel\(s\) changed/,
    },
    {
        name: "a missing measurement alongside timing text",
        missingCell: true,
        expected: 1,
        message: /measurement missing/,
    },
    {
        name: "a changed report with identical captures",
        noPixelChange: true,
        expected: 1,
        message: /fullMad: 0 -> 1/,
    },
    {
        name: "missing capture evidence",
        missingImage: true,
        expected: 1,
        message: /ENOENT/,
    },
    {
        name: "unexpected capture dimensions",
        wrongDimensions: true,
        expected: 1,
        message: /requires 1280x720/,
    },
]) {
    test(`Ocean neutrality handles ${fixture.name}`, (t) => {
        const root = mkdtempSync(join(tmpdir(), "bblite-ocean-neutrality-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const partition = getScene("ocean").parity!.neutralityPartition!;
        for (const directory of ["baseline", "artifacts/parity"]) {
            const current = directory !== "baseline";
            const output = join(root, directory, "ocean");
            mkdirSync(output, { recursive: true });
            writeFileSync(
                join(output, "report-differential.json"),
                JSON.stringify({
                    goldenVersusDawn: {
                        fullMad: current && !fixture.sameReport ? 1 : 0,
                        ...(current && fixture.missingCell
                            ? {}
                            : { foregroundMad: 0 }),
                    },
                }),
            );
            for (const backend of ["gpu", "dawn"]) {
                if (current && backend === "dawn" && fixture.missingImage)
                    continue;
                const width =
                    partition.width -
                    (current && fixture.wrongDimensions ? 1 : 0);
                const png = new PNG({ width, height: partition.height });
                png.data.fill(255);
                if (current && backend === "dawn" && !fixture.noPixelChange) {
                    const region = partition.regions.find(
                        (region) => region.name === "GPU timing total",
                    )!;
                    png.data[(region.y * width + region.x) * 4] = 0;
                    if (fixture.stable) png.data[0] = 0;
                }
                writeFileSync(
                    join(output, `native-${backend}.png`),
                    PNG.sync.write(png),
                );
            }
        }
        const result = spawnSync(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                `import { runNeutralityReport } from ${JSON.stringify(moduleUrl)}; process.exitCode = runNeutralityReport("baseline").neutral ? 0 : 1;`,
            ],
            { cwd: root, encoding: "utf8" },
        );
        assert.equal(
            result.status,
            fixture.expected,
            result.stdout + result.stderr,
        );
        assert.match(result.stdout + result.stderr, fixture.message);
        if (fixture.expected !== 0)
            assert.doesNotMatch(result.stdout, /Neutral:/);
    });
}

for (const fixture of [
    {
        name: "complete reports",
        before: report,
        after: report,
        status: 0,
        message: /Neutral:/,
    },
    {
        name: "missing current scene",
        before: report,
        status: 1,
        message: /not measured now: scene9/,
    },
    {
        name: "malformed current report",
        before: report,
        after: "{",
        status: 1,
        message: /Cannot compare/,
    },
    {
        name: "malformed baseline report",
        before: "{",
        after: report,
        status: 1,
        message: /Cannot compare/,
    },
    {
        name: "empty measurements",
        before: report,
        after: {},
        status: 1,
        message: /no numeric measurements/,
    },
    {
        name: "non-object report",
        before: report,
        after: "null",
        status: 1,
        message: /Expected a report object/,
    },
    {
        name: "non-finite measurement",
        before: report,
        after: '{"mad":1e999}',
        status: 1,
        message: /Non-finite measurement/,
    },
    {
        name: "removed measurement in a wobbling scene",
        before: report,
        after: { goldenVersusDawn: { full: { mad: 0 } } },
        status: 1,
        message: /max: measurement missing/,
    },
    {
        name: "new measurement",
        before: { mad: 0 },
        after: { mad: 0, max: 0 },
        status: 1,
        message: /max: measurement added/,
    },
    {
        name: "known value variation",
        before: report,
        after: { goldenVersusDawn: { full: { mad: 1, max: 1 } } },
        status: 0,
        message: /known wobble/,
    },
    {
        name: "unexcused value movement",
        before: { goldenVersusSdlGpu: { mad: 0 } },
        after: { goldenVersusSdlGpu: { mad: 1 } },
        status: 1,
        message: /mad: 0 -> 1/,
    },
]) {
    test(`neutrality handles ${fixture.name}`, (t) => {
        const root = mkdtempSync(join(tmpdir(), "bblite-neutrality-"));
        t.after(() => rmSync(root, { recursive: true, force: true }));
        const writeReport = (directory: string, value: unknown): void => {
            const path = join(
                root,
                directory,
                "scene9",
                "report-differential.json",
            );
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(
                path,
                typeof value === "string" ? value : JSON.stringify(value),
            );
        };
        writeReport("baseline", fixture.before);
        if (fixture.after !== undefined)
            writeReport("artifacts/parity", fixture.after);
        const result = spawnSync(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                // The library returns the verdict; the entry point owns the exit code.
                `import { runNeutralityReport } from ${JSON.stringify(moduleUrl)}; process.exitCode = runNeutralityReport("baseline").neutral ? 0 : 1;`,
            ],
            { cwd: root, encoding: "utf8" },
        );
        assert.equal(
            result.status,
            fixture.status,
            result.stdout + result.stderr,
        );
        assert.match(result.stdout + result.stderr, fixture.message);
        if (fixture.status !== 0)
            assert.doesNotMatch(result.stdout, /Neutral:/);
    });
}
