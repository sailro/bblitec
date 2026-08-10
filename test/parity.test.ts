import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import {
    analyzeDifference,
    analyzeIdBuffer,
    compareImages,
    compareRegion,
    generateDiffMap,
    generateHotspotMap,
    generateIdVisualization,
} from "../src/parity.js";
import { resolveParityThresholds } from "../src/parity-scene.js";
import { getScene } from "../src/scene-registry.js";

function writePng(path: string, pixels: Array<[number, number, number, number]>): void {
    const png = new PNG({ width: pixels.length, height: 1 });
    pixels.forEach((pixel, index) => {
        png.data.set(pixel, index * 4);
    });
    writeFileSync(path, PNG.sync.write(png));
}

test("requires configured thresholds for CPU parity gates", () => {
    assert.deepEqual(
        resolveParityThresholds(getScene("boombox").parity!, false),
        {
            maxMad: 2.2,
            maxRegionMad: 21.5,
            gate: "enforced",
        },
    );
    assert.throws(
        () =>
            resolveParityThresholds(
                getScene("scene10").parity!,
                false,
            ),
        /CPU parity thresholds are not configured/,
    );
    assert.deepEqual(
        resolveParityThresholds(getScene("scene10").parity!, true),
        {
            maxMad: 0.03,
            maxRegionMad: 0.25,
            gate: "enforced",
        },
    );
    assert.deepEqual(
        resolveParityThresholds(
            {
                reference: {
                    kind: "source",
                    path: "reference.png",
                },
                actual: "actual.png",
                outputDirectory: "output",
                backgroundColor: [0, 0, 0],
                backgroundThreshold: 0,
            },
            true,
        ),
        {
            maxMad: undefined,
            maxRegionMad: undefined,
            gate: "diagnostic-only",
        },
    );
});

test("matches Babylon MAD and foreground-region semantics", () => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-parity-"));
    try {
        const reference = join(directory, "reference.png");
        const actual = join(directory, "actual.png");
        const diff = join(directory, "diff.png");
        const hotspots = join(directory, "hotspots.png");
        const ids = join(directory, "ids.png");
        const idsVisual = join(directory, "ids-visual.png");
        writePng(reference, [
            [51, 51, 77, 255],
            [10, 20, 30, 255],
        ]);
        writePng(actual, [
            [51, 51, 77, 255],
            [13, 26, 30, 255],
        ]);
        writePng(ids, [
            [0, 0, 0, 255],
            [1, 0, 0, 255],
        ]);

        assert.deepEqual(compareImages(actual, reference), {
            totalPixels: 2,
            exactMatch: 1,
            within1: 1,
            within3: 1,
            within5: 1,
            mad: 1.5,
            maxDiff: 6,
        });
        assert.deepEqual(compareRegion(actual, reference), {
            totalPixels: 2,
            regionPixels: 1,
            exactMatch: 0,
            within1: 0,
            within3: 0,
            within5: 0,
            mad: 3,
            maxDiff: 6,
        });
        const breakdown = analyzeDifference(actual, reference);
        assert.deepEqual(breakdown.channelMad, { red: 1.5, green: 3, blue: 0 });
        assert.deepEqual(breakdown.foregroundBias, { red: 3, green: 6, blue: 0 });
        assert.equal(breakdown.regions.background.mad, 0);
        assert.equal(breakdown.regions.foregroundEdge.mad, 3);
        assert.equal(breakdown.regions.foregroundInterior.pixels, 0);
        assert.equal(breakdown.hotspots.length, 1);
        const idBreakdown = analyzeIdBuffer(actual, reference, ids, breakdown.hotspots);
        assert.deepEqual(idBreakdown.draws, [
            {
                drawId: 1,
                pixels: 1,
                mad: 3,
                maxDiff: 6,
                bounds: { x: 1, y: 0, width: 1, height: 1 },
            },
        ]);
        assert.deepEqual(idBreakdown.hotspots[0]?.drawIds, [{ drawId: 1, pixels: 1 }]);
        generateIdVisualization(ids, idsVisual);
        const idVisualPng = PNG.sync.read(readFileSync(idsVisual));
        assert.deepEqual([...idVisualPng.data.slice(4, 8)], [152, 112, 192, 255]);
        generateHotspotMap(actual, breakdown.hotspots, hotspots);
        const hotspotPng = PNG.sync.read(readFileSync(hotspots));
        assert.deepEqual([...hotspotPng.data.slice(4, 8)], [255, 64, 64, 255]);

        generateDiffMap(actual, reference, diff);
        const diffPng = PNG.sync.read(readFileSync(diff));
        assert.deepEqual([...diffPng.data.slice(4, 8)], [255, 24, 180, 255]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
