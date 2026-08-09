#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { captureBabylonReference } from "./capture-reference.js";
import {
    analyzeDifference,
    compareImages,
    compareRegion,
    generateDiffMap,
    generateHotspotMap,
    imageDimensions,
} from "./parity.js";

interface ParityConfig {
    name: string;
    playgroundUrl: string;
    reference: string;
    actual: string;
    outputDirectory: string;
    backgroundColor: [number, number, number];
    backgroundThreshold: number;
    thresholds: {
        maxMad: number;
        maxRegionMad: number;
        minWithin1?: number;
    };
    gpuThresholds?: {
        maxMad: number;
        maxRegionMad: number;
        minWithin1?: number;
    };
    upstreamThresholds: {
        maxMad: number;
        maxRegionMad: number;
        minWithin1: number;
    };
}

interface Arguments {
    config: string;
    executable?: string;
    actual?: string;
    recaptureReference: boolean;
    noFail: boolean;
    gpu: boolean;
}

function parseArguments(arguments_: string[]): Arguments {
    let config = "parity/boombox.json";
    let executable: string | undefined;
    let actual: string | undefined;
    let recaptureReference = false;
    let noFail = false;
    let gpu = false;
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (argument === "--config") config = arguments_[++index] ?? config;
        else if (argument === "--exe") executable = arguments_[++index];
        else if (argument === "--actual") actual = arguments_[++index];
        else if (argument === "--recapture-reference") recaptureReference = true;
        else if (argument === "--no-fail") noFail = true;
        else if (argument === "--gpu") gpu = true;
        else throw new Error(`Unknown argument '${argument}'.`);
    }
    return {
        config,
        ...(executable ? { executable } : {}),
        ...(actual ? { actual } : {}),
        recaptureReference,
        noFail,
        gpu,
    };
}

function defaultExecutable(): string {
    return process.platform === "win32"
        ? "native/build-boombox-release/bblite_native.exe"
        : "native/build-boombox-release/bblite_native";
}

function runNative(executable: string, screenshot: string, gpu: boolean): void {
    if (!existsSync(executable)) {
        throw new Error(`Native executable not found: ${executable}. Build the BoomBox Release target first.`);
    }
    mkdirSync(resolve(screenshot, ".."), { recursive: true });
    const result = spawnSync(resolve(executable), [], {
        stdio: "inherit",
        env: {
            ...process.env,
            ...(gpu
                ? { BBLITE_GPU: "1" }
                : {
                      BBLITE_GPU: "0",
                      SDL_VIDEODRIVER: "dummy",
                      SDL_RENDER_DRIVER: "software",
                  }),
            BBLITE_MAX_FRAMES: "1",
            BBLITE_SCREENSHOT: resolve(screenshot),
        },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`Native renderer exited with status ${result.status}.`);
    }
}

function percentage(count: number, total: number): number {
    return total > 0 ? count / total : 0;
}

