#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
    CompileAsset,
    CompileError,
    compileSource,
    renderFeaturesCmake,
} from "./compiler.js";
import {
    composeCloudPickingShader,
    composeMeshPickingShader,
} from "./pinned-picking-shaders.js";
import type { CompiledShaderProgram } from "./compiler.js";
import type {
    CompiledNodeParticles,
    Feature,
} from "./compiler/types.js";
import { reachedGeneratedSources } from "./generated-sources.js";
import {
    predeclaredShaderProgram,
    shaderMaterialPrograms,
} from "./shader-material-programs.js";
import {
    emitUpstreamGenerated,
    readPinnedMaxLights,
    type UpstreamEmitOptions,
} from "./upstream-lower.js";
import { emitAssetSpecializations } from "./asset-specializer.js";
import { composeEsmShadow } from "./pinned-esm-shadow.js";
import {
    composeComposite,
    composePostProcess,
} from "./pinned-post-process.js";
import {
    featureActivationPath,
    featureActivationRows,
} from "./feature-activation.js";
import { packageBabylon } from "./babylon-packager.js";
import { packageGltf } from "./gltf-packager.js";
import { resolveGeometryExtensions } from "./compressed-geometry.js";
import { glbJsonText } from "./gltf-document.js";
// The dds/hdr/splat/basis packagers and the node-particle bake are imported
// lazily at their per-kind branches: each top-level-awaits its pinned
// modules (the HDR one transitively loads the browser harness), so a static
// import makes every compile pay for asset kinds it never packages.
import { compressedTextureLowerer } from "./compiler/compressed-texture.js";
import { parseDataUrl } from "./data-url.js";
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
} from "./executed-module-assets.js";
import { findRepositoryRoot, readUpstreamPin } from "./upstream-source.js";
import { GeneratedTree } from "./generated-tree.js";
import { downloadCached } from "./asset-download-cache.js";
import {
    gltfHasImageBasedLight,
    gltfLightKinds,
    gltfLightNodeCount,
} from "./pinned-material-arms.js";
import {
    babylonLights,
    reachedDiffuseUv2,
    reachedStandardBump,
    reachedStandardLightLists,
    reachedStandardLights,
    type BabylonLight,
} from "./babylon-asset-features.js";
import { pinnedFeaturesCarrySkeleton } from "./pinned-mesh-features.js";
import { DEFORMATION_BONE_SLOTS } from "./shader-builtins-standard.js";
import { composeScenePipeline } from "./compose-pipeline.js";
import {
    composeSplatModule,
    splatFragmentRecords,
} from "./pinned-splat-fragments.js";
import { assetRecord } from "./compiler/assets.js";
import type {
    NodeParticleRegistrationEmit,
    NodeParticleSprite2DEmit,
    NodeParticleSystemEmit,
} from "./lowering/node-particle-lowerer.js";

interface CliOptions {
    input: string;
    output: string;
    title?: string;
    width?: number;
    height?: number;
    search?: string;
    idDiagnostics: boolean;
}

