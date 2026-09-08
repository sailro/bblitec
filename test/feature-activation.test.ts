import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { AssetSpecializationFeatures } from "../src/asset-specializer.js";
import type { CompiledShaderProgram } from "../src/compiler/types.js";
import type { NodeParticleSystemEmit } from "../src/lowering/node-particle-lowerer.js";
import type { NodeVariantManifestEntry } from "../src/pinned-node-material-cpp.js";
import type { PinnedVariantManifestEntry } from "../src/pinned-pbr-variant-output.js";
import type { PinnedStandardVariantManifestEntry } from "../src/pinned-standard-variants.js";
import type { UpstreamEmitOptions } from "../src/upstream-lower.js";
import {
    featureActivationRows,
    inventoriedRuntimeFeatures,
    type FeatureActivationInputs,
    type FeatureActivationRow,
} from "../src/feature-activation.js";

function specialization(
    overrides: Partial<AssetSpecializationFeatures> = {},
): AssetSpecializationFeatures {
    return {
        gpuDeformation: false,
        animatedWorldBounds: false,
        morphStorage: false,
        maxSkinJoints: 0,
        nonTrianglePrimitives: false,
        pointOrLinePrimitives: false,
        nodeVisibility: false,
        animationPointer: false,
        animationPointerMaterials: false,
        assetTransmission: false,
        materialSpecular: false,
        materialExtensionPayload: false,
        imageBasedLighting: false,
        textureTransform: false,
        gpuInstancing: false,
        punctualLights: false,
        eightInfluenceSkinning: false,
        gaussianSplats: false,
        compressedImages: false,
        interactivity: false,
        ...overrides,
    };
}

function emitOptions(
    overrides: Partial<UpstreamEmitOptions> = {},
): UpstreamEmitOptions {
    return {
        idDiagnostics: false,
        shaderPrograms: [],
        spriteCustomShaders: [],
        effects: [],
        plainSpriteLayer: true,
        plainBillboardSystem: true,
        geometryOutputTasks: [],
        postProcessTasks: [],
        postProcessShaders: [],
        postProcessComposites: [],
        gpuDeformation: false,
        animatedWorldBounds: false,
        morphStorage: false,
        nonTrianglePrimitives: false,
        gaussianSplats: false,
        compressedImages: false,
        nodeVisibility: false,
        gltfNodeVisibility: false,
        animationPointer: false,
        animationPointerMaterials: false,
        assetTransmission: false,
        materialSpecular: false,
        materialExtensionPayload: false,
        selectedMaterialVariant: "",
        standardLightLists: false,
        standardDiffuseUv2: false,
        textureTransform: false,
        imageBasedLighting: false,
        gpuInstancing: false,
        gpuInstanceColors: false,
        punctualLights: false,
        clearcoat: false,
        sheen: false,
        iridescence: false,
        specularGlossiness: false,
        dispersion: false,
        occlusionUv2: false,
        ...overrides,
    };
}

/**
 * Composed PBR variants, optionally all carrying one composition shape: the
 * pin's fragment key (which extension fragments it spliced) and a fragment
 * stage's group-1 bindings, which are what the capability rows read.
 */
function variants(
    count: number,
    composed: { fragmentKey?: string; fragmentWgsl?: string } = {},
): PinnedVariantManifestEntry[] {
    return Array.from({ length: count }, (_, index) => ({
        fragmentKey: composed.fragmentKey ?? `key-${index}`,
        pipeline: `pipeline-${index}`,
        selectors: [],
        vertex: `variant-${index}.vert.wgsl`,
        fragment: `variant-${index}.frag.wgsl`,
        materialUbo: undefined,
        vertexWgsl: "",
        fragmentWgsl: composed.fragmentWgsl ?? "",
    }));
}

/** A fragment stage binding the pin's spec-gloss and uv2 occlusion pairs. */
const specGlossAndOcclusionUv2Bindings =
    "@group(1) @binding(2) var specGlossTexture: texture_2d<f32>;\n" +
    "@group(1) @binding(3) var specGlossSampler: sampler;\n" +
    "@group(1) @binding(4) var occlusionTexture: texture_2d<f32>;\n" +
    "@group(1) @binding(5) var occlusionSampler_: sampler;";

function metallicReflectanceMapInputs(
    binding: "metallicReflectanceMap" | "reflectanceMap",
): FeatureActivationInputs {
    const sampler = `${binding}Sampler`;
    return {
        features: ["material:metallic-reflectance"],
        assetJoinedFeatures: new Map(),
        specialization: specialization(),
        emit: emitOptions({
            pinnedVariants: [
                {
                    ...variants(1)[0]!,
                    fragmentWgsl:
                        `@group(1) @binding(2) var ${binding}: texture_2d<f32>;\n` +
                        `@group(1) @binding(3) var ${sampler}: sampler;`,
                },
            ],
        }),
        imageCodecs: [],
        gltfAssetNames: [],
        composition: {
            lightKinds: [],
            toneMappingStates: [false],
            mutableToneMappingEnabled: false,
            linearImageProcessing: false,
        },
    };
}

