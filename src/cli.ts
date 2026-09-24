#!/usr/bin/env node

import { composePinnedBackgroundModules } from "./pinned-background-modules.js";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareAssetDecoders, type AssetDecoders } from "./asset-decoders.js";
import {
    CompileAsset,
    CompileError,
    surveySource,
    compileSource,
} from "./compiler.js";
import {
    composeBillboardPickingShader,
    composeCloudPickingShader,
    composeDeformPickingShaders,
    composeDetailedMeshPickingShader,
    composeMeshPickingShader,
    composeThinInstancePickingShader,
} from "./pinned-picking-shaders.js";
import type { CompiledShaderProgram } from "./compiler.js";
import type {
    CompileOptions,
    CompileResult,
    CompiledNodeParticles,
} from "./compiler/types.js";
import { writeJsonRecord } from "./tooling/records.js";
import {
    emitUpstreamGenerated,
    readPinnedMaxLights,
    type UpstreamEmitOptions,
} from "./upstream-lower.js";
import { composeEsmShadow } from "./pinned-esm-shadow.js";
import { composeComposite, composePostProcess } from "./pinned-post-process.js";
import { composeScreenSpaceTask } from "./pinned-screen-space.js";
import { readNativeHostUi } from "./native-host-ui.js";
import {
    featureActivationPath,
    featureActivationRows,
} from "./feature-activation.js";
import { featureMacroHeaders } from "./feature-macros.js";
import { packageBabylon } from "./babylon-packager.js";
import { packageGltf } from "./gltf-packager.js";
import { packageGltfLoadPlan } from "./gltf-load-plan.js";
import { reachedImageCodecs } from "./image-codecs.js";
// The dds/hdr/splat/basis packagers and the node-particle bake are imported
// lazily at their per-kind branches: each top-level-awaits its pinned
// modules (the HDR one transitively loads the browser harness), so a static
// import makes every compile pay for asset kinds it never packages.
import { compressedTextureLowerer } from "./compiler/compressed-texture.js";
import { isKtx1, packageKtx1 } from "./compressed-texture-package.js";
import { parseDataUrl } from "./data-url.js";
import { localAssetPath } from "./asset-source.js";
import { generateIblBrdfLutRgba16f } from "./ibl-brdf-lut.js";
import {
    buildStampHeader,
    buildStampHeaderPath,
    buildStampInputsPath,
    computeBuildStamp,
} from "./build-stamp.js";
import {
    bakePixelBytes,
    drawSpriteAtlasPng,
    parseExecutedModuleSource,
    pixelsSourcePrefix,
    spriteAtlasSourcePrefix,
} from "./executed-module-assets.js";
import {
    findRepositoryRoot,
    repositoryRelativePath,
} from "./upstream-source.js";
import { GeneratedTree } from "./generated-tree.js";
import { downloadCached } from "./asset-download-cache.js";
import {
    emitAssetSpecializations,
    gltfAssetDocuments,
} from "./asset-specializer.js";
import {
    joinAssetFeatures,
    sceneTransmission,
    type ActivationPlan,
} from "./asset-feature-join.js";
import {
    reachedDiffuseUv2,
    reachedStandardLightLists,
} from "./babylon-asset-features.js";
import { pinnedFeaturesCarrySkeleton } from "./pinned-mesh-features.js";
import { DEFORMATION_BONE_SLOTS } from "./shader-builtins-standard.js";
import { composeScenePipeline } from "./compose-pipeline.js";
import { refuseGeneration } from "./generation-refusal.js";
import {
    composeDefaultTextPipelines,
    composeStandaloneTextPipelines,
} from "./pinned-text-pipeline-cpp.js";
import { holdDistLock } from "./dist-lock.js";
import {
    composeSplatModule,
    composeSplatShModule,
    splatFragmentRecords,
} from "./pinned-splat-fragments.js";
import {
    SPLAT_ASSET_KINDS,
    SPLAT_CONTAINERS,
    SPLAT_HARMONICS_SUFFIX,
    assetRecord,
    type SplatContainer,
} from "./compiler/assets.js";
import type {
    NodeParticleRegistrationEmit,
    NodeParticleSprite2DEmit,
    NodeParticleSystemEmit,
} from "./lowering/node-particle-lowerer.js";

/** What a run produces: a generated tree, or a survey's census in its place. */
type CliTarget =
    { kind: "generate"; output: string } | { kind: "survey"; census: string };

interface CliOptions {
    input: string;
    target: CliTarget;
    title?: string;
    width?: number;
    height?: number;
    search?: string;
    initialSearch?: string;
    publicDir?: string;
    publicUrl?: string;
    siteUrl?: string;
    environment: Record<string, string>;
    hostUi?: string;
    idDiagnostics: boolean;
}

/**
 * Every option `parseArguments` accepts, with its value placeholder. The
 * usage text is generated from this table, and a test holds the table and
 * the parser's cases to the same set, so neither can grow alone.
 */
const TARGET_FLAGS = [
    { flag: "--out", value: "<directory>" },
    { flag: "--survey", value: "<census.json>" },
] as const;
const OPTION_FLAGS: ReadonlyArray<{ flag: string; value?: string }> = [
    { flag: "--title", value: "<text>" },
    { flag: "--width", value: "<pixels>" },
    { flag: "--height", value: "<pixels>" },
    { flag: "--search", value: "<query>" },
    { flag: "--initial-search", value: "<query>" },
    { flag: "--public-dir", value: "<directory>" },
    { flag: "--public-url", value: "<url>" },
    { flag: "--site-url", value: "<url>" },
    { flag: "--env", value: "<NAME=value>" },
    { flag: "--host-ui", value: "<json>" },
    { flag: "--id-diagnostics" },
];

