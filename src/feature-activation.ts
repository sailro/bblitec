// The per-scene activation inventory behind
// `generated/<scene>/upstream/feature-activation.json`.
//
// Generation activates native code through six distinct mechanisms: the
// scene's own runtime-feature list, the asset-specialized capability
// defines, the image codecs, the emit options handed to the upstream
// lowerer, variant composition, and the generation-time refusals. Each
// mechanism's authority already exists somewhere (`features.cmake`,
// `render_capabilities.hpp`, `UpstreamEmitOptions`, the composed
// variants, `specializeGltf`); this table is the one place a developer
// or a drift audit sees every unit at once: whether it is active for
// THIS scene, the concrete reason, which pinned module or predicate it
// mirrors, and what consumes it.
//
// Two disciplines keep the table honest rather than a parallel
// re-derivation:
//
// - Rows are built from the values the CLI actually used. The caller
//   passes the already-computed booleans in; where a value is a merge of
//   two inputs, the row derives its reason from the same halves and a
//   disagreement with the emitted value fails generation loudly, the
//   same way the generated-source table does.
// - `upstreamProvenance` is the drift detector's other half. Every unit
//   in the current inventory maps to a pinned module/predicate or to a
//   documented `native-architecture:` divergence; a row that resolves to
//   "none" (an unmapped unit) is asserted against by the test suite, so
//   a new activation unit cannot land without naming what it mirrors.
import type { AssetSpecializationFeatures } from "./asset-specializer.js";
import type { Feature } from "./compiler/types.js";
import { variantBindings } from "./pinned-pbr-variant-cpp.js";
import type { UpstreamEmitOptions } from "./upstream-lower.js";

/** Where the inventory is written, beside the other upstream artifacts. */
export const featureActivationPath = "upstream/feature-activation.json";

export type FeatureActivationMechanism =
    | "runtime-feature"
    | "capability"
    | "codec"
    | "emit-option"
    | "composition"
    | "generation-refusal";

/**
 * What reads an activation unit. The vocabulary is closed so consumers
 * stay greppable: `features.cmake` (BBLITE_RUNTIME_FEATURES and the
 * source lists), the two generated capability headers, the composed
 * pinned variant set ("variant table"), the generated loader's lowering
 * flags, the renderer plan/shader lowering options, the vcpkg codec
 * manifest features, the per-scene `fidelity.json` adaptations, and the
 * generation-time gates that refuse instead of emitting.
 */
export type FeatureActivationConsumer =
    | "features.cmake"
    | "render_capabilities.hpp"
    | "material_texture_slots.hpp"
    | "variant table"
    | "loader flag"
    | "renderer plan"
    | "vcpkg manifest"
    | "fidelity.json"
    | "generation gate";

export interface FeatureActivationRow {
    name: string;
    mechanism: FeatureActivationMechanism;
    active: boolean;
    /** The concrete reason for THIS scene, or why the unit stayed off. */
    activatedBy: string;
    /**
     * The pinned module/predicate the unit mirrors, or
     * `native-architecture: <reason>` for a documented deliberate
     * divergence. "none" marks an unmapped unit — the drift-detector
     * state the tests assert never ships.
     */
    upstreamProvenance: string;
    consumers: string[];
}

export interface FeatureActivationInputs {
    /** The final manifest feature list, after the asset-light join. */
    features: readonly string[];
    /**
     * feature -> "file:line" of the first scene-source call site that
     * reached it, from the manifest's `featureSites` record. Optional:
     * a caller without recorded sites keeps the generic scene-source
     * reason. Features the CLI asset-join added carry no entry and are
     * attributed to their asset instead.
     */
    featureSites?: Readonly<Record<string, string>>;
    /**
     * feature -> asset output for the two deliberate post-compilation
     * joins (`light:*` kinds and `environment:ibl`), recorded by the CLI
     * loop that performed them.
     */
    assetJoinedFeatures: ReadonlyMap<string, string>;
    /** The asset specializer's per-scene summary. */
    specialization: AssetSpecializationFeatures;
    /** The exact options handed to `emitUpstreamGenerated`. */
    emit: UpstreamEmitOptions;
    /**
     * The merged transmission define (scene feature OR asset predicate),
     * as the CLI computed it for the arm coverage check.
     */
    transmission: boolean;
    /** `reachedImageCodecs`' output: png first, then reached codecs. */
    imageCodecs: readonly string[];
    /** The glTF asset outputs the generation-time refusals checked. */
    gltfAssetNames: readonly string[];
    /**
     * The frozen pinned MAX_LIGHTS the max-lights refusal checked
     * against, read from the pin's own `src/light/types.ts` by the
     * upstream lowerer. Optional: a caller without the value keeps the
     * count-only wording.
     */
    pinnedMaxLights?: number;
    /**
     * The variant-key interleave guards' inputs, exactly as the CLI
     * checked them: for each scene-code mesh / PBR material in creation
     * order, how many glTF assets had loaded when it was created,
     * against the scene's glTF asset total. The runtime keys the
     * variant table by creation-order handle, so a creation before a
     * later load would interleave the key — the CLI refuses generation
     * instead, and the two rows record that the check ran clean.
     * Optional: the rows are emitted only when the caller records the
     * counts.
     */
    interleave?: {
        sceneMeshGltfAssetsBefore: readonly number[];
        scenePbrMaterialGltfAssetsBefore: readonly number[];
        gltfAssetCount: number;
    };
    composition: {
        /** The single-light kinds the composed scene arms cover. */
        lightKinds: readonly string[];
        /** Whether both tone-mapping states composed (environment on). */
        toneMappingArms: boolean;
        linearImageProcessing: boolean;
    };
}

interface RuntimeFeatureEntry {
    provenance: string;
    consumers: readonly FeatureActivationConsumer[];
}

const CMAKE: readonly FeatureActivationConsumer[] = ["features.cmake"];

/**
 * Every runtime feature the compiler can reach, in the order
 * `featureSources` declares them (compiler.ts), with the pinned module
 * each one mirrors. `Record<Feature, …>` makes completeness a compile
 * error: a new `Feature` union member cannot land without a row here.
 */
