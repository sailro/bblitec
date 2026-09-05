#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    CompileAsset,
    CompileError,
    compileSource,
    renderFeaturesCmake,
} from "./compiler.js";
import {
    composeBillboardPickingShader,
    composeCloudPickingShader,
    composeDeformDetailedMeshPickingShader,
    composeDetailedMeshPickingShader,
    composeMeshPickingShader,
    composeThinInstancePickingShader,
} from "./pinned-picking-shaders.js";
import type { CompiledShaderProgram } from "./compiler.js";
import type {
    CompiledNodeParticles,
    Feature,
    NativeHostUi,
    NativeHostUiElement,
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
import { reachedImageCodecs } from "./image-codecs.js";
// The dds/hdr/splat/basis packagers and the node-particle bake are imported
// lazily at their per-kind branches: each top-level-awaits its pinned
// modules (the HDR one transitively loads the browser harness), so a static
// import makes every compile pay for asset kinds it never packages.
import { compressedTextureLowerer } from "./compiler/compressed-texture.js";
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
    readUpstreamPin,
    repositoryRelativePath,
} from "./upstream-source.js";
import { GeneratedTree } from "./generated-tree.js";
import { downloadCached } from "./asset-download-cache.js";
import {
    gltfHasImageBasedLight,
    gltfLightKinds,
    gltfLightNodeCount,
} from "./pinned-material-arms.js";
import {
    emitAssetSpecializations,
    gltfHasCompressedImages,
    gltfHasGaussianSplats,
} from "./asset-specializer.js";
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
import { holdDistLock } from "./dist-lock.js";
import {
    isUiStyleSelectorKind,
    nativeHostUiStyleRules,
} from "./ui-style-rule.js";
import {
    composeSplatModule,
    composeSplatShModule,
    splatFragmentRecords,
} from "./pinned-splat-fragments.js";
import {
    SPLAT_ASSET_KINDS,
    SPLAT_HARMONICS_SUFFIX,
    assetRecord,
} from "./compiler/assets.js";
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
    hostUi?: string;
    idDiagnostics: boolean;
}

function usage(): never {
    console.error("Usage: bblitec <entry.ts> --out <directory> [--title <text>] [--width <pixels>] [--height <pixels>] [--search <query>] [--host-ui <json>] [--id-diagnostics]");
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
            case "--host-ui":
                if (!value) usage();
                hostUi = value;
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
        ...(hostUi ? { hostUi } : {}),
    };
}

function refuseUnknownKeys(
    record: Record<string, unknown>,
    known: readonly string[],
    location: string,
): void {
    for (const key of Object.keys(record)) {
        if (!known.includes(key)) {
            throw new Error(`${location}: unknown key '${key}'.`);
        }
    }
}

