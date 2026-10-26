/**
 * Execute pinned glTF material extensions, texture/props assembly and animated
 * pointer seeding over recording textures. Production readers await
 * ensurePinnedLoaderExecution; synchronous recording calls use the shared
 * async/await AST transform. Source core assembly receives recording image
 * identities; registry discovery, material prerequisites and dispatch execute
 * in one source module realm. GPU records remain slot-shaped adapters.
 */
import { javascriptModuleUrl } from "./data-url.js";
import { asNumbers, asObject, type JsonObject } from "./json-fields.js";
import {
    assertPinnedSync,
    importPinnedModule,
    importPinnedModuleUnasynced,
    pinnedLibraryRoot,
} from "./pinned-shader-composer.js";
import {
    registeredPbrExtensionIds,
    type PinnedMaterialInput,
} from "./pinned-pbr-variants.js";
import { createRecordingDevice } from "./recording-device.js";
import { pinnedGltfMaterialCore } from "./pinned-gltf-material-core.js";
import {
    sharedPinnedContext,
    type LoweringContext,
} from "./lowering/context.js";
import {
    loadPinnedMaterialRegistry,
    type PinnedMaterialFeatureContext,
    type PinnedMaterialRegistry,
    type PreparedMaterialFeatures,
} from "./pinned-gltf-material-registry.js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
    recordingTransmissionSetter,
    transmissionRegistrationMarker,
} from "./pinned-pbr-transmission.js";

/**
 * Builds the pinned material input for one glTF material.
 *
 * `alpha` and `_alphaCutOff` follow the pin's own blend predicate:
 * `alphaBlend === true || ((_alphaCutOff ?? 0) <= 0 && alpha < 1)`, so a MASK
 * material carries its cutoff and a BLEND material carries its alpha.
 */
interface PinnedMaterialSceneContext {
    /** Discovery and material prerequisites executed over the complete glTF document. */
    materialFeatures?: PreparedMaterialFeatures;
    /**
     * True when the scene renders linear because some material transmits.
     * Upstream this is a property of the material, but it is decided by the
     * scene: enabling transmission retargets the frame graph's colour buffer to
     * a linear one, so *every* material in that scene composes the linear
     * image-processing arm, not just the transmissive ones. The refraction
     * extension reads it as `_linearImageProcessing`.
     */
    linearImageProcessing?: boolean;
    /**
     * Resolves a glTF texture index to the image index behind it. The texture
     * assembly branches on whether occlusion and metallic-roughness share an
     * *image*, which two distinct texture objects can, so the slot indices are
     * not enough on their own.
     */
    imageOf?: (textureIndex: unknown) => number | undefined;
    /**
     * True when `KHR_animation_pointer` drives this material's base colour
     * factor. An animated factor has to live in the material UBO, so the field
     * exists even when its load-time value is the default the assembly would
     * otherwise skip — Scene 242's material carries `[1,1,1,1]` at load and the
     * browser's fragment still declares `baseColorFactor`.
     */
    animatedBaseColorFactor?: boolean;
    /**
     * True when `KHR_animation_pointer` drives a `KHR_texture_transform` on
     * this material. `gltf-feature-animation-pointer.ts` calls
     * `enableMaterialUvTransform`, which sets `_hasUvTx` outright — the same
     * shape as the base-colour exception above, and for the same reason: the
     * animation writes into a UBO field, so the field has to exist.
     *
     * The load-time transform is typically the *empty* object in this case —
     * Scene 253's NormalScale and TextureTransform materials both declare
     * `KHR_texture_transform: {}` and animate offset and scale — so the
     * static rule and this one disagree exactly where it matters.
     */
    animatedUvTransform?: boolean;
    /**
     * The `animation-pointer-ext.ts` pointer families targeting this material,
     * from `gltfAnimatedExtensionTargets`. Each one makes `seedExtMaterials`
     * change the material's shape so the animation has somewhere to write.
     */
    animatedExtensionTargets?: PinnedAnimatedExtensionTargets;
    /**
     * True when `KHR_animation_pointer` drives this material's emissive factor
     * or its `KHR_materials_emissive_strength`. The emissive extension reads
     * `_emissiveColor` for `PBR_HAS_EMISSIVE_COLOR`, and an animated emissive
     * needs that field however the load-time factor reads — Scene 242 animates
     * both halves and its captured fragment declares `emissiveColor`.
     */
    animatedEmissive?: boolean;
    /** Records a call to the pinned metallic-reflectance setter while this
     *  material's loader and animation-pointer paths execute. */
    recordMetallicReflectanceRegistration?: () => void;
    /** Records the actual transmission hook call in the executed material setters. */
    recordTransmissionRegistration?: () => void;
}