const runtimeFeatureTable: Record<Feature, RuntimeFeatureEntry> = {
    "animation:gltf-groups": {
        provenance:
            "src/animation/animation-group.ts (playAnimation, pauseAnimation, " +
            "stopAnimation) + src/loader-gltf/gltf-feature-animations.ts",
        consumers: ["features.cmake"],
    },
    "animation:property": {
        provenance: "src/animation/property-animation.ts",
        consumers: CMAKE,
    },
    "core": {
        provenance:
            "src/engine/engine.ts + src/scene/scene-core.ts " +
            "(lowered engine and scene core; every scene reaches it)",
        consumers: CMAKE,
    },
    "backend:sdl": {
        provenance:
            "native-architecture: the SDL platform layer (pal_sdl.cpp); " +
            "upstream targets the browser and has no platform abstraction",
        consumers: CMAKE,
    },
    "camera:arc-rotate": {
        provenance:
            "src/camera/arc-rotate.ts + src/camera/arc-rotate-controls.ts",
        consumers: CMAKE,
    },
    "camera:default": {
        provenance: "src/scene/scene-camera.ts (default framing)",
        consumers: CMAKE,
    },
    "camera:free": {
        provenance:
            "src/camera/free-camera.ts + src/camera/free-camera-controls.ts",
        consumers: CMAKE,
    },
    "camera:orthographic": {
        provenance: "src/camera/orthographic.ts",
        consumers: CMAKE,
    },
    "environment:ibl": {
        provenance:
            "src/material/pbr/fragments/ibl-fragment.ts (the scene " +
            "environment turns IBL and tone mapping on); asset-joined " +
            "via EXT_lights_image_based " +
            "(src/loader-gltf/gltf-ext-lights-image-based.ts)",
        consumers: ["features.cmake", "variant table"],
    },
    "environment:env": {
        provenance:
            "src/loader-env/load-env.ts + src/loader-env/env-parse.ts",
        consumers: CMAKE,
    },
    "environment:hdr": {
        provenance:
            "src/loader-hdr/load-hdr.ts (+ hdr-parser.ts, " +
            "hdr-ibl-pipeline.ts executed at generation)",
        consumers: CMAKE,
    },
    "environment:dds": {
        provenance: "src/loader-env/load-dds-env.ts",
        consumers: CMAKE,
    },
    "background:ground": {
        provenance: "src/material/pbr/background-ground.ts",
        consumers: CMAKE,
    },
    "background:skybox": {
        provenance: "src/material/pbr/background-dds-skybox.ts",
        consumers: CMAKE,
    },
    "background:image-skybox": {
        provenance:
            "src/loader-skybox/load-skybox.ts + " +
            "src/loader-skybox/skybox-renderable.ts",
        consumers: ["features.cmake", "render_capabilities.hpp"],
    },
    "background:solid-skybox": {
        provenance: "src/material/pbr/background-solid-skybox.ts",
        consumers: ["features.cmake", "render_capabilities.hpp"],
    },
    "light:hemispheric": {
        provenance: "src/light/hemispheric.ts",
        consumers: ["features.cmake", "variant table"],
    },
    "light:directional": {
        provenance:
            "src/light/directional-light.ts; asset-joined via " +
            "KHR_lights_punctual " +
            "(src/loader-gltf/gltf-feature-lights-punctual.ts)",
        consumers: ["features.cmake", "variant table"],
    },
    "light:point": {
        provenance:
            "src/light/point-light.ts; asset-joined via " +
            "KHR_lights_punctual " +
            "(src/loader-gltf/gltf-feature-lights-punctual.ts)",
        consumers: ["features.cmake", "variant table"],
    },
    "light:spot": {
        provenance:
            "src/light/spot-light.ts; asset-joined via " +
            "KHR_lights_punctual " +
            "(src/loader-gltf/gltf-feature-lights-punctual.ts)",
        consumers: ["features.cmake", "variant table"],
    },
    "loader:babylon": {
        provenance: "src/loader-babylon/load-babylon.ts",
        consumers: CMAKE,
    },
    "loader:gltf": {
        provenance:
            "src/loader-gltf/load-gltf.ts + " +
            "src/loader-gltf/gltf-glb-parser.ts",
        consumers: CMAKE,
    },
    "loader:gltf-variants": {
        provenance:
            "src/loader-gltf/material-variants.ts#selectVariant + " +
            "src/loader-gltf/gltf-feature-variants.ts",
        consumers: ["features.cmake", "variant table", "loader flag"],
    },
    "material:pbr": {
        provenance: "src/material/pbr/pbr-material.ts",
        consumers: CMAKE,
    },
    "material:clearcoat": {
        provenance: "src/material/pbr/set-clearcoat.ts",
        consumers: ["features.cmake", "render_capabilities.hpp", "variant table"],
    },
    "material:sheen": {
        provenance: "src/material/pbr/set-sheen.ts",
        consumers: ["features.cmake", "render_capabilities.hpp", "variant table"],
    },
    "material:sheen-albedo-scaling": {
        provenance:
            "src/material/pbr/set-sheen.ts (the albedo-scaling arm; the " +
            "two pinned sheen models compose distinct fragments)",
        consumers: ["features.cmake", "renderer plan", "variant table"],
    },
    "material:clearcoat-f0-remap": {
        provenance:
            "src/material/pbr/set-clearcoat.ts (useF0Remap; " +
            "src/loader-gltf/gltf-ext-clearcoat.ts is the single pinned " +
            "caller passing false)",
        consumers: ["features.cmake", "renderer plan", "variant table"],
    },
    "material:iridescence": {
        provenance: "src/material/pbr/set-iridescence.ts",
        consumers: ["features.cmake", "render_capabilities.hpp", "variant table"],
    },
    "material:emissive": {
        provenance: "src/material/pbr/set-emissive.ts",
        consumers: ["features.cmake", "variant table"],
    },
    "material:no-color-view": {
        provenance: "src/material/pbr/no-color-view.ts",
        consumers: CMAKE,
    },
    "material:grid": {
        provenance: "src/material/grid/grid-material.ts",
        consumers: CMAKE,
    },
    "material:shader": {
        provenance: "src/material/shader/shader-material.ts",
        consumers: CMAKE,
    },
    "material:standard": {
        provenance: "src/material/standard/create-standard-material.ts",
        consumers: CMAKE,
    },
    "material:standard-vertex-colors": {
        provenance:
            "src/material/standard/fragments/std-vertex-color-fragment.ts",
        consumers: CMAKE,
    },
    "mesh:box": {
        provenance: "src/mesh/create-box.ts",
        consumers: CMAKE,
    },
    "mesh:from-data": {
        provenance: "src/mesh/mesh-factories.ts",
        consumers: CMAKE,
    },
    "mesh:ground": {
        provenance: "src/mesh/create-ground.ts",
        consumers: CMAKE,
    },
    "mesh:morph-targets": {
        provenance: "src/morph/create-morph-targets.ts",
        consumers: ["features.cmake", "render_capabilities.hpp"],
    },
    "mesh:plane": {
        provenance: "src/mesh/create-plane.ts",
        consumers: CMAKE,
    },
    "mesh:sphere": {
        provenance: "src/mesh/create-sphere.ts",
        consumers: CMAKE,
    },
    "mesh:thin-instances": {
        provenance: "src/mesh/thin-instance.ts",
        consumers: ["features.cmake", "render_capabilities.hpp"],
    },
    "mesh:thin-instances-dynamic": {
        provenance: "src/mesh/thin-instance.ts",
        consumers: ["features.cmake", "render_capabilities.hpp"],
    },
    "mesh:torus": {
        provenance: "src/mesh/create-torus.ts",
        consumers: CMAKE,
    },
    "scene:remove": {
        provenance: "src/scene/scene-remove.ts",
        consumers: CMAKE,
    },
    "sprite:2d": {
        provenance: "src/sprite/sprite-2d.ts",
        consumers: CMAKE,
    },
    "renderer:sprite": {
        provenance: "src/sprite/sprite-pipeline.ts",
        consumers: CMAKE,
    },
    "renderer:pbr": {
        provenance:
            "src/material/pbr/pbr-template.ts (fragments composed by the " +
            "pin itself) + the pinned frame-graph renderer plan",
        consumers: CMAKE,
    },
    "renderer:transmission": {
        provenance:
            "src/frame-graph/transmission.ts (enableSceneTransmission)",
        consumers: ["features.cmake", "render_capabilities.hpp", "variant table"],
    },
    "renderer:fog": {
        provenance:
            "src/shader/wgsl-fog.ts (scene fog state in scene-core.ts)",
        consumers: ["features.cmake", "variant table"],
    },
    "renderer:geometry-output": {
        provenance: "src/frame-graph/geometry-renderer-task.ts",
        consumers: ["features.cmake", "variant table"],
    },
};