function nativeHostUiElement(
    value: unknown,
    location: string,
): NativeHostUiElement {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${location} must be an object.`);
    }
    const record = value as Record<string, unknown>;
    refuseUnknownKeys(
        record,
        ["tag", "text", "attributes", "children"],
        location,
    );
    if (typeof record.tag !== "string") {
        throw new Error(`${location}.tag must be a string.`);
    }
    if (record.text !== undefined && typeof record.text !== "string") {
        throw new Error(`${location}.text must be a string.`);
    }
    let attributes: Record<string, string> | undefined;
    if (record.attributes !== undefined) {
        if (
            !record.attributes ||
            typeof record.attributes !== "object" ||
            Array.isArray(record.attributes)
        ) {
            throw new Error(`${location}.attributes must be an object.`);
        }
        attributes = {};
        for (const [name, attribute] of Object.entries(record.attributes)) {
            if (typeof attribute !== "string") {
                throw new Error(
                    `${location}.attributes.${name} must be a string.`,
                );
            }
            attributes[name] = attribute;
        }
    }
    if (record.children !== undefined && !Array.isArray(record.children)) {
        throw new Error(`${location}.children must be an array.`);
    }
    return {
        tag: record.tag,
        ...(record.text !== undefined ? { text: record.text } : {}),
        ...(attributes ? { attributes } : {}),
        ...(record.children
            ? {
                  children: record.children.map((child, index) =>
                      nativeHostUiElement(
                          child,
                          `${location}.children[${index}]`,
                      ),
                  ),
              }
            : {}),
    };
}

function readNativeHostUi(path: string): NativeHostUi {
    const value: unknown = JSON.parse(readFileSync(resolve(path), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Native host UI '${path}' must contain an object.`);
    }
    const record = value as Record<string, unknown>;
    refuseUnknownKeys(
        record,
        ["elements", "classStyles", "styleRules"],
        `Native host UI '${path}'`,
    );
    if (!Array.isArray(record.elements)) {
        throw new Error(`Native host UI '${path}' must contain elements[].`);
    }
    if (
        record.classStyles !== undefined &&
        !Array.isArray(record.classStyles)
    ) {
        throw new Error(`Native host UI '${path}' classStyles must be an array.`);
    }
    const classStyles = (record.classStyles ?? []).map((rule, index) => {
        if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
            throw new Error(`Native host UI '${path}' classStyles[${index}] must be an object.`);
        }
        const item = rule as Record<string, unknown>;
        refuseUnknownKeys(
            item,
            ["className", "style"],
            `Native host UI '${path}' classStyles[${index}]`,
        );
        if (
            typeof item.className !== "string" ||
            typeof item.style !== "string"
        ) {
            throw new Error(`Native host UI '${path}' classStyles[${index}] requires string className and style values.`);
        }
        return { className: item.className, style: item.style };
    });
    if (
        record.styleRules !== undefined &&
        !Array.isArray(record.styleRules)
    ) {
        throw new Error(`Native host UI '${path}' styleRules must be an array.`);
    }
    const styleRules = (record.styleRules ?? []).map((rule, index) => {
        const location = `Native host UI '${path}' styleRules[${index}]`;
        if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
            throw new Error(`${location} must be an object.`);
        }
        const item = rule as Record<string, unknown>;
        refuseUnknownKeys(
            item,
            [
                "kind",
                "primary",
                "secondary",
                "tag",
                "hover",
                "focusVisible",
                "maxWidth",
                "style",
            ],
            location,
        );
        if (
            !isUiStyleSelectorKind(item.kind) ||
            typeof item.primary !== "string" ||
            typeof item.style !== "string"
        ) {
            throw new Error(
                `${location} requires a supported kind plus string primary and style values.`,
            );
        }
        if (
            item.secondary !== undefined &&
            typeof item.secondary !== "string"
        ) {
            throw new Error(`${location}.secondary must be a string.`);
        }
        if (item.tag !== undefined && typeof item.tag !== "string") {
            throw new Error(`${location}.tag must be a string.`);
        }
        if (item.hover !== undefined && typeof item.hover !== "boolean") {
            throw new Error(`${location}.hover must be a boolean.`);
        }
        if (item.focusVisible !== undefined && typeof item.focusVisible !== "boolean") {
            throw new Error(`${location}.focusVisible must be a boolean.`);
        }
        if (item.maxWidth !== undefined && typeof item.maxWidth !== "number") {
            throw new Error(`${location}.maxWidth must be a number.`);
        }
        return {
            kind: item.kind,
            primary: item.primary,
            style: item.style,
            ...(item.secondary !== undefined
                ? { secondary: item.secondary }
                : {}),
            ...(item.tag !== undefined ? { tag: item.tag } : {}),
            ...(item.hover !== undefined ? { hover: item.hover } : {}),
            ...(item.focusVisible !== undefined ? { focusVisible: item.focusVisible } : {}),
            ...(item.maxWidth !== undefined
                ? { maxWidth: item.maxWidth }
                : {}),
        };
    });
    return {
        // As given (registry-relative), so the recorded activation site is
        // machine-independent where an absolute resolution would not be.
        sourcePath: path,
        ...((classStyles.length > 0 || styleRules.length > 0)
            ? { styleRules: nativeHostUiStyleRules({ classStyles, styleRules }) }
            : {}),
        elements: record.elements.map((element, index) =>
            nativeHostUiElement(
                element,
                `Native host UI '${path}' elements[${index}]`,
            ),
        ),
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
     * The Euler rotation the pinned `loadSPZ` left on the cloud it attached,
     * observed by running that loader rather than restated. Present only for
     * an SPZ container -- the pin's `loadSOG` writes the same lane, so this
     * is one of two rather than the only one, which is why the recorder that
     * observes it is shared rather than local to the SPZ arm.
     */
    spzRotation?: readonly [number, number, number];
}

