#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
    CompileAsset,
    CompileError,
    compileSource,
    renderFeaturesCmake,
} from "./compiler.js";
import type { CompiledShaderProgram } from "./compiler.js";
import type { Feature } from "./compiler/types.js";
import { reachedGeneratedSources } from "./generated-sources.js";
import { shaderMaterialPrograms } from "./shader-material-programs.js";
import { emitUpstreamGenerated } from "./upstream-lower.js";
import { emitAssetSpecializations } from "./asset-specializer.js";
import { packageBabylon } from "./babylon-packager.js";
import { packageGltf } from "./gltf-packager.js";
import { decompressGeometry } from "./compressed-geometry.js";
import { packageDdsEnvironment } from "./dds-packager.js";
import { packageHdrEnvironment } from "./hdr-packager.js";
import { generateIblBrdfLutRgba16f } from "./ibl-brdf-lut.js";
import {
    buildStampHeader,
    buildStampHeaderPath,
    buildStampInputsPath,
    computeBuildStamp,
} from "./build-stamp.js";
import {
    drawSpriteAtlasPng,
    parseSpriteAtlasAssetSource,
} from "./sprite-atlas-packager.js";
import { findRepositoryRoot, readUpstreamPin } from "./upstream-source.js";
import { GeneratedTree } from "./generated-tree.js";
import { pinnedShaderHelpers } from "./pinned-pbr-variants.js";
import { writePinnedPbrVariants } from "./pinned-pbr-variant-output.js";
import { downloadCached } from "./asset-download-cache.js";
import {
    assertArmsCovered,
    composeGltfMaterials,
    composeRenderableVariants,
    composeScenePbrVariants,
    gltfHasImageBasedLight,
    gltfLightKinds,
    gltfMaterialCount,
    gltfRenderableFeatures,
    proceduralRenderableFeatures,
    type PinnedRenderableVariant,
} from "./pinned-material-arms.js";
import {
    pinnedSceneArms,
    pinnedSingleLightTypes,
} from "./pinned-scene-arms.js";
import { pinnedMeshFeaturesFromPrimitive } from "./pinned-mesh-features.js";

interface CliOptions {
    input: string;
    output: string;
    title?: string;
    width?: number;
    height?: number;
    idDiagnostics: boolean;
    pbrDiagnostics: boolean;
}