/**
 * Inputs shaped like scene33's measured generation: a KHR_lights_punctual
 * lamp GLB with 5 light nodes and a transmissive material, joining
 * `light:point`; a scene-source `.env` environment; scene-source
 * transmission as well; 18 composed variants.
 */
function scene33Inputs(): FeatureActivationInputs {
    const lamp = "94162f67-LightsPunctualLamp.glb";
    return {
        features: [
            "core",
            "backend:sdl",
            "camera:arc-rotate",
            "camera:default",
            "environment:ibl",
            "environment:env",
            "loader:gltf",
            "renderer:scene",
            "renderer:transmission",
            "material:pbr-linear-image-processing",
            "light:point",
        ],
        assetJoinedFeatures: new Map([["light:point", lamp]]),
        // The manifest's first-reach record: the entry file's call
        // sites, minus the seeded "core" and the asset-joined kind.
        featureSites: {
            "backend:sdl": "scene33.ts:42",
            "camera:arc-rotate": "scene33.ts:12",
            "camera:default": "scene33.ts:12",
            "environment:ibl": "scene33.ts:15",
            "environment:env": "scene33.ts:15",
            "loader:gltf": "scene33.ts:9",
            "renderer:scene": "scene33.ts:9",
            "renderer:transmission": "scene33.ts:24",
            "material:pbr-linear-image-processing": "scene33.ts:24",
        },
        specialization: specialization({
            punctualLights: true,
            assetTransmission: true,
        }),
        emit: emitOptions({
            punctualLights: true,
            assetTransmission: true,
            assetLightNodes: { count: 5, asset: lamp },
            pinnedVariants: variants(18),
        }),
        imageCodecs: ["png"],
        gltfAssetNames: [lamp],
        pinnedMaxLights: 8,
        // No scene-code meshes or PBR materials: the guards had nothing
        // to compare against the one glTF load.
        interleave: {
            sceneMeshGltfAssetsBefore: [],
            scenePbrMaterialGltfAssetsBefore: [],
            gltfAssetCount: 1,
        },
        composition: {
            lightKinds: ["point"],
            toneMappingStates: [true],
            mutableToneMappingEnabled: false,
            linearImageProcessing: true,
        },
    };
}

/**
 * A scene whose only material activations come from what its asset
 * composed: an iridescent, dispersive, transmissive GLB with no
 * scene-source material features, so every arm is the composition's.
 */
function dispersiveInputs(): FeatureActivationInputs {
    return {
        features: [
            "core",
            "backend:sdl",
            "camera:arc-rotate",
            "loader:gltf",
            "renderer:scene",
        ],
        assetJoinedFeatures: new Map(),
        specialization: specialization({
            assetTransmission: true,
        }),
        emit: emitOptions({
            iridescence: true,
            dispersion: true,
            assetTransmission: true,
            pinnedVariants: variants(2, {
                fragmentKey: "ibl|iridescence|refraction",
            }),
        }),
        imageCodecs: ["png"],
        gltfAssetNames: ["dispersive.glb"],
        composition: {
            lightKinds: [],
            toneMappingStates: [false],
            mutableToneMappingEnabled: false,
            linearImageProcessing: true,
        },
    };
}