/** The runtime features the inventory maps, in emission order. */
export const inventoriedRuntimeFeatures: readonly Feature[] = Object.keys(
    runtimeFeatureTable,
) as Feature[];

function runtimeEntry(name: string): RuntimeFeatureEntry | undefined {
    return Object.prototype.hasOwnProperty.call(runtimeFeatureTable, name)
        ? runtimeFeatureTable[name as Feature]
        : undefined;
}

/**
 * Derive `active`/`activatedBy` from the individual halves the CLI
 * merged. The parts are the same already-computed booleans the join
 * point used, so the derivation cannot disagree with the emitted value
 * unless the join changes without this table — which `checkedRow` turns
 * into a generation failure instead of a silently wrong inventory.
 */
function activation(
    parts: ReadonlyArray<readonly [boolean, string]>,
    inactive: string,
): { active: boolean; activatedBy: string } {
    const reasons = parts
        .filter(([on]) => on)
        .map(([, reason]) => reason);
    return reasons.length > 0
        ? { active: true, activatedBy: reasons.join("; ") }
        : { active: false, activatedBy: inactive };
}

function checkedRow(
    name: string,
    mechanism: FeatureActivationMechanism,
    emitted: boolean,
    parts: ReadonlyArray<readonly [boolean, string]>,
    inactive: string,
    upstreamProvenance: string,
    consumers: readonly FeatureActivationConsumer[],
): FeatureActivationRow {
    const { active, activatedBy } = activation(parts, inactive);
    if (active !== emitted) {
        throw new Error(
            `feature-activation: row '${name}' derives ${active} from its ` +
                `recorded reasons but the emitted value is ${emitted}; the ` +
                `activation table no longer mirrors the join point. Update ` +
                `src/feature-activation.ts beside the cli.ts merge.`,
        );
    }
    return {
        name,
        mechanism,
        active,
        activatedBy,
        upstreamProvenance,
        consumers: [...consumers],
    };
}

function row(
    name: string,
    mechanism: FeatureActivationMechanism,
    active: boolean,
    activatedBy: string,
    upstreamProvenance: string,
    consumers: readonly FeatureActivationConsumer[],
): FeatureActivationRow {
    return {
        name,
        mechanism,
        active,
        activatedBy,
        upstreamProvenance,
        consumers: [...consumers],
    };
}

function runtimeFeatureRows(
    inputs: FeatureActivationInputs,
): FeatureActivationRow[] {
    const rows: FeatureActivationRow[] = [];
    const emit = (name: string, entry: RuntimeFeatureEntry | undefined): void => {
        const active = inputs.features.includes(name);
        const joinedBy = inputs.assetJoinedFeatures.get(name);
        // The first reaching scene-source call site, recorded by the
        // compiler (first-reach wins, document order breaks ties). The
        // seeded "core" has none, so it keeps the generic reason.
        const site = inputs.featureSites?.[name];
        const activatedBy = !active
            ? "not reached"
            : joinedBy !== undefined
                ? name === "environment:ibl"
                    ? `asset-joined: ${joinedBy} carries EXT_lights_image_based`
                    : `asset-joined: ${joinedBy} carries KHR_lights_punctual ` +
                      `kind "${name.slice("light:".length)}"`
                : site !== undefined
                    ? `scene source: reached at ${site}`
                    : "scene source: reached by the compiled scene TypeScript";
        rows.push(
            row(
                name,
                "runtime-feature",
                active,
                activatedBy,
                entry?.provenance ?? "none",
                entry?.consumers ?? CMAKE,
            ),
        );
    };
    for (const name of inventoriedRuntimeFeatures) {
        emit(name, runtimeFeatureTable[name]);
    }
    // A manifest feature outside the table is exactly the drift the
    // provenance column detects: it still gets a row, with "none".
    for (const name of inputs.features) {
        if (runtimeEntry(name) === undefined) {
            emit(name, undefined);
        }
    }
    return rows;
}

