#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
    analyzeDifference,
    compareImages,
    compareRegion,
    generateDiffMap,
} from "./parity.js";

interface DiagnosticPair {
    name: string;
    native: string;
    babylon: string;
}

const pairs: DiagnosticPair[] = [
    {
        name: "world-normal",
        native: "artifacts/parity/normal-gpu.png",
        babylon: "artifacts/parity/lite-diagnostics/babylon-lite-world-normal.png",
    },
    {
        name: "albedo",
        native: "artifacts/parity/albedo-gpu.png",
        babylon: "artifacts/parity/lite-diagnostics/babylon-lite-albedo.png",
    },
    {
        name: "reflectivity",
        native: "artifacts/parity/reflectivity-gpu.png",
        babylon: "artifacts/parity/lite-diagnostics/babylon-lite-reflectivity.png",
    },
    {
        name: "irradiance",
        native: "artifacts/parity/irradiance-gpu.png",
        babylon: "artifacts/parity/lite-diagnostics/babylon-lite-irradiance.png",
    },
    {
        name: "normalized-depth",
        native: "artifacts/parity/normalized-depth-gpu.png",
        babylon: "artifacts/parity/lite-diagnostics/babylon-lite-normalized-depth.png",
    },
];

function background(path: string): [number, number, number] {
    const png = PNG.sync.read(readFileSync(resolve(path)));
    return [png.data[0]!, png.data[1]!, png.data[2]!];
}

function main(): void {
    const outputDirectory = resolve("artifacts/parity/lite-diagnostics/compare");
    mkdirSync(outputDirectory, { recursive: true });
    const results = pairs.map((pair) => {
        const native = resolve(pair.native);
        const babylon = resolve(pair.babylon);
        const backgroundColor = background(babylon);
        const diff = resolve(outputDirectory, `${pair.name}-diff.png`);
        generateDiffMap(native, babylon, diff);
        return {
            name: pair.name,
            backgroundColor,
            full: compareImages(native, babylon),
            foreground: compareRegion(native, babylon, backgroundColor, 1),
            breakdown: analyzeDifference(native, babylon, backgroundColor, 1),
            files: { native, babylon, diff },
        };
    });
    const output = resolve(outputDirectory, "comparison.json");
    writeFileSync(output, `${JSON.stringify({ results }, null, 2)}\n`);
    for (const result of results) {
        console.log(
            `${result.name}: full MAD=${result.full.mad.toFixed(3)}, ` +
                `foreground MAD=${result.foreground.mad.toFixed(3)}`,
        );
    }
    console.log(`Report: ${output}`);
}

main();