/** Every mechanism activated at once, to walk every row's active arm. */
function everythingOnInputs(): FeatureActivationInputs {
    return {
        features: [...inventoriedRuntimeFeatures],
        assetJoinedFeatures: new Map([
            ["light:directional", "a.glb"],
        ]),
        specialization: specialization({
            gpuDeformation: true,
            animatedWorldBounds: true,
            morphStorage: true,
            nonTrianglePrimitives: true,
            nodeVisibility: true,
            animationPointer: true,
            animationPointerMaterials: true,
            assetTransmission: true,
            materialSpecular: true,
            imageBasedLighting: true,
            textureTransform: true,
            gpuInstancing: true,
            punctualLights: true,
            eightInfluenceSkinning: true,
        }),
        emit: emitOptions({
            idDiagnostics: true,
            geometryOutputTasks: [
                { shaderIndex: 0, attachments: [], emitColor: true },
            ],
            gpuDeformation: true,
            animatedWorldBounds: true,
            morphStorage: true,
            nonTrianglePrimitives: true,
            nodeVisibility: true,
            animationPointer: true,
            animationPointerMaterials: true,
            assetTransmission: true,
            materialSpecular: true,
            standardLightLists: true,
            standardDiffuseUv2: true,
            textureTransform: true,
            imageBasedLighting: true,
            gpuInstancing: true,
            // Derived the way cli.ts derives it: the feature list above
            // includes mesh:thin-instance-colors, so the emitted define is
            // on and the new capability row's cross-check must agree.
            gpuInstanceColors: true,
            punctualLights: true,
            // The arms as the CLI derives them: the union over the composed
            // variants, which the entries below carry in their keys and
            // bindings so the rows' second reading agrees.
            clearcoat: true,
            sheen: true,
            iridescence: true,
            dispersion: true,
            specularGlossiness: true,
            occlusionUv2: true,
            assetLightNodes: { count: 4, asset: "a.glb" },
            pinnedVariants: variants(7, {
                fragmentKey: "ibl|clearcoat-IRNX|sheen|iridescence|refraction",
                fragmentWgsl: specGlossAndOcclusionUv2Bindings,
            }),
        }),
        imageCodecs: ["png", "jpeg", "webp"],
        gltfAssetNames: ["a.glb"],
        pinnedMaxLights: 8,
        // Two scene-code meshes and one PBR material, all created after
        // the single glTF load: the guards' clean pass.
        interleave: {
            sceneMeshGltfAssetsBefore: [1, 1],
            scenePbrMaterialGltfAssetsBefore: [1],
            gltfAssetCount: 1,
        },
        featureSites: {
            "mesh:box": "everything.ts:3",
        },
        composition: {
            lightKinds: ["hemispheric", "directional", "point", "spot"],
            toneMappingStates: [false, true],
            mutableToneMappingEnabled: true,
            linearImageProcessing: true,
        },
    };
}

/**
 * A scene shaped like the sprite/effect/particle families: custom sprite
 * shaders, effect wrappers, a frozen node-particle system, shader-material
 * programs, and both non-PBR composed material families — the mechanisms
 * the FA-2 backfill rows cover, active all at once.
 */
function familyInputs(): FeatureActivationInputs {
    const frozen: NodeParticleSystemEmit = {
        bake: {
            set: 0,
            system: 0,
            capacity: 16,
            blendMode: 0,
            updateSpeed: 0,
            stepIsIdentity: true,
            texture: {
                url: "textures/flare.png",
                invertY: false,
                sceneAssigned: false,
                width: 128,
                height: 128,
            },
            spriteSheet: null,
            alive: 0,
            positions: [],
            sizes: [],
            colors: [],
            rotations: [],
            frames: null,
        },
        exactBlend: false,
        textureAsset: "flare.png",
    };
    const shaderProgram: CompiledShaderProgram = {
        name: "lines",
        vertexSource: "",
        fragmentSource: "",
        attributes: [],
        uniforms: [],
        uniformDefaults: [],
          samplers: [],
          samplerDeclarations: [],
          storageBuffers: [],
          defines: [],
        needAlphaBlending: false,
        blendMode: "alpha",
        needAlphaTesting: false,
        backFaceCulling: true,
        depthWrite: true,
    };
    const standardVariant: PinnedStandardVariantManifestEntry = {
        fragmentKey: "std-base",
        features: 0,
        meshFeatures: 0,
        vertex: "std-base.vert.wgsl",
        fragment: "std-base.frag.wgsl",
        vertexWgsl: "",
        fragmentWgsl: "",
    };
    const nodeVariant: NodeVariantManifestEntry = {
        index: 0,
        vertexStem: "node-0.vert",
        fragmentStem: "node-0.frag",
        composed: {
            wgsl: "",
            uboBytes: 0,
            uboBinding: null,
            uboFloats: [],
            attributes: [],
            shadowBindings: [],
            caster: null,
            textures: [],
            inputs: [],
            backFaceCulling: true,
            alphaBlending: false,
            envBindings: null,
            morphBindings: null,
            geometryViews: [],
        },
    };
    return {
        features: [
            "core",
            "renderer:sprite",
            "sprite:2d",
            "sprite:billboard",
            "sprite:custom-shader",
            "particle:node",
            "physics:world",
            "physics:aggregate",
            "texture:compressed",
            "loader:splat",
            "material:shader",
            "material:standard",
            "material:node",
            "mesh:lines",
            "effect:wrapper",
        ],
        assetJoinedFeatures: new Map(),
        specialization: specialization(),
        emit: emitOptions({
            spriteCustomShaders: [
                { family: "sprite", fragment: "", extraTextures: [] },
            ],
            effects: [{
                family: "effect",
                name: "glow",
                fragment: "",
                bindings: [],
            }],
            plainSpriteLayer: false,
            plainBillboardSystem: false,
            pinnedSkeletonPalette: true,
            nodeParticles: [frozen],
            shaderPrograms: [shaderProgram],
            pinnedStandardVariants: [standardVariant],
            nodeVariants: [nodeVariant],
        }),
        imageCodecs: ["png"],
        gltfAssetNames: [],
        composition: {
            lightKinds: [],
            toneMappingStates: [false],
            mutableToneMappingEnabled: false,
            linearImageProcessing: false,
        },
    };
}