function capabilityRows(
    inputs: FeatureActivationInputs,
): FeatureActivationRow[] {
    const { specialization: spec, emit, features } = inputs;
    const has = (feature: Feature): boolean => features.includes(feature);
    const variantCount = (emit.pinnedVariants ?? []).length;
    // The same derivation upstream-lower makes for the define: a composed
    // Standard variant binding the pin's 2D reflection pair.
    const standardReflection = (emit.pinnedStandardVariants ?? [])
        .some((variant) =>
            variantBindings(
                variant.vertexWgsl,
                variant.fragmentWgsl,
            ).some((binding) => binding.name === "rT")
        );
    return [
        checkedRow(
            "BBLITE_RENDERER_TRANSMISSION",
            "capability",
            inputs.transmission,
            [
                [
                    has("renderer:transmission"),
                    "scene source reached renderer:transmission",
                ],
                [
                    spec.assetTransmission,
                    "a glTF material carries transmissionFactor > 0",
                ],
            ],
            "no scene or asset transmission",
            "src/frame-graph/transmission.ts (enableSceneTransmission / " +
                "markPbrMaterialsLinear); asset half: registerPbrTransmission " +
                "accepts any material set _transmissive with refraction " +
                "intensity > 0 (src/material/pbr/pbr-transmission-ext.ts, " +
                "set from transmissionFactor by " +
                "src/loader-gltf/gltf-ext-dielectric.ts)",
            [
                "render_capabilities.hpp",
                "material_texture_slots.hpp",
                "renderer plan",
                "variant table",
            ],
        ),
        checkedRow(
            "BBLITE_GPU_DEFORMATION",
            "capability",
            emit.gpuDeformation,
            [
                [
                    spec.gpuDeformation,
                    "a glTF asset carries animations",
                ],
                [
                    has("mesh:morph-targets"),
                    "scene-source morph targets need the deformation " +
                        "vertex layout",
                ],
            ],
            "no animated glTF assets and no scene-source morph targets",
            "native-architecture: upstream keys its skeleton module on " +
                "skins + JOINTS_0 (src/loader-gltf/gltf-feature-registry.ts) " +
                "and recomputes node worlds live; this port bakes static " +
                "node matrices, so ANY animated mesh needs the deformation " +
                "path's palette-as-world transport (docs/fidelity.md)",
            ["render_capabilities.hpp"],
        ),
        checkedRow(
            "BBLITE_GPU_MORPH_STORAGE",
            "capability",
            emit.morphStorage,
            [
                [
                    spec.morphStorage,
                    "a glTF primitive carries morph targets " +
                        "(maxMorphTargets > 0)",
                ],
                [
                    has("mesh:morph-targets"),
                    "scene source reached mesh:morph-targets (the pinned " +
                        "standard morph fragment reads storage buffers)",
                ],
            ],
            "no morph targets from either the assets or the scene source",
            "src/loader-gltf/gltf-feature-registry.ts morph row: " +
                "anyPrimitive(targets.length > 0) -> gltf-feature-morph.js; " +
                "the pin has one uncapped storage-buffer morph mechanism",
            ["render_capabilities.hpp"],
        ),
        checkedRow(
            "BBLITE_GPU_INSTANCING",
            "capability",
            emit.gpuInstancing,
            [
                [
                    spec.gpuInstancing,
                    "an asset uses EXT_mesh_gpu_instancing",
                ],
                [
                    has("mesh:thin-instances"),
                    "scene source reached mesh:thin-instances",
                ],
                [
                    has("mesh:thin-instances-dynamic"),
                    "scene source reached mesh:thin-instances-dynamic",
                ],
            ],
            "no instanced assets or thin instances",
            "src/loader-gltf/gltf-feature-registry.ts: " +
                "EXT_mesh_gpu_instancing -> gltf-feature-gpu-instancing.js; " +
                "scene half src/mesh/thin-instance.ts",
            ["render_capabilities.hpp"],
        ),
        checkedRow(
            "BBLITE_MATERIAL_CLEARCOAT",
            "capability",
            emit.clearcoat,
            [
                [
                    spec.clearcoat,
                    "an asset uses KHR_materials_clearcoat",
                ],
                [
                    has("material:clearcoat"),
                    "scene source reached material:clearcoat",
                ],
            ],
            "no clearcoat from assets or scene source",
            "src/loader-gltf/gltf-ext-clearcoat.ts (registry row " +
                "KHR_materials_clearcoat); scene half " +
                "src/material/pbr/set-clearcoat.ts; fragment " +
                "src/material/pbr/fragments/clearcoat-fragment.ts",
            [
                "render_capabilities.hpp",
                "material_texture_slots.hpp",
                "variant table",
            ],
        ),
        checkedRow(
            "BBLITE_MATERIAL_SHEEN",
            "capability",
            emit.sheen,
            [
                [spec.sheen, "an asset uses KHR_materials_sheen"],
                [
                    has("material:sheen"),
                    "scene source reached material:sheen",
                ],
            ],
            "no sheen from assets or scene source",
            "src/loader-gltf/gltf-ext-sheen.ts (registry row " +
                "KHR_materials_sheen); scene half " +
                "src/material/pbr/set-sheen.ts; fragment " +
                "src/material/pbr/fragments/sheen-fragment.ts",
            [
                "render_capabilities.hpp",
                "material_texture_slots.hpp",
                "variant table",
            ],
        ),
        checkedRow(
            "BBLITE_MATERIAL_IRIDESCENCE",
            "capability",
            emit.iridescence,
            [
                [
                    spec.iridescence,
                    "an asset uses KHR_materials_iridescence",
                ],
                [
                    has("material:iridescence"),
                    "scene source reached material:iridescence",
                ],
            ],
            "no iridescence from assets or scene source",
            "src/loader-gltf/gltf-ext-iridescence.ts (registry row " +
                "KHR_materials_iridescence); scene half " +
                "src/material/pbr/set-iridescence.ts; fragment " +
                "src/material/pbr/fragments/iridescence-fragment.ts",
            [
                "render_capabilities.hpp",
                "material_texture_slots.hpp",
                "variant table",
            ],
        ),
        checkedRow(
            "BBLITE_MATERIAL_DISPERSION",
            "capability",
            emit.dispersion,
            [
                [
                    spec.dispersion,
                    "a glTF material satisfies the evaluated pinned " +
                        "needsDispersion predicate",
                ],
            ],
            "no glTF material satisfies the evaluated pinned " +
                "needsDispersion predicate (extension presence alone does " +
                "not activate)",
            "src/loader-gltf/gltf-ext-dielectric.ts needsDispersion, " +
                "evaluated term for term: dispersion > 0 && (ior || " +
                "needsTransmission) && volume && (thicknessFactor > 0 || " +
                "thicknessTexture)",
            ["render_capabilities.hpp", "variant table"],
        ),
        checkedRow(
            "BBLITE_MATERIAL_OCCLUSION_UV2",
            "capability",
            emit.occlusionUv2,
            [
                [
                    spec.occlusionUv2,
                    "a glTF occlusionTexture selects TEXCOORD_1",
                ],
            ],
            "no glTF occlusion texture on the second UV set",
            "src/material/pbr/pbr-template-ext.ts: a dedicated occlusion " +
                "texture pair sampled at uv2 when occlusionTexture.texCoord " +
                "=== 1",
            [
                "render_capabilities.hpp",
                "material_texture_slots.hpp",
                "variant table",
            ],
        ),
        row(
            "BBLITE_MATERIAL_STANDARD_BUMP",
            "capability",
            emit.standardBump,
            emit.standardBump
                ? "a .babylon material carries a bump map"
                : "no .babylon material carries a bump map",
            "src/material/standard/create-standard-material.ts: the pinned " +
                "Standard material composes its normal-map fragment per " +
                "material with a bumpTexture " +
                "(src/loader-babylon/load-babylon.ts reads the slot)",
            ["render_capabilities.hpp", "material_texture_slots.hpp"],
        ),
        row(
            "BBLITE_MATERIAL_STANDARD_REFLECTION",
            "capability",
            standardReflection,
            standardReflection
                ? "a composed Standard variant binds the pin's 2D " +
                    "reflection pair (rT/rS)"
                : "no composed Standard variant binds a 2D reflection",
            "src/material/standard/fragments/std-reflection-fragment.ts: " +
                "the pinned Standard material composes its std-reflection " +
                "fragment for a non-cube reflectionTexture " +
                "(src/loader-babylon/load-babylon.ts TEX_SLOTS, skipIf " +
                "isCube); upstream-lower derives the define from the " +
                "composed set through the same variantBindings walk",
            ["render_capabilities.hpp", "material_texture_slots.hpp"],
        ),
        checkedRow(
            "BBLITE_IMAGE_SKYBOX",
            "capability",
            has("background:image-skybox"),
            [
                [
                    has("background:image-skybox"),
                    "scene source reached background:image-skybox",
                ],
            ],
            "not reached",
            "src/loader-skybox/load-skybox.ts",
            ["render_capabilities.hpp"],
        ),
        checkedRow(
            "BBLITE_SOLID_SKYBOX",
            "capability",
            has("background:solid-skybox"),
            [
                [
                    has("background:solid-skybox"),
                    "scene source reached background:solid-skybox",
                ],
            ],
            "not reached",
            "src/material/pbr/background-solid-skybox.ts",
            ["render_capabilities.hpp"],
        ),
        row(
            "BBLITE_PBR_VARIANTS",
            "capability",
            variantCount > 0,
            variantCount > 0
                ? `${variantCount} variant(s) composed by the pin over ` +
                    "the scene's materials, mesh feature sets, and scene arms"
                : "no glTF or scene-code PBR materials compose variants",
            "the pin's own composed PBR stages " +
                "(src/material/pbr/pbr-template.ts and its fragments), one " +
                "file per distinct variant, replacing the transcribed " +
                "per-scene fragment",
            ["render_capabilities.hpp", "variant table"],
        ),
    ];
}