/** The material indices a `KHR_animation_pointer` channel drives a pointer into. */
export function gltfAnimatedMaterialPointers(
    document: JsonObject,
    pointerSuffix: string,
): ReadonlySet<number> {
    return gltfAnimatedPointers(
        document,
        new RegExp(`^/materials/(\\d+)/${pointerSuffix}$`),
    );
}

/** Material indices whose animated pointer matches `pattern`. */
function gltfAnimatedPointers(
    document: JsonObject,
    pattern: RegExp,
): ReadonlySet<number> {
    const animated = new Set<number>();
    const animations = Array.isArray(document["animations"])
        ? (document["animations"] as JsonObject[])
        : [];
    for (const animation of animations) {
        const channels = Array.isArray(animation["channels"])
            ? (animation["channels"] as JsonObject[])
            : [];
        for (const channel of channels) {
            const pointer = asObject(
                asObject(asObject(channel["target"])?.["extensions"])?.[
                    "KHR_animation_pointer"
                ],
            )?.["pointer"];
            if (typeof pointer !== "string") continue;
            const match = pattern.exec(pointer);
            if (match) animated.add(Number(match[1]));
        }
    }
    return animated;
}

/**
 * Which of `animation-pointer-ext.ts`'s pointer families target a material.
 *
 * These are not the same list as the plain pointers: `animatedTargets` picks
 * out five specific ones because each makes `seedExtMaterials` *change the
 * material's shape* so the animation has a UBO field to write into. That is a
 * second-order effect the material alone cannot show — Scene 253's
 * OcclusionStrength sphere is an ordinary occlusion material whose composed
 * fragment reads no occlusion at all, purely because its strength animates.
 */
interface PinnedAnimatedExtensionTargets {
    occlusionStrength?: boolean;
    transmission?: boolean;
    ior?: boolean;
    volumeThickness?: boolean;
    volumeTint?: boolean;
}

/** The per-family material-index sets `animatedTargets` returns. */
interface PinnedAnimatedTargetSets {
    occlusionStrength: ReadonlySet<number>;
    transmission: ReadonlySet<number>;
    ior: ReadonlySet<number>;
    volumeThickness: ReadonlySet<number>;
    volumeTint: ReadonlySet<number>;
}

/**
 * `animatedTargets`, executed from the pin, projected onto per-material flag
 * records. The pointer regexes are the pin's own; only the flag names are
 * this module's, because `seedAnimatedExtensions` re-expands them into the
 * index sets `seedExtMaterials` takes.
 */
export function gltfAnimatedExtensionTargets(
    document: JsonObject,
): ReadonlyMap<number, PinnedAnimatedExtensionTargets> {
    const pin = executedPin();
    const animated = pin.animatedTargets(document);
    const families: ReadonlyArray<
        readonly [keyof PinnedAnimatedExtensionTargets, ReadonlySet<number>]
    > = [
        ["occlusionStrength", animated.occlusionStrength],
        ["transmission", animated.transmission],
        ["ior", animated.ior],
        ["volumeThickness", animated.volumeThickness],
        ["volumeTint", animated.volumeTint],
    ];
    const targets = new Map<number, PinnedAnimatedExtensionTargets>();
    for (const [family, indices] of families) {
        for (const material of indices) {
            const entry = targets.get(material) ?? {};
            entry[family] = true;
            targets.set(material, entry);
        }
    }
    return targets;
}

