#!/usr/bin/env node

import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { captureSuiteReference } from "./capture-suite-reference.js";
import {
    comparePayload,
    computeBuildStamp,
} from "./build-stamp.js";
import {
    isRegisteredScene,
    resolveScene,
    type SceneDefinition,
    type SceneParityDefinition,
} from "./scene-registry.js";
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

/**
 * The generated manifest records the deterministic-seeded-random adaptation
 * whenever the compiled scene reached Math.random; the browser reference
 * must then install the pinned seeded generator before module load.
 */
function usesSeededRandom(scene: SceneDefinition): boolean {
    const manifestPath = resolve(
        scene.output,
        "manifest.json",
    );
    if (!existsSync(manifestPath)) {
        return false;
    }
    try {
        const manifest: unknown = JSON.parse(
            readFileSync(manifestPath, "utf8"),
        );
        if (
            typeof manifest !== "object" ||
            manifest === null
        ) {
            return false;
        }
        const adaptations = (
            manifest as {
                adaptations?: Array<{ id?: string }>;
            }
        ).adaptations;
        return (
            Array.isArray(adaptations) &&
            adaptations.some(
                (adaptation) =>
                    adaptation.id ===
                    "deterministic-seeded-random",
            )
        );
    } catch {
        return false;
    }
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
    shaderVariant: "pbr";
    alphaMode: "OPAQUE" | "MASK" | "BLEND";
    doubleSided: boolean;
}

interface GltfSpecialization {
    renderItems: RenderItemMetadata[];
}

interface Arguments {
    sceneId: string;
    executable?: string;
    actual?: string;
    recaptureReference: boolean;
    noFail: boolean;
    gpu: boolean;
}

function parseArguments(arguments_: string[]): Arguments {
    let sceneId = "scene1";
    let executable: string | undefined;
    let actual: string | undefined;
    let recaptureReference = false;
    let noFail = false;
    let gpu = true;
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (!argument) continue;
        if (!argument.startsWith("--")) sceneId = argument;
        else if (argument === "--exe") executable = arguments_[++index];
        else if (argument === "--actual") actual = arguments_[++index];
        else if (argument === "--recapture-reference") recaptureReference = true;
        else if (argument === "--no-fail") noFail = true;
        else if (argument === "--gpu") gpu = true;
        else if (argument === "--cpu") gpu = false;
        else throw new Error(`Unknown argument '${argument}'.`);
    }
    return {
        sceneId,
        ...(executable ? { executable } : {}),
        ...(actual ? { actual } : {}),
        recaptureReference,
        noFail,
        gpu,
    };
}