function usage(): never {
    console.error("Usage: bblitec <entry.ts> --out <directory> [--title <text>] [--width <pixels>] [--height <pixels>] [--search <query>] [--id-diagnostics]");
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
    let search: string | undefined;
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
            case "--id-diagnostics":
                idDiagnostics = true;
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
        ...(title ? { title } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        ...(search ? { search } : {}),
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
    if (!/^https?:\/\//i.test(source)) {
        return new Uint8Array(
            readFileSync(resolve(dirname(inputPath), source)),
        );
    }
    return downloadCached(source);
}

async function materializeAsset(
    asset: CompileAsset,
    inputPath: string,
    outputPath: string,
    assetPayloads: ReadonlyMap<string, string>,
): Promise<void> {
    const inlineSource = assetPayloads.get(asset.source);
    if (
        asset.source.startsWith("generated:data-url:") &&
        inlineSource === undefined
    ) {
        throw new Error(
            `Missing materialization payload for '${asset.source}'.`,
        );
    }
    const source = materializedAssetSource(
        inlineSource ?? asset.source,
        inputPath,
    );
    const destination = resolve(outputPath, "assets", asset.output);
    mkdirSync(dirname(destination), { recursive: true });

    if (asset.source === "generated:pinned-ibl-brdf-lut") {
        writeFileSync(destination, await generateIblBrdfLutRgba16f());
        return;
    }

    // The two asset kinds a scene module produces rather than fetches: same
    // execution, one decoder each for what the export returned.
    const bake =
        asset.kind === "pixels"
            ? bakePixelBytes
            : asset.kind === "sprite-atlas"
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
        await packageBabylon(source, dirname(inputPath), destination);
        return;
    }

    if (asset.kind === "gltf" && /\.gltf(?:[?#]|$)/i.test(source)) {
        writeFileSync(
            destination,
            await resolveGeometryExtensions(
                await packageGltf(source, dirname(inputPath)),
                source,
            ),
        );
        return;
    }

    if (asset.kind === "splat") {
        const { packageSplat } = await import("./splat-packager.js");
        writeFileSync(
            destination,
            packageSplat(await assetBytes(source, inputPath)).rows,
        );
        return;
    }

    if (asset.kind === "basis") {
        // The one texture whose bytes the browser produces: the pin fetches
        // its transcoder from a CDN and picks a target format from the
        // device, so generation runs the pinned loader and packages what it
        // uploaded. The file itself rides the ordinary download cache and is
        // served back to the page from the loopback origin, so a recompile
        // asks the CDN for the transcoder alone.
        const { transcodeBasisTexture, writeKtx1 } = await import(
            "./basis-transcode.js"
        );
        const lowerer = compressedTextureLowerer();
        const transcoded = await transcodeBasisTexture(
            source,
            await assetBytes(source, inputPath),
        );
        writeFileSync(
            destination,
            writeKtx1(
                transcoded,
                lowerer.magicBytes(),
                lowerer.glInternalFormat(transcoded.gpuFormat),
                lowerer.headerLayout(),
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
    writeFileSync(
        destination,
        await resolveGeometryExtensions(
            await assetBytes(source, inputPath),
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
    const text = glbJsonText(bytes);
    if (text === undefined) {
        return [];
    }
    const document = JSON.parse(text) as {
        images?: { mimeType?: string; uri?: string }[];
    };
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
): Promise<{
    systems: NodeParticleSystemEmit[];
    sprite2d: NodeParticleSprite2DEmit[];
    registrations: NodeParticleRegistrationEmit[];
}> {
    const { bakeNodeParticles } = await import("./pinned-node-particle.js");
    const bake = await bakeNodeParticles(program);
    const systems = bake.systems.map((system) => {
        // A texture the scene assigned is already a generated asset -- the
        // pixel-buffer module the compiler registered -- so only a graph's
        // own loaded image is packaged from its URL here.
        const asset =
            system.texture && !system.texture.sceneAssigned
                ? assetRecord(
                      system.texture.url,
                      "texture",
                      assetPayloads,
                  )
                : undefined;
        const assigned = program.textures.find(
            (entry) =>
                entry.set === system.set &&
                entry.system === system.system,
        );
        const set = program.sets[system.set];
        return {
            bake: system,
            exactBlend:
                set?.builder === "buildNodeParticleSetWithBlendModes" ||
                set?.enableBlendModes === true,
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
    // The bake reports which systems each pure-2D binding walked, because a
    // set's count is the graph's answer and `systems.push` can add one from
    // another set. The mapping constants beside it are the scene's own.
    const sprite2d = bake.sprite2d.map((expansion) => {
        const request = program.sprite2d[expansion.request]!;
        return {
            exact: request.exact,
            pixelsPerUnit: request.pixelsPerUnit,
            originPx: request.originPx,
            invertY: request.invertY,
            ...(request.opacity === undefined
                ? {}
                : { opacity: request.opacity }),
            ...(request.visible === undefined
                ? {}
                : { visible: request.visible }),
            ...(request.order === undefined
                ? {}
                : { order: request.order }),
            systems: expansion.systems,
        };
    });
    // Both registrars report which systems each call walked, for the
    // same reason: a set's count is the graph's answer, and `systems.push`
    // can add one built elsewhere.
    const registrations = bake.registrations.map((expansion) => ({
        systems: expansion.systems,
    }));
    return { systems, sprite2d, registrations };
}

/**
 * How many passes one baked system's billboard draws, by the pin's own rule:
 * the pass count rides `createParticleBlend`'s descriptor, and only the
 * exact-blend chain reaches it. Zero is the stock program.
 */
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
        ...(options.search ? { search: options.search } : {}),
    });

    // The frozen node-particle bake is a Chromium run that nothing between
    // here and the emitters depends on, so it is started rather than
    // awaited: the compile spends about as long lowering and writing the
    // tree as the browser spends simulating, and the two overlap. It is
    // joined below, before the first consumer of what it produces.
    const bakingNodeParticles = result.nodeParticles
        ? bakeNodeParticleSystems(
              result.nodeParticles,
              result.assetPayloads,
          )
        : undefined;

    mkdirSync(outputPath, { recursive: true });
    // Assets are materialized from their sources every run; the compiled
    // tree is written through `tree`, which rewrites only what changed
    // and prunes what this run no longer emits.
    rmSync(resolve(outputPath, "assets"), { recursive: true, force: true });
    const tree = new GeneratedTree(outputPath);
    await Promise.all(
        result.manifest.assets.map((asset) =>
            materializeAsset(
                asset,
                inputPath,
                outputPath,
                result.assetPayloads,
            ),
        ),
    );
    const specializationFeatures =
        emitAssetSpecializations(outputPath, result.manifest.assets);
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
    tree.keep("upstream/gltf-specialization.json");
    if (specializationFeatures.imageBasedLighting) {
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
        : { systems: [], sprite2d: [], registrations: [] };
    const nodeParticles = bakedParticles.systems;
    const nodeParticleSprite2d = bakedParticles.sprite2d;
    const nodeParticleRegistrations = bakedParticles.registrations;
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
            );
        }
    }

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
            return predeclaredShaderProgram(predeclared);
        });
    const reachedBabylonLights = babylonLights(
        outputPath,
        result.manifest.assets,
    );
    const emittedArms = {
        clearcoat:
            specializationFeatures.clearcoat ||
            result.manifest.features.includes("material:clearcoat"),
        // The coat's base-F0 remap is composed for every clearcoat except a
        // glTF one: `gltf-ext-clearcoat.ts` is the single caller passing
        // `useF0Remap: false`. So it follows the scene-code setter and not
        // the asset specializer's `KHR_materials_clearcoat` flag.
        clearcoatF0Remap: result.manifest.features.includes(
            "material:clearcoat-f0-remap",
        ),
        sheen:
            specializationFeatures.sheen ||
            result.manifest.features.includes("material:sheen"),
        // The two pinned sheen models are composed, not switched at run time,
        // so one fragment cannot serve both. A glTF KHR_materials_sheen
        // material takes the albedo-scaling arm; `setPbrSheen` defaults to
        // the legacy one and can ask for the other explicitly.
        sheenAlbedoScaling:
            specializationFeatures.sheen ||
            result.manifest.features.includes(
                "material:sheen-albedo-scaling",
            ),
        iridescence:
            specializationFeatures.iridescence ||
            result.manifest.features.includes("material:iridescence"),
        dispersion: specializationFeatures.dispersion,
        // Spec-gloss has no scene-code entry point: the pin reaches it only
        // through the glTF extension, so the asset alone decides.
        specularGlossiness: specializationFeatures.specularGlossiness,
        occlusionUv2: specializationFeatures.occlusionUv2,
        // The same derivation `upstream-lower.ts` uses for the compiled
        // define: transmission is reached from scene code and from a loaded
        // asset alike, because the pin enables it for any transmissive
        // surface the asset carries without the scene naming it.
        transmission:
            result.manifest.features.includes("renderer:transmission") ||
            specializationFeatures.assetTransmission,
    };
    // An asset's own KHR_lights_punctual lights are the scene's lights: the
    // pin's loader creates them exactly like scene code does, and every
    // consumer keyed on the light features -- the composed arms, the pinned
    // light writers, the generated-source table -- reads the one authority,
    // so the kinds the assets reach join the manifest here.
    // Which features the join added and the asset that carried each,
    // recorded for the activation inventory: a feature already reached by
    // scene source is deliberately not re-attributed to an asset.
    const assetJoinedFeatures = new Map<string, string>();
    let assetLightNodes: { count: number; asset: string } | undefined;
    for (const asset of result.manifest.assets) {
        if (asset.kind !== "gltf") continue;
        const assetPath = resolve(outputPath, "assets", asset.output);
        // The pin grows MAX_LIGHTS from this count at run time; the frozen
        // constant makes exceeding it a generation refusal instead
        // (`emitUpstreamGenerated` checks it beside the pinned constant).
        const lightNodeCount = gltfLightNodeCount(assetPath);
        if (lightNodeCount > (assetLightNodes?.count ?? 0)) {
            assetLightNodes = { count: lightNodeCount, asset: asset.output };
        }
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
                assetJoinedFeatures.set(feature, asset.output);
            }
        }
    }
    // A `.babylon` asset's own lights are the scene's lights the same way a
    // glTF's KHR_lights_punctual lights are: the generated loader fills
    // point LightRecords (`type: 0` is the only kind it accepts), and the
    // pinned lights block consumes them through `write_pinned_light`, whose
    // per-kind writers are emitted only for the light features the scene
    // reaches. Joining `light:point` here is what routes the point writer
    // (and the pinned light matrix it indexes) into the generated tree.
    for (const asset of result.manifest.assets) {
        if (asset.kind !== "babylon") continue;
        const materialized = resolve(outputPath, "assets", asset.output);
        if (!existsSync(materialized)) continue;
        const document = JSON.parse(
            readFileSync(materialized, "utf8"),
        ) as { lights?: BabylonLight[] };
        if (
            (document.lights ?? []).some((light) => light.type === 0) &&
            !result.manifest.features.includes("light:point")
        ) {
            result.manifest.features.push("light:point");
            assetJoinedFeatures.set("light:point", asset.output);
        }
    }
    if (assetJoinedFeatures.size > 0) {
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
    const {
        lightKinds,
        toneMappingStates,
        linearImageProcessing,
        gltfAssets,
        materialIndexBase,
        casterViewCount,
        renderableMeshFeatures,
        pinnedVariants,
        runtimeMeshFeatures,
        standardComposition,
        standardRenderableMeshFeatures,
        nodeVariants,
    } = await composeScenePipeline({
        result,
        outputPath,
        specializationFeatures,
        emittedArms,
        tree,
    });
    // Each reached post-process pass composes its module by running the
    // pinned factory: the effect's stage is the pin's text for the options
    // this scene passed, never a reproduction of it.
    // A GPU pick draws through the pin's own two modules. Both are
    // executed rather than re-typed, for the reason every composed stage
    // here is: what deploys must be the text the browser compiled.
    const pickingShaders = result.manifest.features.includes("picking:gpu")
        ? {
              mesh: await composeMeshPickingShader(),
              ...(result.manifest.features.includes("loader:splat")
                  ? { cloud: await composeCloudPickingShader() }
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
    const splatShaderModule =
        result.manifest.splatFragments.length > 0
            ? await composeSplatModule(
                  await splatFragmentRecords(result.manifest.splatFragments),
              )
            : undefined;
    // A composite runs its own factory instead: which passes it records, over
    // which intermediates and at which sizes, is the factory's answer.
    const postProcessComposites = await Promise.all(
        result.manifest.postProcessComposites.map((composite) =>
            composeComposite({
                intrinsic: composite.intrinsic,
                options: composite.options,
                hasTarget: composite.hasTarget,
            }),
        ),
    );
    // Named rather than inline so the activation inventory below records
    // the exact values the emitters consumed, not a restatement of them.
    // Which palette transport a skin takes: a build whose composed variants
    // carry the pin's own skeleton bit reads the palette from its per-bone
    // texture, which caps no joint count.
    const pinnedSkeletonPalette = await pinnedFeaturesCarrySkeleton(
        renderableMeshFeatures,
    );
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
        throw new Error(
            `A skin of ${specializationFeatures.maxSkinJoints} joints exceeds ` +
                `the ${DEFORMATION_BONE_SLOTS}-matrix bone palette of the ` +
                "transcribed vertex stage, which is this scene's transport " +
                "because it composes no pinned skeleton variant. The pin's " +
                "own per-bone palette texture caps nothing; there is no CPU " +
                "deformation path to fall back to.",
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
        (result.manifest.features.includes("renderer:transmission") ||
            specializationFeatures.assetTransmission ||
            result.manifest.geometryOutputTasks.length > 0)
    ) {
        throw new Error(
            "A glTF point or line primitive in a scene that also reaches " +
                "transmission or a geometry-output task is not lowered: " +
                "those passes build their pipelines at a triangle list.",
        );
    }
    const emitOptions: UpstreamEmitOptions = {
        idDiagnostics: options.idDiagnostics,
        // The compiler's first-reach record, threaded so late refusals in
        // the composition/lowering layer can name the scene call site that
        // pulled the owning feature in.
        featureSites: result.manifest.featureSites,
        ...(assetLightNodes !== undefined ? { assetLightNodes } : {}),
        shaderPrograms,
        geometryOutputTasks: result.manifest.geometryOutputTasks,
        postProcessTasks: result.manifest.postProcessTasks,
        postProcessShaders,
        ...(pickingShaders !== undefined ? { pickingShaders } : {}),
        postProcessComposites,
        ...(nodeParticles.length > 0 ? { nodeParticles } : {}),
        ...(nodeParticleSprite2d.length > 0
            ? { nodeParticleSprite2d }
            : {}),
        ...(nodeParticleRegistrations.length > 0
            ? { nodeParticleRegistrations }
            : {}),
        gpuDeformation:
            specializationFeatures.gpuDeformation ||
            result.manifest.features.includes(
                "mesh:morph-targets",
            ),
        animatedWorldBounds: specializationFeatures.animatedWorldBounds,
        // Scene-code morph targets join the storage arm: the pinned morph
        // fragment (`morph-fragment-core`) reads its deltas and weights
        // from storage buffers, and with the transcribed standard fragment
        // retired there is no attribute-lane consumer left for them.
        morphStorage: specializationFeatures.morphStorage ||
            result.manifest.features.includes("mesh:morph-targets"),
        nonTrianglePrimitives:
            specializationFeatures.nonTrianglePrimitives,
        nodeVisibility: specializationFeatures.nodeVisibility,
        spriteCustomShaders: result.manifest.spriteCustomShaders,
        effects: result.manifest.effects,
        ...(esmShadows.length > 0 ? { esmShadows } : {}),
        ...(splatShaderModule !== undefined ? { splatShaderModule } : {}),
        plainSpriteLayer: result.manifest.plainSpriteLayer,
        plainBillboardSystem: result.manifest.plainBillboardSystem,
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
        // The one static `selectVariant` a scene reaches: the loader reads
        // the variant order and the per-primitive mappings out of the
        // document, so only the chosen name is compiled in.
        selectedMaterialVariant:
            result.manifest.assets.find(
                (asset) => asset.selectedVariant !== undefined,
            )?.selectedVariant ?? "",
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
        gpuInstanceColors: result.manifest.features.includes(
            "mesh:thin-instance-colors",
        ),
        punctualLights:
            specializationFeatures.punctualLights,
        clearcoat: emittedArms.clearcoat,
        sheen: emittedArms.sheen,
        pinnedVariants,
        ...(nodeVariants.length > 0 ? { nodeVariants } : {}),
        ...(standardComposition !== undefined
            ? {
                pinnedStandardVariants: standardComposition.variants,
                pinnedStandardSelectors: standardComposition.selectors,
                standardRenderableMeshFeatures:
                    standardRenderableMeshFeatures ?? [],
                ...(runtimeMeshFeatures !== undefined
                    ? { standardRuntimeMeshFeatures: runtimeMeshFeatures }
                    : {}),
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
        ...(runtimeMeshFeatures !== undefined
            ? { runtimeMeshFeatures }
            : {}),
        iridescence: emittedArms.iridescence,
        specularGlossiness: emittedArms.specularGlossiness,
        dispersion: emittedArms.dispersion,
        occlusionUv2: emittedArms.occlusionUv2,
    };
    emitUpstreamGenerated(
        outputPath,
        result.manifest.features,
        emitOptions,
        tree,
    );
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
                featureSites: result.manifest.featureSites,
                assetJoinedFeatures,
                specialization: specializationFeatures,
                emit: emitOptions,
                transmission: emittedArms.transmission,
                imageCodecs,
                gltfAssetNames: gltfAssets.map((asset) => asset.output),
                pinnedMaxLights: readPinnedMaxLights(),
                interleave: {
                    sceneMeshGltfAssetsBefore:
                        result.manifest.sceneMeshes.map(
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
                    linearImageProcessing,
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
