import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { compareImages, compareRegion, generateDiffMap } from "../src/parity.js";

function writePng(path: string, pixels: Array<[number, number, number, number]>): void {
    const png = new PNG({ width: pixels.length, height: 1 });
    pixels.forEach((pixel, index) => {
        png.data.set(pixel, index * 4);
    });
    writeFileSync(path, PNG.sync.write(png));
}

test("matches Babylon MAD and foreground-region semantics", () => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-parity-"));
    try {
        const reference = join(directory, "reference.png");
        const actual = join(directory, "actual.png");
        const diff = join(directory, "diff.png");
        writePng(reference, [
            [51, 51, 77, 255],
            [10, 20, 30, 255],
        ]);
        writePng(actual, [
            [51, 51, 77, 255],
            [13, 26, 30, 255],
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

        generateDiffMap(actual, reference, diff);
        const diffPng = PNG.sync.read(readFileSync(diff));
        assert.deepEqual([...diffPng.data.slice(4, 8)], [255, 24, 180, 255]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