function usage(): never {
    console.error("Usage: bblitec <entry.ts> --out <directory> [--title <text>] [--width <pixels>] [--height <pixels>] [--id-diagnostics] [--pbr-diagnostics]");
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
    let title: string | undefined;
    let width: number | undefined;
    let height: number | undefined;
    let idDiagnostics = false;
    let pbrDiagnostics = false;

    for (let index = 1; index < arguments_.length; index += 1) {
        const flag = arguments_[index];
        const value = arguments_[index + 1];
        switch (flag) {
            case "--out":
                if (!value) usage();
                output = value;
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
            case "--id-diagnostics":
                idDiagnostics = true;
                break;
            case "--pbr-diagnostics":
                pbrDiagnostics = true;
                break;
            default:
                throw new Error(`Unknown argument '${flag}'.`);
        }
    }

    if (!output) {
        usage();
    }

    return {
        input,
        output,
        idDiagnostics,
        pbrDiagnostics,
        ...(title ? { title } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
    };
}

async function assetBytes(
    source: string,
    inputPath: string,
): Promise<Uint8Array> {
    if (!/^https?:\/\//i.test(source)) {
        return new Uint8Array(
            readFileSync(resolve(dirname(inputPath), source)),
        );
    }
    return downloadCached(source);
}

async function materializeAsset(asset: CompileAsset, inputPath: string, outputPath: string): Promise<void> {
    const source = materializedAssetSource(
        asset.source,
        inputPath,
    );
    const destination = resolve(outputPath, "assets", asset.output);
    mkdirSync(dirname(destination), { recursive: true });

    if (asset.source === "generated:pinned-ibl-brdf-lut") {
        writeFileSync(destination, generateIblBrdfLutRgba16f());
        return;
    }

    if (asset.kind === "sprite-atlas") {
        writeFileSync(
            destination,
            await drawSpriteAtlasPng(
                parseSpriteAtlasAssetSource(
                    asset.source,
                    findRepositoryRoot(dirname(inputPath)),
                ),
            ),
        );
        return;
    }

    if (asset.kind === "babylon") {
        await packageBabylon(source, dirname(inputPath), destination);
        return;
    }

    if (asset.kind === "gltf" && /\.gltf(?:[?#]|$)/i.test(source)) {
        writeFileSync(
            destination,
            await decompressGeometry(
                await packageGltf(source, dirname(inputPath)),
                source,
            ),
        );
        return;
    }

    if (asset.kind === "dds-environment") {
        writeFileSync(
            destination,
            packageDdsEnvironment(await assetBytes(source, inputPath)),
        );
        return;
    }

    if (asset.kind === "hdr-environment") {
        writeFileSync(
            destination,
            await packageHdrEnvironment(
                await assetBytes(source, inputPath),
                asset.faceSize ?? 256,
            ),
        );
        return;
    }

    if (/^https?:\/\//i.test(source)) {
        writeFileSync(
            destination,
            await decompressGeometry(
                await downloadCached(source),
                source,
            ),
        );
        return;
    }

    writeFileSync(
        destination,
        await decompressGeometry(
            new Uint8Array(readFileSync(resolve(dirname(inputPath), source))),
            source,
        ),
    );
}

/**
 * The optional image codecs a scene's materialized assets can reach, each
 * with the ways an asset names its content. PNG is not listed because it is
 * unconditional: `.env` RGBD payloads, the RGBD BRDF LUT and screenshot
 * capture all go through it.
 */
const optionalImageCodecs: ReadonlyArray<{
    codec: string;
    mimeType: string;
    namePattern: RegExp;
}> = [
    {
        codec: "jpeg",
        mimeType: "image/jpeg",
        namePattern: /\.jpe?g(?:[?#]|$)/i,
    },
    {
        codec: "webp",
        mimeType: "image/webp",
        namePattern: /\.webp(?:[?#]|$)/i,
    },
];

function glbImages(
    bytes: Buffer,
): { mimeType?: string; uri?: string }[] {
    if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67) {
        return [];
    }
    const jsonLength = bytes.readUInt32LE(12);
    if (bytes.length < 20 + jsonLength) {
        return [];
    }
    const document = JSON.parse(
        bytes.subarray(20, 20 + jsonLength).toString("utf8"),
    ) as { images?: { mimeType?: string; uri?: string }[] };
    return document.images ?? [];
}

function reachedImageCodecs(
    outputPath: string,
    assets: CompileAsset[],
): string[] {
    // PNG stays unconditional: .env RGBD payloads and the RGBD BRDF
    // LUT decode through PNG, and screenshot capture encodes PNG.
    // Every other codec is reached only when a materialized asset carries
    // its content; the native build then links that codec through the
    // matching vcpkg manifest feature and packaging ships its runtime.
    const reached = new Set<string>();
    for (const asset of assets) {
        const materialized = resolve(outputPath, "assets", asset.output);
        const bytes = existsSync(materialized)
            ? readFileSync(materialized)
            : undefined;
        const isGlb = /\.glb$/i.test(asset.output);
        const isTextDocument = /\.(?:babylon|gltf)$/i.test(asset.output);
        const images = bytes && isGlb ? glbImages(bytes) : [];
        const text =
            bytes && isTextDocument ? bytes.toString("utf8") : undefined;
        for (const { codec, mimeType, namePattern } of optionalImageCodecs) {
            if (reached.has(codec)) {
                continue;
            }
            const inGlb = images.some(
                (image) =>
                    image.mimeType === mimeType ||
                    (typeof image.uri === "string" &&
                        (new RegExp(`^data:${mimeType}`, "i").test(image.uri) ||
                            namePattern.test(image.uri))),
            );
            const inText =
                text !== undefined &&
                (new RegExp(mimeType.replace("/", "\\/"), "i").test(text) ||
                    new RegExp(
                        `${namePattern.source.replace(/\(\?:\[\?#\]\|\$\)/, "")}["']`,
                        "i",
                    ).test(text));
            if (namePattern.test(asset.output) || inGlb || inText) {
                reached.add(codec);
            }
        }
    }
    return [
        "png",
        ...optionalImageCodecs
            .map(({ codec }) => codec)
            .filter((codec) => reached.has(codec)),
    ];
}

/**
 * How many Standard light slots the scene's materialized `.babylon` assets
 * ask for. The pinned template sizes its light array at generation time from
 * `MAX_LIGHTS`; native unrolls one slot per light instead, and the count is
 * knowable here because the loader only accepts point lights (`type: 0`) and
 * the asset is on disk before the emitters run.
 */
interface BabylonLight {
    type?: number;
    includedOnlyMeshesIds?: unknown[];
    excludedMeshesIds?: unknown[];
}

function babylonLights(
    outputPath: string,
    assets: CompileAsset[],
): BabylonLight[] {
    const result: BabylonLight[] = [];
    for (const asset of assets) {
        if (asset.kind !== "babylon") {
            continue;
        }
        const materialized = resolve(outputPath, "assets", asset.output);
        if (!existsSync(materialized)) {
            continue;
        }
        const document = JSON.parse(
            readFileSync(materialized, "utf8"),
        ) as { lights?: BabylonLight[] };
        result.push(...(document.lights ?? []));
    }
    return result;
}

/**
 * Whether any reached `.babylon` material authors its diffuse texture
 * against the second UV set. The specular and ambient slots always carried
 * that selection; a scene needs it on the diffuse slot only when its assets
 * ask for it, which Sponza's upper walls do.
 */
function reachedDiffuseUv2(
    outputPath: string,
    assets: CompileAsset[],
): boolean {
    for (const asset of assets) {
        if (asset.kind !== "babylon") {
            continue;
        }
        const materialized = resolve(outputPath, "assets", asset.output);
        if (!existsSync(materialized)) {
            continue;
        }
        const document = JSON.parse(
            readFileSync(materialized, "utf8"),
        ) as {
            materials?: { diffuseTexture?: { coordinatesIndex?: number } }[];
        };
        if (
            (document.materials ?? []).some(
                (material) =>
                    material.diffuseTexture?.coordinatesIndex === 1,
            )
        ) {
            return true;
        }
    }
    return false;
}

/**
 * Whether any reached `.babylon` material carries a bump map. The pinned
 * Standard material composes its normal-map fragment per material, so a
 * scene with none emits the loader, uniform block, shader and texture slot
 * it emitted before.
 */
function reachedStandardBump(
    outputPath: string,
    assets: CompileAsset[],
): boolean {
    for (const asset of assets) {
        if (asset.kind !== "babylon") {
            continue;
        }
        const materialized = resolve(outputPath, "assets", asset.output);
        if (!existsSync(materialized)) {
            continue;
        }
        const document = JSON.parse(
            readFileSync(materialized, "utf8"),
        ) as { materials?: { bumpTexture?: unknown }[] };
        if (
            (document.materials ?? []).some(
                (material) => material.bumpTexture,
            )
        ) {
            return true;
        }
    }
    return false;
}

function reachedStandardLights(lights: BabylonLight[]): number {
    return lights.filter((light) => light.type === 0).length;
}

/**
 * Whether any reached light names the meshes it applies to. The pinned
 * engine keeps that as a per-mesh light set, which the Standard uniform
 * block only has to express for a scene whose assets declare one.
 */
function reachedStandardLightLists(
    lights: BabylonLight[],
): boolean {
    return lights.some(
        (light) =>
            light.type === 0 &&
            ((light.includedOnlyMeshesIds ?? []).length > 0 ||
                (light.excludedMeshesIds ?? []).length > 0),
    );
}

function materializedAssetSource(
    source: string,
    inputPath: string,
): string {
    if (
        !source.startsWith("/") ||
        !inputPath
            .replace(/\\/g, "/")
            .includes(
                "/corpus/babylon-lite/lab/lite/src/lite/",
            )
    ) {
        return source;
    }
    const pin = readUpstreamPin();
    return (
        "https://raw.githubusercontent.com/" +
        `BabylonJS/Babylon-Lite/${pin.sourceVersion}` +
        `/lab/public${source}`
    );
}

async function main(): Promise<void> {
    const options = parseArguments(process.argv.slice(2));
    const inputPath = resolve(options.input);
    const outputPath = resolve(options.output);
    const source = readFileSync(inputPath, "utf8");
    const result = compileSource(source, {
        fileName: inputPath,
        ...(options.title ? { title: options.title } : {}),
        ...(options.width ? { width: options.width } : {}),
        ...(options.height ? { height: options.height } : {}),
    });

    mkdirSync(outputPath, { recursive: true });
    // Assets are materialized from their sources every run; the compiled
    // tree is written through `tree`, which rewrites only what changed
    // and prunes what this run no longer emits.
    rmSync(resolve(outputPath, "assets"), { recursive: true, force: true });
    const tree = new GeneratedTree(outputPath);
    await Promise.all(result.manifest.assets.map((asset) => materializeAsset(asset, inputPath, outputPath)));
    const specializationFeatures =
        emitAssetSpecializations(outputPath, result.manifest.assets);
    tree.keep("upstream/gltf-specialization.json");
    if (specializationFeatures.imageBasedLighting) {
        const brdfAsset: CompileAsset = {
            source: "generated:pinned-ibl-brdf-lut",
            output: "gltf-ibl-brdf-lut.rgba16f",
            kind: "texture",
        };
        writeFileSync(
            resolve(outputPath, "assets", brdfAsset.output),
            generateIblBrdfLutRgba16f(),
        );
        result.manifest.assets.push(brdfAsset);
    }
    // Resolve reached variant slugs to full program records: predeclared
    // names come from the pinned registry (no defaults), scene-local
    // programs travel in the manifest.
    const shaderPrograms: CompiledShaderProgram[] =
        result.manifest.shaderVariants.map((name) => {
            const custom =
                result.manifest.customShaderPrograms.find(
                    (program) => program.name === name,
                );
            if (custom) {
                return custom;
            }
            const predeclared = shaderMaterialPrograms.find(
                (program) => program.name === name,
            );
            if (!predeclared) {
                throw new Error(
                    `Unknown shader variant '${name}'.`,
                );
            }
            return {
                ...predeclared,
                uniformDefaults:
                    predeclared.uniformDefaults ?? [],
            };
        });
    const reachedBabylonLights = babylonLights(
        outputPath,
        result.manifest.assets,
    );
    const emittedArms = {
        clearcoat:
            specializationFeatures.clearcoat ||
            result.manifest.features.includes("material:clearcoat"),
        clearcoatF0Remap: result.manifest.features.includes(
            "material:clearcoat-f0-remap",
        ),
        sheen:
            specializationFeatures.sheen ||
            result.manifest.features.includes("material:sheen"),
        sheenAlbedoScaling:
            specializationFeatures.sheen ||
            result.manifest.features.includes(
                "material:sheen-albedo-scaling",
            ),
        iridescence: specializationFeatures.iridescence,
        dispersion: specializationFeatures.dispersion,
        occlusionUv2: specializationFeatures.occlusionUv2,
        // The same derivation `upstream-lower.ts` uses for the compiled
        // define: transmission is reached from scene code and from a loaded
        // asset alike, because the pin enables it for any transmissive
        // surface the asset carries without the scene naming it.
        transmission:
            result.manifest.features.includes("renderer:transmission") ||
            specializationFeatures.assetTransmission,
    };
    // Every glTF material the scene loads, composed through Babylon Lite's own
    // pipeline. An arm it reaches that the emitted fragment does not carry is
    // refused here, where it names the material, rather than shipping as a
    // shading bias nothing points at.
    // The scene arms a renderable can reach: the light modes the scene compiles
    // support for, and — with an environment loaded, which is what turns tone
    // mapping on upstream — both tone-mapping states. Generation cannot know how
    // many lights will end up affecting a given mesh, so it composes the arms
    // and the runtime selects the one its own light walk produces.
    // An asset's own KHR_lights_punctual lights are the scene's lights: the
    // pin's loader creates them exactly like scene code does, and every
    // consumer keyed on the light features -- the composed arms, the pinned
    // light writers, the generated-source table -- reads the one authority,
    // so the kinds the assets reach join the manifest here.
    let assetLightsAdded = false;
    for (const asset of result.manifest.assets) {
        if (asset.kind !== "gltf") continue;
        const assetPath = resolve(outputPath, "assets", asset.output);
        const assetFeatures = gltfLightKinds(assetPath).map(
            (kind) => `light:${kind}` as Feature,
        );
        // EXT_lights_image_based installs the asset's own environment, which
        // composes the same arms `environment:ibl` does.
        if (gltfHasImageBasedLight(assetPath)) {
            assetFeatures.push("environment:ibl" as Feature);
        }
        for (const feature of assetFeatures) {
            if (!result.manifest.features.includes(feature)) {
                result.manifest.features.push(feature);
                assetLightsAdded = true;
            }
        }
    }
    if (assetLightsAdded) {
        // The features drive the generated-source table and the CMake
        // projection, both rendered at compile time; re-render them from the
        // same authorities so the joined features stay declared everywhere.
        result.manifest.generatedSources = reachedGeneratedSources(
            result.manifest.features as Feature[],
        );
        result.cmake = renderFeaturesCmake(
            result.manifest.features as Feature[],
            result.manifest.runtimeSources,
            result.manifest.generatedSources,
        );
    }
    const hasEnvironment = result.manifest.features.includes(
        "environment:ibl",
    );
    const lightKinds = pinnedSingleLightTypes.filter((kind) =>
        result.manifest.features.includes(`light:${kind}`)
    );
    const sceneArms = await pinnedSceneArms({
        lightKinds,
        multiLight: lightKinds.length > 0,
        noLight: true,
        toneMapping: hasEnvironment ? [false, true] : [false],
        environment: hasEnvironment,
        fog: result.manifest.features.includes("renderer:fog"),
    });
    // The pin's enableSceneTransmission marks every material in the scene
    // `_linearImageProcessing` (markPbrMaterialsLinear), so each composed
    // fragment wraps its processing tail in `if(scene.vImageInfos.w>=0.0)`
    // and the retargeted linear pass runs with w = -1.
    const linearImageProcessing =
        result.manifest.features.includes("renderer:transmission") ||
        // Asset-carried KHR_materials_transmission enables the runtime's
        // transmission exactly like the feature does (scene_core stamps
        // `transmission_enabled` from the same disjunction), and the pin
        // marks every material linear either way.
        specializationFeatures.assetTransmission;
    // The runtime keys the variant table by material handle, which is
    // creation order: each glTF load appends its materials, and a scene
    // material appends where its `createPbrMaterial` runs. Every reached
    // scene creates its materials after every load, so the sequence is the
    // assets' materials in load order followed by the scene's; a material
    // created before a later load would interleave, and stays a named error.
    const composedVariants: PinnedRenderableVariant[] = [];
    const gltfAssets = result.manifest.assets.filter(
        (asset) => asset.kind === "gltf",
    );
    // The mesh half of the variant key, per runtime mesh handle: each glTF
    // load appends its renderables in the pinned loader's node-order walk,
    // and each scene-code builder appends one mesh of the fixed procedural
    // attribute set, in the same creation order the runtime hands out
    // handles. Computed before composition because a scene-code material can
    // be assigned to any of these renderables, so its variants compose over
    // every distinct set here.
    const renderableMeshFeatures: number[] = [];
    for (const asset of gltfAssets) {
        renderableMeshFeatures.push(
            ...(await gltfRenderableFeatures(
                resolve(outputPath, "assets", asset.output),
            )),
        );
    }
    for (const mesh of result.manifest.sceneMeshes) {
        if (mesh.gltfAssetsBefore !== gltfAssets.length) {
            throw new Error(
                "A scene-code mesh created before a later glTF load " +
                    "would interleave the renderable key; no scene " +
                    "reaches this yet.",
            );
        }
        if (mesh.kind === "from-data") {
            // The recorded streams, walked exactly the way a glTF primitive
            // is: normals are a required argument, so the flat-normal arm is
            // unreachable from this builder.
            renderableMeshFeatures.push(
                await pinnedMeshFeaturesFromPrimitive({
                    attributes: {
                        POSITION: 0,
                        NORMAL: 0,
                        TEXCOORD_0: 0,
                        ...(mesh.hasUv2 ? { TEXCOORD_1: 0 } : {}),
                        ...(mesh.hasTangents ? { TANGENT: 0 } : {}),
                        ...(mesh.hasColors ? { COLOR_0: 0 } : {}),
                    },
                }),
            );
            continue;
        }
        renderableMeshFeatures.push(await proceduralRenderableFeatures());
    }
    let materialIndexBase = 0;
    for (const asset of gltfAssets) {
        const path = resolve(outputPath, "assets", asset.output);
        const composed = await composeGltfMaterials(path, {
            linearImageProcessing,
        });
        assertArmsCovered(composed, emittedArms, asset.output);
        const variants = await composeRenderableVariants(
            path,
            sceneArms,
            materialIndexBase,
            { linearImageProcessing },
        );
        composedVariants.push(...variants);
        materialIndexBase += gltfMaterialCount(path);
    }
    if (result.manifest.scenePbrMaterials.length > 0) {
        for (const material of result.manifest.scenePbrMaterials) {
            if (material.gltfAssetsBefore !== gltfAssets.length) {
                throw new Error(
                    "A scene-code PBR material created before a later glTF " +
                        "load would interleave the variant table's " +
                        "creation-order key; no scene reaches this yet.",
                );
            }
        }
        composedVariants.push(
            ...(await composeScenePbrVariants(
                result.manifest.scenePbrMaterials,
                sceneArms,
                materialIndexBase,
                [
                    ...new Set([
                        ...renderableMeshFeatures,
                        await proceduralRenderableFeatures(),
                    ]),
                ],
                { linearImageProcessing },
            )),
        );
    }
    // The pin's own composed stages, one file per distinct variant. These are
    // the artifacts that replace `templates/renderer/pbr.frag.wgsl`: the
    // renderer selects per-material behaviour from uniform lanes inside one
    // fragment where Babylon composes a fragment per feature set, and this is
    // that set, written by the pin rather than transcribed here.
    const pinnedVariants = writePinnedPbrVariants(tree, composedVariants);
    // Scene code can keep creating meshes after registration -- the runtime
    // sweep spawns per-frame boxes from one compiled call site -- so handles
    // past the static table take this fallback when every scene-code mesh
    // shares one attribute set, and refuse otherwise.
    const sceneMeshFeatureValues = new Set(
        renderableMeshFeatures.slice(
            renderableMeshFeatures.length -
                result.manifest.sceneMeshes.length,
        ),
    );
    const runtimeMeshFeatures =
        result.manifest.sceneMeshes.length === 0
            ? await proceduralRenderableFeatures()
            : sceneMeshFeatureValues.size === 1
                ? [...sceneMeshFeatureValues][0]!
                : undefined;
    emitUpstreamGenerated(outputPath, result.manifest.features, {
        idDiagnostics: options.idDiagnostics,
        pbrDiagnostics: options.pbrDiagnostics,
        shaderPrograms,
        geometryOutputTasks: result.manifest.geometryOutputTasks,
        gpuDeformation:
            specializationFeatures.gpuDeformation ||
            result.manifest.features.includes(
                "mesh:morph-targets",
            ),
        morphStorage: specializationFeatures.morphStorage,
        nonTrianglePrimitives:
            specializationFeatures.nonTrianglePrimitives,
        nodeVisibility: specializationFeatures.nodeVisibility,
        standardLights: reachedStandardLights(reachedBabylonLights),
        standardLightLists: reachedStandardLightLists(
            reachedBabylonLights,
        ),
        standardDiffuseUv2: reachedDiffuseUv2(
            outputPath,
            result.manifest.assets,
        ),
        standardBump: reachedStandardBump(
            outputPath,
            result.manifest.assets,
        ),
        animationPointer:
            specializationFeatures.animationPointer,
        animationPointerMaterials:
            specializationFeatures.animationPointerMaterials,
        assetTransmission: specializationFeatures.assetTransmission,
        materialSpecular: specializationFeatures.materialSpecular,
        textureTransform:
            specializationFeatures.textureTransform,
        imageBasedLighting:
            specializationFeatures.imageBasedLighting,
        gpuInstancing:
            specializationFeatures.gpuInstancing ||
            result.manifest.features.includes(
                "mesh:thin-instances",
            ) ||
            result.manifest.features.includes(
                "mesh:thin-instances-dynamic",
            ),
        multiLight:
            specializationFeatures.multiLight,
        clearcoat: emittedArms.clearcoat,
        sheen: emittedArms.sheen,
        // The two pinned sheen models are composed, not switched at run time,
        // so one fragment cannot serve both. A glTF KHR_materials_sheen
        // material takes the albedo-scaling arm; `setPbrSheen` defaults to
        // the legacy one and can ask for the other explicitly.
        sheenAlbedoScaling: emittedArms.sheenAlbedoScaling,
        // The coat's base-F0 remap is composed for every clearcoat except a
        // glTF one: `gltf-ext-clearcoat.ts` is the single caller passing
        // `useF0Remap: false`. So it follows the scene-code setter and not
        // the asset specializer's `KHR_materials_clearcoat` flag.
        clearcoatF0Remap: emittedArms.clearcoatF0Remap,
        // Taken from a real composition rather than transcribed, so the coat's
        // formulas are the pin's own text under the pin's own names.
        pinnedHelpers: await pinnedShaderHelpers(),
        pinnedVariants,
        // The runtime's material-handle count: the assets' materials plus
        // every scene-code creation of any family, since handles are
        // creation-ordered across families.
        pinnedMaterialCount:
            materialIndexBase + result.manifest.sceneMaterialCount,
        renderableMeshFeatures,
        ...(runtimeMeshFeatures !== undefined
            ? { runtimeMeshFeatures }
            : {}),
        iridescence: emittedArms.iridescence,
        dispersion: emittedArms.dispersion,
        occlusionUv2: emittedArms.occlusionUv2,
    }, tree);
    tree.write("main.cpp", result.cpp);
    const imageCodecs = reachedImageCodecs(
        outputPath,
        result.manifest.assets,
    );
    const imageCodecLines = imageCodecs
        .map((codec) => `    "${codec}"`)
        .join("\n");
    tree.write(
        "features.cmake",
        `${result.cmake}
set(BBLITE_IMAGE_CODECS
${imageCodecLines}
)
`,
    );
    tree.write(
        "manifest.json",
        `${JSON.stringify(result.manifest, null, 2)}\n`,
    );
    tree.write(
        "fidelity.json",
        `${JSON.stringify(
            {
                source: result.manifest.source,
                adaptations: result.manifest.adaptations,
            },
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
        console.log(`Assets: ${result.manifest.assets.map((asset) => asset.output).join(", ")}`);
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