/**
 * `seedExtMaterials`, executed over a one-material view.
 *
 * The pin runs it per document, reading `json.materials[matIdx]` beside the
 * built material map. This module is handed one material and its flags, so
 * the bridge synthesizes that view — a single-entry document and map, and the
 * flags re-expanded into the index sets — and the pin's own function does the
 * seeding, `iorToF0Factor` included. The reflectance setter is wired exactly
 * when `prepareExtMaterials` would wire it: an occlusion-strength or ior
 * family with targets.
 */
function seedAnimatedExtensions(
    input: PinnedMaterialInput,
    material: JsonObject,
    animated: PinnedAnimatedExtensionTargets,
): void {
    const pin = executedPin();
    const indices = (flagged?: boolean): ReadonlySet<number> =>
        flagged ? new Set([0]) : new Set();
    pin.seedExtMaterials(
        { materials: [material] },
        [input],
        {
            occlusionStrength: indices(animated.occlusionStrength),
            transmission: indices(animated.transmission),
            ior: indices(animated.ior),
            volumeThickness: indices(animated.volumeThickness),
            volumeTint: indices(animated.volumeTint),
        },
        animated.occlusionStrength || animated.ior
            ? pin.setPbrMetallicReflectance
            : null,
    );
}

/** Resolve image identity with the pinned loader's alternate-source rules. */
export function gltfImageResolver(
    document: JsonObject,
): (textureIndex: unknown) => number | undefined {
    const textures = Array.isArray(document["textures"])
        ? (document["textures"] as JsonObject[])
        : [];
    const { getTextureImageIndex } = executedPin();
    return (textureIndex) => {
        if (typeof textureIndex !== "number") return undefined;
        const texture = textures[textureIndex];
        if (!texture) return undefined;
        const source = getTextureImageIndex(texture);
        return typeof source === "number" ? source : undefined;
    };
}

/** The texture set `buildDefaultPbrTexturesExt` returns; `void 0` slots stay. */
interface PinnedTextureSet {
    baseColorTexture: JsonObject | undefined;
    ormTexture: JsonObject | undefined;
    normalTexture: JsonObject | undefined;
    emissiveTexture: JsonObject | undefined;
    occlusionTexture: JsonObject | undefined;
}

/** The executed pinned callables this module drives. */
interface PinnedLoaderExecution {
    getTextureImageIndex: (texture: JsonObject) => unknown;
    registry: PinnedMaterialRegistry;
    buildDefaultPbrTexturesExt: (
        engine: unknown,
        mat: JsonObject,
        sampler: undefined,
        generateMipmaps: () => void,
        getCachedTex: (image: unknown, srgb: boolean) => JsonObject,
        wrapTex: (texture: JsonObject, texInfo: unknown) => JsonObject,
        extLayers: JsonObject | undefined,
        samplerFor: undefined,
    ) => PinnedTextureSet;
    assemblePbrPropsExt: (
        mat: JsonObject,
        textures: PinnedTextureSet,
        extLayers: JsonObject | undefined,
    ) => JsonObject;
    needsGltfUvTransform: (textures: PinnedTextureSet) => boolean;
    needsGltfEmissive: (mat: JsonObject, emissiveTexture: unknown) => boolean;
    setPbrEmissive: (material: PinnedMaterialInput, color: number[]) => void;
    setPbrAlphaCutoff: (
        material: PinnedMaterialInput,
        alphaCutOff: unknown,
    ) => void;
    setPbrMetallicReflectance: (
        material: PinnedMaterialInput,
        options: JsonObject,
    ) => void;
    enableMaterialUvTransform: (material: PinnedMaterialInput) => boolean;
    animatedTargets: (json: JsonObject) => PinnedAnimatedTargetSets;
    seedExtMaterials: (
        json: JsonObject,
        map: readonly PinnedMaterialInput[],
        animated: PinnedAnimatedTargetSets,
        setReflectance:
            | ((material: PinnedMaterialInput, options: JsonObject) => void)
            | null,
    ) => void;
}

