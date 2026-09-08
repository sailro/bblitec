import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    canvasProblems,
    coverageMatches,
    coverageProblems,
    outOfOrderRows,
    parseCanvasCell,
    parsePublishedRows,
    severityColor,
    verifyStatus,
} from "../src/verify-status.js";
import { scenes } from "../src/scene-registry.js";

const table = [
    "| Scene | Preview | SDL_GPU | Dawn | Coverage |",
    "| ---: | :-: | :-: | :-: | --- |",
    '| 33 | <img src="images/scenes/scene33.png" alt="Scene 33 rendering" width="160"> | $\\color{#1a7f37}{\\textsf{0.061}} / \\color{#cf222e}{\\textsf{1.457}}$ | 0.005 / 0.123 | punctual lights |',
    '| runtime-sweep | <img src="images/scenes/regression-runtime-sweep.png" alt="Runtime sweep rendering" width="160"> | 0.000 / 0.001 | 0.000 / 0.001 | thin-instance pools |',
    "| not a scene row | no image | no numbers | | |",
].join("\n");

test("reads each published row through its preview image id", () => {
    const rows = parsePublishedRows(table);
    assert.equal(rows.length, 2);

    // The label column is a scene number for corpus scenes and a short
    // name for the project-owned gates, so the id comes from the preview
    // path instead -- `glTF-track-clamp` labels `regression-track-clamp`.
    assert.deepEqual(
        rows.map((row) => row.sceneId),
        ["scene33", "regression-runtime-sweep"],
    );
    assert.deepEqual(rows[0]?.values, [
        "0.061",
        "1.457",
        "0.005",
        "0.123",
    ]);
    assert.deepEqual(rows[0]?.colors, [
        "#1a7f37",
        "#cf222e",
        "#1a7f37",
        "#1a7f37",
    ]);
    assert.equal(rows[0]?.line, 3);
});

const orderedRow = (id: number): string =>
    `| ${id} | <img src="images/scenes/scene${id}.png" alt="Scene ${id} rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | coverage |`;

test("names a row published out of scene order", () => {
    const problems = outOfOrderRows(
        parsePublishedRows(
            [orderedRow(10), orderedRow(98), orderedRow(11)].join("\n"),
        ),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /:3 scene 11 is published after scene 98/);
});

test("names a scene published twice", () => {
    const problems = outOfOrderRows(
        parsePublishedRows([orderedRow(10), orderedRow(10)].join("\n")),
    );
    assert.deepEqual(problems, [
        "docs/status.md:2 scene 10 is published twice.",
    ]);
});

test("leaves the named project-owned gates in their own order", () => {
    const gate = (name: string): string =>
        `| ${name} | <img src="images/scenes/regression-${name}.png" alt="${name}" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | gate |`;
    assert.deepEqual(
        outOfOrderRows(
            parsePublishedRows(
                [
                    orderedRow(301),
                    gate("runtime-sweep"),
                    gate("instanced-ground"),
                ].join("\n"),
            ),
        ),
        [],
    );
});

test("the published table is in scene order", () => {
    // The gate itself: a row hand-inserted in the wrong place fails here
    // rather than surviving into the published table.
    assert.deepEqual(
        outOfOrderRows(
            parsePublishedRows(readFileSync("docs/status.md", "utf8")),
        ),
        [],
    );
});

test("publishes every registered parity gate exactly once", () => {
    const rows = parsePublishedRows(readFileSync("docs/status.md", "utf8"));
    assert.deepEqual(
        rows.map(({ sceneId }) => sceneId).sort(),
        scenes
            .filter(({ parity }) => parity !== undefined)
            .map(({ id }) => id)
            .sort(),
    );
});

test("bands the severity colour the way the table documents it", () => {
    assert.equal(severityColor(0), "#1a7f37");
    assert.equal(severityColor(0.499), "#1a7f37");
    assert.equal(severityColor(0.5), "#9a6700");
    assert.equal(severityColor(0.999), "#9a6700");
    assert.equal(severityColor(1), "#cf222e");
    assert.equal(severityColor(1.457), "#cf222e");
});

test("reads the canvas-only pair a coverage cell publishes, in both forms", () => {
    assert.deepEqual(parseCanvasCell("UI residual; canvas-only MAD: SDL_GPU 0.002 / 0.003, Dawn 0.001 / 0.002."), {
        sdl_gpu: ["0.002", "0.003"],
        dawn: ["0.001", "0.002"],
    });
    assert.deepEqual(parseCanvasCell("canvas-only MAD: 0.000 / 0.002 on both backends."), {
        sdl_gpu: ["0.000", "0.002"],
        dawn: ["0.000", "0.002"],
    });
    assert.equal(parseCanvasCell("BoomBox PBR"), undefined);
});

