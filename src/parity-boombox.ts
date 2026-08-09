#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { captureBabylonReference } from "./capture-reference.js";
import {
    analyzeDifference,
    analyzeIdBuffer,
    compareImages,
    compareRegion,
    generateDiffMap,
    generateHotspotMap,
    generateIdVisualization,
    imageDimensions,
} from "./parity.js";

interface ParityConfig {
    name: string;
    playgroundUrl: string;
    reference: string;
    actual: string;
    outputDirectory: string;
    specialization?: string;
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

interface RenderItemMetadata {
    drawId: number;
    nodeIndex: number;
    nodeName?: string;
    meshIndex: number;
    meshName?: string;
    primitiveIndex: number;
    triangleCount: number;
    trianglesPerCluster: number;
    clusterIdStart: number;
    clusterCount: number;
    materialIndex?: number;
    materialName?: string;
    alphaMode: "OPAQUE" | "MASK" | "BLEND";
    doubleSided: boolean;
}

interface GltfSpecialization {
    renderItems: RenderItemMetadata[];
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

function runNative(
    executable: string,
    screenshot: string,
    gpu: boolean,
    idBufferPath?: string,
    clusterBufferPath?: string,
    diagnosticDirectory?: string,
): void {
    if (!existsSync(executable)) {
        throw new Error(`Native executable not found: ${executable}. Build the BoomBox Release target first.`);
    }
    mkdirSync(resolve(screenshot, ".."), { recursive: true });
    const result = spawnSync(resolve(executable), [], {
        stdio: "inherit",
        env: {
            ...process.env,
            ...(gpu
                ? {
                      BBLITE_GPU: "1",
                      ...(idBufferPath ? { BBLITE_ID_BUFFER: resolve(idBufferPath) } : {}),
                      ...(clusterBufferPath
                          ? { BBLITE_CLUSTER_BUFFER: resolve(clusterBufferPath) }
                          : {}),
                      ...(diagnosticDirectory
                          ? { BBLITE_DIAGNOSTIC_DIR: resolve(diagnosticDirectory) }
                          : {}),
                  }
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
    const idBufferPath = arguments_.gpu
        ? resolve(outputDirectory, "draw-ids-gpu.png")
        : undefined;
    const idVisualizationPath = arguments_.gpu
        ? resolve(outputDirectory, "draw-ids-visual-gpu.png")
        : undefined;
    const clusterBufferPath = arguments_.gpu
        ? resolve(outputDirectory, "triangle-clusters-gpu.png")
        : undefined;
    const clusterVisualizationPath = arguments_.gpu
        ? resolve(outputDirectory, "triangle-clusters-visual-gpu.png")
        : undefined;

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
            idBufferPath,
            clusterBufferPath,
            arguments_.gpu ? outputDirectory : undefined,
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
    const idBreakdown =
        idBufferPath && existsSync(idBufferPath)
            ? analyzeIdBuffer(actual, reference, idBufferPath, breakdown.hotspots)
            : undefined;
    if (idBufferPath && idVisualizationPath && existsSync(idBufferPath)) {
        generateIdVisualization(idBufferPath, idVisualizationPath);
    }
    const specializations = config.specialization && existsSync(resolve(config.specialization))
        ? JSON.parse(readFileSync(resolve(config.specialization), "utf8")) as GltfSpecialization[]
        : [];
    const renderItems = new Map(
        specializations.flatMap((specialization) => specialization.renderItems)
            .map((item) => [item.drawId, item] as const),
    );
    const renderItemForCluster = (clusterId: number): RenderItemMetadata | undefined =>
        specializations.flatMap((specialization) => specialization.renderItems)
            .find(
                (item) =>
                    item.clusterCount > 0 &&
                    clusterId >= item.clusterIdStart &&
                    clusterId < item.clusterIdStart + item.clusterCount,
            );
    const drawAttribution = idBreakdown?.draws.map((draw) => ({
        ...draw,
        renderItem: renderItems.get(draw.drawId),
    }));
    const hotspotAttribution = idBreakdown?.hotspots.map((hotspot) => ({
        ...hotspot,
        drawIds: hotspot.drawIds.map((draw) => ({
            ...draw,
            renderItem: renderItems.get(draw.drawId),
        })),
    }));
    const clusterBreakdown =
        clusterBufferPath && existsSync(clusterBufferPath)
            ? analyzeIdBuffer(actual, reference, clusterBufferPath, breakdown.hotspots)
            : undefined;
    if (
        clusterBufferPath &&
        clusterVisualizationPath &&
        existsSync(clusterBufferPath)
    ) {
        generateIdVisualization(clusterBufferPath, clusterVisualizationPath);
    }
    const clusterAttribution = clusterBreakdown?.draws.map((cluster) => {
        const renderItem = renderItemForCluster(cluster.drawId);
        return {
            clusterId: cluster.drawId,
            clusterIndex: renderItem
                ? cluster.drawId - renderItem.clusterIdStart
                : undefined,
            triangles: renderItem
                ? {
                      start:
                          (cluster.drawId - renderItem.clusterIdStart) *
                          renderItem.trianglesPerCluster,
                      count: Math.min(
                          renderItem.trianglesPerCluster,
                          renderItem.triangleCount -
                              (cluster.drawId - renderItem.clusterIdStart) *
                                  renderItem.trianglesPerCluster,
                      ),
                  }
                : undefined,
            pixels: cluster.pixels,
            mad: cluster.mad,
            maxDiff: cluster.maxDiff,
            bounds: cluster.bounds,
            renderItem,
        };
    });
    const hotspotClusterAttribution = clusterBreakdown?.hotspots.map((hotspot) => {
        const { drawIds, ...region } = hotspot;
        return {
            ...region,
            clusterIds: drawIds.map(({ drawId, pixels }) => ({
                clusterId: drawId,
                pixels,
                renderItem: renderItemForCluster(drawId),
            })),
        };
    });
    const diagnosticFiles = arguments_.gpu
        ? Object.fromEntries(
              [
                  ["normal", "normal-gpu.png"],
                  ["material", "material-gpu.png"],
                  ["directLight", "direct-light-gpu.png"],
                  ["ibl", "ibl-gpu.png"],
                  ["depth", "depth-gpu.png"],
              ]
                  .map(([key, file]) => [key, resolve(outputDirectory, file!)] as const)
                  .filter(([, path]) => existsSync(path)),
          )
        : {};
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
        ...(drawAttribution ? { drawAttribution } : {}),
        ...(hotspotAttribution ? { hotspotAttribution } : {}),
        ...(clusterAttribution ? { clusterAttribution } : {}),
        ...(hotspotClusterAttribution ? { hotspotClusterAttribution } : {}),
        ratios: {
            exact: percentage(region.exactMatch, region.regionPixels),
            within1: percentage(region.within1, region.regionPixels),
            within3: percentage(region.within3, region.regionPixels),
            within5: percentage(region.within5, region.regionPixels),
        },
        thresholds,
        upstreamThresholds: config.upstreamThresholds,
        files: {
            actual,
            reference,
            diff: diffPath,
            hotspots: hotspotPath,
            ...(idBufferPath && existsSync(idBufferPath) ? { drawIds: idBufferPath } : {}),
            ...(idVisualizationPath && existsSync(idVisualizationPath)
                ? { drawIdsVisual: idVisualizationPath }
                : {}),
            ...(clusterBufferPath && existsSync(clusterBufferPath)
                ? { triangleClusters: clusterBufferPath }
                : {}),
            ...(clusterVisualizationPath && existsSync(clusterVisualizationPath)
                ? { triangleClustersVisual: clusterVisualizationPath }
                : {}),
            ...diagnosticFiles,
        },
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
    if (drawAttribution?.length) {
        const worst = drawAttribution[0]!;
        const label =
            worst.renderItem?.materialName ??
            worst.renderItem?.meshName ??
            worst.renderItem?.nodeName ??
            `draw ${worst.drawId}`;
        console.log(
            `Worst draw: ${label} (id=${worst.drawId}, MAD=${worst.mad.toFixed(3)}, ` +
                `pixels=${worst.pixels})`,
        );
    }
    if (clusterAttribution?.length) {
        const worst = clusterAttribution[0]!;
        console.log(
            `Worst triangle cluster: id=${worst.clusterId}, ` +
                `triangles=${worst.triangles?.start ?? "?"}..` +
                `${
                    worst.triangles
                        ? worst.triangles.start + worst.triangles.count - 1
                        : "?"
                }, MAD=${worst.mad.toFixed(3)}`,
        );
    }
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