async function materializeAsset(
    asset: CompileAsset,
    inputPath: string,
    outputPath: string,
    assetPayloads: ReadonlyMap<string, string>,
): Promise<MaterializedAssetFacts | undefined> {
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

    // The two source prefixes a scene module produces rather than fetches:
    // same execution, one decoder each for what the export returned. The
    // `pixels` kind can also name already-baked inline bytes (the fetched
    // Canvas2D atlas), so kind alone is not an execution contract.
    const bake =
        asset.source.startsWith(pixelsSourcePrefix)
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
        await packageBabylon(source, dirname(inputPath), destination);
        return;
    }

    if (asset.kind === "gltf" && /\.(?:gltf|glb)(?:[?#]|$)/i.test(source)) {
        writeFileSync(
            destination,
            await resolveGeometryExtensions(
                await packageGltf(source, dirname(inputPath)),
                source,
            ),
        );
        return;
    }

    if (SPLAT_ASSET_KINDS.has(asset.kind)) {
        const { packageSplat, packageSpz } = await import(
            "./splat-packager.js"
        );
        const bytes = await assetBytes(source, inputPath);
        // The one lane a pinned loader writes on the cloud it attached rides
        // the facts rather than the packaged file, for the reason the
        // harmonics ride a sidecar: the row buffer is upstream's own `.splat`
        // layout and nothing may be appended to it.
        const spz =
            asset.kind === "spz"
                ? await packageSpz(bytes, source)
                : undefined;
        const packaged = spz ?? packageSplat(bytes);
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
            ...(spz ? { spzRotation: spz.rotation } : {}),
        };
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
    // This process runs out of `dist/` too, and an ad-hoc generation probe is
    // exactly what runs beside somebody else's `npm run build`. A `compile`
    // fan-out's children already run under their parent's lock and take
    // nothing here.
    holdDistLock(`generate ${options.input}`);
    const inputPath = resolve(options.input);
    const outputPath = resolve(options.output);
    const source = readFileSync(inputPath, "utf8");
    const result = compileSource(source, {
        fileName: inputPath,
        ...(options.title ? { title: options.title } : {}),
        ...(options.width ? { width: options.width } : {}),
        ...(options.height ? { height: options.height } : {}),
        ...(options.search ? { search: options.search } : {}),
        ...(options.hostUi
            ? { nativeHostUi: readNativeHostUi(options.hostUi) }
            : {}),
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
    const materializedFacts = await Promise.all(
        result.manifest.assets.map((asset) =>
            materializeAsset(
                asset,
                inputPath,
                outputPath,
                result.assetPayloads,
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
        throw new Error(
            "This scene loads Gaussian clouds at spherical-harmonic " +
                `degrees ${[...splatHarmonicDegrees]
                    .sort()
                    .join(" and ")}; generation deploys one splat stage ` +
                "pair, and the pin builds a distinct module per degree " +
                "(degree 0 being the stock pipeline).",
        );
    }
    const splatHarmonicDegree = [...splatHarmonicDegrees].find(
        (degree) => degree > 0,
    );
    // The rotation the pinned `loadSPZ` writes on every cloud it attaches,
    // observed once per SPZ container. Two containers cannot disagree -- it
    // is a constant of the loader, not of the asset -- so a scene whose
    // observations differ means the pin grew a per-container arm this port
    // does not model, and refuses rather than emitting one of them.
    const spzRotations = materializedFacts
        .map((facts) => facts?.spzRotation)
        .filter((rotation) => rotation !== undefined);
    const distinctSpzRotations = new Set(
        spzRotations.map((rotation) => rotation.join(",")),
    );
    if (distinctSpzRotations.size > 1) {
        throw new Error(
            "This scene's SPZ containers attach clouds at different " +
                `rotations (${[...distinctSpzRotations].join("; ")}); the ` +
                "pinned loadSPZ writes one, so a difference means it now " +
                "forks on the container.",
        );
    }
    const splatSpzRotation = spzRotations[0];
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
                "and writes what it uploaded back into the glTF as the KTX1 " +
                "container the runtime's one compressed-texture reader " +
                "parses, so the extension is resolved away like the " +
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
        // KHR_gaussian_splatting resolves to the pin's own splat row buffer
        // at packaging, and the clouds the loader then builds draw through
        // the generated splat pipeline -- which `loader:splat` is what
        // selects. No scene API names the extension, so the asset joins the
        // feature the way its punctual lights join `light:*`.
        if (gltfHasGaussianSplats(assetPath)) {
            assetFeatures.push("loader:splat" as Feature);
        }
        // KHR_texture_basisu resolves to a KTX1 container at packaging for
        // the same reason, and the generated loader reads it through the
        // pin's own `parseKtx1` -- which `texture:compressed` is what
        // emits.
        if (gltfHasCompressedImages(assetPath)) {
            assetFeatures.push("texture:compressed" as Feature);
        }
        for (const feature of assetFeatures) {
            if (!result.manifest.features.includes(feature)) {
                result.manifest.features.push(feature);
                assetJoinedFeatures.set(feature, asset.output);
            }
        }
    }
    // A packaged splat container that parsed to a non-zero SH degree is
    // what `attachParsedSplat` forks on, and no scene API names it -- so
    // the asset joins the feature exactly as a glTF's own extensions do
    // above. It selects the payload packer and the SH capability defines;
    // `loader:splat` is already reached by the `loadSplat` call itself.
    if (splatHarmonicDegree !== undefined) {
        // The container that carried them, not merely the first splat asset:
        // the facts are positional over the manifest's assets, so a scene
        // holding a plain cloud beside one with harmonics still attributes
        // the feature -- and names the parser below -- from the one that
        // answered the degree.
        const splatAsset = result.manifest.assets[
            materializedFacts.findIndex(
                (facts) => (facts?.splatHarmonicDegree ?? 0) > 0,
            )
        ];
        result.manifest.features.push("loader:splat-sh");
        assetJoinedFeatures.set(
            "loader:splat-sh",
            splatAsset?.output ?? "splat",
        );
            // Pushed HERE rather than in `compileAdaptations`, beside the two
        // siblings below, because `loader:splat-sh` is an asset-joined
        // feature: the compiler decides its adaptations from the entry AST
        // and this one is not known until the pin has parsed the container
        // and said the cloud carries harmonics. Gating it on the AST-side
        // list recorded nothing at all -- scene 124's fidelity.json had no
        // such entry -- which is the failure this placement fixes.
        result.manifest.adaptations.push({
            id: "splat-harmonics-sidecar",
            category: "asset-materialization",
            sourceSemantics:
                // The parser that produced them, which is the container's
                // answer rather than a fixed one: the compressed PLY and the
                // SPZ both reach the SH pipeline through this same fork.
                (splatAsset?.kind === "spz"
                    ? "parseSpz"
                    : "convertCompressedPlyToParsedSplat") +
                " returns the 32-byte rows " +
                "beside a flat spherical-harmonic byte stream, and " +
                "attachParsedSplat hands both to the SH pipeline in one call.",
            nativeSemantics:
                "The rows package to the interchange .splat buffer " +
                "unchanged -- a .ply and a .splat of one cloud must still " +
                "produce identical bytes -- so the harmonics package to a " +
                "sidecar named off the row file, and the degree becomes a " +
                "generation-time constant the loader, the payload packer " +
                "and the deployed stages all read. The pin's run-time fork " +
                "on parsed.shDegree is therefore taken at generation: a " +
                "scene whose clouds disagree on degree refuses.",
            risk: "low",
            validation: [
                "scene 124 parity against the browser golden on both backends",
                "the browser's own compiled module is byte-identical to " +
                    "buildShShaderSource(3)",
            ],
        });
    }
    // The SPZ container, recorded here for the same reason its sibling above
    // is: `compileAdaptations` runs over the entry AST, and the VALUE this
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
        standardRuntimeMeshFeatures,
        standardPluginBindings,
        nodeVariants,
    } = await composeScenePipeline({
        result,
        outputPath,
        specializationFeatures,
        emittedArms,
        tree,
    });
    // Whether anything in this scene deforms on the GPU. Named once
    // because two unrelated consumers ask it -- the pick pass's deform
    // projection below and the emit options further down -- and the
    // asset-or-scene-code disjunction is the whole answer either way.
    const gpuDeformation =
        specializationFeatures.gpuDeformation ||
        result.manifest.features.includes("mesh:morph-targets");
    // Scene-code morph targets join the storage arm: the pinned morph
    // fragment (`morph-fragment-core`) reads its deltas and weights
    // from storage buffers, and with the transcribed standard fragment
    // retired there is no attribute-lane consumer left for them.
    const morphStorage =
        specializationFeatures.morphStorage ||
        result.manifest.features.includes("mesh:morph-targets");
    const gpuInstancing =
        specializationFeatures.gpuInstancing ||
        result.manifest.features.includes("mesh:thin-instances") ||
        result.manifest.features.includes("mesh:thin-instances-dynamic");
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
                        detailed:
                            await composeDetailedMeshPickingShader(),
                        // And its deforming arm where the scene's assets
                        // put a live pose on a candidate: the pin reaches
                        // `deform-picking-projection.js` from exactly that
                        // condition, so a scene with nothing to deform
                        // composes neither the module nor the pipeline.
                        // The pinned palette is the second half of the
                        // condition rather than a second condition: the
                        // projection samples `boneSampler`, which is the
                        // per-bone texture a composed skeleton variant
                        // publishes, and a scene deforming through the
                        // transcribed 64-matrix block has no such texture
                        // to sample.
                        ...(gpuDeformation && pinnedSkeletonPalette
                            ? {
                                  deform:
                                      await composeDeformDetailedMeshPickingShader(
                                          morphStorage,
                                      ),
                                  // The arm that composition picked,
                                  // carried so the runtime sizes its bind
                                  // group to this shader rather than to
                                  // BBLITE_GPU_MORPH_STORAGE, which is a
                                  // wider disjunction.
                                  deformMorph: morphStorage,
                              }
                            : {}),
                    }
                  : {}),
              ...(result.manifest.features.includes("loader:splat")
                  ? { cloud: await composeCloudPickingShader() }
                  : {}),
              ...(result.manifest.features.includes("picking:billboard")
                  ? {
                        billboard: {
                            facing:
                                await composeBillboardPickingShader(
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
        ...(result.manifest.engineMsaaSamples !== undefined
            ? { msaaSamples: result.manifest.engineMsaaSamples }
            : {}),
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
        gpuDeformation,
        animatedWorldBounds: specializationFeatures.animatedWorldBounds,
        morphStorage,
        nonTrianglePrimitives:
            specializationFeatures.nonTrianglePrimitives,
        // No scene API reaches KHR_gaussian_splatting, so the asset alone
        // decides -- the shape the spec-gloss workflow replacement takes.
        gaussianSplats: specializationFeatures.gaussianSplats,
        // KHR_texture_basisu likewise: packaging leaves KTX1 containers on
        // the document, and only the asset says whether the loader reads
        // one.
        compressedImages: specializationFeatures.compressedImages,
        // Both halves of the same lane: an asset's KHR_node_visibility
        // materializes the cascade at load, and scene code writes the same
        // per-mesh boolean directly. Either reaches the render-plan skip
        // and the camera-bounds skip that read it.
        nodeVisibility: specializationFeatures.nodeVisibility ||
            result.manifest.features.includes("mesh:visible"),
        gltfNodeVisibility: specializationFeatures.nodeVisibility,
        spriteCustomShaders: result.manifest.spriteCustomShaders,
        effects: result.manifest.effects,
        ...(esmShadows.length > 0 ? { esmShadows } : {}),
        ...(splatShaderModule !== undefined ? { splatShaderModule } : {}),
        ...(splatSh !== undefined ? { splatSh } : {}),
        ...(splatSpzRotation !== undefined
            ? { splatSpzRotation }
            : {}),
        pureSpriteVertex: result.manifest.pureSpriteVertex,
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
        gpuInstancing,
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
                ...(standardRuntimeMeshFeatures !== undefined
                    ? { standardRuntimeMeshFeatures }
                    : {}),
                ...(standardPluginBindings
                    ? { standardPluginBindings }
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
${imageCodecLines || '    ""'}
)
`,
    );
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
    result.manifest.inputs = [...new Set(result.manifest.inputs)].sort();
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