/** A node graph declares morph storage, but no asset or mesh has targets. */
function graphOnlyMorphInputs(): FeatureActivationInputs {
    const base = familyInputs();
    const node = base.emit.nodeVariants![0]!;
    return {
        ...base,
        features: ["core", "material:node", "mesh:box"],
        specialization: specialization(),
        emit: emitOptions({
            nodeVariants: [{
                ...node,
                composed: {
                    ...node.composed,
                    morphBindings: { deltas: 1, weights: 2 },
                },
            }],
        }),
        imageCodecs: [],
    };
}

function named(
    rows: FeatureActivationRow[],
    name: string,
): FeatureActivationRow {
    const row = rows.find((candidate) => candidate.name === name);
    assert.ok(row, `expected a row named '${name}'`);
    return row;
}

test("records scene-source and asset-joined runtime features", () => {
    const rows = featureActivationRows(scene33Inputs());

    // Every inventoried runtime feature has a row, active or not.
    for (const feature of inventoriedRuntimeFeatures) {
        assert.ok(
            rows.some(
                (row) =>
                    row.name === feature &&
                    row.mechanism === "runtime-feature",
            ),
            `missing runtime-feature row for ${feature}`,
        );
    }

    // (i) A scene-source feature.
    const pbr = named(rows, "renderer:scene");
    assert.equal(pbr.active, true);
    assert.match(pbr.activatedBy, /^scene source/);
    assert.match(pbr.upstreamProvenance, /pbr-template\.ts/);
    assert.ok(pbr.consumers.includes("features.cmake"));

    // (ii) The asset-joined light kind names its asset and mechanism,
    // and feeds the composed scene arms.
    const point = named(rows, "light:point");
    assert.equal(point.active, true);
    assert.match(
        point.activatedBy,
        /asset-joined: 94162f67-LightsPunctualLamp\.glb carries KHR_lights_punctual kind "point"/,
    );
    assert.match(
        point.upstreamProvenance,
        /gltf-feature-lights-punctual\.ts/,
    );
    assert.ok(point.consumers.includes("variant table"));

    // The environment came from scene source, not the asset join.
    assert.match(
        named(rows, "environment:ibl").activatedBy,
        /^scene source/,
    );

    // An unreached feature stays in the inventory as an inactive row.
    const box = named(rows, "mesh:box");
    assert.equal(box.active, false);
    assert.equal(box.activatedBy, "not reached");
});

test("capability rows carry the composed set's activation", () => {
    const rows = featureActivationRows(dispersiveInputs());

    // (iii) A capability the asset's composed variants alone activate: the
    // row reads the arm off the composition and names no scene reach.
    const iridescence = named(rows, "BBLITE_MATERIAL_IRIDESCENCE");
    assert.equal(iridescence.active, true);
    assert.equal(iridescence.mechanism, "capability");
    assert.match(iridescence.activatedBy, /composed PBR variant carries/);
    assert.doesNotMatch(iridescence.activatedBy, /scene source/);
    assert.match(
        iridescence.upstreamProvenance,
        /gltf-ext-iridescence\.ts/,
    );
    assert.ok(iridescence.consumers.includes("render_capabilities.hpp"));

    // The same arm reached from scene source names the reach beside the
    // composition, and the composition is still what activates it.
    const sceneCoat = named(
        featureActivationRows({
            ...dispersiveInputs(),
            features: [...dispersiveInputs().features, "material:iridescence"],
        }),
        "BBLITE_MATERIAL_IRIDESCENCE",
    );
    assert.match(sceneCoat.activatedBy, /scene source reached material:iridescence/);

    // The transmission define reports the asset half only: the scene
    // never named the feature.
    const transmission = named(rows, "BBLITE_RENDERER_TRANSMISSION");
    assert.equal(transmission.active, true);
    assert.match(transmission.activatedBy, /transmissionFactor > 0/);
    assert.doesNotMatch(transmission.activatedBy, /scene source/);
});

test("a graph-only MorphTargetsBlock activates native empty morph storage", () => {
    const rows = featureActivationRows(graphOnlyMorphInputs());
    const morph = named(rows, "BBLITE_GPU_MORPH_STORAGE");
    assert.equal(morph.active, true);
    assert.match(morph.activatedBy, /compiled node graph/);
    assert.match(morph.activatedBy, /zero-target fallback/);
    // The graph needs buffer lifetime/bindings, not the transcribed PBR
    // deformation vertex layout.
    assert.equal(named(rows, "BBLITE_GPU_DEFORMATION").active, false);
});

