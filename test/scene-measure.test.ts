import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import {
    formatPngMeasurement,
    measurePng,
    parseRgbTriple,
} from "../src/parity-scene.js";

// `scene -- measure <png>`: the measure-the-PNG rule as a command. The
// bar is the recipe it institutionalizes — "exactly 7200 px at
// (640,180)-(719,269)" — so every assertion here is exact.

function writePng(
    path: string,
    width: number,
    height: number,
    pixel: (x: number, y: number) => [number, number, number],
): void {
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const [red, green, blue] = pixel(x, y);
            const index = (y * width + x) * 4;
            png.data[index] = red;
            png.data[index + 1] = green;
            png.data[index + 2] = blue;
            png.data[index + 3] = 255;
        }
    }
    writeFileSync(path, PNG.sync.write(png));
}

test("measures the non-background box, count and means from the top-left pixel", () => {
    const root = mkdtempSync(join(tmpdir(), "measure-"));
    try {
        const path = join(root, "scene.png");
        writePng(path, 20, 10, (x, y) =>
            x >= 5 && x <= 8 && y >= 2 && y <= 4
                ? [200, 100, 50]
                : [10, 20, 30],
        );
        const measured = measurePng(path);
        assert.equal(measured.backgroundSource, "top-left");
        assert.deepEqual(measured.background, [10, 20, 30]);
        assert.equal(measured.pixels, 12);
        assert.deepEqual(measured.bounds, {
            minX: 5,
            minY: 2,
            maxX: 8,
            maxY: 4,
        });
        assert.deepEqual(measured.mean, { red: 200, green: 100, blue: 50 });
        const text = formatPngMeasurement(path, measured);
        assert.match(
            text,
            /12 non-background px in \(5,2\)-\(8,4\) \(4x3 box\)/,
        );
        assert.match(
            text,
            /mean RGB over those pixels: 200\.00, 100\.00, 50\.00/,
        );
        assert.match(text, /background 10,20,30 \(top-left pixel\)/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("an explicit background overrides the top-left pixel", () => {
    const root = mkdtempSync(join(tmpdir(), "measure-"));
    try {
        // Content reaches the top-left corner, so the default would call
        // the whole render "background"; the flag names the real one.
        const path = join(root, "full.png");
        writePng(path, 6, 6, (x, y) =>
            x === 5 && y === 5 ? [1, 2, 3] : [200, 100, 50],
        );
        const measured = measurePng(path, [200, 100, 50]);
        assert.equal(measured.backgroundSource, "explicit");
        assert.equal(measured.pixels, 1);
        assert.deepEqual(measured.bounds, {
            minX: 5,
            minY: 5,
            maxX: 5,
            maxY: 5,
        });
        assert.deepEqual(measured.mean, { red: 1, green: 2, blue: 3 });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a uniform image reports zero content and says so", () => {
    const root = mkdtempSync(join(tmpdir(), "measure-"));
    try {
        const path = join(root, "flat.png");
        writePng(path, 4, 4, () => [7, 7, 7]);
        const measured = measurePng(path);
        assert.equal(measured.pixels, 0);
        assert.equal(measured.bounds, undefined);
        assert.equal(measured.mean, undefined);
        assert.match(
            formatPngMeasurement(path, measured),
            /Every pixel is the background color\./,
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("parseRgbTriple accepts r,g,b and rejects anything else loudly", () => {
    assert.deepEqual(
        parseRgbTriple("51,51,77", "--background", "measure"),
        [51, 51, 77],
    );
    assert.deepEqual(
        parseRgbTriple(" 0, 128, 255 ", "--background", "measure"),
        [0, 128, 255],
    );
    for (const bad of [
        "",
        "1,2",
        "1,2,3,4",
        "a,b,c",
        "256,0,0",
        "-1,0,0",
        "1.5,2,3",
    ]) {
        assert.throws(
            () => parseRgbTriple(bad, "--background", "measure"),
            /--background must be three 0-255 integers/,
        );
    }
});