/**
 * Everything the pinned extensions are allowed to have set. A key outside
 * this list means the pin grew a new option this module has never projected,
 * and the right response is a loud failure at generation time, not a silent
 * pass-through whose downstream meaning nobody checked.
 */
/**
 * `setPbrMetallicReflectance`'s write order, which is also the order the
 * transcription used to write them, so the projection preserves both.
 */
const reflectanceProperties = [
    "_metallicReflectanceColor",
    "_metallicReflectanceTexture",
    "_reflectanceTexture",
    "_metallicF0Factor",
    "_specularWeight",
    "_useOnlyMetallicFromMetallicReflectanceTexture",
] as const;

/** A non-enumerable observation stamped by the dielectric import shim when
 *  the pin actually calls its setter, including with an empty options object. */
const reflectanceRegistrationMarker = "__bbliteMetallicReflectanceRegistered";

/**
 * `gltf-ext-spec-gloss.ts` writes the base workflow rather than a layer, so
 * these five are the fields its returned fragment merges over the core
 * material.
 */
const specGlossProperties = [
    "metallicFactor",
    "roughnessFactor",
    "reflectance",
    "baseColorTexture",
    "specGlossTexture",
] as const;

const knownLayerProperties = new Set([
    "_clearCoat",
    "_sheen",
    "_iridescence",
    "_anisotropy",
    "_emissiveColor",
    "_unlit",
    "_unlitColor",
    "_transmissive",
    "_subsurface",
    ...reflectanceProperties,
    ...specGlossProperties,
    "baseColorFactor",
    "alpha",
    "metadata",
]);