const codecProvenance =
    "native-architecture: the pinned engine decodes images through the " +
    "browser; the native build links a codec per reached content type " +
    "and packaging ships its runtime (docs/features.md)";

function codecRows(inputs: FeatureActivationInputs): FeatureActivationRow[] {
    const reached = (codec: string): boolean =>
        inputs.imageCodecs.includes(codec);
    return [
        row(
            "png",
            "codec",
            reached("png"),
            "unconditional: .env RGBD payloads and the RGBD BRDF LUT " +
                "decode through PNG; screenshot capture encodes PNG",
            codecProvenance,
            ["features.cmake", "vcpkg manifest"],
        ),
        row(
            "jpeg",
            "codec",
            reached("jpeg"),
            reached("jpeg")
                ? "a materialized asset carries image/jpeg content"
                : "no materialized asset carries JPEG content",
            codecProvenance,
            ["features.cmake", "vcpkg manifest"],
        ),
        row(
            "webp",
            "codec",
            reached("webp"),
            reached("webp")
                ? "a materialized asset carries image/webp content"
                : "no materialized asset carries WebP content",
            `${codecProvenance}; the EXT_texture_webp source override is ` +
                "read by the pinned core parser " +
                "(src/loader-gltf/gltf-parser.ts) and mirrored by the " +
                "generated loader's texture_image_index",
            ["features.cmake", "vcpkg manifest"],
        ),
    ];
}

