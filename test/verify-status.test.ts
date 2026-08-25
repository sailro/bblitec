import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    outOfOrderRows,
    parsePublishedRows,
    severityColor,
} from "../src/verify-status.js";

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

test("bands the severity colour the way the table documents it", () => {
    assert.equal(severityColor(0), "#1a7f37");
    assert.equal(severityColor(0.499), "#1a7f37");
    assert.equal(severityColor(0.5), "#9a6700");
    assert.equal(severityColor(0.999), "#9a6700");
    assert.equal(severityColor(1), "#cf222e");
    assert.equal(severityColor(1.457), "#cf222e");
});