/** Register the curated PBR order before loading the recording material realm. */
async function loadPinnedLoaderExecution(
    context: LoweringContext = sharedPinnedContext(),
): Promise<PinnedLoaderExecution> {
    await registeredPbrExtensionIds();
    const parser = await importPinnedModule<{
        getTextureImageIndex: PinnedLoaderExecution["getTextureImageIndex"];
    }>("loader-gltf/gltf-parser.js");
    const builder = await importPinnedModule<{
        needsGltfEmissive: (
            mat: JsonObject,
            emissiveTexture: unknown,
        ) => boolean;
    }>("loader-gltf/gltf-pbr-builder.js");
    // The texture assembly's factor-texel branches call the pin's own GPU
    // uploads, which run against the recording engine below: a factor
    // texel's only reads here are its missing `_hasTx`/`_texCoord` markers
    // and its truthiness, both of which the pin's texture record carries.
    const builderExt = (await importPinnedModuleUnasynced(
        "loader-gltf/gltf-pbr-builder-ext.js",
        ["needsGltfUvTransform"],
    )) as {
        buildDefaultPbrTexturesExt: PinnedLoaderExecution["buildDefaultPbrTexturesExt"];
        assemblePbrPropsExt: PinnedLoaderExecution["assemblePbrPropsExt"];
        needsGltfUvTransform: PinnedLoaderExecution["needsGltfUvTransform"];
    };
    const emissive = await importPinnedModule<{
        setPbrEmissive: PinnedLoaderExecution["setPbrEmissive"];
    }>("material/pbr/set-emissive.js");
    const alphaCutoff = await importPinnedModule<{
        setPbrAlphaCutoff: PinnedLoaderExecution["setPbrAlphaCutoff"];
    }>("material/pbr/set-alpha-cutoff.js");
    const reflectance = await importPinnedModule<{
        setPbrMetallicReflectance: PinnedLoaderExecution["setPbrMetallicReflectance"];
    }>("material/pbr/set-metallic-reflectance.js");
    const uvEnable = await importPinnedModule<{
        enableMaterialUvTransform: PinnedLoaderExecution["enableMaterialUvTransform"];
    }>("material/pbr/enable-material-uv-transform.js");
    const pointerExt = await importPinnedModuleUnasynced(
        "loader-gltf/animation-pointer-ext.js",
        ["animatedTargets", "seedExtMaterials"],
    );
    const reflectanceModuleUrl = pathToFileURL(
        resolve(
            pinnedLibraryRoot(),
            "material/pbr/set-metallic-reflectance.js",
        ),
    ).href;
    const reflectanceRegistrationShim = javascriptModuleUrl(
        `import { setPbrMetallicReflectance as pinnedSetter } from ${JSON.stringify(
            reflectanceModuleUrl,
        )};\n` +
            `export function setPbrMetallicReflectance(material, options) {\n` +
            `  pinnedSetter(material, options);\n` +
            `  Object.defineProperty(material, ${JSON.stringify(
                reflectanceRegistrationMarker,
            )}, { value: true, enumerable: false });\n` +
            `}\n`,
    );
    const registry = await loadPinnedMaterialRegistry(
        context,
        new Map([
            [
                "../material/pbr/set-transmission.js",
                recordingTransmissionSetter("transmission", context),
            ],
            [
                "../material/pbr/set-dispersion.js",
                recordingTransmissionSetter("dispersion", context),
            ],
            [
                "../material/pbr/set-metallic-reflectance.js",
                reflectanceRegistrationShim,
            ],
        ]),
    );
    return {
        getTextureImageIndex: parser.getTextureImageIndex,
        registry,
        buildDefaultPbrTexturesExt: builderExt.buildDefaultPbrTexturesExt,
        assemblePbrPropsExt: builderExt.assemblePbrPropsExt,
        needsGltfUvTransform: builderExt.needsGltfUvTransform,
        needsGltfEmissive: builder.needsGltfEmissive,
        setPbrEmissive: emissive.setPbrEmissive,
        setPbrAlphaCutoff: alphaCutoff.setPbrAlphaCutoff,
        setPbrMetallicReflectance: reflectance.setPbrMetallicReflectance,
        enableMaterialUvTransform: uvEnable.enableMaterialUvTransform,
        animatedTargets: pointerExt[
            "animatedTargets"
        ] as PinnedLoaderExecution["animatedTargets"],
        seedExtMaterials: pointerExt[
            "seedExtMaterials"
        ] as PinnedLoaderExecution["seedExtMaterials"],
    };
}

let pinExecutionPromise: Promise<PinnedLoaderExecution> | undefined;
let pinExecution: PinnedLoaderExecution | undefined;

/** Initialize once, registering curated extensions before importing loaders. */
export async function ensurePinnedLoaderExecution(): Promise<void> {
    pinExecutionPromise ??= loadPinnedLoaderExecution();
    pinExecution = await pinExecutionPromise;
}

/** Prepare one document's source-selected hooks before projecting its materials. */
export async function preparePinnedMaterialFeatures(
    document: JsonObject,
    context?: LoweringContext,
): Promise<PreparedMaterialFeatures> {
    await ensurePinnedLoaderExecution();
    const pin = context
        ? await loadPinnedLoaderExecution(context)
        : executedPin();
    return pin.registry.prepare(document);
}

/** The executed pin, or a loud refusal naming the missing await. */
function executedPin(): PinnedLoaderExecution {
    if (pinExecution === undefined) {
        throw new Error(
            "pinned-material-input: the executed pinned loader has not " +
                "run; await ensurePinnedLoaderExecution() before reading " +
                "materials through this module.",
        );
    }
    return pinExecution;
}

/**
 * The engine the factor-texel uploads run against. `samplerFor` is withheld,
 * so every image-backed slot goes through the `getCachedTex` stub instead,
 * and the one upload the pin makes here is `uploadTex` writing a factor
 * texel; nothing it records is read back, and the mipmap generator it is
 * handed is reached only for a decoded image.
 */
const uploadEngine: unknown = {
    _device: createRecordingDevice({
        producer: "gltf-material-input",
        device: ["createTexture"],
        queue: ["writeTexture"],
    }).device,
};

const noopGenerateMipmaps = (): void => {};