export function defaultExecutable(buildDirectory: string): string {
    const name = process.platform === "win32"
        ? "bblite_native.exe"
        : "bblite_native";
    const candidates = [
        resolve(buildDirectory, name),
        resolve(buildDirectory, "Release", name),
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

/**
 * Refuse a measurement taken from a stale build.
 *
 * The executable reports the digest of the sources it was compiled from,
 * and its shader and asset payload is copied beside it after every
 * successful build. Comparing both against the generated tree catches the
 * three ways a run can measure something other than the current inputs: a
 * build that never ran, a shader step that failed without stopping the
 * build, and a deployment that never happened.
 */
export function verifyDeployedPayload(
    executable: string,
    generatedDirectory: string,
): void {
    // BBLITE_ASSET_DIR and BBLITE_GPU_SHADER_DIR redirect the runtime
    // lookup, so the deployment beside the executable is only the payload
    // when neither override is active.
    const executableDirectory = resolve(executable, "..");
    const payloads: Array<[string, string, string]> = [];
    if (!process.env.BBLITE_GPU_SHADER_DIR) {
        payloads.push([
            "shaders",
            resolve(generatedDirectory, "upstream/shaders"),
            resolve(executableDirectory, "shaders"),
        ]);
    }
    if (!process.env.BBLITE_ASSET_DIR) {
        payloads.push([
            "assets",
            resolve(generatedDirectory, "assets"),
            resolve(executableDirectory, "assets"),
        ]);
    }
    for (const [label, source, deployed] of payloads) {
        const mismatches = comparePayload(source, deployed);
        if (mismatches.length > 0) {
            const detail = mismatches
                .slice(0, 5)
                .map(
                    (mismatch) =>
                        `${mismatch.path} (${mismatch.reason})`,
                )
                .join(", ");
            throw new Error(
                `Stale ${label} beside ${executable}: ${mismatches.length} file(s) differ from ${source} ` +
                    `[${detail}]. Run 'scene -- process' before measuring.`,
            );
        }
    }
}

export function verifyBuildIdentity(
    executable: string,
    generatedDirectory: string,
    reportedStampPath: string,
): void {
    const expected = computeBuildStamp(generatedDirectory).stamp;
    if (!existsSync(reportedStampPath)) {
        throw new Error(
            `The native executable did not report a build stamp. Rebuild it with 'scene -- process' so it carries one: ${executable}`,
        );
    }
    const reported = readFileSync(
        reportedStampPath,
        "utf8",
    ).trim();
    if (reported !== expected) {
        throw new Error(
            `Stale native build: ${executable} was built from different sources ` +
                `(reports ${reported.slice(0, 12)}, generated tree is ${expected.slice(0, 12)}). ` +
                `Run 'scene -- process' before measuring.`,
        );
    }
}

export function runNative(
    executable: string,
    screenshot: string,
    gpu: boolean,
    nativeEnvironment?: Record<string, string>,
    idBufferPath?: string,
    clusterBufferPath?: string,
    diagnosticDirectory?: string,
    generatedDirectory?: string,
): void {
    if (!existsSync(executable)) {
        throw new Error(
            `Native executable not found: ${executable}. Build the scene Release target first.`,
        );
    }
    if (generatedDirectory) {
        // Before spending a run: a payload that never deployed would
        // otherwise surface as a driver error from the previous binaries.
        verifyDeployedPayload(executable, generatedDirectory);
    }
    mkdirSync(resolve(screenshot, ".."), { recursive: true });
    const screenshotFrame = Number.parseInt(
        nativeEnvironment?.BBLITE_SCREENSHOT_FRAME ?? "0",
        10,
    );
    const maxFrames = Number.isFinite(screenshotFrame) && screenshotFrame >= 0
        ? screenshotFrame + 1
        : 1;
    const nativeBaseEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(
            ([name]) => !name.toLowerCase().startsWith("npm_"),
        ),
    );
    const result = spawnSync(resolve(executable), [], {
        stdio: "inherit",
        windowsHide: true,
        env: {
            ...nativeBaseEnvironment,
            ...nativeEnvironment,
            ...(gpu
                ? {
                      BBLITE_GPU: "1",
                      BBLITE_GPU_REQUIRED: "1",
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
            BBLITE_MAX_FRAMES: String(maxFrames),
            BBLITE_SCREENSHOT: resolve(screenshot),
            BBLITE_TEST_PASS: "1",
            ...(generatedDirectory
                ? {
                      BBLITE_BUILD_STAMP_OUT: resolve(
                          `${screenshot}.build-stamp`,
                      ),
                  }
                : {}),
        },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`Native renderer exited with status ${result.status}.`);
    }
    if (generatedDirectory) {
        verifyBuildIdentity(
            executable,
            generatedDirectory,
            resolve(`${screenshot}.build-stamp`),
        );
    }
}

export function validateReferenceCapture(
    scene: SceneDefinition,
    reference: string,
    recaptureReference: boolean,
): void {
    if (
        isRegisteredScene(scene) &&
        !existsSync(reference) &&
        !recaptureReference
    ) {
        throw new Error(
            `Curated reference is missing: ${reference}. Use --recapture-reference only for an intentional reference update.`,
        );
    }
}

export function resolveParityThresholds(
    config: SceneParityDefinition,
    gpu: boolean,
): {
    maxMad: number | undefined;
    maxRegionMad: number | undefined;
    gate: "enforced" | "diagnostic-only";
} {
    if (gpu) {
        if (
            process.env.BBLITE_GPU_BACKEND === "dawn" &&
            config.dawnThresholds
        ) {
            return {
                maxMad: config.dawnThresholds.maxFullMad,
                maxRegionMad: config.dawnThresholds.maxForegroundMad,
                gate: "enforced",
            };
        }
        const enforced =
            config.maxFullMad !== undefined &&
            config.maxForegroundMad !== undefined;
        return {
            maxMad: config.maxFullMad,
            maxRegionMad: config.maxForegroundMad,
            gate: enforced ? "enforced" : "diagnostic-only",
        };
    }
    if (!config.cpuThresholds) {
        throw new Error(
            "CPU parity thresholds are not configured for this scene.",
        );
    }
    return {
        maxMad: config.cpuThresholds.maxFullMad,
        maxRegionMad: config.cpuThresholds.maxForegroundMad,
        gate: "enforced",
    };
}

function percentage(count: number, total: number): number {
    return total > 0 ? count / total : 0;
}

export async function runSceneParity(
    inputArguments: string[],
): Promise<void> {
    const arguments_ = parseArguments(inputArguments);
    const scene = resolveScene(arguments_.sceneId);
    const config = scene.parity;
    if (!config) throw new Error(`Scene '${scene.id}' has no parity definition.`);
    const reference = resolve(config.reference.path);
    const outputDirectory = resolve(config.outputDirectory);
    mkdirSync(outputDirectory, { recursive: true });
    const actual = resolve(
        arguments_.actual ??
            (arguments_.gpu
                ? config.actual
                : `${config.outputDirectory}/${scene.id}-cpu.png`),
    );
    const thresholds = resolveParityThresholds(
        config,
        arguments_.gpu,
    );
    const renderer = arguments_.gpu
        ? {
              mode: "gpu",
              implementation:
                  process.env.BBLITE_GPU_BACKEND === "dawn"
                      ? "Dawn"
                      : "SDL_GPU",
              driverSelection: process.env.SDL_GPU_DRIVER ?? "auto",
          }
        : {
              mode: "cpu-fallback",
              implementation: "SDL_Renderer",
              driverSelection: process.env.SDL_RENDER_DRIVER ?? "software",
          };
    // Backend-suffixed artifacts keep both GPU backends' outputs side
    // by side ("gpu" stays the SDL_GPU suffix for continuity).
    const artifactSuffix = arguments_.gpu
        ? process.env.BBLITE_GPU_BACKEND === "dawn"
            ? "dawn"
            : "gpu"
        : "cpu";
    const idBufferPath = arguments_.gpu && config.attribution?.drawIds
        ? resolve(outputDirectory, "draw-ids-gpu.png")
        : undefined;
    const idVisualizationPath = idBufferPath
        ? resolve(outputDirectory, "draw-ids-visual-gpu.png")
        : undefined;
    const clusterBufferPath =
        arguments_.gpu && config.attribution?.triangleClusters
        ? resolve(outputDirectory, "triangle-clusters-gpu.png")
        : undefined;
    const clusterVisualizationPath = clusterBufferPath
        ? resolve(outputDirectory, "triangle-clusters-visual-gpu.png")
        : undefined;

    validateReferenceCapture(
        scene,
        reference,
        arguments_.recaptureReference,
    );
    await captureSuiteReference(
        scene.source,
        reference,
        arguments_.recaptureReference,
        undefined,
        config.referenceTimeSeconds,
        config.referenceFrameRate,
        config.referenceAnimationGroups,
        { seededRandom: usesSeededRandom(scene) },
    );
    if (!arguments_.actual) {
        runNative(
            resolve(
                arguments_.executable ??
                    process.env.BBLITE_NATIVE_EXE ??
                    defaultExecutable(scene.buildDirectory),
            ),
            actual,
            arguments_.gpu,
            config.nativeEnvironment,
            idBufferPath,
            clusterBufferPath,
            arguments_.gpu && config.attribution?.diagnostics
                ? outputDirectory
                : undefined,
            resolve(scene.output),
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
    const specialization = config.attribution?.specialization;
    const specializations = specialization && existsSync(resolve(specialization))
        ? JSON.parse(readFileSync(resolve(specialization), "utf8")) as GltfSpecialization[]
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
    const diagnosticFiles = arguments_.gpu && config.attribution?.diagnostics
        ? Object.fromEntries(
              [
                  ["normal", "normal-gpu.png"],
                  ["reflectivity", "reflectivity-gpu.png"],
                  ["irradiance", "irradiance-gpu.png"],
                  ["directLight", "direct-light-gpu.png"],
                  ["ibl", "ibl-gpu.png"],
                  ["normalizedDepth", "normalized-depth-gpu.png"],
                  ["albedo", "albedo-gpu.png"],
                  ["baseColor", "base-color-gpu.png"],
                  ["preToneHdr", "pre-tone-hdr-gpu.png"],
                  ["preToneHdrRaw", "pre-tone-hdr-gpu.rgba16f"],
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
        scene: scene.name,
        sourceOrigin:
            scene.sourceOrigin ?? "babylon-lite",
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
    const reportPath = resolve(
        outputDirectory,
        `report-${artifactSuffix}.json`,
    );
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    console.log(`Renderer: ${renderer.implementation} (${renderer.mode}, ${renderer.driverSelection})`);
    if (thresholds.gate === "diagnostic-only") {
        console.warn(
            "Parity result is diagnostic-only because no thresholds are configured.",
        );
    }
    console.log(`${scene.name} full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, max=${full.maxDiff}`);
    console.log(
        `${scene.name} region (${region.regionPixels} px): MAD=${region.mad.toFixed(3)}, ` +
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
    if (thresholds.maxMad !== undefined && full.mad > thresholds.maxMad) {
        failures.push(`full MAD ${full.mad.toFixed(3)} > ${thresholds.maxMad}`);
    }
    if (
        thresholds.maxRegionMad !== undefined &&
        region.mad > thresholds.maxRegionMad
    ) {
        failures.push(`region MAD ${region.mad.toFixed(3)} > ${thresholds.maxRegionMad}`);
    }
    if (failures.length > 0) {
        const message = `Parity regression: ${failures.join(", ")}`;
        if (arguments_.noFail) console.warn(message);
        else throw new Error(message);
    }
}

// Renders both GPU backends through the standard gates, then diffs
// the two native images against each other — the project's decisive
// diagnostic (backend agreement to one LSB puts a divergence on the
// CPU side; disagreement puts it on the GPU side) — and writes the
// combined report beside the per-backend ones.
export async function runSceneParityDifferential(
    sceneId: string,
): Promise<void> {
    const scene = resolveScene(sceneId);
    const config = scene.parity;
    if (!config) {
        throw new Error(`Scene '${scene.id}' has no parity definition.`);
    }
    const outputDirectory = resolve(config.outputDirectory);
    mkdirSync(outputDirectory, { recursive: true });
    const sdlImage = resolve(outputDirectory, "native-gpu.png");
    const dawnImage = resolve(outputDirectory, "native-dawn.png");
    const previousBackend = process.env.BBLITE_GPU_BACKEND;
    try {
        delete process.env.BBLITE_GPU_BACKEND;
        await runSceneParity([sceneId]);
        copyFileSync(resolve(config.actual), sdlImage);
        process.env.BBLITE_GPU_BACKEND = "dawn";
        await runSceneParity([sceneId]);
        copyFileSync(resolve(config.actual), dawnImage);
    } finally {
        if (previousBackend === undefined) {
            delete process.env.BBLITE_GPU_BACKEND;
        } else {
            process.env.BBLITE_GPU_BACKEND = previousBackend;
        }
    }
    const backendDelta = compareImages(sdlImage, dawnImage);
    const readBackendReport = (suffix: string): {
        full: { mad: number };
        region: { mad: number };
    } =>
        JSON.parse(
            readFileSync(
                resolve(outputDirectory, `report-${suffix}.json`),
                "utf8",
            ),
        ) as { full: { mad: number }; region: { mad: number } };
    const sdlReport = readBackendReport("gpu");
    const dawnReport = readBackendReport("dawn");
    const report = {
        scene: scene.name,
        goldenVersusSdlGpu: {
            fullMad: sdlReport.full.mad,
            foregroundMad: sdlReport.region.mad,
        },
        goldenVersusDawn: {
            fullMad: dawnReport.full.mad,
            foregroundMad: dawnReport.region.mad,
        },
        sdlGpuVersusDawn: backendDelta,
    };
    const reportPath = resolve(
        outputDirectory,
        "report-differential.json",
    );
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
        `Backend differential (${scene.name}): ` +
            `SDL_GPU ${sdlReport.full.mad.toFixed(3)}/${sdlReport.region.mad.toFixed(3)}, ` +
            `Dawn ${dawnReport.full.mad.toFixed(3)}/${dawnReport.region.mad.toFixed(3)}, ` +
            `SDL_GPU-vs-Dawn MAD=${backendDelta.mad.toFixed(3)} ` +
            `max=${backendDelta.maxDiff} ` +
            `within1=${(
                (backendDelta.within1 / backendDelta.totalPixels) *
                100
            ).toFixed(2)}%`,
    );
    console.log(`Report: ${reportPath}`);
}

if (
    process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    runSceneParity(process.argv.slice(2)).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