function emitOptionRows(
    inputs: FeatureActivationInputs,
): FeatureActivationRow[] {
    const { emit } = inputs;
    return [
        row(
            "animatedWorldBounds",
            "emit-option",
            emit.animatedWorldBounds,
            emit.animatedWorldBounds
                ? "a glTF asset carries animations, so the loader records " +
                    "live world boxes"
                : "no glTF asset carries animations",
            "native-architecture: upstream recomputes node worlds live and " +
                "composes boxes per frame (expandWorldAabbForMesh — " +
                "src/scene/scene-camera.ts, src/mesh/mesh-world-bounds.ts); " +
                "this port bakes static node matrices, so default framing " +
                "reads recorded live boxes for animated assets",
            ["loader flag"],
        ),
        row(
            "nonTrianglePrimitives",
            "emit-option",
            emit.nonTrianglePrimitives,
            emit.nonTrianglePrimitives
                ? "a glTF primitive has mode !== 4"
                : "every glTF primitive is a triangle list (or there are " +
                    "no glTF assets)",
            "src/loader-gltf/gltf-feature-registry.ts primitive row, the " +
                "anyPrimitive(mode !== 4) half -> gltf-feature-primitive.js; " +
                "the hasNegDetNode half is unconditional inline code in the " +
                "generated loader (mirrored_x)",
            ["loader flag"],
        ),
        row(
            "nodeVisibility",
            "emit-option",
            emit.nodeVisibility,
            emit.nodeVisibility
                ? "an asset uses KHR_node_visibility"
                : "no asset uses KHR_node_visibility",
            "src/loader-gltf/gltf-feature-registry.ts: " +
                "KHR_node_visibility -> gltf-ext-node-visibility.js",
            ["loader flag", "renderer plan"],
        ),
        row(
            "animationPointer",
            "emit-option",
            emit.animationPointer,
            emit.animationPointer
                ? "an asset uses KHR_animation_pointer"
                : "no asset uses KHR_animation_pointer",
            "src/loader-gltf/gltf-feature-registry.ts: " +
                "KHR_animation_pointer -> gltf-feature-animation-pointer.js",
            ["loader flag"],
        ),
        row(
            "animationPointerMaterials",
            "emit-option",
            emit.animationPointerMaterials,
            emit.animationPointerMaterials
                ? "a KHR_animation_pointer channel targets /materials/..."
                : "no animation-pointer channel targets materials",
            "the pinned animation-pointer split: material targets pull " +
                "their own writers (src/loader-gltf/animation-pointer-ext.ts) " +
                "while the base module resolves node targets, so a " +
                "node-only scene never carries the material half",
            ["loader flag"],
        ),
        row(
            "assetTransmission",
            "emit-option",
            emit.assetTransmission,
            emit.assetTransmission
                ? "a glTF material's transmissionFactor > 0"
                : "no glTF material carries transmissionFactor > 0 (a " +
                    "declared extension with a zero factor reaches nothing)",
            "src/loader-gltf/gltf-ext-dielectric.ts sets _transmissive and " +
                "the refraction intensity from transmissionFactor; " +
                "registerPbrTransmission " +
                "(src/material/pbr/pbr-transmission-ext.ts) accepts any " +
                "such mesh without the scene naming it",
            ["loader flag", "render_capabilities.hpp"],
        ),
        row(
            "materialSpecular",
            "emit-option",
            emit.materialSpecular,
            emit.materialSpecular
                ? "a KHR_materials_specular material reaches the specular " +
                    "half of the pinned needsReflectance (a texture, factor " +
                    "!= 1, or a non-white colour)"
                : "no material reaches the specular half of " +
                    "needsReflectance (the ior-alone arm folds exactly; " +
                    "factor 1 with white colour reaches nothing)",
            "src/loader-gltf/gltf-ext-dielectric.ts needsReflectance, the " +
                "specular half; the ior !== 1.5 arm is folded exactly by " +
                "the generated loader's reflectance fold and " +
                "applyDielectric, so it deliberately does not activate this",
            ["loader flag", "renderer plan"],
        ),
        row(
            "textureTransform",
            "emit-option",
            emit.textureTransform,
            emit.textureTransform
                ? "an asset uses KHR_texture_transform"
                : "no asset uses KHR_texture_transform",
            "src/loader-gltf/gltf-feature-registry.ts: " +
                "KHR_texture_transform -> gltf-ext-uv-transform.js; " +
                "fragment src/material/pbr/fragments/uv-transform-fragment.ts",
            ["renderer plan"],
        ),
        row(
            "imageBasedLighting",
            "emit-option",
            emit.imageBasedLighting,
            emit.imageBasedLighting
                ? "an asset uses EXT_lights_image_based (installs the " +
                    "asset's own environment, adds the pinned BRDF LUT " +
                    "asset, and joins environment:ibl)"
                : "no asset uses EXT_lights_image_based",
            "src/loader-gltf/gltf-ext-lights-image-based.ts",
            ["renderer plan"],
        ),
        row(
            "punctualLights",
            "emit-option",
            emit.punctualLights,
            emit.punctualLights
                ? "an asset uses KHR_lights_punctual"
                : "no asset uses KHR_lights_punctual",
            "src/loader-gltf/gltf-feature-lights-punctual.ts " +
                "(KHR_lights_punctual)",
            ["renderer plan"],
        ),
        row(
            "standardLights",
            "emit-option",
            emit.standardLights > 0,
            emit.standardLights > 0
                ? `${emit.standardLights} point light(s) (type 0) across ` +
                    "the scene's .babylon assets"
                : "no .babylon point lights",
            "native-architecture: the pinned Standard template sizes its " +
                "light array from MAX_LIGHTS at generation " +
                "(src/material/standard/standard-template.ts, " +
                "src/light/types.ts); the composed fragment loops " +
                "min(mesh.lc, MAX_LIGHTS) over the shared lights block, " +
                "and the count is knowable because the loader accepts " +
                "only point lights",
            ["renderer plan"],
        ),
        row(
            "standardLightLists",
            "emit-option",
            emit.standardLightLists,
            emit.standardLightLists
                ? "a .babylon point light names included/excluded meshes"
                : "no .babylon light names the meshes it applies to",
            "src/loader-babylon/load-babylon.ts " +
                "includedOnlyMeshesIds/excludedMeshesIds; the pinned engine " +
                "keeps a per-mesh light set (src/render/lights-ubo.ts) the " +
                "Standard uniform block expresses only when an asset " +
                "declares one",
            ["loader flag", "renderer plan"],
        ),
        row(
            "standardDiffuseUv2",
            "emit-option",
            emit.standardDiffuseUv2,
            emit.standardDiffuseUv2
                ? "a .babylon material authors its diffuse texture against " +
                    "the second UV set"
                : "no .babylon diffuse texture selects coordinatesIndex 1",
            "src/loader-babylon/load-babylon.ts reads " +
                "diffuseTexture.coordinatesIndex; the pinned Standard " +
                "material samples the diffuse slot at the authored UV set " +
                "(src/material/standard/standard-template.ts) — specular " +
                "and ambient always carried the selection",
            ["loader flag", "renderer plan"],
        ),
        row(
            "idDiagnostics",
            "emit-option",
            emit.idDiagnostics,
            emit.idDiagnostics
                ? "--id-diagnostics passed on the command line"
                : "not requested",
            "native-architecture: a generation-time diagnostics option " +
                "with no upstream counterpart; adds ID outputs to the " +
                "composed shaders",
            ["renderer plan"],
        ),
    ];
}