async function main(): Promise<void> {
    const arguments_ = parseArguments(process.argv.slice(2));
    const config = JSON.parse(readFileSync(resolve(arguments_.config), "utf8")) as ParityConfig;
    const reference = resolve(config.reference);
    const outputDirectory = resolve(config.outputDirectory);
    const actual = resolve(
        arguments_.actual ??
            (arguments_.gpu ? `${config.outputDirectory}/boombox-gpu.png` : config.actual),
    );
    const thresholds = arguments_.gpu && config.gpuThresholds
        ? config.gpuThresholds
        : config.thresholds;
    const renderer = arguments_.gpu
        ? {
              mode: "gpu",
              implementation: "SDL_GPU",
              driverSelection: process.env.SDL_GPU_DRIVER ?? "auto",
          }
        : {
              mode: "cpu-fallback",
              implementation: "SDL_Renderer",
              driverSelection: process.env.SDL_RENDER_DRIVER ?? "software",
          };
    const artifactSuffix = arguments_.gpu ? "gpu" : "cpu";

    await captureBabylonReference({
        output: reference,
        url: config.playgroundUrl,
        force: arguments_.recaptureReference,
    });
    if (!arguments_.actual) {
        runNative(
            resolve(arguments_.executable ?? process.env.BBLITE_NATIVE_EXE ?? defaultExecutable()),
            actual,
            arguments_.gpu,
        );
    }

    const actualDimensions = imageDimensions(actual);
    const referenceDimensions = imageDimensions(reference);
    if (
        actualDimensions.width !== referenceDimensions.width ||
        actualDimensions.height !== referenceDimensions.height
    ) {
        throw new Error(
            `Image dimensions differ: actual ${actualDimensions.width}x${actualDimensions.height}, ` +
                `reference ${referenceDimensions.width}x${referenceDimensions.height}.`,
        );
    }

    mkdirSync(outputDirectory, { recursive: true });
    const full = compareImages(actual, reference);
    const region = compareRegion(actual, reference, config.backgroundColor, config.backgroundThreshold);
    const breakdown = analyzeDifference(
        actual,
        reference,
        config.backgroundColor,
        config.backgroundThreshold,
    );
    const diffPath = resolve(outputDirectory, `diff-map-${artifactSuffix}.png`);
    const hotspotPath = resolve(outputDirectory, `hotspots-${artifactSuffix}.png`);
    generateDiffMap(actual, reference, diffPath);
    generateHotspotMap(actual, breakdown.hotspots, hotspotPath);

    const report = {
        scene: config.name,
        renderer,
        dimensions: actualDimensions,
        full,
        region,
        breakdown,
        ratios: {
            exact: percentage(region.exactMatch, region.regionPixels),
            within1: percentage(region.within1, region.regionPixels),
            within3: percentage(region.within3, region.regionPixels),
            within5: percentage(region.within5, region.regionPixels),
        },
        thresholds,
        upstreamThresholds: config.upstreamThresholds,
        files: { actual, reference, diff: diffPath, hotspots: hotspotPath },
    };
    const reportPath = resolve(outputDirectory, `report-${artifactSuffix}.json`);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    console.log(`Renderer: ${renderer.implementation} (${renderer.mode}, ${renderer.driverSelection})`);
    console.log(`${config.name} full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, max=${full.maxDiff}`);
    console.log(
        `${config.name} region (${region.regionPixels} px): MAD=${region.mad.toFixed(3)}, ` +
            `exact=${(report.ratios.exact * 100).toFixed(2)}%, ` +
            `within1=${(report.ratios.within1 * 100).toFixed(2)}%, ` +
            `within5=${(report.ratios.within5 * 100).toFixed(2)}%`,
    );
    console.log(
        `Diff attribution: background=${breakdown.regions.background.mad.toFixed(3)}, ` +
            `edges=${breakdown.regions.foregroundEdge.mad.toFixed(3)}, ` +
            `interior=${breakdown.regions.foregroundInterior.mad.toFixed(3)}`,
    );
    console.log(`Diff: ${diffPath}`);
    console.log(`Hotspots: ${hotspotPath}`);
    console.log(`Report: ${reportPath}`);

    const failures: string[] = [];
    if (full.mad > thresholds.maxMad) {
        failures.push(`full MAD ${full.mad.toFixed(3)} > ${thresholds.maxMad}`);
    }
    if (region.mad > thresholds.maxRegionMad) {
        failures.push(`region MAD ${region.mad.toFixed(3)} > ${thresholds.maxRegionMad}`);
    }
    if (thresholds.minWithin1 !== undefined && report.ratios.within1 < thresholds.minWithin1) {
        failures.push(`within1 ${report.ratios.within1.toFixed(4)} < ${thresholds.minWithin1}`);
    }
    if (failures.length > 0) {
        const message = `Parity regression: ${failures.join(", ")}`;
        if (arguments_.noFail) console.warn(message);
        else throw new Error(message);
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