test("metallic-reflectance map capabilities stay independent", () => {
    for (const [binding, activeName, inactiveName] of [
        [
            "metallicReflectanceMap",
            "BBLITE_MATERIAL_METALLIC_REFLECTANCE_MAP",
            "BBLITE_MATERIAL_REFLECTANCE_MAP",
        ],
        [
            "reflectanceMap",
            "BBLITE_MATERIAL_REFLECTANCE_MAP",
            "BBLITE_MATERIAL_METALLIC_REFLECTANCE_MAP",
        ],
    ] as const) {
        const rows = featureActivationRows(
            metallicReflectanceMapInputs(binding),
        );
        assert.equal(named(rows, activeName).active, true);
        assert.equal(named(rows, inactiveName).active, false);
    }
});

test("spec-gloss and uv2 occlusion key on the composed bindings", () => {
    // (iv) Active: a composed variant binds the pair, and the emitted
    // arm agrees.
    const inputs = scene33Inputs();
    const rows = featureActivationRows({
        ...inputs,
        emit: emitOptions({
            ...inputs.emit,
            specularGlossiness: true,
            occlusionUv2: true,
            pinnedVariants: variants(1, {
                fragmentWgsl: specGlossAndOcclusionUv2Bindings,
            }),
        }),
    });
    const specGloss = named(rows, "BBLITE_MATERIAL_SPEC_GLOSS");
    assert.equal(specGloss.active, true);
    assert.match(specGloss.activatedBy, /binds the spec-gloss pair/);
    assert.match(specGloss.upstreamProvenance, /PBR_HAS_SPEC_GLOSS/);
    assert.equal(named(rows, "BBLITE_MATERIAL_OCCLUSION_UV2").active, true);

    // Inactive: the row states that a declared extension without the
    // texture composes nothing the define would serve.
    const inactive = named(
        featureActivationRows(scene33Inputs()),
        "BBLITE_MATERIAL_SPEC_GLOSS",
    );
    assert.equal(inactive.active, false);
    assert.match(inactive.activatedBy, /metallic-roughness\s+path/);

    // An emitted arm no composed variant binds is the drift the checked
    // row refuses: the define would allocate a slot nothing reads.
    assert.throws(
        () =>
            featureActivationRows({
                ...inputs,
                emit: emitOptions({ ...inputs.emit, specularGlossiness: true }),
            }),
        /BBLITE_MATERIAL_SPEC_GLOSS/,
    );
});

test("composition and refusal rows report this scene's facts", () => {
    const rows = featureActivationRows(scene33Inputs());

    const lightModes = named(rows, "scene-arms:light-modes");
    assert.equal(lightModes.active, true);
    assert.match(lightModes.activatedBy, /single-light \[point\]/);

    assert.match(
        named(rows, "BBLITE_PBR_VARIANTS").activatedBy,
        /^18 variant\(s\)/,
    );

    // Refusals were checked and did not fire; the max-lights row records
    // the count it verified.
    const maxLights = named(rows, "refusal:max-lights");
    assert.equal(maxLights.active, false);
    assert.match(
        maxLights.activatedBy,
        /light-node count is 5 \(94162f67-LightsPunctualLamp\.glb\)/,
    );

    // The refusal relaxed to a fidelity adaptation is the one
    // refusal-family row that can be active in an emitted tree.
    const skinning = named(
        featureActivationRows(everythingOnInputs()),
        "refusal:eight-influence-skinning",
    );
    assert.equal(skinning.active, true);
    assert.match(skinning.activatedBy, /four-influence-skinning/);
    assert.deepEqual(skinning.consumers, ["fidelity.json"]);
});

/** Every file under a directory carrying one of the extensions. */
function sourceFiles(
    directory: string,
    extensions: readonly string[],
): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...sourceFiles(path, extensions));
        } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
            files.push(path);
        }
    }
    return files;
}

/**
 * Every `#define BBLITE_*` a generated tree can carry, by the emitter that
 * writes it. The emitters are the authority: scanning them is scanning
 * every tree at once, before any is generated, and holds for the pair
 * metallicReflectanceCapabilityDefines emits and the derived expressions.
 */
function emittedDefines(): Map<string, string> {
    const defines = new Map<string, string>();
    for (const file of sourceFiles("src", [".ts"])) {
        for (
            const match of readFileSync(file, "utf8").matchAll(
                /#define (BBLITE_[A-Z0-9_]+)/g,
            )
        ) {
            defines.set(match[1]!, file);
        }
    }
    assert.ok(defines.size > 0, "the define scan found the emitters");
    return defines;
}

/**
 * The emitted names that are constants rather than activation units: the
 * build stamp string, the asset-directory fallback and an include guard.
 */