function compositionRows(
    inputs: FeatureActivationInputs,
): FeatureActivationRow[] {
    const { composition, emit, specialization: spec, features } = inputs;
    const variantCount = (emit.pinnedVariants ?? []).length;
    const taskCount = emit.geometryOutputTasks.length;
    const kinds = composition.lightKinds;
    return [
        row(
            "scene-arms:light-modes",
            "composition",
            variantCount > 0,
            variantCount > 0
                ? "composed over light modes: no-light" +
                    (kinds.length > 0
                        ? `, single-light [${kinds.join(", ")}], multi-light`
                        : "") +
                    "; the runtime selects the arm its own light walk produces"
                : "no composed PBR variants consume the scene arms",
            "src/material/pbr/fragments/multilight-wgsl.ts and the " +
                "single-light modules; generation cannot know how many " +
                "lights end up affecting a mesh, so every reachable mode " +
                "is composed",
            ["variant table"],
        ),
        checkedRow(
            "scene-arms:tone-mapping",
            "composition",
            composition.toneMappingArms,
            [
                [
                    features.includes("environment:ibl"),
                    "an environment is loaded, which is what turns tone " +
                        "mapping on upstream — both states composed",
                ],
            ],
            "no environment: only the tone-mapping-off arm exists",
            "src/material/pbr/tone-mapping.ts (StandardToneMapping) via " +
                "src/scene/scene-image-processing.ts",
            ["variant table"],
        ),
        checkedRow(
            "linear-image-processing",
            "composition",
            composition.linearImageProcessing,
            [
                [
                    features.includes("renderer:transmission"),
                    "scene source reached renderer:transmission",
                ],
                [
                    spec.assetTransmission,
                    "asset-carried KHR_materials_transmission enables the " +
                        "runtime's transmission exactly like the feature",
                ],
            ],
            "no transmission, so materials keep gamma-space image " +
                "processing",
            "src/frame-graph/transmission.ts markPbrMaterialsLinear: " +
                "enableSceneTransmission marks every material " +
                "_linearImageProcessing, so each composed fragment wraps " +
                "its processing tail in if(scene.vImageInfos.w >= 0.0) and " +
                "the retargeted linear pass runs with w = -1",
            ["variant table"],
        ),
        row(
            "scene-arms:geometry-output",
            "composition",
            taskCount > 0,
            taskCount > 0
                ? `${taskCount} geometry-output task(s); a PBR mesh drawn ` +
                    "in one resolves the pin's own MRT arm for that task's " +
                    "attachment list"
                : "no geometry-output tasks",
            "src/material/pbr/pbr-geometry-output-shader.ts (attachmentExpr)",
            ["variant table"],
        ),
    ];
}

/**
 * One variant-key interleave guard's row. The counts are the same
 * per-creation `gltfAssetsBefore` values the CLI guard compared, so a
 * derivation that says the refusal fired while generation proceeded is
 * the guard and the table drifting apart — a loud failure, like
 * `checkedRow`.
 */
function interleaveRow(
    name: string,
    kind: "mesh" | "PBR material",
    counts: readonly number[],
    gltfAssetCount: number,
    upstreamProvenance: string,
): FeatureActivationRow {
    if (counts.some((before) => before !== gltfAssetCount)) {
        throw new Error(
            `feature-activation: row '${name}' derives a fired ` +
                `interleave refusal (a scene-code ${kind} was created ` +
                `before a later glTF load) but generation proceeded; ` +
                `the cli.ts guard no longer mirrors the activation ` +
                `table. Update src/feature-activation.ts beside the ` +
                `guard.`,
        );
    }
    return row(
        name,
        "generation-refusal",
        false,
        counts.length > 0
            ? `checked ${counts.length} scene-code ${kind} ` +
                `creation(s) against ${gltfAssetCount} glTF load(s): ` +
                `every one was created after the last load, so the ` +
                `creation-order key does not interleave`
            : `no scene-code ${kind} creations to check`,
        upstreamProvenance,
        ["generation gate"],
    );
}