/** Slot-shaped recording textures carry markers from the document's selected wraps. */
function builtExtensionTexture(
    prepared: PreparedMaterialFeatures,
    imageOf: (textureIndex: unknown) => number | undefined,
    slot: unknown,
): JsonObject | undefined {
    const info = asObject(slot);
    if (!info || imageOf(info["index"]) === undefined) return undefined;
    const wrapped = prepared.wrapTexture({}, info);
    return {
        ...info,
        ...(wrapped["_hasTx"] === true ? { _hasTx: true as const } : {}),
        ...(wrapped["_texCoord"] === 1 ? { _texCoord: 1 as const } : {}),
    };
}

/** Registration observations remain separate from the source's fragment merge. */
interface PinnedExtensionLayerResult {
    layers: JsonObject;
    metallicReflectanceRegistered: boolean;
    transmissionRegistered: boolean;
}

function pinnedExtensionLayers(
    prepared: PreparedMaterialFeatures,
    mat: JsonObject,
    imageOf: (textureIndex: unknown) => number | undefined,
): PinnedExtensionLayerResult {
    const ctx: PinnedMaterialFeatureContext = {
        _texture: (texInfo, _sRGB) =>
            builtExtensionTexture(prepared, imageOf, texInfo),
    };
    let metallicReflectanceRegistered = false;
    let transmissionRegistered = false;
    const observed = prepared.features.map((extension) => ({
        ...extension,
        applyMaterial(mat: JsonObject, ctx: PinnedMaterialFeatureContext) {
            const fragment = assertPinnedSync(
                extension.applyMaterial(mat, ctx),
                `${extension.id}.applyMaterial`,
            );
            if (fragment) {
                if (fragment[transmissionRegistrationMarker] === true)
                    transmissionRegistered = true;
                if (fragment[reflectanceRegistrationMarker] === true) {
                    metallicReflectanceRegistered = true;
                }
            }
            return fragment;
        },
    }));
    const layers =
        assertPinnedSync(
            prepared.runGltfMaterialFeatures(mat, observed, ctx),
            "runGltfMaterialFeatures",
        ) ?? {};
    for (const name of Object.keys(layers)) {
        if (!knownLayerProperties.has(name)) {
            throw new Error(
                `Pinned material extension set '${name}', which this ` +
                    `module has no projection for; the pin grew an option.`,
            );
        }
    }
    return { layers, metallicReflectanceRegistered, transmissionRegistered };
}

/**
 * An option object as the pin built it, minus the `undefined`-valued keys the
 * builders leave behind for the slots they could not build (`texture: tex`
 * with no image resolves to an explicit `undefined` upstream). Dropping them
 * is this module's long-standing output normalization — JSON-identical to the
 * pin's object, and what every existing consumer and baseline expects.
 */
function withoutUndefinedOptions(options: JsonObject): JsonObject {
    const scrubbed: JsonObject = {};
    for (const [name, value] of Object.entries(options)) {
        if (value !== undefined) scrubbed[name] = value;
    }
    return scrubbed;
}