function usage(): never {
    const spell = (option: { flag: string; value?: string }): string =>
        option.value === undefined
            ? option.flag
            : `${option.flag} ${option.value}`;
    console.error(
        `Usage: bblitec <entry.ts> (${TARGET_FLAGS.map(spell).join(" | ")}) ` +
            OPTION_FLAGS.map((option) => `[${spell(option)}]`).join(" "),
    );
    process.exit(2);
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${flag} expects a positive integer.`);
    }
    return parsed;
}

function parseArguments(arguments_: string[]): CliOptions {
    const input = arguments_[0];
    if (!input || input.startsWith("--")) {
        usage();
    }

    let output: string | undefined;
    let survey: string | undefined;
    let title: string | undefined;
    let width: number | undefined;
    let height: number | undefined;
    let search: string | undefined;
    let initialSearch: string | undefined;
    let publicDir: string | undefined;
    let publicUrl: string | undefined;
    let siteUrl: string | undefined;
    const environment = new Map<string, string>();
    let hostUi: string | undefined;
    let idDiagnostics = false;

    for (let index = 1; index < arguments_.length; index += 1) {
        const flag = arguments_[index];
        const value = arguments_[index + 1];
        switch (flag) {
            case "--out":
                if (!value) usage();
                output = value;
                index += 1;
                break;
            case "--survey":
                if (!value) usage();
                survey = value;
                index += 1;
                break;
            case "--title":
                if (!value) usage();
                title = value;
                index += 1;
                break;
            case "--width":
                width = parsePositiveInteger(value, flag);
                index += 1;
                break;
            case "--height":
                height = parsePositiveInteger(value, flag);
                index += 1;
                break;
            case "--search":
                if (!value) usage();
                search = value;
                index += 1;
                break;
            case "--initial-search":
                if (value === undefined) usage();
                initialSearch = value;
                index += 1;
                break;
            case "--host-ui":
                if (!value) usage();
                hostUi = value;
                index += 1;
                break;
            case "--public-dir":
                if (!value) usage();
                publicDir = value;
                index += 1;
                break;
            case "--public-url":
                if (!value) usage();
                publicUrl = value;
                index += 1;
                break;
            case "--site-url":
                if (!value) usage();
                siteUrl = value;
                index += 1;
                break;
            case "--env": {
                const equals = value?.indexOf("=") ?? -1;
                if (!value || equals <= 0)
                    throw new Error("--env expects NAME=value.");
                environment.set(
                    value.slice(0, equals),
                    value.slice(equals + 1),
                );
                index += 1;
                break;
            }
            case "--id-diagnostics":
                idDiagnostics = true;
                break;
            default:
                throw new Error(`Unknown argument '${flag}'.`);
        }
    }

    const target: CliTarget = survey
        ? { kind: "survey", census: survey }
        : output
          ? { kind: "generate", output }
          : usage();

    return {
        input,
        target,
        idDiagnostics,
        environment: Object.fromEntries(environment),
        ...(title ? { title } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        ...(search ? { search } : {}),
        ...(initialSearch !== undefined ? { initialSearch } : {}),
        ...(publicDir ? { publicDir } : {}),
        ...(publicUrl ? { publicUrl } : {}),
        ...(siteUrl ? { siteUrl } : {}),
        ...(hostUi ? { hostUi } : {}),
    };
}

async function assetBytes(
    source: string,
    inputPath: string,
): Promise<Uint8Array> {
    // A data URL carries its own bytes, so there is nothing to fetch and
    // nothing to read: materializing one is a decode.
    const inline = parseDataUrl(source);
    if (inline) return inline.bytes;
    const local = localAssetPath(source, inputPath);
    if (local !== undefined) {
        return new Uint8Array(readFileSync(local));
    }
    return downloadCached(source);
}

/**
 * What materializing one asset told generation about the asset itself.
 *
 * Only the splat containers answer anything today: whether the pin's parser
 * came back carrying spherical harmonics, which decides which of its two
 * pipelines the scene compiles. It is the same shape `emitAssetSpecializations`
 * takes for a glTF -- the asset alone decides, because no scene call reaches
 * the fork.
 */
interface MaterializedAssetFacts {
    splatHarmonicDegree: number;
    /**
     * The Euler rotation the pinned container loader left on the cloud it
     * attached, observed by running that loader rather than restated.
     * Present for the two containers whose loader writes one -- `loadSPZ`
     * and `loadSOG` -- and read back beside the asset kind that produced it,
     * which is what keeps the two entry points' observations apart.
     */
    containerRotation?: readonly [number, number, number];
}

async function materializeAsset(
    asset: CompileAsset,
    inputPath: string,
    outputPath: string,
    assetPayloads: ReadonlyMap<string, string>,
    sourceTextureReads = false,
    nodeTransforms = false,
    meshWalks: NonNullable<CompileResult["manifest"]["meshWalks"]> = [],
    decoders: AssetDecoders = {},
): Promise<MaterializedAssetFacts | undefined> {
    const inlineSource = assetPayloads.get(asset.source);
    if (
        asset.source.startsWith("generated:data-url:") &&
        inlineSource === undefined
    ) {
        refuseGeneration(
            asset.source,
            `Missing materialization payload for '${asset.source}'.`,
        );
    }
    const source = inlineSource ?? asset.source;
    const destination = resolve(outputPath, "assets", asset.output);
    mkdirSync(dirname(destination), { recursive: true });

    if (asset.source === "generated:pinned-ibl-brdf-lut") {
        writeFileSync(destination, await generateIblBrdfLutRgba16f());
        return;
    }

    // The two source prefixes a scene module produces rather than fetches:
    // same execution, one decoder each for what the export returned. The
    // `pixels` kind can also name already-baked inline bytes (the fetched
    // Canvas2D atlas), so kind alone is not an execution contract.
    const bake = asset.source.startsWith(pixelsSourcePrefix)
        ? bakePixelBytes
        : asset.source.startsWith(spriteAtlasSourcePrefix)
          ? drawSpriteAtlasPng
          : undefined;
    if (bake) {
        writeFileSync(
            destination,
            await bake(
                parseExecutedModuleSource(
                    asset.source,
                    findRepositoryRoot(dirname(inputPath)),
                ),
            ),
        );
        return;
    }

    if (asset.kind === "babylon") {
        await packageBabylon(
            source,
            dirname(inputPath),
            destination,
            meshWalks.map((walk, index) =>
                asset.meshWalks?.includes(index) ? walk : undefined,
            ),
            asset.babylonTextureModes?.includes(true) ?? true,
        );
        return;
    }

    if (
        asset.kind === "gltf" &&
        (/\.(?:gltf|glb)(?:[?#]|$)/i.test(source) ||
            (asset.meshWalks?.length ?? 0) > 0)
    ) {
        writeFileSync(
            destination,
            await packageGltfLoadPlan(
                await packageGltf(
                    source,
                    dirname(inputPath),
                    sourceTextureReads,
                    meshWalks.map((walk, index) =>
                        asset.meshWalks?.includes(index) ? walk : undefined,
                    ),
                    decoders,
                ),
                source,
                { cameras: asset.gltfCameras === true, nodeTransforms },
                decoders,
            ),
        );
        return;
    }

    if (SPLAT_ASSET_KINDS.has(asset.kind)) {
        const { packageSplat, packageSog, packageSpz } =
            await import("./splat-packager.js");
        const bytes = await assetBytes(source, inputPath);
        // The one lane a pinned loader writes on the cloud it attached rides
        // the facts rather than the packaged file, for the reason the
        // harmonics ride a sidecar: the row buffer is upstream's own `.splat`
        // layout and nothing may be appended to it.
        const container =
            asset.kind === "spz"
                ? await packageSpz(bytes, source)
                : asset.kind === "sog"
                  ? await packageSog(bytes)
                  : undefined;
        const packaged = container ?? packageSplat(bytes);
        // The rows alone, so a `.ply`, a `.splat` and an `.spz` of the same
        // cloud still package to identical bytes.
        writeFileSync(destination, packaged.rows);
        if (packaged.harmonics) {
            writeFileSync(
                `${destination}${SPLAT_HARMONICS_SUFFIX}`,
                packaged.harmonics.bytes,
            );
        }
        return {
            splatHarmonicDegree: packaged.harmonics?.degree ?? 0,
            ...(container ? { containerRotation: container.rotation } : {}),
        };
    }

    if (asset.kind === "basis") {
        // The one texture whose bytes the browser produces: the pin fetches
        // its transcoder from a CDN and picks a target format from the
        // device, so generation runs the pinned loader and packages what it
        // uploaded. The file itself rides the ordinary download cache and is
        // served back to the page from the loopback origin, so a recompile
        // asks the CDN for the transcoder alone.
        const { transcodeBasisTexture, writeKtx1 } =
            await import("./basis-transcode.js");
        const lowerer = compressedTextureLowerer();
        const transcoded = await transcodeBasisTexture(
            source,
            await assetBytes(source, inputPath),
        );
        writeFileSync(
            destination,
            await packageKtx1(
                writeKtx1(
                    transcoded,
                    lowerer.magicBytes(),
                    lowerer.glInternalFormat(transcoded.gpuFormat),
                    lowerer.headerLayout(),
                ),
            ),
        );
        return;
    }

    if (asset.kind === "dds-environment") {
        const { packageDdsEnvironment } = await import("./dds-packager.js");
        writeFileSync(
            destination,
            packageDdsEnvironment(await assetBytes(source, inputPath)),
        );
        return;
    }

    if (asset.kind === "hdr-environment") {
        const { packageHdrEnvironment } = await import("./hdr-packager.js");
        writeFileSync(
            destination,
            await packageHdrEnvironment(
                await assetBytes(source, inputPath),
                asset.faceSize ?? 256,
            ),
        );
        return;
    }

    // One branch, because `assetBytes` already answers "the bytes this source
    // names" for all three kinds. Spelling the local case as the complement of
    // a scheme test is what made a data URL have to be taught to two
    // predicates in this file rather than one.
    const bytes = await assetBytes(source, inputPath);
    writeFileSync(
        destination,
        asset.kind === "texture" && isKtx1(bytes)
            ? await packageKtx1(bytes)
            : await packageGltfLoadPlan(
                  bytes,
                  source,
                  { cameras: asset.gltfCameras === true, nodeTransforms },
                  decoders,
              ),
    );
}

/**
 * The manifest as the generated tree records it.
 *
 * The compiler reports the files it read by their resolved paths: its own
 * readers resolve them and its diagnostics print them. The record names
 * each one the way `inputs` already does -- relative to the repository
 * root, forward slashes -- so a tree generated in another checkout or
 * worktree records the same bytes. A file outside the repository keeps
 * the relative path that reaches it from the root, or its absolute path
 * where none exists (another drive). A name that is not an absolute path
 * -- a host-UI companion's registry path, a virtual entry name -- is
 * already machine-independent and is recorded as given.
 */
function recordedManifest(
    manifest: CompileResult["manifest"],
    repositoryRoot: string,
): CompileResult["manifest"] {
    const recordedPath = (path: string): string =>
        isAbsolute(path) ? repositoryRelativePath(repositoryRoot, path) : path;
    // A site is `file:line`; anything else is a named location.
    const recordedSite = (site: string): string => {
        const location = /^(.+):(\d+)$/.exec(site);
        return location
            ? `${recordedPath(location[1]!)}:${location[2]!}`
            : site;
    };
    return {
        ...manifest,
        source: recordedPath(manifest.source),
        featureSites: Object.fromEntries(
            Object.entries(manifest.featureSites).map(([feature, site]) => [
                feature,
                recordedSite(site),
            ]),
        ),
        sourceUnits: manifest.sourceUnits.map((unit) => ({
            ...unit,
            source: recordedPath(unit.source),
        })),
    };
}

/**
 * Run the scene's node-particle program through the pin and package each
 * frozen system's texture.
 *
 * The bake is the executed half of the family (`src/pinned-node-particle.ts`
 * carries why); what it hands back is the particle state and the URL the
 * pin's own texture block resolved, which becomes an ordinary packaged
 * asset from here on.
 */
async function bakeNodeParticleSystems(
    program: CompiledNodeParticles,
    assetPayloads: Map<string, string>,
    compileOptions: CompileOptions,
): Promise<{
    systems: NodeParticleSystemEmit[];
    sprite2d: NodeParticleSprite2DEmit[];
    registrations: NodeParticleRegistrationEmit[];
    /** Whether any system was frozen at generation (the executed bake). */
    frozen: boolean;
}> {
    const { bakeNodeParticles } = await import("./pinned-node-particle.js");
    const bake = await bakeNodeParticles(program);
    // A graph texture the pin resolved against a root-relative
    // `textureBaseUrl` names the deployment's public files, as a scene's own
    // root-relative URL does.
    const texturePlacement = {
        entryFileName: compileOptions.fileName,
        deployment: compileOptions,
    };
    // Whether a set's blend takes `createParticleBlend`'s five modes (the
    // exact-blend builder, or the enabler over any builder) or the plain
    // builder's three-arm mapping.
    const exactBlendOf = (setIndex: number): boolean => {
        const set = program.sets[setIndex];
        return (
            set?.builder === "buildNodeParticleSetWithBlendModes" ||
            set?.enableBlendModes === true
        );
    };
    const systems: NodeParticleSystemEmit[] = bake.systems.map((system) => {
        // A texture the scene assigned is already a generated asset -- the
        // pixel-buffer module the compiler registered -- so only a graph's
        // own loaded image is packaged from its URL here.
        const asset =
            system.texture && !system.texture.sceneAssigned
                ? assetRecord(
                      system.texture.bytes === undefined
                          ? system.texture.url
                          : `data:${system.texture.mediaType || "image/png"};base64,${system.texture.bytes}`,
                      "texture",
                      assetPayloads,
                      texturePlacement,
                  )
                : undefined;
        const assigned = program.textures.find(
            (entry) =>
                entry.set === system.set && entry.system === system.system,
        );
        return {
            bake: system,
            exactBlend: exactBlendOf(system.set),
            textureAsset: asset?.output ?? "",
            ...(assigned
                ? {
                      texturePixels: {
                          source: assigned.source,
                          asset: assigned.asset,
                          width: assigned.width,
                          height: assigned.height,
                          options: assigned.options,
                      },
                  }
                : {}),
            ...(asset ? { asset } : {}),
        };
    });
    // A live system has no frozen state: the renderer animates it every
    // frame, and the live lowering takes the built graph and the facts the
    // pin reported about its own build. What the bake row carries is what
    // the atlas builder reads -- the texture, packaged from the bytes the
    // driver fetched when the URL was a browser object URL.
    for (const entry of bake.live) {
        const { bytes, mediaType, ...texture } = entry.texture;
        const source =
            bytes !== undefined
                ? `data:${mediaType || "image/png"};base64,${bytes}`
                : texture.url;
        const asset = texture.sceneAssigned
            ? undefined
            : assetRecord(source, "texture", assetPayloads, texturePlacement);
        const assigned = program.textures.find(
            (texture) =>
                texture.set === entry.set && texture.system === entry.system,
        );
        systems.push({
            bake: {
                set: entry.set,
                system: entry.system,
                capacity: entry.facts.capacity,
                blendMode: entry.facts.blendMode,
                updateSpeed: entry.facts.updateSpeed,
                stepIsIdentity: false,
                texture,
                spriteSheet: null,
                alive: 0,
                positions: [],
                sizes: [],
                colors: [],
                rotations: [],
                frames: null,
            },
            exactBlend: exactBlendOf(entry.set),
            textureAsset: asset?.output ?? "",
            ...(asset ? { asset } : {}),
            ...(assigned
                ? {
                      texturePixels: {
                          source: assigned.source,
                          asset: assigned.asset,
                          width: assigned.width,
                          height: assigned.height,
                          options: assigned.options,
                      },
                  }
                : {}),
            live: {
                graph: entry.graph,
                facts: entry.facts,
                ...(entry.provider ? { provider: true as const } : {}),
            },
        });
    }
    // The bake reports which systems each pure-2D binding walked, because a
    // set's count is the graph's answer and `systems.push` can add one from
    // another set. The mapping constants beside it are the scene's own.
    const sprite2d = bake.sprite2d.map((expansion) => {
        const request = program.sprite2d[expansion.request]!;
        return {
            exact: request.exact,
            autoStart: request.autoStart,
            pixelsPerUnit: request.pixelsPerUnit,
            originPx: request.originPx,
            invertY: request.invertY,
            ...(request.retainFrozen ? { retainFrozen: true as const } : {}),
            ...(request.opacity === undefined
                ? {}
                : { opacity: request.opacity }),
            ...(request.visible === undefined
                ? {}
                : { visible: request.visible }),
            ...(request.order === undefined ? {} : { order: request.order }),
            systems: expansion.systems,
        };
    });
    // Both registrars report which systems each call walked, for the
    // same reason: a set's count is the graph's answer, and `systems.push`
    // can add one built elsewhere.
    const registrations = bake.registrations.map((expansion) => ({
        systems: expansion.systems,
        autoStart: program.registrations[expansion.request]!.autoStart,
    }));
    return {
        systems,
        sprite2d,
        registrations,
        frozen: bake.systems.length > 0,
    };
}

/**
 * `--survey`: lower the entry past every refusal and write the census in
 * place of a tree. The exit status reports whether the survey ran to the
 * end, not whether the entry generates.
 */
function writeSurvey(
    censusPath: string,
    source: string,
    compileOptions: CompileOptions,
): void {
    const { report } = surveySource(source, compileOptions);
    writeJsonRecord(censusPath, report);
    console.log(
        `Survey: ${report.statements.attempted} statement lowerings, ${report.statements.refused} refused ` +
            `(${report.refusals.length} sites, ${report.classes.length} classes) -> ${censusPath}`,
    );
    for (const entry of report.classes.slice(0, 12)) {
        const cascades =
            entry.cascades > 0 ? `, ${entry.cascades} cascade(s)` : "";
        console.log(
            `  ${entry.sites} site(s)${cascades}, ${entry.occurrences} lowering(s): ${entry.class}`,
        );
    }
    if (!report.complete) {
        console.error(`Survey incomplete: ${report.terminal}`);
        process.exitCode = 1;
    }
}

async function main(): Promise<void> {
    const options = parseArguments(process.argv.slice(2));
    // This process runs out of `dist/` too, and an ad-hoc generation probe is
    // exactly what runs beside somebody else's `npm run build`. A `compile`
    // fan-out's children already run under their parent's lock and take
    // nothing here.
    holdDistLock(`generate ${options.input}`);
    const inputPath = resolve(options.input);
    const source = readFileSync(inputPath, "utf8");
    const compileOptions: CompileOptions = {
        fileName: inputPath,
        environment: options.environment,
        ...(options.title ? { title: options.title } : {}),
        ...(options.width ? { width: options.width } : {}),
        ...(options.height ? { height: options.height } : {}),
        ...(options.search ? { search: options.search } : {}),
        ...(options.initialSearch !== undefined
            ? { initialSearch: options.initialSearch }
            : {}),
        ...(options.publicDir ? { publicDir: options.publicDir } : {}),
        ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
        ...(options.siteUrl ? { siteUrl: options.siteUrl } : {}),
        ...(options.hostUi
            ? { nativeHostUi: readNativeHostUi(options.hostUi) }
            : {}),
    };
    if (options.target.kind === "survey") {
        writeSurvey(resolve(options.target.census), source, compileOptions);
        return;
    }
    const outputPath = resolve(options.target.output);
    const result = compileSource(source, compileOptions);

    // The frozen node-particle bake is a Chromium run that nothing between
    // here and the emitters depends on, so it is started rather than
    // awaited: the compile spends about as long lowering and writing the
    // tree as the browser spends simulating, and the two overlap. It is
    // joined below, before the first consumer of what it produces.
    const bakingNodeParticles = result.nodeParticles
        ? bakeNodeParticleSystems(
              result.nodeParticles,
              result.assetPayloads,
              compileOptions,
          )
        : undefined;

    mkdirSync(outputPath, { recursive: true });
    // Assets are materialized from their sources every run; the compiled
    // tree is written through `tree`, which rewrites only what changed
    // and prunes what this run no longer emits.
    rmSync(resolve(outputPath, "assets"), { recursive: true, force: true });
    const tree = new GeneratedTree(outputPath);
    const decoderSources = new Set<string>();
    const decoderSets = new Map<string, AssetDecoders>();
    const decodersFor = (asset: CompileAsset): AssetDecoders => {
        const key = JSON.stringify(asset.assetDecoders ?? {});
        let decoders = decoderSets.get(key);
        if (!decoders) {
            decoders = prepareAssetDecoders(asset.assetDecoders, (source) => {
                decoderSources.add(source);
                return assetBytes(source, inputPath);
            });
            decoderSets.set(key, decoders);
        }
        return decoders;
    };
    const materializedFacts = await Promise.all(
        result.manifest.assets.map((asset) =>
            materializeAsset(
                asset,
                inputPath,
                outputPath,
                result.assetPayloads,
                result.manifest.features.includes(
                    "material:source-texture-read",
                ),
                result.manifest.features.includes("scene:node-transforms"),
                result.manifest.meshWalks,
                decodersFor(asset),
            ),
        ),
    );
    // Which pipeline a Gaussian cloud attaches is the PARSE's answer, not
    // the scene's: `attachParsedSplat` tests `parsed.sh && parsed.shDegree`
    // and imports the SH module when both hold. Generation deploys one
    // splat stage pair, so a scene whose clouds disagree -- two degrees, or
    // one cloud with harmonics beside one without -- would need two, and
    // refuses here instead of drawing one of them through the other's.
    const splatHarmonicDegrees = new Set(
        materializedFacts
            .filter((facts) => facts !== undefined)
            .map((facts) => facts.splatHarmonicDegree),
    );
    if (splatHarmonicDegrees.size > 1) {
        refuseGeneration(
            "loader:splat",
            "This scene loads Gaussian clouds at spherical-harmonic " +
                `degrees ${[...splatHarmonicDegrees]
                    .sort()
                    .join(" and ")}; generation deploys one splat stage ` +
                "pair, and the pin builds a distinct module per degree " +
                "(degree 0 being the stock pipeline).",
            result.manifest.featureSites,
        );
    }
    const splatHarmonicDegree = [...splatHarmonicDegrees].find(
        (degree) => degree > 0,
    );
    // The rotation a pinned container loader writes on every cloud it
    // attaches, observed once per container of that kind. Two containers one
    // loader read cannot disagree -- it is a constant of the loader, not of
    // the asset -- so a scene whose observations differ means the pin grew a
    // per-container arm this port does not model, and refuses rather than
    // emitting one of them. Asked per kind, because each loader is its own
    // emitted entry point and one answer must not stand in for another's.
    const containerRotation = (
        container: SplatContainer,
    ): readonly [number, number, number] | undefined => {
        const observed = materializedFacts
            .map((facts, index) =>
                result.manifest.assets[index]?.kind === container.kind
                    ? facts?.containerRotation
                    : undefined,
            )
            .filter((rotation) => rotation !== undefined);
        const distinct = new Set(
            observed.map((rotation) => rotation.join(",")),
        );
        if (distinct.size > 1) {
            refuseGeneration(
                "loader:splat",
                `This scene's ${container.kind.toUpperCase()} containers ` +
                    `attach clouds at different rotations (${[...distinct].join(
                        "; ",
                    )}); the pinned ${container.loader} writes ` +
                    "one, so a difference means it now forks on the " +
                    "container.",
                result.manifest.featureSites,
            );
        }
        return observed[0];
    };
    // Asked of every container the table knows, so a fourth arrives here with
    // its row rather than with an edit. A kind is present exactly when a
    // container of it was packaged, which is what the emitted entry point's
    // constant comes from.
    const splatContainerRotations = new Map(
        [...SPLAT_CONTAINERS.values()].flatMap((container) => {
            const rotation = containerRotation(container);
            return rotation === undefined
                ? []
                : [[container.kind, rotation] as const];
        }),
    );
    const splatSpzRotation = splatContainerRotations.get("spz");
    const splatSogRotation = splatContainerRotations.get("sog");
    // Each packaged glTF document, parsed once for the specializer and the
    // join alike.
    const gltfDocuments = gltfAssetDocuments(
        outputPath,
        result.manifest.assets,
    );
    const specializationFeatures = emitAssetSpecializations(
        outputPath,
        result.manifest.assets,
        gltfDocuments,
    );
    // Everything past this point reads the finished feature list: the join
    // adds what the assets carry, re-projects the list, and decides the
    // capabilities an asset and a scene call can both turn on.
    const assetJoin = await joinAssetFeatures({
        result,
        outputPath,
        documents: gltfDocuments,
        specialization: specializationFeatures,
        splatHarmonics: result.manifest.assets.find(
            (_, index) =>
                (materializedFacts[index]?.splatHarmonicDegree ?? 0) > 0,
        ),
    });
    // KHR_interactivity is the asset's feature, as the pinned loader's
    // document predicate makes it: the join parsed each interactive asset's
    // graphs through the pin; the adaptation the attach records is stated
    // here.
    if (specializationFeatures.interactivity) {
        result.manifest.adaptations.push({
            id: "flow-graph-attach-at-add",
            category: "async",
            sourceSemantics:
                "addToScene stores a promise of the interactivity runtimes on the container; the graphs attach when it resolves and start on the next frame's tick, and a pointer pick dispatches its event after the GPU readback resolves.",
            nativeSemantics:
                "The graphs attach inside addToScene, start on the first before-render tick as upstream does, and a tap's pick reads back synchronously so its cascade runs inside the release handler. Each block's body is evaluated over the parsed graph at generation and emitted as C++; the runtime plumbing is restated over the static graph with its pinned bodies asserted.",
            risk: "low",
            validation: [
                "the calculator demo's onStart cascade at the frame-180 golden on both backends",
                "a replayed button tap moving the display digits on both backends",
            ],
        });
    }

    if (specializationFeatures.eightInfluenceSkinning) {
        // The pinned loader reads the second influence pair and skins eight
        // influences (MSH_HAS_SKELETON_8); the generated loader reads four.
        // The divergence is intentional and bounded — the second pair
        // carries the small weight tail — so it is recorded here instead of
        // refused, per the repository's adaptation policy.
        result.manifest.adaptations.push({
            id: "four-influence-skinning",
            category: "rendering",
            sourceSemantics:
                "An asset carries JOINTS_1/WEIGHTS_1 and the pinned loader " +
                "skins eight influences per vertex (MSH_HAS_SKELETON_8).",
            nativeSemantics:
                "The generated loader reads the first influence pair and " +
                "skins four; the second pair's weights are dropped.",
            risk: "medium",
            validation: [
                "scene 7 parity thresholds",
                "asset-specializer tests",
            ],
        });
    }
    if (specializationFeatures.compressedImages) {
        // The same tradeoff the `.basis` arm records, reached through a glTF
        // instead of a texture call: `uploadKtx2Texture2D` is the one glTF
        // image path whose bytes the browser produces, so it is executed at
        // generation rather than folded.
        result.manifest.adaptations.push({
            id: "executed-ktx2-transcode",
            category: "asset-materialization",
            sourceSemantics:
                "KHR_texture_basisu redirects a material slot to a KTX2 " +
                "image, and uploadKtx2Texture2D fetches the Babylon KTX2 " +
                "decoder from a CDN at run time, transcodes to the first " +
                "compressed format the device reports, and uploads the mip " +
                "chain it produced.",
            nativeSemantics:
                "Packaging runs the pin's own loader in headless Chromium " +
                "and packages its GPU blocks with the pin's parsed mip list " +
                "for native span-based upload, so the extension is resolved away like the " +
                "geometry extensions and the loader that ships sees an " +
                "ordinary asset. The decoder is a WebAssembly module the " +
                "page injects with a script tag, and the target format is a " +
                "device question both the reference and the compiled " +
                "backends answer with BC7 on D3D12. sRGB is not a transcode " +
                "input -- it selects the container's GL enum -- so an image " +
                "reached at both colour spaces is refused rather than " +
                "packaged once.",
            risk: "medium",
            validation: [
                "scene 112 parity against the browser golden, which " +
                    "transcodes the same images at load",
                "byte-stable across repeated compilations",
            ],
        });
    }
    tree.keep("upstream/gltf-specialization.json");
    if (assetJoin.imageBasedLight) {
        const brdfAsset: CompileAsset = {
            source: "generated:pinned-ibl-brdf-lut",
            output: "gltf-ibl-brdf-lut.rgba16f",
            kind: "texture",
        };
        writeFileSync(
            resolve(outputPath, "assets", brdfAsset.output),
            await generateIblBrdfLutRgba16f(),
        );
        result.manifest.assets.push(brdfAsset);
    }
    // Resolve reached variant slugs to full program records: predeclared
    // names come from the pinned registry (no defaults), scene-local
    // programs travel in the manifest.
    // The bake's own texture is the one asset it contributes, and it is
    // only known once the pin has resolved it against the scene's
    // `textureBaseUrl`. Joining here keeps it ahead of every consumer: the
    // emitters below, the image-codec scan and the manifest write.
    const bakedParticles = bakingNodeParticles
        ? await bakingNodeParticles
        : { systems: [], sprite2d: [], registrations: [], frozen: false };
    const nodeParticles = bakedParticles.systems;
    const nodeParticleSprite2d = bakedParticles.sprite2d;
    const nodeParticleRegistrations = bakedParticles.registrations;
    if (bakedParticles.frozen) {
        // A frozen system is the executed bake. A system a pure-2D binding
        // took live is simulated natively from the lowered graph and
        // records no adaptation of its own: its random draws are the pinned
        // generator's, which `deterministic-seeded-random` already states.
        result.manifest.adaptations.push({
            id: "executed-node-particle-simulation",
            category: "asset-materialization",
            sourceSemantics:
                "The scene builds a node-particle graph and steps its CPU simulation a fixed number of times before the first frame, drawing from the deterministic Math.random it installs.",
            nativeSemantics:
                "Generation runs the pin's own parser, graph builder and simulation in headless Chromium and bakes the particle state they produced; the native runtime draws that state and never simulates. The graph build is closures the compiler does not lower, and the value is fragile beyond a rounding step: the seed is drawn through Math.sin, which is not bit-portable off V8, so a native simulation would diverge into a different set of particles rather than a slightly different one. Everything downstream of the state -- the atlas, the blend and the per-particle write -- stays folded from the pinned declarations. The baked state depends on the Chrome that ran it, as the drawn atlas and the pinned GGX prefilter already do.",
            risk: "medium",
            validation: [
                "scenes 262, 263, 264, 276, 277, 280 and 281 parity against the browser golden, which runs the same simulation at load",
                "byte-stable across repeated compilations",
            ],
        });
    }
    for (const system of nodeParticles) {
        if (!system.asset) continue;
        if (
            !result.manifest.assets.some(
                (existing) => existing.output === system.asset!.output,
            )
        ) {
            result.manifest.assets.push(system.asset);
            await materializeAsset(
                system.asset,
                inputPath,
                outputPath,
                result.assetPayloads,
                result.manifest.features.includes(
                    "material:source-texture-read",
                ),
                result.manifest.features.includes("scene:node-transforms"),
                result.manifest.meshWalks,
            );
        }
    }

    const shaderPrograms: CompiledShaderProgram[] =
        result.manifest.shaderVariants.map((name) => {
            const custom = result.manifest.customShaderPrograms.find(
                (program) => program.name === name,
            );
            if (!custom) {
                refuseGeneration(
                    "material:shader",
                    `Unknown shader variant '${name}'.`,
                    result.manifest.featureSites,
                );
            }
            return custom;
        });
    // The SPZ container, recorded here rather than in the adaptation table:
    // `compileAdaptations` runs over the entry AST, and the VALUE this
    // entry records -- the rotation the pinned loader wrote, which is the
    // whole point of executing it -- is not known until the container has
    // been fetched and it has run over it. The reach itself is AST-derived
    // (`loader:splat-spz`), so only the observation pins it here.
    if (splatSpzRotation !== undefined) {
        result.manifest.adaptations.push({
            id: "spz-loader-at-generation",
            category: "asset-materialization",
            sourceSemantics:
                "loadSPZ fetches the container, tests the two gzip magic " +
                "bytes, inflates a match through DecompressionStream, reads " +
                "the 32-byte rows and the flat spherical-harmonic stream " +
                "out of the result with the module-local parseSpz, and " +
                "writes a half turn about X on the cloud it attached.",
            nativeSemantics:
                "That whole loader runs at generation, with its two " +
                "boundaries stood in for: fetch answers from the bytes the " +
                "download cache holds, and attachParsedSplat records " +
                "instead of building a GPU mesh. So the gzip fork and the " +
                "parse are taken there, the rows and harmonics package " +
                "exactly as every other splat container's do, and the " +
                "rotation the loader wrote is observed from that run rather " +
                "than restated -- the generated load_spz applies the " +
                `observed ${splatSpzRotation.join(", ")}.`,
            risk: "low",
            validation: [
                "scene 123 parity against the browser golden on both backends",
                "the packaged rows and sidecar are what the pin's own " +
                    "loadSPZ handed attachParsedSplat",
            ],
        });
    }
    // The SOG container, pinned here for the same reason the SPZ one above
    // is. It is a separate entry because its stand-ins are not the same: this
    // loader's decode step is the BROWSER's, so the run happens there.
    if (splatSogRotation !== undefined) {
        result.manifest.adaptations.push({
            id: "sog-loader-at-generation",
            category: "asset-materialization",
            sourceSemantics:
                "loadSOG fetches the ZIP container, unzips it with the " +
                "module-local unzipBuffer, reads meta.json, decodes each " +
                "WebP by drawing an ImageBitmap into a 2D canvas and " +
                "reading it back with getImageData, rebuilds the 32-byte " +
                "rows and the flat spherical-harmonic stream with the " +
                "module-local parseSogDatas, and writes a half turn about " +
                "X on the cloud it attached.",
            nativeSemantics:
                "That whole loader runs at generation, in headless " +
                "Chromium under the golden capture's own flags -- because " +
                "its decode step is a canvas round trip, which " +
                "premultiplies, and the browser reference the golden is " +
                "captured from performs exactly that one. A substituted " +
                "decoder would have to agree with Skia byte for byte, so " +
                "none is introduced. Two boundaries are stood in for, the " +
                "SPZ loader's two: fetch answers from the bytes the " +
                "download cache holds, served on the page's own origin, " +
                "and attachParsedSplat records instead of building a GPU " +
                "mesh. The rows and harmonics then package exactly as " +
                "every other splat container's do, and the rotation the " +
                "loader wrote is observed from that run rather than " +
                "restated -- the generated load_sog applies the observed " +
                `${splatSogRotation.join(", ")}.`,
            risk: "low",
            validation: [
                "scene 122 parity against the browser golden on both backends",
                "the packaged rows and sidecar are what the pin's own " +
                    "loadSOG handed attachParsedSplat",
            ],
        });
    }
    const {
        lightKinds,
        toneMappingStates,
        gltfAssets,
        materialIndexBase,
        casterViewCount,
        renderableMeshFeatures,
        meshProfiles,
        pinnedVariants,
        runtimeMeshFeatures,
        standardComposition,
        standardRenderableMeshFeatures,
        standardRuntimeMeshFeatures,
        standardPluginBindings,
        nodeVariants,
        composedArms,
    } = await composeScenePipeline({
        result,
        outputPath,
        assetJoin,
        tree,
    });
    // The plan the join decided, completed by the one capability the
    // composition decides: whether the transmission renderer compiles.
    const activationPlan: ActivationPlan = {
        ...assetJoin.plan,
        transmission: sceneTransmission(result.manifest.features, composedArms),
    };
    const gpuDeformation = activationPlan.gpuDeformation.value;
    const morphStorage = activationPlan.morphStorage.value;
    const gpuInstancing = activationPlan.gpuInstancing.value;
    // Named rather than inline so the activation inventory below records
    // the exact values the emitters consumed, not a restatement of them.
    // Which palette transport a skin takes: a build whose composed variants
    // carry the pin's own skeleton bit reads the palette from its per-bone
    // texture, which caps no joint count.
    const pinnedSkeletonPalette = await pinnedFeaturesCarrySkeleton(
        renderableMeshFeatures,
    );
    // Each reached post-process pass composes its module by running the
    // pinned factory: the effect's stage is the pin's text for the options
    // this scene passed, never a reproduction of it.
    // A GPU pick draws through the pin's own two modules. Both are
    // executed rather than re-typed, for the reason every composed stage
    // here is: what deploys must be the text the browser compiled.
    // A contributor's module is composed only where its own entity can be
    // picked, which is the pin's own pay-for-use rule: the picker
    // dynamic-imports each pick source's pipeline, so a scene with no
    // cloud and no billboard system fetches neither.
    const pickingShaders = result.manifest.features.includes("picking:gpu")
        ? {
              mesh: await composeMeshPickingShader(),
              ...(gpuInstancing
                  ? { thin: await composeThinInstancePickingShader() }
                  : {}),
              // The detailed pipeline is a second pinned module rather
              // than an option, composed only where a scene armed it.
              ...(result.manifest.features.includes("picking:detailed")
                  ? {
                        detailed: await composeDetailedMeshPickingShader(),
                    }
                  : {}),
              deform: await composeDeformPickingShaders({
                  meshFeatures: renderableMeshFeatures,
                  skeleton: gpuDeformation && pinnedSkeletonPalette,
                  morph: morphStorage,
                  detailed:
                      result.manifest.features.includes("picking:detailed"),
              }),
              ...(result.manifest.features.includes("loader:splat")
                  ? { cloud: await composeCloudPickingShader() }
                  : {}),
              ...(result.manifest.features.includes("picking:billboard")
                  ? {
                        billboard: {
                            facing: await composeBillboardPickingShader(
                                "facing",
                            ),
                            ...(result.manifest.features.includes(
                                "sprite:billboard-axis-locked",
                            )
                                ? {
                                      axisLocked:
                                          await composeBillboardPickingShader(
                                              "axis-locked",
                                          ),
                                  }
                                : {}),
                        },
                    }
                  : {}),
          }
        : undefined;
    const postProcessShaders = await Promise.all(
        result.manifest.postProcessTasks.map((task) =>
            composePostProcess({
                intrinsic: task.intrinsic,
                options: task.options,
            }),
        ),
    );
    // Each ESM generator runs its own factory too, for the same reason: the
    // four textures it builds and the two blur stages it compiles -- whose
    // tap table is folded from this scene's `blurKernel` -- are the
    // factory's answer, not something this repo can restate.
    const esmShadows = await Promise.all(
        result.manifest.shadowGenerators
            .filter((generator) => generator.kind === "esm-directional")
            .map((generator) => composeEsmShadow(generator.esm ?? {})),
    );
    // A splat scene that named shader plugins composes its module through
    // the pin's own splicer: `applyGsFragments` concatenates each plugin's
    // slots and then runs upstream's own field-name mangler over the whole
    // string, which is why the module is composed rather than assembled.
    const splatFragments = await splatFragmentRecords(
        result.manifest.splatFragments,
    );
    // A cloud carrying harmonics reaches the pin's OTHER pipeline, whose
    // module `buildShShaderSource` writes for this degree -- with the same
    // plugin splice applied, because `getOrCreateShPipeline` runs
    // `applyGsFragments` over its build exactly as the stock one does.
    const splatSh =
        splatHarmonicDegree !== undefined
            ? await composeSplatShModule(splatHarmonicDegree, splatFragments)
            : undefined;
    const splatShaderModule =
        splatSh === undefined && splatFragments.length > 0
            ? await composeSplatModule(splatFragments)
            : undefined;
    // The pin's background renderables: each reached factory runs against
    // the recording device and is drawn once, so the modules, layouts,
    // states and buffer bindings the backends build from are its own.
    const backgroundFeatures = result.manifest.features;
    const pinnedBackgrounds = await composePinnedBackgroundModules({
        ground: backgroundFeatures.includes("background:ground"),
        skybox: backgroundFeatures.includes("background:skybox"),
        ddsEnvironment: backgroundFeatures.includes(
            "background:dds-environment",
        ),
        solidSkybox: backgroundFeatures.includes("background:solid-skybox"),
        imageSkybox: backgroundFeatures.includes("background:image-skybox"),
    });
    // A composite runs its own factory instead: which passes it records, over
    // which intermediates and at which sizes, is the factory's answer.
    const postProcessComposites = await Promise.all(
        result.manifest.postProcessComposites.map((composite) =>
            composeComposite({
                intrinsic: composite.intrinsic,
                options: composite.options,
                hasTarget: composite.hasTarget,
                ...(composite.scalarAccesses
                    ? { scalarAccesses: composite.scalarAccesses }
                    : {}),
            }),
        ),
    );
    const screenSpaceTasks = await Promise.all(
        result.manifest.screenSpaceTasks.map(async (manifest) => ({
            manifest,
            composed: await composeScreenSpaceTask(manifest),
        })),
    );
    if (screenSpaceTasks.length > 0) {
        // The pin flags a temporal reallocation by comparing scaled sizes
        // and keeps its GPU textures across frame-graph rebuilds; the
        // backends renumber every target's allocation on a rebuild, and
        // that identity is what the native frame function compares.
        result.manifest.adaptations.push({
            id: "screen-space-allocation-identity",
            category: "rendering",
            sourceSemantics:
                "A screen-space task's record() flags a reallocation when " +
                "its scaled extent changed and its temporal history survives " +
                "a frame-graph rebuild that keeps every texture.",
            nativeSemantics:
                "The frame function flags a reallocation when a target's " +
                "backend allocation changed, so a rebuild that recreates " +
                "unchanged-size targets also invalidates the temporal history.",
            risk: "low",
            validation: ["screen-space-effects parity thresholds"],
        });
    }
    // Deformation runs on the GPU or not at all, so the transcribed vertex
    // stage's uniform array is a hard bound rather than a slow path. Both
    // halves of the question are settled here — the asset's largest skin and
    // the variant set the scene composes — so refuse by name now instead of
    // after a native build. The generated loader keeps the same check as the
    // BBLITE_ASSET_DIR defense, exactly as asset-specializer.ts documents for
    // every other unsupported-asset refusal.
    if (
        !pinnedSkeletonPalette &&
        specializationFeatures.maxSkinJoints > DEFORMATION_BONE_SLOTS
    ) {
        refuseGeneration(
            "loader:gltf",
            `A skin of ${specializationFeatures.maxSkinJoints} joints exceeds ` +
                `the ${DEFORMATION_BONE_SLOTS}-matrix bone palette of the ` +
                "transcribed vertex stage, which is this scene's transport " +
                "because it composes no pinned skeleton variant. The pin's " +
                "own per-bone palette texture caps nothing; there is no CPU " +
                "deformation path to fall back to.",
            result.manifest.featureSites,
        );
    }
    // A points or lines primitive reaches the pipeline as itself, and only
    // the pinned colour pipeline carries its topology: the depth-only
    // pipelines a transmission grab pre-passes through, and the
    // geometry-output tasks, are built at a triangle list for every draw
    // they take. A scene that reached both would silently pre-pass a line as
    // a triangle, so the combination refuses rather than rendering. No
    // corpus asset pairs them.
    if (
        specializationFeatures.pointOrLinePrimitives &&
        (activationPlan.transmission.value ||
            result.manifest.geometryOutputTasks.length > 0)
    ) {
        refuseGeneration(
            "loader:gltf",
            "A glTF point or line primitive in a scene that also reaches " +
                "transmission or a geometry-output task is not lowered: " +
                "those passes build their pipelines at a triangle list.",
            result.manifest.featureSites,
        );
    }
    const emitOptions: UpstreamEmitOptions = {
        ...(result.manifest.features.includes("text:renderable")
            ? { textPipelines: await composeDefaultTextPipelines() }
            : {}),
        ...(result.manifest.features.includes("renderer:text")
            ? {
                  textPipelines: await composeStandaloneTextPipelines(
                      result.manifest.features.includes("text:weight"),
                  ),
              }
            : {}),
        ...(result.manifest.textData
            ? { textData: result.manifest.textData }
            : {}),
        idDiagnostics: options.idDiagnostics,
        ...(result.manifest.engineMsaaSamples !== undefined
            ? { msaaSamples: result.manifest.engineMsaaSamples }
            : {}),
        // The compiler's first-reach record, threaded so late refusals in
        // the composition/lowering layer can name the scene call site that
        // pulled the owning feature in.
        featureSites: result.manifest.featureSites,
        sourceMeshWalks: (result.manifest.meshWalks?.length ?? 0) > 0,
        ...(assetJoin.assetLightNodes !== undefined
            ? { assetLightNodes: assetJoin.assetLightNodes }
            : {}),
        shaderPrograms,
        ...(result.manifest.computePrograms
            ? { computePrograms: result.manifest.computePrograms }
            : {}),
        geometryOutputTasks: result.manifest.geometryOutputTasks,
        postProcessTasks: result.manifest.postProcessTasks,
        postProcessShaders,
        ...(pickingShaders !== undefined ? { pickingShaders } : {}),
        postProcessComposites,
        ...(screenSpaceTasks.length > 0 ? { screenSpaceTasks } : {}),
        ...(nodeParticles.length > 0 ? { nodeParticles } : {}),
        ...(nodeParticleSprite2d.length > 0 ? { nodeParticleSprite2d } : {}),
        ...(nodeParticleRegistrations.length > 0
            ? { nodeParticleRegistrations }
            : {}),
        gpuDeformation,
        morphStorage,
        nonTrianglePrimitives: specializationFeatures.nonTrianglePrimitives,
        // No scene API reaches KHR_gaussian_splatting, so the asset alone
        // decides -- the shape the spec-gloss workflow replacement takes.
        gaussianSplats: specializationFeatures.gaussianSplats,
        // KHR_texture_basisu likewise: packaging leaves compressed mip payloads on
        // the document, and only the asset says whether the loader reads
        // one.
        compressedImages: specializationFeatures.compressedImages,
        nodeVisibility: activationPlan.nodeVisibility.value,
        gltfNodeVisibility: specializationFeatures.nodeVisibility,
        gltfInteractivity: specializationFeatures.interactivity,
        ...(assetJoin.flowGraphs.length > 0
            ? { flowGraphs: assetJoin.flowGraphs }
            : {}),
        spriteCustomShaders: result.manifest.spriteCustomShaders,
        effects: result.manifest.effects,
        ...(esmShadows.length > 0 ? { esmShadows } : {}),
        ...(splatShaderModule !== undefined ? { splatShaderModule } : {}),
        ...(splatSh !== undefined ? { splatSh } : {}),
        ...(pinnedBackgrounds.length > 0 ? { pinnedBackgrounds } : {}),
        splatContainerRotations,
        pureSpriteVertex: result.manifest.pureSpriteVertex,
        plainSpriteLayer: result.manifest.plainSpriteLayer,
        plainBillboardSystem: result.manifest.plainBillboardSystem,
        standardLightLists: reachedStandardLightLists(assetJoin.babylonLights),
        standardDiffuseUv2: reachedDiffuseUv2(
            outputPath,
            result.manifest.assets,
        ),
        animationPointer: specializationFeatures.animationPointer,
        animationPointerMaterials:
            specializationFeatures.animationPointerMaterials,
        assetTransmission: specializationFeatures.assetTransmission,
        transmission: activationPlan.transmission.value,
        materialSpecular: specializationFeatures.materialSpecular,
        // The one static `selectVariant` a scene reaches: the loader reads
        // the variant order and the per-primitive mappings out of the
        // document, so only the chosen name is compiled in.
        selectedMaterialVariant:
            result.manifest.assets.find(
                (asset) => asset.selectedVariant !== undefined,
            )?.selectedVariant ?? "",
        textureTransform: specializationFeatures.textureTransform,
        imageBasedLighting: assetJoin.imageBasedLight,
        gpuInstancing,
        gpuInstanceColors: result.manifest.features.includes(
            "mesh:thin-instance-colors",
        ),
        // The lights the asset's executed light plan registers, not the
        // extension's declaration: a declared light no node instances
        // creates nothing upstream.
        punctualLights: assetJoin.assetLightNodes !== undefined,
        // The arms the composed set carries, read off the composition
        // itself: a glTF material's, a scene-code material's and a caster
        // view's variants all report through `pinnedVariantArms`, so what
        // the pin spliced is what the defines and the slot table declare.
        clearcoat: composedArms.clearcoat,
        sheen: composedArms.sheen,
        pinnedVariants,
        ...(nodeVariants.length > 0 ? { nodeVariants } : {}),
        ...(standardComposition !== undefined
            ? {
                  pinnedStandardVariants: standardComposition.variants,
                  pinnedStandardSelectors: standardComposition.selectors,
                  standardRenderableMeshFeatures:
                      standardRenderableMeshFeatures ?? [],
                  ...(standardRuntimeMeshFeatures !== undefined
                      ? { standardRuntimeMeshFeatures }
                      : {}),
                  ...(standardPluginBindings ? { standardPluginBindings } : {}),
              }
            : {}),
        // Every handle the runtime will hold: the assets' materials, the
        // scene's own creations of any family (handles are creation-ordered
        // across families), then one caster material view per shadow caster,
        // which `registerSceneWithShadowSupport` appends.
        pinnedMaterialCount:
            materialIndexBase +
            result.manifest.sceneMaterialCount +
            casterViewCount,
        renderableMeshFeatures,
        pinnedSkeletonPalette,
        ...(meshProfiles ? { meshProfiles } : {}),
        ...(runtimeMeshFeatures !== undefined ? { runtimeMeshFeatures } : {}),
        iridescence: composedArms.iridescence,
        specularGlossiness: composedArms.specularGlossiness,
        dispersion: composedArms.dispersion,
        occlusionUv2: composedArms.occlusionUv2,
    };
    emitUpstreamGenerated(
        outputPath,
        result.manifest.features,
        emitOptions,
        tree,
    );
    for (const [path, cpp] of result.cppFiles) tree.write(path, cpp);
    tree.prune("sources");
    const imageCodecs = reachedImageCodecs(outputPath, result.manifest.assets);
    const imageCodecLines = imageCodecs
        .map((codec) => `    "${codec}"`)
        .join("\n");
    tree.write(
        "features.cmake",
        `${result.cmake}
set(BBLITE_IMAGE_CODECS
${imageCodecLines || '    ""'}
)
`,
    );
    for (const [include, text] of featureMacroHeaders({
        features: result.manifest.features,
        imageCodecs,
    }))
        tree.write(`upstream/include/${include}`, text);
    // The reached-file list: the program's files (recorded by the
    // compiler) plus what this run read beside them -- the host-UI
    // companion and every asset materialized from a repository path. A
    // remote asset is pinned by URL and a data URL carries its bytes in the
    // source, so neither is a file to list. `scene -- compile` skips a
    // scene whose listed inputs are unchanged, so a read added here that
    // is not listed is a read that skip cannot see.
    const repositoryRoot = findRepositoryRoot(
        dirname(fileURLToPath(import.meta.url)),
    );
    const listInput = (path: string): void => {
        result.manifest.inputs.push(
            repositoryRelativePath(repositoryRoot, path),
        );
    };
    if (options.hostUi) listInput(options.hostUi);
    for (const asset of result.manifest.assets) {
        const local = localAssetPath(asset.source, inputPath);
        if (local !== undefined) listInput(local);
    }
    for (const source of decoderSources) {
        const local = localAssetPath(source, inputPath);
        if (local !== undefined) listInput(local);
    }
    if (decoderSources.size)
        result.manifest.adaptations.push({
            id: "configured-asset-decoders",
            category: "asset-materialization",
            risk: "medium",
            sourceSemantics:
                "Decoder setup selects the JavaScript and WebAssembly files loaded when the browser first reaches compressed geometry or KTX2 images.",
            nativeSemantics:
                "Packaging executes the configured decoder files and stores decoded geometry or transcoded texture bytes. Decoder reads remain lazy, their contents distinguish cached results, and local files participate in scene input tracking.",
            validation: [
                "asset-decoders: configured Draco execution, KTX2 URL overrides and cache invalidation by decoder bytes",
            ],
        });
    result.manifest.inputs = [...new Set(result.manifest.inputs)].sort();
    const recorded = recordedManifest(result.manifest, repositoryRoot);
    tree.write("manifest.json", `${JSON.stringify(recorded, null, 2)}\n`);
    tree.write(
        "fidelity.json",
        `${JSON.stringify(
            {
                source: recorded.source,
                adaptations: recorded.adaptations,
            },
            null,
            2,
        )}\n`,
    );
    // The activation inventory: one row per unit across every mechanism
    // generation used — runtime features, capability defines, codecs,
    // emit options, composition, and the generation-time refusals — with
    // the concrete reason for this scene and the pinned provenance each
    // mirrors, built from the same values the emitters above consumed.
    tree.write(
        featureActivationPath,
        `${JSON.stringify(
            featureActivationRows({
                features: result.manifest.features,
                featureSites: recorded.featureSites,
                assetJoinedFeatures: assetJoin.joined,
                specialization: specializationFeatures,
                activation: activationPlan,
                emit: emitOptions,
                imageCodecs,
                gltfAssetNames: gltfAssets.map((asset) => asset.output),
                pinnedMaxLights: readPinnedMaxLights(),
                interleave: {
                    sceneMeshGltfAssetsBefore: result.manifest.sceneMeshes.map(
                        (mesh) => mesh.gltfAssetsBefore,
                    ),
                    scenePbrMaterialGltfAssetsBefore:
                        result.manifest.scenePbrMaterials.map(
                            (material) => material.gltfAssetsBefore,
                        ),
                    gltfAssetCount: gltfAssets.length,
                },
                composition: {
                    lightKinds,
                    toneMappingStates,
                    mutableToneMappingEnabled:
                        result.manifest.mutableToneMappingEnabled,
                },
            }),
            null,
            2,
        )}\n`,
    );

    // Prune before stamping: a source this run no longer emits must be
    // gone from the tree before its digest is taken. The stamp header is
    // written after the digest but belongs to this run, so it is claimed
    // first -- pruning it would rewrite it on every generation and
    // recompile everything that includes it.
    tree.keep(buildStampHeaderPath);
    tree.prune("upstream");
    // A valid presentation-only program can reach no Babylon shader. Keep
    // the stage's input directory even when pruning removed its last shader.
    mkdirSync(resolve(outputPath, "upstream", "shaders"), { recursive: true });
    // Last, because it digests everything written above. The executable
    // embeds this and the parity gate refuses a binary whose stamp no
    // longer matches the inputs on disk.
    const { stamp, inputs } = computeBuildStamp(outputPath);
    tree.write(buildStampHeaderPath, buildStampHeader(stamp));
    tree.write(
        buildStampInputsPath,
        `${JSON.stringify({ stamp, inputs }, null, 2)}\n`,
    );
    console.log(`Generated ${outputPath}`);
    console.log(`Features: ${result.manifest.features.join(", ")}`);
    if (result.manifest.assets.length > 0) {
        console.log(
            `Assets: ${result.manifest.assets.map((asset) => asset.output).join(", ")}`,
        );
    }
}

main().catch((error: unknown) => {
    if (error instanceof CompileError || error instanceof Error) {
        console.error(error.message);
    } else {
        console.error(String(error));
    }
    process.exitCode = 1;
});
