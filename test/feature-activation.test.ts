import assert from "node:assert/strict";
import test from "node:test";
import type { AssetSpecializationFeatures } from "../src/asset-specializer.js";
import type { PinnedVariantManifestEntry } from "../src/pinned-pbr-variant-output.js";
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
        nonTrianglePrimitives: false,
        nodeVisibility: false,
        animationPointer: false,
        animationPointerMaterials: false,
        assetTransmission: false,
        materialSpecular: false,
        imageBasedLighting: false,
        textureTransform: false,
        gpuInstancing: false,
        punctualLights: false,
        clearcoat: false,
        sheen: false,
        iridescence: false,
        specularGlossiness: false,
        dispersion: false,
        occlusionUv2: false,
        eightInfluenceSkinning: false,
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
        nodeVisibility: false,
        animationPointer: false,
        animationPointerMaterials: false,
        assetTransmission: false,
        materialSpecular: false,
        selectedMaterialVariant: "",
        standardLights: 0,
        standardLightLists: false,
        standardDiffuseUv2: false,
        standardBump: false,
        textureTransform: false,
        imageBasedLighting: false,
        gpuInstancing: false,
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

function variants(count: number): PinnedVariantManifestEntry[] {
    return Array.from({ length: count }, (_, index) => ({
        fragmentKey: `key-${index}`,
        selectors: [],
        vertex: `variant-${index}.vert.wgsl`,
        fragment: `variant-${index}.frag.wgsl`,
        materialUbo: undefined,
        vertexWgsl: "",
        fragmentWgsl: "",
    }));
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
            "renderer:pbr",
            "renderer:transmission",
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
            "renderer:pbr": "scene33.ts:9",
            "renderer:transmission": "scene33.ts:24",
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
        transmission: true,
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
            toneMappingArms: true,
            linearImageProcessing: true,
        },
    };
}

/**
 * A scene whose only activations come from the asset specializer: an
 * iridescent, dispersive, transmissive GLB with no scene-source
 * material features.
 */
function dispersiveInputs(): FeatureActivationInputs {
    return {
        features: [
            "core",
            "backend:sdl",
            "camera:arc-rotate",
            "loader:gltf",
            "renderer:pbr",
        ],
        assetJoinedFeatures: new Map(),
        specialization: specialization({
            iridescence: true,
            dispersion: true,
            assetTransmission: true,
        }),
        emit: emitOptions({
            iridescence: true,
            dispersion: true,
            assetTransmission: true,
            pinnedVariants: variants(2),
        }),
        transmission: true,
        imageCodecs: ["png"],
        gltfAssetNames: ["dispersive.glb"],
        composition: {
            lightKinds: [],
            toneMappingArms: false,
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
            clearcoat: true,
            sheen: true,
            iridescence: true,
            dispersion: true,
            occlusionUv2: true,
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
            standardLights: 3,
            standardLightLists: true,
            standardDiffuseUv2: true,
            standardBump: true,
            textureTransform: true,
            imageBasedLighting: true,
            gpuInstancing: true,
            punctualLights: true,
            clearcoat: true,
            sheen: true,
            iridescence: true,
            dispersion: true,
            occlusionUv2: true,
            assetLightNodes: { count: 4, asset: "a.glb" },
            pinnedVariants: variants(7),
        }),
        transmission: true,
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
            toneMappingArms: true,
            linearImageProcessing: true,
        },
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
    const pbr = named(rows, "renderer:pbr");
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

test("capability rows carry the specializer's activation", () => {
    const rows = featureActivationRows(dispersiveInputs());

    // (iii) A capability activated by the asset specializer alone.
    const iridescence = named(rows, "BBLITE_MATERIAL_IRIDESCENCE");
    assert.equal(iridescence.active, true);
    assert.equal(iridescence.mechanism, "capability");
    assert.match(iridescence.activatedBy, /KHR_materials_iridescence/);
    assert.match(
        iridescence.upstreamProvenance,
        /gltf-ext-iridescence\.ts/,
    );
    assert.ok(iridescence.consumers.includes("render_capabilities.hpp"));

    // The transmission define reports the asset half only: the scene
    // never named the feature.
    const transmission = named(rows, "BBLITE_RENDERER_TRANSMISSION");
    assert.equal(transmission.active, true);
    assert.match(transmission.activatedBy, /transmissionFactor > 0/);
    assert.doesNotMatch(transmission.activatedBy, /scene source/);
});

test("dispersion keys on the evaluated pinned predicate", () => {
    // (iv) Active: the evaluated needsDispersion, not extension presence.
    const active = named(
        featureActivationRows(dispersiveInputs()),
        "BBLITE_MATERIAL_DISPERSION",
    );
    assert.equal(active.active, true);
    assert.match(active.activatedBy, /evaluated pinned\s+needsDispersion/);
    assert.match(active.upstreamProvenance, /needsDispersion/);
    assert.match(active.upstreamProvenance, /gltf-ext-dielectric\.ts/);

    // Inactive: the row states that presence alone does not activate.
    const inactive = named(
        featureActivationRows(scene33Inputs()),
        "BBLITE_MATERIAL_DISPERSION",
    );
    assert.equal(inactive.active, false);
    assert.match(
        inactive.activatedBy,
        /extension presence alone does\s+not activate/,
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

test("no inventoried row is unmapped, and the order is deterministic", () => {
    // (v) Zero "none"-provenance rows across every fixture, including
    // the fully-activated one that walks every active arm.
    for (const inputs of [
        scene33Inputs(),
        dispersiveInputs(),
        everythingOnInputs(),
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
    // The emitted define says clearcoat, but neither the specializer nor
    // the feature list recorded a reason: the join and the table have
    // drifted apart, which must refuse rather than publish a wrong row.
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
        named(rows, "renderer:pbr").activatedBy,
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
        named(uncited, "renderer:pbr").activatedBy,
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

test("interleave refusal rows record the guards' clean pass", () => {
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

    // An interleaving creation reaching the table is the cli.ts guard
    // and the inventory drifting apart: fail loudly, never publish a
    // wrong refusal row.
    assert.throws(
        () =>
            featureActivationRows({
                ...everythingOnInputs(),
                interleave: {
                    sceneMeshGltfAssetsBefore: [0, 1],
                    scenePbrMaterialGltfAssetsBefore: [1],
                    gltfAssetCount: 1,
                },
            }),
        /scene-mesh-interleave/,
    );
    assert.throws(
        () =>
            featureActivationRows({
                ...everythingOnInputs(),
                interleave: {
                    sceneMeshGltfAssetsBefore: [1],
                    scenePbrMaterialGltfAssetsBefore: [0],
                    gltfAssetCount: 1,
                },
            }),
        /scene-material-interleave/,
    );
});