export function pinnedMaterialInputFromGltf(
    material: JsonObject,
    scene: PinnedMaterialSceneContext = {},
): PinnedMaterialInput {
    const pin = executedPin();
    const pbr = asObject(material["pbrMetallicRoughness"]) ?? {};
    const occlusion = asObject(material["occlusionTexture"]);
    const imageOf = scene.imageOf ?? ((): undefined => undefined);
    const prepared =
        scene.materialFeatures ??
        pin.registry.prepare({ materials: [material] });

    // The pin's own loader steps, over this one material: the parsed state,
    // the extension fragments, the texture assembly, the props assembly.
    const mat = pinnedGltfMaterialCore()(material, imageOf);
    const { layers, metallicReflectanceRegistered, transmissionRegistered } =
        pinnedExtensionLayers(prepared, mat, imageOf);
    if (metallicReflectanceRegistered) {
        scene.recordMetallicReflectanceRegistration?.();
    }
    if (transmissionRegistered) scene.recordTransmissionRegistration?.();
    const textures = pin.buildDefaultPbrTexturesExt(
        uploadEngine,
        mat,
        undefined,
        noopGenerateMipmaps,
        () => ({}),
        prepared.wrapTexture,
        layers,
        undefined,
    );
    const props = pin.assemblePbrPropsExt(mat, textures, layers);

    const input: PinnedMaterialInput = {
        // The base texture fields stay slot-shaped — the raw glTF slot stands
        // in for the pin's GPU texture record, carrying the same truthiness
        // for every slot with an image behind it. `buildDefaultPbrTexturesExt`
        // attaches the emissive texture from the image alone; the factor
        // gates only `_emissiveColor` below — Scene 253's module 9 shows
        // exactly that: an emissive texture bound, and no `emissiveUVm`
        // beside it.
        emissiveTexture: asObject(material["emissiveTexture"]),
        normalTexture: asObject(material["normalTexture"]),
        doubleSided: props["doubleSided"] as boolean,
        // `assemblePbrPropsExt` sets this unconditionally: every glTF PBR
        // material composes the specular-AA block that derives `alphaG` from
        // the normal's screen-space slope.
        enableSpecularAA: props["enableSpecularAA"] as boolean,
        // The pin's `mat._occlusionImage ? 1 : 0` — whether an occlusion
        // image was decoded at all, not the glTF `strength`.
        // `_computePbrMaterialFeatures` reads it as PBR_HAS_OCCLUSION.
        occlusionStrength: props["occlusionStrength"] as number,
    };
    // ExtrasAsMetadata returns an opaque payload; preserve the source's shape and identity.
    if ("metadata" in props) input.metadata = props["metadata"];
    // `_emissiveColor`, three writers in the pin's own order:
    // `gltf-ext-emissive-strength.ts` ran with the other extensions and wrote
    // `factor * strength` whenever the extension is declared; an animated
    // pointer needs the field regardless of the load-time factor
    // (`gltf-feature-animation-pointer.ts`, mirrored — its module is
    // asset-level plumbing); otherwise the executed `needsGltfEmissive`
    // decides and the pin's own setter writes. The predicate's texture
    // operand is the slot, standing in for the built texture as everywhere
    // else in the output shape.
    if ("_emissiveColor" in layers) {
        input["_emissiveColor"] = layers["_emissiveColor"];
    } else if (scene.animatedEmissive) {
        input["_emissiveColor"] = asNumbers(material["emissiveFactor"]) ?? [
            1, 1, 1,
        ];
    } else if (
        pin.needsGltfEmissive(mat, asObject(material["emissiveTexture"]))
    ) {
        const factor = mat["_emissiveFactor"] as number[];
        pin.setPbrEmissive(input, [factor[0]!, factor[1]!, factor[2]!]);
    }
    // The occlusion carrier is whatever the executed texture assembly built:
    // its own slot on a second UV set, or the orm-unpack split when occlusion
    // and metallic-roughness name one image through different texture objects
    // or a declared transform. The carried fields stay slot-shaped.
    if (textures.occlusionTexture && occlusion) {
        input["occlusionTexture"] = occlusion;
        if ("occlusionTexCoord" in props) {
            input["occlusionTexCoord"] = props["occlusionTexCoord"];
        }
    }
    // `assemblePbrPropsExt`'s own mask, executed — read off the built
    // textures' `_texCoord`, except occlusion, which is read off the
    // material, so a UV2 occlusion that becomes its own carrier still sets
    // bit 32.
    if ("_uv2Mask" in props) {
        input["_uv2Mask"] = props["_uv2Mask"] as number;
    }
    // `PBR2_HAS_UV_TRANSFORM` follows the executed `needsGltfUvTransform`
    // over the built textures — so a declared-but-empty transform, or a
    // transform on a slot the assembly never built, composes nothing — and
    // the pin's own `enableMaterialUvTransform` writes the field, here as in
    // the animated-pointer path upstream.
    if (pin.needsGltfUvTransform(textures) || scene.animatedUvTransform) {
        pin.enableMaterialUvTransform(input);
    }
    if (scene.linearImageProcessing) input["_linearImageProcessing"] = true;
    // The factor field follows source assembly or animated-pointer preparation.
    // Without an image the factor is baked into the uploaded texel instead.
    if ("baseColorFactor" in props || scene.animatedBaseColorFactor) {
        input.baseColorFactor = (
            "baseColorFactor" in props
                ? props["baseColorFactor"]
                : mat["_baseColorFactor"]
        ) as readonly number[];
    }
    // The executed assembly's own alpha block: BLEND carries the blend flag
    // and the factor's alpha; MASK carries the alpha and, through the pin's
    // alpha-test setter, the cutoff — the two `applyGltfOptInPbrFeatures`
    // gates, mirrored around the executed setter.
    if ("alphaBlend" in props) {
        input.alphaBlend = props["alphaBlend"] as boolean;
        input.alpha = props["alpha"] as number;
    }
    if (mat["_alphaMode"] === "MASK") {
        input.alpha = props["alpha"] as number;
        pin.setPbrAlphaCutoff(input, mat["_alphaCutoff"]);
    }
    if (asObject(pbr["metallicRoughnessTexture"])) {
        // The ORM slot is the metallic-roughness image; the pin reads it off
        // the material rather than through an extension.
        input["ormTexture"] = asObject(pbr["metallicRoughnessTexture"]);
    }
    if (asObject(pbr["baseColorTexture"])) {
        input["baseColorTexture"] = asObject(pbr["baseColorTexture"]);
    }
    // The layered extensions, exactly as their executed `setPbrX` calls set
    // them — presence alone enables each layer (`if (!c) return null;` then
    // `isEnabled: true`), the coat's normal map arrives as `bumpTexture`,
    // the glTF coat carries `useF0Remap: false`, the sheen model
    // `albedoScaling: true`, and a sheen roughness map that is the tint map
    // is dropped because that packing reads roughness from the tint's alpha.
    for (const property of [
        "_clearCoat",
        "_sheen",
        "_iridescence",
        "_anisotropy",
    ] as const) {
        if (property in layers) {
            input[property] = withoutUndefinedOptions(
                layers[property] as JsonObject,
            );
        }
    }
    // The dielectric cluster's fragment — ior, specular, volume, transmission
    // and dispersion interact in one pinned extension, and the quietest
    // interaction costs a variant: any `ior !== 1.5` composes a reflectance
    // arm, which is why Scene 253's Transmission sphere carries one at ior
    // 1.209. Projected in this module's long-standing field order; the
    // reflectance names are the pin's own setter writes.
    if (layers["_transmissive"] === true) input["_transmissive"] = true;
    if ("_subsurface" in layers) input["_subsurface"] = layers["_subsurface"];
    for (const property of reflectanceProperties) {
        if (property in layers) input[property] = layers[property];
    }
    // `gltf-ext-spec-gloss.ts` replaces the metallic-roughness workflow
    // outright, so its writes land on the base material: the loader merges
    // the fragment over the core fields, and `specGlossTexture` is what the
    // pin's own derivation reads for `PBR_HAS_SPEC_GLOSS`.
    for (const property of specGlossProperties) {
        if (property in layers) input[property] = layers[property];
    }
    // The extension owns unlit fields; base-color assembly owns the tint.
    if ("_unlit" in layers) {
        input["_unlit"] = layers["_unlit"];
        if ("_unlitColor" in layers) {
            input["_unlitColor"] = layers["_unlitColor"];
        }
    }

    if (scene.animatedExtensionTargets) {
        seedAnimatedExtensions(input, material, scene.animatedExtensionTargets);
        if (
            scene.animatedExtensionTargets.occlusionStrength ||
            scene.animatedExtensionTargets.ior
        ) {
            scene.recordMetallicReflectanceRegistration?.();
        }
    }
    return input;
}
