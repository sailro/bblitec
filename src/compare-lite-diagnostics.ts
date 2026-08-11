#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

interface HotspotBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface ParityReport {
    dimensions?: { width: number; height: number };
    breakdown?: { hotspots?: HotspotBounds[] };
    hotspotAttribution?: unknown[];
}

const pairs: DiagnosticPair[] = [
    {
        name: "world-normal",
        native: "artifacts/parity/scene1/normal-gpu.png",
        babylon: "artifacts/parity/lite-diagnostics/babylon-lite-world-normal.png",
    },
    {
        name: "albedo",
        native: "artifacts/parity/scene1/albedo-gpu.png",
        babylon: "artifacts/parity/lite-diagnostics/babylon-lite-albedo.png",
    },
    {
        name: "reflectivity",
        native: "artifacts/parity/scene1/reflectivity-gpu.png",
        babylon: "artifacts/parity/lite-diagnostics/babylon-lite-reflectivity.png",
    },
    {
        name: "irradiance",
        native: "artifacts/parity/scene1/irradiance-gpu.png",
        babylon: "artifacts/parity/lite-diagnostics/babylon-lite-irradiance.png",
    },
    {
        name: "normalized-depth",
        native: "artifacts/parity/scene1/normalized-depth-gpu.png",
        babylon: "artifacts/parity/lite-diagnostics/babylon-lite-normalized-depth.png",
    },
];

function background(path: string): [number, number, number] {
    const png = PNG.sync.read(readFileSync(resolve(path)));
    return [png.data[0]!, png.data[1]!, png.data[2]!];
}

function compareBounds(
    actualPath: string,
    referencePath: string,
    bounds: HotspotBounds,
): { mad: number; maxDiff: number; pixels: number } {
    const actual = PNG.sync.read(readFileSync(resolve(actualPath)));
    const reference = PNG.sync.read(readFileSync(resolve(referencePath)));
    if (
        actual.width !== reference.width ||
        actual.height !== reference.height
    ) {
        throw new Error("Diagnostic dimensions differ.");
    }
    let total = 0;
    let maxDiff = 0;
    let pixels = 0;
    const maxX = Math.min(bounds.x + bounds.width, actual.width);
    const maxY = Math.min(bounds.y + bounds.height, actual.height);
    for (let y = Math.max(bounds.y, 0); y < maxY; y += 1) {
        for (let x = Math.max(bounds.x, 0); x < maxX; x += 1) {
            const offset = (y * actual.width + x) * 4;
            for (let channel = 0; channel < 3; channel += 1) {
                const difference = Math.abs(
                    actual.data[offset + channel]! -
                        reference.data[offset + channel]!,
                );
                total += difference;
                maxDiff = Math.max(maxDiff, difference);
            }
            pixels += 1;
        }
    }
    return {
        mad: pixels > 0 ? total / (pixels * 3) : 0,
        maxDiff,
        pixels,
    };
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
    const parityReportPath = resolve(
        "artifacts/parity/scene1/report-gpu.json",
    );
    const parityReport = existsSync(parityReportPath)
        ? JSON.parse(readFileSync(parityReportPath, "utf8")) as ParityReport
        : undefined;
    const hotspots = parityReport?.breakdown?.hotspots ?? [];
    const hotspotDiagnostics = hotspots.map((hotspot, index) => ({
        hotspot,
        attribution: parityReport?.hotspotAttribution?.[index],
        buffers: Object.fromEntries(
            pairs.map((pair) => [
                pair.name,
                compareBounds(pair.native, pair.babylon, hotspot),
            ]),
        ),
    }));
    const uncomparedNative = {
        baseColor: {
            path: resolve("artifacts/parity/base-color-gpu.png"),
            encoding: "linear-rgba8",
        },
        preToneHdrPreview: {
            path: resolve("artifacts/parity/pre-tone-hdr-gpu.png"),
            encoding: "clamped-rgba8-preview",
        },
        preToneHdrRaw: {
            path: resolve("artifacts/parity/pre-tone-hdr-gpu.rgba16f"),
            encoding: "little-endian-rgba16float",
            ...parityReport?.dimensions,
        },
    };
    writeFileSync(
        output,
        `${JSON.stringify(
            { results, hotspotDiagnostics, uncomparedNative },
            null,
            2,
        )}\n`,
    );
    for (const result of results) {
        console.log(
            `${result.name}: full MAD=${result.full.mad.toFixed(3)}, ` +
                `foreground MAD=${result.foreground.mad.toFixed(3)}`,
        );
    }
    console.log(`Report: ${output}`);
}

main();