test("a numbered row's coverage cell carries the registry name, commentary after ; or .", () => {
    assert.ok(coverageMatches("BoomBox PBR", "Scene 1 - BoomBox PBR"));
    assert.ok(coverageMatches("Physics Raycast Instance Picking; exact captureFrame=5 pose.", "Scene 103 - Physics Raycast Instance Picking"));
    assert.ok(coverageMatches("Geospatial Camera. Renders its pose.", "Scene 225 - Geospatial Camera"));
    assert.ok(!coverageMatches("SMAA", "Scene 187 - Subpixel Morphological Anti-Aliasing"));
    assert.ok(!coverageMatches("BoomBox PBR Extended", "Scene 1 - BoomBox PBR"));
    const problems = coverageProblems(
        parsePublishedRows(
            [
                '| 1 | <img src="images/scenes/scene1.png" alt="Scene 1" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | BoomBox PBR |',
                '| 2 | <img src="images/scenes/scene2.png" alt="Scene 2" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Something else |',
                '| app | <img src="images/scenes/tetris.png" alt="Tetris" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | A description by design |',
            ].join("\n"),
        ),
        "status.md",
        new Map([["scene1", "Scene 1 - BoomBox PBR"], ["scene2", "Scene 2 - Directional Light Sphere"], ["tetris", "Tetris"]]),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /status\.md:2 scene2 coverage: published 'Something else', registry name 'Directional Light Sphere'/);
});

test("checks the published canvas-only pair against the canvas lane's report", () => {
    const root = mkdtempSync(join(tmpdir(), "bblite-canvas-"));
    try {
        const rows = parsePublishedRows(
            '| app | <img src="images/scenes/tetris.png" alt="Tetris" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | UI residual; canvas-only MAD: SDL_GPU 0.002 / 0.003, Dawn 0.001 / 0.002. |',
        );
        assert.match(canvasProblems(rows, root, "status.md")[0]!, /tetris canvas-only: no canvas report/);
        mkdirSync(join(root, "tetris"), { recursive: true });
        writeFileSync(join(root, "tetris", "report-canvas.json"), JSON.stringify({
            tool: "parity-canvas", writtenAt: "now",
            backends: { sdl_gpu: { fullMad: 0.0021, foregroundMad: 0.003 }, dawn: { fullMad: 0.0014, foregroundMad: 0.0025 } },
        }));
        const problems = canvasProblems(rows, root, "status.md");
        assert.deepEqual(problems, ["status.md:1 tetris canvas-only Dawn: published 0.001 / 0.002, measured 0.001 / 0.003"]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("verifyStatus returns the wobble-exempt cells with their newest values instead of comparing them", () => {
    const root = mkdtempSync(join(tmpdir(), "bblite-status-"));
    try {
        const statusPath = join(root, "status.md");
        writeFileSync(statusPath, [
            '| 3 | <img src="images/scenes/scene3.png" alt="Scene 3" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Fog Boxes |',
            '| 126 | <img src="images/scenes/scene126.png" alt="Scene 126" width="160"> | 0.000 / 0.001 | 0.002 / 0.005 | Gaussian Splat Shader Plugin |',
        ].join("\n"));
        const parityRoot = join(root, "parity");
        for (const [id, values] of [["scene126", [0.0004, 0.0012, 0.0016, 0.0012]], ["scene3", [0, 0, 0, 0.0007]]] as const) {
            mkdirSync(join(parityRoot, id), { recursive: true });
            writeFileSync(join(parityRoot, id, "report-differential.json"), JSON.stringify({
                goldenVersusSdlGpu: { fullMad: values[0], foregroundMad: values[1] },
                goldenVersusDawn: { fullMad: values[2], foregroundMad: values[3] },
                sdlGpuVersusDawn: { mad: 0 },
            }));
        }
        const { problems, exempt } = verifyStatus({ statusPath, parityRoot, canvasRoot: join(root, "canvas") });
        // Scene 126 wobbles on both backends: its four cells are reported, not compared.
        assert.equal(exempt.length, 4);
        assert.match(exempt[3]!, /scene126 Dawn foreground: wobble-exempt, published 0.005, newest 0.001 \(differs\)/);
        // Scene 3 is compared, and its Dawn foreground moved.
        assert.deepEqual(problems, [`${statusPath}:1 scene3 Dawn foreground: published 0.000, measured 0.001`]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