const emittedConstants = new Set([
    "BBLITE_BUILD_STAMP",
    "BBLITE_ASSET_DIR",
    "BBLITE_UPSTREAM_CAMERA_CHANGE_KEY_HPP",
]);

test("every emitted BBLITE_ define has a capability row", () => {
    // Each define a generated tree carries must have a row, so the next
    // define cannot land without naming its activation -- whichever header
    // its lowerer writes it into.
    const rows = featureActivationRows(everythingOnInputs());
    for (const [define, emitter] of emittedDefines()) {
        if (emittedConstants.has(define)) continue;
        assert.ok(
            rows.some(
                (row) =>
                    row.name === define &&
                    row.mechanism === "capability",
            ),
            `${emitter} can emit ${define} with no capability row; add it ` +
                "to capabilityRows in src/feature-activation.ts",
        );
    }
});

test("every emitted BBLITE_ define has a reader", () => {
    // A define nothing tests gates nothing: it drifts silently while
    // reading as a capability the build honours. The readers are the
    // checked-in PAL sources (their own #define lines excluded), plus an
    // emitter's preprocessor test where generated code reads a define
    // another generated header wrote -- an include guard reads itself.
    const native = sourceFiles("native/src", [".cpp", ".hpp", ".h"]).map(
        (file) =>
            readFileSync(file, "utf8")
                .split("\n")
                .filter((line) => !/^\s*#\s*define\b/.test(line))
                .join("\n"),
    );
    assert.ok(native.length > 0, "the reader scan found the PAL sources");
    const emitters = sourceFiles("src", [".ts"]).map((file) =>
        readFileSync(file, "utf8")
    );
    for (const [define, emitter] of emittedDefines()) {
        const word = new RegExp(`\\b${define}\\b`);
        const preprocessorRead = new RegExp(
            `#\\s*(?:if|ifdef|ifndef|elif)\\b[^\\n]*\\b${define}\\b`,
        );
        assert.ok(
            native.some((text) => word.test(text)) ||
                emitters.some((text) => preprocessorRead.test(text)),
            `${emitter} emits ${define}, which nothing in native/src and ` +
                "no emitted preprocessor test reads; delete the define or " +
                "give it a reader",
        );
    }
});

test("no inventoried row is unmapped, and the order is deterministic", () => {
    // (v) Zero "none"-provenance rows across every fixture, including
    // the fully-activated one that walks every active arm.
    for (const inputs of [
        scene33Inputs(),
        dispersiveInputs(),
        everythingOnInputs(),
        familyInputs(),
    ]) {
        const rows = featureActivationRows(inputs);
        assert.deepEqual(
            rows
                .filter((row) => row.upstreamProvenance === "none")
                .map((row) => row.name),
            [],
        );
        const names = rows.map((row) => row.name);
        assert.equal(new Set(names).size, names.length);
    }

    // Deterministic: identical inputs serialize identically.
    assert.equal(
        JSON.stringify(featureActivationRows(everythingOnInputs())),
        JSON.stringify(featureActivationRows(everythingOnInputs())),
    );
});

test("an unmapped manifest feature surfaces as the 'none' drift row", () => {
    const inputs = scene33Inputs();
    const rows = featureActivationRows({
        ...inputs,
        features: [...inputs.features, "future:unmapped"],
    });
    const drifted = named(rows, "future:unmapped");
    assert.equal(drifted.upstreamProvenance, "none");
    assert.equal(drifted.active, true);
});

test("a merge that stops matching its recorded reasons fails loudly", () => {
    const inputs = scene33Inputs();
    // The emitted define says clearcoat, but no composed variant spliced
    // the fragment: the emit options and the composed set have drifted
    // apart, which must refuse rather than publish a wrong row.
    assert.throws(
        () =>
            featureActivationRows({
                ...inputs,
                emit: emitOptions({
                    ...inputs.emit,
                    clearcoat: true,
                }),
            }),
        /BBLITE_MATERIAL_CLEARCOAT/,
    );
});

test("scene-source rows cite the recorded first-reach site", () => {
    const rows = featureActivationRows(scene33Inputs());

    // A feature with a recorded site cites it verbatim.
    assert.equal(
        named(rows, "renderer:scene").activatedBy,
        "scene source: reached at scene33.ts:9",
    );
    assert.equal(
        named(rows, "renderer:transmission").activatedBy,
        "scene source: reached at scene33.ts:24",
    );

    // A reached feature without a site (the seeded "core") keeps the
    // generic reason.
    assert.equal(
        named(rows, "core").activatedBy,
        "scene source: reached by the compiled scene TypeScript",
    );

    // The asset join wins over a site: a feature the CLI attributed to
    // an asset is never re-attributed to scene source.
    const inputs = scene33Inputs();
    const joined = named(
        featureActivationRows({
            ...inputs,
            featureSites: {
                ...inputs.featureSites,
                "light:point": "scene33.ts:1",
            },
        }),
        "light:point",
    );
    assert.match(joined.activatedBy, /^asset-joined:/);

    // Without the record, every scene-source row keeps the pre-citation
    // wording, so trees regenerate unchanged until the CLI passes it.
    const unrecorded = { ...inputs };
    delete unrecorded.featureSites;
    const uncited = featureActivationRows(unrecorded);
    assert.equal(
        named(uncited, "renderer:scene").activatedBy,
        "scene source: reached by the compiled scene TypeScript",
    );
});

test("the max-lights refusal row records the pinned constant's value", () => {
    // Checked count present: the row names the count, the asset, and
    // the frozen constant's value.
    assert.match(
        named(
            featureActivationRows(scene33Inputs()),
            "refusal:max-lights",
        ).activatedBy,
        /within the frozen pinned MAX_LIGHTS = 8$/,
    );

    // No punctual light nodes: the value still lands on the row.
    assert.equal(
        named(
            featureActivationRows({
                ...dispersiveInputs(),
                pinnedMaxLights: 8,
            }),
            "refusal:max-lights",
        ).activatedBy,
        "no glTF asset carries KHR_lights_punctual light nodes " +
            "(frozen pinned MAX_LIGHTS = 8)",
    );

    // Without the input the wording stays byte-identical to the
    // pre-value row, so trees regenerate unchanged until the CLI
    // passes it.
    assert.equal(
        named(
            featureActivationRows(dispersiveInputs()),
            "refusal:max-lights",
        ).activatedBy,
        "no glTF asset carries KHR_lights_punctual light nodes",
    );

    // A checked count above the constant is the upstream-lower.ts gate
    // and the table drifting apart: refuse rather than publish a row
    // for a generation that should not have proceeded.
    assert.throws(
        () =>
            featureActivationRows({
                ...scene33Inputs(),
                pinnedMaxLights: 4,
            }),
        /refusal:max-lights/,
    );
});

test("emit-option rows cover the sprite, effect and particle options", () => {
    const rows = featureActivationRows(familyInputs());

    const custom = named(rows, "spriteCustomShaders");
    assert.equal(custom.active, true);
    assert.equal(custom.mechanism, "emit-option");
    assert.match(custom.activatedBy, /1 scene-code custom/);
    assert.match(custom.activatedBy, /sprite$/);
    assert.match(custom.upstreamProvenance, /sprite-custom-shader\.ts/);

    const effects = named(rows, "effects");
    assert.equal(effects.active, true);
    assert.match(effects.activatedBy, /^1 createEffectWrapper/);
    assert.match(effects.upstreamProvenance, /effect-renderer\.ts/);

    // The plain flags record why a stock stage was NOT deployed.
    const plain = named(rows, "plainSpriteLayer");
    assert.equal(plain.active, false);
    assert.match(plain.activatedBy, /opts into a custom shader/);
    assert.equal(named(rows, "plainBillboardSystem").active, false);

    const palette = named(rows, "pinnedSkeletonPalette");
    assert.equal(palette.active, true);
    assert.match(palette.activatedBy, /per-bone\s+texture/);
    assert.match(palette.upstreamProvenance, /gltf-feature-skeleton\.ts/);

    // The derived colour-lane option cross-checks its feature, like its
    // capability twin.
    const colors = named(
        featureActivationRows(everythingOnInputs()),
        "gpuInstanceColors",
    );
    assert.equal(colors.active, true);
    assert.match(colors.activatedBy, /mesh:thin-instance-colors/);

    // The inactive arms on a scene that reaches none of the families.
    const off = featureActivationRows(scene33Inputs());
    assert.equal(named(off, "spriteCustomShaders").active, false);
    assert.equal(named(off, "effects").active, false);
    assert.equal(named(off, "plainSpriteLayer").active, true);
    assert.equal(named(off, "pinnedSkeletonPalette").active, false);
});

test("composition rows cover the six backfilled shader families", () => {
    const rows = featureActivationRows(familyInputs());

    const nodeFeature = named(rows, "material:node");
    assert.equal(nodeFeature.active, true);
    assert.match(nodeFeature.upstreamProvenance, /node-material\.ts/);

    assert.match(
        named(rows, "standard-variants:stages").activatedBy,
        /^1 Standard variant\(s\)/,
    );
    assert.match(
        named(rows, "node-variants:stages").activatedBy,
        /^1 node graph\(s\)/,
    );
    assert.equal(named(rows, "splat:stages").active, true);
    assert.match(
        named(rows, "shader-material:programs").activatedBy,
        /lines$/,
    );
    assert.match(
        named(rows, "sprite-billboard:stages").activatedBy,
        /2D sprite, billboard/,
    );
    assert.match(
        named(rows, "effect-wrapper:stages").activatedBy,
        /^1 composed effect module\(s\)/,
    );

    // Every family stays an inactive row for a scene that reaches none.
    const off = featureActivationRows(scene33Inputs());
    for (const name of [
        "standard-variants:stages",
        "node-variants:stages",
        "splat:stages",
        "shader-material:programs",
        "sprite-billboard:stages",
        "effect-wrapper:stages",
    ]) {
        const row = named(off, name);
        assert.equal(row.active, false, `${name} should be inactive`);
        assert.equal(row.mechanism, "composition");
    }
});

test("the new families' generation refusals are inventoried", () => {
    const rows = featureActivationRows(familyInputs());

    const physics = named(rows, "refusal:physics-shapes");
    assert.equal(physics.active, false);
    assert.equal(physics.mechanism, "generation-refusal");
    assert.match(
        physics.activatedBy,
        /^checked: every reached physics shape/,
    );
    assert.match(physics.upstreamProvenance, /havok\.ts/);

    assert.match(
        named(rows, "refusal:ktx-format").activatedBy,
        /block-compression suffix/,
    );
    assert.match(
        named(rows, "refusal:splat-format").activatedBy,
        /plain PLY/,
    );
    const liveSet = named(rows, "refusal:node-particle-live-set");
    assert.match(liveSet.activatedBy, /^checked 1 frozen/);
    assert.match(
        liveSet.upstreamProvenance,
        /particle-scene\.ts registerNodeParticleSet/,
    );

    // The nothing-to-check arms.
    const off = featureActivationRows(scene33Inputs());
    assert.equal(
        named(off, "refusal:physics-shapes").activatedBy,
        "no physics shapes to check",
    );
    assert.equal(
        named(off, "refusal:ktx-format").activatedBy,
        "no compressed-texture loads to check",
    );
    assert.equal(
        named(off, "refusal:splat-format").activatedBy,
        "no splat assets to check",
    );
    assert.equal(
        named(off, "refusal:node-particle-live-set").activatedBy,
        "no frozen node-particle systems to check",
    );
});

test("creation-order rows record ordered and interleaved paths", () => {
    // Zero creations: the rows state there was nothing to compare.
    const scene33 = featureActivationRows(scene33Inputs());
    const meshRow = named(scene33, "refusal:scene-mesh-interleave");
    assert.equal(meshRow.active, false);
    assert.equal(meshRow.mechanism, "generation-refusal");
    assert.equal(
        meshRow.activatedBy,
        "no scene-code mesh creations to check",
    );
    assert.deepEqual(meshRow.consumers, ["generation gate"]);
    assert.match(meshRow.upstreamProvenance, /^native-architecture:/);
    assert.equal(
        named(scene33, "refusal:scene-material-interleave").activatedBy,
        "no scene-code PBR material creations to check",
    );

    // Counted creations, all after the last load.
    const everything = featureActivationRows(everythingOnInputs());
    assert.equal(
        named(everything, "refusal:scene-mesh-interleave").activatedBy,
        "checked 2 scene-code mesh creation(s) against 1 glTF " +
            "load(s): every one was created after the last load, so " +
            "the creation-order key does not interleave",
    );
    assert.match(
        named(
            everything,
            "refusal:scene-material-interleave",
        ).activatedBy,
        /^checked 1 scene-code PBR material creation\(s\)/,
    );

    // A caller that does not record the counts emits no rows, so trees
    // regenerate unchanged until the CLI passes them.
    assert.equal(
        featureActivationRows(dispersiveInputs()).some((row) =>
            row.name.includes("interleave"),
        ),
        false,
    );

    // Interleaved creation is now composed by recorded load count, and the
    // inventory records that supported path rather than a generation refusal.
    const interleaved = featureActivationRows({
        ...everythingOnInputs(),
        interleave: {
            sceneMeshGltfAssetsBefore: [0, 1],
            scenePbrMaterialGltfAssetsBefore: [0],
            gltfAssetCount: 1,
        },
    });
    const interleavedMesh = named(
        interleaved,
        "refusal:scene-mesh-interleave",
    );
    assert.equal(interleavedMesh.active, true);
    assert.equal(interleavedMesh.mechanism, "composition");
    assert.equal(
        interleavedMesh.activatedBy,
        "composed 2 scene-code mesh creation(s) through 1 glTF load(s) " +
            "in their recorded handle order",
    );
    assert.deepEqual(interleavedMesh.consumers, ["variant table"]);
    assert.equal(
        named(
            interleaved,
            "refusal:scene-material-interleave",
        ).activatedBy,
        "composed 1 scene-code PBR material creation(s) through 1 glTF " +
            "load(s) in their recorded handle order",
    );
});