function refusalRows(
    inputs: FeatureActivationInputs,
): FeatureActivationRow[] {
    const { specialization: spec, emit, gltfAssetNames } = inputs;
    const checkedAssets =
        gltfAssetNames.length > 0
            ? `checked ${gltfAssetNames.length} glTF asset(s) ` +
              `(${gltfAssetNames.join(", ")})`
            : "no glTF assets to check";
    const gate: readonly FeatureActivationConsumer[] = ["generation gate"];
    // The frozen constant's own value, when the caller read it from the
    // pin. A checked count above it is the same drift `checkedRow`
    // refuses on: the gate would have thrown before rows were built.
    if (
        inputs.pinnedMaxLights !== undefined &&
        emit.assetLightNodes !== undefined &&
        emit.assetLightNodes.count > inputs.pinnedMaxLights
    ) {
        throw new Error(
            `feature-activation: row 'refusal:max-lights' records a ` +
                `light-node count of ${emit.assetLightNodes.count} ` +
                `above the pinned MAX_LIGHTS of ` +
                `${inputs.pinnedMaxLights}, but generation proceeded; ` +
                `the upstream-lower.ts gate no longer mirrors the ` +
                `activation table.`,
        );
    }
    const maxLightsSuffix =
        inputs.pinnedMaxLights !== undefined
            ? ` = ${inputs.pinnedMaxLights}`
            : "";
    return [
        row(
            "refusal:pin-implemented-extension",
            "generation-refusal",
            false,
            `${checkedAssets}: every declared extension is either lowered ` +
                "end to end or ignored identically by both sides",
            "src/loader-gltf/gltf-feature-registry.ts extension->module " +
                "rows, parsed from the pin's own AST, plus the named " +
                "pin-only loader extensions (spec-gloss, anisotropy, " +
                "diffuse-transmission, basisu, variants); an extension the " +
                "pinned loader implements and this port does not would " +
                "silently render a different image, so it refuses at " +
                "generation",
            gate,
        ),
        row(
            "refusal:sparse-accessors",
            "generation-refusal",
            false,
            `${checkedAssets}: no accessor carries a sparse block`,
            "src/loader-gltf/gltf-feature-registry.ts sparse-accessor " +
                "predicate -> gltf-feature-sparse.js (the pinned loader " +
                "reads them; this port refuses at generation instead of " +
                "throwing at load)",
            gate,
        ),
        row(
            "refusal:orm-shapes",
            "generation-refusal",
            false,
            `${checkedAssets}: no un-lowered occlusion/metallic-roughness ` +
                "shape (occlusion on TEXCOORD_1 beside metallic-roughness, " +
                "occlusion past uv2, or distinct ORM images)",
            "src/loader-gltf/gltf-ext-orm.ts (needsOrmComposite in the " +
                "registry): upstream composites occlusion and " +
                "metallic-roughness images on a canvas; the shapes this " +
                "port does not lower refuse at generation",
            gate,
        ),
        row(
            "refusal:max-lights",
            "generation-refusal",
            false,
            emit.assetLightNodes !== undefined
                ? `checked: the largest per-asset KHR_lights_punctual ` +
                    `light-node count is ${emit.assetLightNodes.count} ` +
                    `(${emit.assetLightNodes.asset}), within the frozen ` +
                    `pinned MAX_LIGHTS${maxLightsSuffix}`
                : "no glTF asset carries KHR_lights_punctual light nodes" +
                    (inputs.pinnedMaxLights !== undefined
                        ? ` (frozen pinned MAX_LIGHTS${maxLightsSuffix})`
                        : ""),
            "src/loader-gltf/gltf-feature-lights-punctual.ts setMaxLights: " +
                "the pin grows MAX_LIGHTS (src/light/types.ts) at run time; " +
                "this port freezes the constant and the native writers stop " +
                "at it, so an asset exceeding it refuses at generation " +
                "instead of silently unlighting the excess",
            gate,
        ),
        row(
            "refusal:uncovered-material-arm",
            "generation-refusal",
            false,
            gltfAssetNames.length > 0
                ? "checked: every arm the pin's own composition reaches " +
                    "for the scene's glTF materials is carried by the " +
                    "emitted fragments"
                : "no glTF materials composed",
            "the pin's own per-material composition " +
                "(src/material/pbr/pbr-template.ts and its fragments) " +
                "cross-checked against the emitted arm set; an arm reached " +
                "but not emitted refuses naming the material rather than " +
                "shipping a shading bias",
            gate,
        ),
        ...(inputs.interleave === undefined
            ? []
            : [
                interleaveRow(
                    "refusal:scene-mesh-interleave",
                    "mesh",
                    inputs.interleave.sceneMeshGltfAssetsBefore,
                    inputs.interleave.gltfAssetCount,
                    "native-architecture: the generated variant table " +
                        "keys renderables by creation-order mesh handle " +
                        "(each glTF load appends its renderables in the " +
                        "pinned loader's node-order walk, then scene-code " +
                        "builders append; recordSceneMesh in compiler.ts " +
                        "records gltfAssetsBefore per creation); the pin " +
                        "composes shaders at run time and keys no static " +
                        "table, so a scene-code mesh created before a " +
                        "later glTF load refuses at generation instead of " +
                        "mis-keying the table",
                ),
                interleaveRow(
                    "refusal:scene-material-interleave",
                    "PBR material",
                    inputs.interleave.scenePbrMaterialGltfAssetsBefore,
                    inputs.interleave.gltfAssetCount,
                    "native-architecture: the generated variant table " +
                        "keys materials by creation-order handle (each " +
                        "glTF load appends its materials, then scene-code " +
                        "creations append; compilePbrMaterialOptions " +
                        "records gltfAssetsBefore per creation); the pin " +
                        "composes per-material at run time and keys no " +
                        "static table, so a scene-code PBR material " +
                        "created before a later glTF load refuses at " +
                        "generation instead of mis-keying the table",
                ),
            ]),
        row(
            "refusal:eight-influence-skinning",
            "generation-refusal",
            spec.eightInfluenceSkinning,
            spec.eightInfluenceSkinning
                ? "an asset carries JOINTS_1/WEIGHTS_1; recorded as the " +
                    "four-influence-skinning fidelity adaptation instead of " +
                    "refusing (the second pair carries the small weight tail)"
                : "no asset carries a second influence pair",
            "src/loader-gltf/gltf-feature-skeleton.ts reads the second " +
                "influence pair and skins eight influences " +
                "(MSH_HAS_SKELETON_8); the generated loader reads four, and " +
                "the bounded truncation is the documented refusal-relaxed " +
                "case (docs/fidelity.md, gated by scene 7)",
            ["fidelity.json"],
        ),
    ];
}

/**
 * The full activation inventory for one scene, in a deterministic order:
 * runtime features (table order, then any unmapped manifest feature),
 * capability defines (header order), codecs, emit options, composition
 * facts, and the generation-time refusals.
 */
export function featureActivationRows(
    inputs: FeatureActivationInputs,
): FeatureActivationRow[] {
    return [
        ...runtimeFeatureRows(inputs),
        ...capabilityRows(inputs),
        ...codecRows(inputs),
        ...emitOptionRows(inputs),
        ...compositionRows(inputs),
        ...refusalRows(inputs),
    ];
}
