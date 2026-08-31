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
import {
    nodeShadowInputs,
    shadowCapabilities,
} from "./shadow-capabilities.js";
import { variantBindings } from "./pinned-pbr-variant-cpp.js";
import { nodeVariantsUseMorphStorage } from "./pinned-node-material-cpp.js";
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
    | "deployed shaders"
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
     * The variant-key interleave inputs: for each scene-code mesh / PBR
     * material in creation order, how many glTF assets had loaded when it
     * was created, against the scene's glTF asset total. The runtime keys the
     * variant table by creation-order handle, so the compose layer uses these
     * counts to reproduce interleaving and the rows record which path ran.
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
        /** The upstream loader/runtime tone-mapping states composed. */
        toneMappingStates: readonly boolean[];
        /** Whether scene code can assign the tone-mapping state at runtime. */
        mutableToneMappingEnabled: boolean;
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
            "stopAnimation, goToFrame) + src/loader-gltf/gltf-feature-animations.ts",
        consumers: ["features.cmake"],
    },
    "animation:property": {
        provenance: "src/animation/property-animation.ts",
        consumers: CMAKE,
    },
    "animation:property-blending": {
        provenance:
            "src/animation/weighted-pointer-mixer.ts " +
            "(enablePropertyAnimationBlending installs the manager's " +
            "animation-group category handler) + " +
            "src/animation/animation-weight.ts (setAnimationWeight)",
        consumers: CMAKE,
    },
    "animation:weight-fades": {
        provenance:
            "src/animation/animation-weight-fade.ts " +
            "(crossFadeAnimationGroups schedules mixer-neutral weight " +
            "jobs in the manager's composable pre-update hook)",
        consumers: CMAKE,
    },
    "animation:managed-groups": {
        provenance:
            "src/animation/animation-group-task.ts (addAnimationGroups " +
            "attaches a loaded file's clips to a scene-owned manager) + " +
            "src/animation/animation-manager.ts (updateAnimationManager)",
        consumers: CMAKE,
    },
    "animation:gltf-blending": {
        provenance:
            "src/animation/weighted-gltf-mixer.ts " +
            "(enableAnimationBlending installs the weighted skeleton " +
            "mixer as the manager's animation-group category handler)",
        consumers: CMAKE,
    },
    "animation:gltf-additive": {
        provenance:
            "src/animation/weighted-gltf-mixer.ts " +
            "(setAnimationAdditive marks a group additive with its " +
            "reference time and enables blending on the owning manager; " +
            "accumulateAdditiveGroup adds each channel's weighted " +
            "difference from the reference-time sample, rotations as " +
            "reference^-1 * sample onto the base before the weighted " +
            "slerp)",
        consumers: CMAKE,
    },
    "animation:gltf-group-time": {
        provenance:
            "src/animation/animation-group.ts (AnimationGroup." +
            "currentTime is a public mutable field; the direct write " +
            "takes the loader's set_clip_time writer route, and whoever " +
            "drives the group applies the pose on its next tick)",
        consumers: CMAKE,
    },
    "animation:gltf-group-speed": {
        provenance:
            "src/animation/animation-group.ts (AnimationGroup." +
            "speedRatio is a public mutable field that " +
            "syncControllerFromGroup pushes onto the controller, whose " +
            "tick advances time += (deltaMs / 1000) * speedRatio)",
        consumers: CMAKE,
    },
    "animation:gltf-group-mask": {
        provenance:
            "src/animation/animation-group-mask.ts " +
            "(createAnimationGroupMask + animationGroupMaskRetainsTarget) " +
            "+ src/skeleton/skeleton-updater.ts (the controller skips a " +
            "masked node's channels, so it keeps its rest-pose TRS)",
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
            "environment turns IBL on); asset-joined " +
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
            "(src/loader-gltf/gltf-feature-lights-punctual.ts) or a " +
            ".babylon document's point lights " +
            "(src/loader-babylon/load-babylon.ts)",
        consumers: ["features.cmake", "variant table"],
    },
    "light:spot": {
        provenance:
            "src/light/spot-light.ts; asset-joined via " +
            "KHR_lights_punctual " +
            "(src/loader-gltf/gltf-feature-lights-punctual.ts)",
        consumers: ["features.cmake", "variant table"],
    },
    "light:clustered": {
        provenance:
            "src/light/clustered.ts, with the spot arm behind " +
            "src/light/clustered-spot-support.ts",
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
    "loader:gltf-cameras": {
        provenance:
            "src/loader-gltf/gltf-feature-camera.ts#enableGltfCameras + " +
            "src/loader-gltf/gltf-feature-camera.ts#applyAsset",
        consumers: ["features.cmake", "loader flag"],
    },
    "loader:gltf-bone-control": {
        provenance:
            "src/skeleton/bone-control.ts#enableBoneControl + " +
            "src/skeleton/bone-control.ts#buildSkeletons + " +
            "src/skeleton/skeleton-pose.ts",
        consumers: ["features.cmake", "loader flag"],
    },
    "loader:splat": {
        provenance:
            "src/loader-splat/load-splat.ts#loadSplat + " +
            "src/loader-splat/splat-data.ts#buildSplatGeometry + " +
            "src/loader-splat/splat-sort-core.ts + " +
            "src/mesh/GaussianSplatting/gaussian-splatting-pipeline.ts",
        consumers: ["features.cmake", "deployed shaders"],
    },
    "loader:splat-bake": {
        provenance:
            "src/mesh/GaussianSplatting/gaussian-splatting-bake.ts" +
            "#bakeCurrentTransformIntoVertices",
        consumers: ["features.cmake"],
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
    "material:pbr-gamma-albedo": {
        provenance:
            "src/material/pbr/set-gamma-albedo.ts (the ext contributes one " +
            "feature bit and the base template's sRGB decode block; no " +
            "fragment slot, UBO field or binding of its own)",
        consumers: ["features.cmake", "variant table"],
    },
    "material:iridescence": {
        provenance: "src/material/pbr/set-iridescence.ts",
        consumers: ["features.cmake", "render_capabilities.hpp", "variant table"],
    },
    "material:anisotropy": {
        provenance: "src/material/pbr/set-anisotropy.ts",
        // No capability define: the layer declares no binding and no texture
        // slot, so its whole arm rides the composed variant.
        consumers: ["features.cmake", "variant table"],
    },
    "material:metallic-reflectance": {
        provenance: "src/material/pbr/set-metallic-reflectance.ts",
        consumers: [
            "features.cmake",
            "material_texture_slots.hpp",
            "variant table",
        ],
    },
    "material:tracking": {
        provenance: "src/material/tracking/pbr-tracking.ts",
        // Nothing is emitted for it, so the only consumer is the record of
        // what was dropped and why.
        consumers: ["features.cmake"],
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
    "material:node": {
        provenance: "src/material/node/node-material.ts",
        consumers: ["features.cmake", "variant table"],
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
    "mesh:update-positions": {
        provenance: "src/mesh/mesh-factories.ts (updateMeshPositions)",
        consumers: CMAKE,
    },
    "mesh:ground": {
        provenance: "src/mesh/create-ground.ts",
        consumers: CMAKE,
    },
    "mesh:ground-heightmap": {
        provenance: "src/mesh/create-ground.ts",
        consumers: CMAKE,
    },
    "mesh:lines": {
        provenance: "src/mesh/create-line-system.ts",
        consumers: CMAKE,
    },
    "mesh:morph-targets": {
        provenance: "src/morph/create-morph-targets.ts",
        consumers: ["features.cmake", "render_capabilities.hpp"],
    },
    "mesh:mirrored": {
        provenance: "src/mesh/enable-mirrored-meshes.ts",
        consumers: CMAKE,
    },
    "mesh:transform-node": {
        provenance: "src/scene/transform-node.ts",
        consumers: CMAKE,
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
    "mesh:thin-instance-colors": {
        provenance: "src/mesh/thin-instance.ts",
        consumers: ["features.cmake", "render_capabilities.hpp"],
    },
    "mesh:thin-instances-dynamic": {
        provenance: "src/mesh/thin-instance.ts",
        consumers: ["features.cmake", "render_capabilities.hpp"],
    },
    "mesh:cylinder": {
        provenance: "src/mesh/create-cylinder.ts",
        consumers: CMAKE,
    },
    "mesh:extrude": {
        provenance: "src/mesh/create-extrude.ts",
        consumers: CMAKE,
    },
    "mesh:polyhedron": {
        provenance: "src/mesh/create-polyhedron.ts",
        consumers: CMAKE,
    },
    "mesh:ribbon": {
        provenance: "src/mesh/create-ribbon.ts",
        consumers: CMAKE,
    },
    "mesh:disc": {
        provenance: "src/mesh/create-disc.ts",
        consumers: CMAKE,
    },
    "mesh:torus": {
        provenance: "src/mesh/create-torus.ts",
        consumers: CMAKE,
    },
    "mesh:parenting": {
        provenance: "src/scene/set-parent.ts",
        consumers: CMAKE,
    },
    "mesh:geometry-access": {
        provenance: "src/mesh/mesh.ts retained CPU geometry + worldMatrix",
        consumers: CMAKE,
    },
    "mesh:visible": {
        provenance: "src/scene/scene-node.ts",
        consumers: CMAKE,
    },
    "mesh:pickable": {
        provenance: "src/mesh/mesh.ts",
        consumers: CMAKE,
    },
    "picking:gpu": {
        provenance: "src/picking/gpu-picker.ts",
        consumers: CMAKE,
    },
    "scene:remove": {
        provenance: "src/scene/scene-remove.ts",
        consumers: CMAKE,
    },
    "shadow:esm": {
        provenance: "src/shadow/esm-directional-shadow-generator.ts",
        consumers: ["features.cmake", "render_capabilities.hpp"],
    },
    "shadow:pcf": {
        provenance: "src/shadow/pcf-spotlight-shadow-generator.ts",
        consumers: ["features.cmake", "render_capabilities.hpp"],
    },
    // The directional PCF factory alone. It reaches `shadow:pcf` beside
    // this one, because every resource and every receiver arm is that
    // generator's; what differs is the volume its light matrix is fitted
    // with, so this row gates the emitted factory and nothing else.
    "shadow:pcf-directional": {
        provenance: "src/shadow/pcf-directional-shadow-generator.ts",
        consumers: ["features.cmake"],
    },
    // The pin allocates a depth-texture array and one camera-fitted map per
    // cascade. The native resource seam retains its first cascade in the PCF
    // family's single sampled depth texture, so this distinct row gates that
    // factory and records the adaptation in fidelity.json.
    "shadow:csm-single-map": {
        provenance: "src/shadow/csm-directional-shadow-generator.ts",
        consumers: ["features.cmake", "fidelity.json"],
    },
    "shadow:task": {
        provenance: "src/frame-graph/shadow-task.ts",
        consumers: CMAKE,
    },
    "sprite:2d": {
        provenance:
            "src/sprite/sprite-2d.ts + " +
            "src/render/alpha-to-coverage.ts#setAlphaToCoverage",
        consumers: CMAKE,
    },
    "sprite:2d-depth-host": {
        provenance:
            "src/sprite/sprite-scene.ts#addDepthHostedSpriteLayer + " +
            "src/sprite/sprite-renderable.ts#buildSpriteRenderable",
        consumers: CMAKE,
    },
    "sprite:uv-scroll": {
        provenance: "src/sprite/sprite-2d-uvscroll.ts",
        consumers: CMAKE,
    },
    "material:standard-diffuse-render-texture": {
        provenance:
            "src/material/standard/standard-material.ts diffuseTexture + " +
            "src/texture/rtt.ts",
        consumers: CMAKE,
    },
    "material:standard-emissive-render-texture": {
        provenance:
            "src/material/standard/set-std-emissive.ts + src/texture/rtt.ts",
        consumers: CMAKE,
    },
    "material:standard-emissive-file-texture": {
        provenance:
            "src/material/standard/set-std-emissive.ts + " +
            "src/texture/texture-2d.ts",
        consumers: CMAKE,
    },
    "material:standard-diffuse-file-texture": {
        provenance:
            "src/material/standard/standard-material.ts diffuseTexture + " +
            "src/texture/texture-2d.ts",
        consumers: CMAKE,
    },
    "material:standard-diffuse-pixels-texture": {
        provenance:
            "src/material/standard/standard-material.ts diffuseTexture + " +
            "src/texture/pixels-texture.ts",
        consumers: CMAKE,
    },
    "material:standard-uv-transform": {
        provenance:
            "src/material/enable-material-uv-transform.ts + " +
            "src/material/standard/fragments/std-uv-transform-fragment.ts",
        consumers: CMAKE,
    },
    "material:plugins": {
        provenance:
            "src/material/plugin/enable-material-plugins.ts + " +
            "src/material/plugin/plugin-bridge-shared.ts",
        consumers: CMAKE,
    },
    "material:plugin-index": {
        provenance:
            "src/material/material.ts plugins + " +
            "src/material/plugin/std-plugin-bridge.ts",
        consumers: CMAKE,
    },
    "texture:file": {
        provenance:
            "src/texture/texture-2d.ts + src/texture/solid-texture.ts",
        consumers: CMAKE,
    },
    "texture:compressed": {
        provenance:
            "src/texture/ktx-loader.ts + src/texture/compressed-formats.ts",
        consumers: CMAKE,
    },
    "texture:pixels": {
        provenance: "src/texture/pixels-texture.ts",
        consumers: CMAKE,
    },
    "sprite:custom-shader": {
        provenance:
            "src/sprite/sprite-custom-shader.ts + src/sprite/custom-shader-core.ts",
        consumers: CMAKE,
    },
    "sprite:billboard": {
        provenance:
            "src/sprite/billboard-sprite.ts + src/sprite/billboard-scene.ts",
        consumers: CMAKE,
    },
    "particle:node": {
        provenance:
            "src/particle/node/npe-build.ts + src/particle/particle-system.ts " +
            "+ src/particle/particle-billboard.ts",
        consumers: CMAKE,
    },
    "mesh:tube": {
        provenance:
            "src/mesh/create-tube.ts createTubeData + rodrigues, " +
            "src/mesh/path3d.ts computePath3D, " +
            "src/mesh/create-ribbon.ts createRibbonData, " +
            "src/mesh/compute-normals.ts computeNormals",
        consumers: CMAKE,
    },
    "navigation:recast": {
        provenance:
            "src/navigation/navigation.ts createNavigationPluginAsync + " +
            "the @recast-navigation/generators pipeline and the Detour " +
            "crowd its createNavCrowd builds (the wasm the pin loads is " +
            "the same recastnavigation sources the native library links)",
        consumers: CMAKE,
    },
    "sprite:animation": {
        provenance:
            "src/sprite/sprite-animation.ts createSpriteAnimationManager + " +
            "the frame stepper its updateSpriteAnimationManager runs, and " +
            "the two family adapters (sprite-2d-handle-animation.ts, " +
            "billboard-sprite-handle-animation.ts) that name a sprite for it",
        consumers: CMAKE,
    },
    "navigation:tile-cache": {
        provenance:
            "src/navigation/navigation.ts createNavMesh with " +
            "maxObstacles > 0 + the @recast-navigation/generators " +
            "generateTileCache pipeline and the addBoxObstacle / " +
            "addCylinderObstacle / removeObstacle / " +
            "updateNavMeshObstacles surface it is what makes possible",
        consumers: CMAKE,
    },
    "audio:engine": {
        provenance:
            "src/audio/audio-engine.ts createAudioEngineAsync + bus.ts " +
            "createMainOut/createMainBus (the Web Audio API the pinned " +
            "module reaches is the back end this port supplies from the " +
            "PAL, over LabSound with an SDL3 device)",
        consumers: CMAKE,
    },
    "audio:buffer-source": {
        provenance:
            "the reached Web Audio graph creates an AudioBuffer, writes its " +
            "channel data, and plays it through an AudioBufferSourceNode",
        consumers: CMAKE,
    },
    "audio:decoded-buffer": {
        provenance:
            "the reached Web Audio graph fetches an encoded packaged file " +
            "and decodes it through BaseAudioContext.decodeAudioData",
        consumers: CMAKE,
    },
    "audio:oscillator": {
        provenance:
            "the reached Web Audio graph calls AudioContext.createOscillator()",
        consumers: CMAKE,
    },
    "audio:biquad-filter": {
        provenance:
            "the reached Web Audio graph calls AudioContext.createBiquadFilter()",
        consumers: CMAKE,
    },
    "audio:stereo-panner": {
        provenance:
            "the reached Web Audio graph calls AudioContext.createStereoPanner()",
        consumers: CMAKE,
    },
    "physics:world": {
        provenance:
            "src/physics/havok.ts createHavokWorld + _stepWorld " +
            "(the pin's own `hknp` parameter is the back end this port " +
            "supplies from the PAL)",
        consumers: CMAKE,
    },
    "physics:aggregate": {
        provenance:
            "src/physics/havok.ts createPhysicsAggregate + " +
            "createPrimitivePhysicsShapeHandle",
        consumers: CMAKE,
    },
    "sprite:billboard-custom-shader": {
        provenance:
            "src/sprite/billboard-custom-shader.ts + src/sprite/custom-shader-core.ts",
        consumers: CMAKE,
    },
    "sprite:billboard-axis-locked": {
        provenance:
            "src/sprite/billboard-sprite.ts#createAxisLockedBillboardSystem " +
            "+ src/sprite/billboard-pipeline.ts#makeBillboardBasisWgsl",
        consumers: CMAKE,
    },
    "sprite:billboard-cutout": {
        provenance:
            "src/sprite/billboard-blend.ts#billboardBlendCutout + " +
            "src/sprite/billboard-pipeline.ts#makeBillboardFragmentWgsl",
        consumers: CMAKE,
    },
    "renderer:sprite": {
        provenance: "src/sprite/sprite-pipeline.ts",
        consumers: CMAKE,
    },
    "renderer:effect": {
        provenance:
            "src/effect/effect-renderer.ts createEffectRenderer " +
            "(a RenderingContext on the engine, like a SpriteRenderer)",
        consumers: CMAKE,
    },
    "frame-graph:resources": {
        provenance:
            "src/engine/render-target.ts createRenderTarget + " +
            "src/texture/rtt.ts createRenderTargetTexture",
        consumers: CMAKE,
    },
    "renderer:frame-graph": {
        provenance:
            "src/frame-graph/frame-graph-context.ts " +
            "createFrameGraphContext/registerFrameGraphContext",
        consumers: CMAKE,
    },
    "effect:wrapper": {
        provenance:
            "src/effect/effect-renderer.ts createEffectWrapper " +
            "(DEFAULT_VERTEX_WGSL plus the caller's fragment)",
        consumers: CMAKE,
    },
    "effect:task": {
        provenance:
            "src/effect/effect-renderer.ts createEffectRenderTask " +
            "(the frame-graph pass into a RenderTarget)",
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
    "material:pbr-linear-image-processing": {
        provenance:
            "src/frame-graph/transmission.ts markPbrMaterialsLinear " +
            "(_linearImageProcessing on every reached PBR material)",
        consumers: ["variant table"],
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
    "renderer:post-process": {
        provenance: "src/frame-graph/post-process-task.ts",
        consumers: ["features.cmake"],
    },
    "renderer:high-precision-matrix": {
        provenance: "src/math/_matrix-allocator.ts",
        consumers: ["features.cmake"],
    },
    "renderer:floating-origin": {
        provenance: "src/large-world/floating-origin.ts",
        consumers: ["features.cmake", "render_capabilities.hpp"],
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
                    // The CLI performs the light join from two loaders and
                    // records the asset output either way; a `.babylon`
                    // document's own lights are load-babylon.ts's, not a
                    // glTF extension's.
                    : joinedBy.endsWith(".babylon")
                        ? `asset-joined: ${joinedBy} carries a .babylon ` +
                          `${name.slice("light:".length)} light ` +
                          "(src/loader-babylon/load-babylon.ts)"
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
    const standardVariantCount = (emit.pinnedStandardVariants ?? []).length;
    // What the header will SAY, from the same record the emitter writes it
    // from. The rows below state their reasons from the reached features
    // directly -- `has("shadow:pcf") || has("shadow:esm")` rather than the
    // shared predicate -- so `checkedRow` compares two derivations and not
    // one expression against itself.
    const nodeVariantList = emit.nodeVariants ?? [];
    const {
        nodeShadowReceivers: nodeShadowReceiverCount,
        nodeEsmCasters: nodeEsmCasterCount,
    } = nodeShadowInputs(nodeVariantList);
    const shadows = shadowCapabilities({
        features,
        standardVariants: standardVariantCount,
        pbrVariants: variantCount,
        nodeShadowReceivers: nodeShadowReceiverCount,
        nodeEsmCasters: nodeEsmCasterCount,
    });
    const nodeVariantCount = nodeVariantList.length;
    const nodeMorphStorage = nodeVariantsUseMorphStorage(nodeVariantList);
    // The same derivation upstream-lower makes for the define: a composed
    // Standard variant binding the pin's 2D reflection pair.
    const standardReflection = (emit.pinnedStandardVariants ?? [])
        .some((variant) =>
            variantBindings(
                variant.vertexWgsl,
                variant.fragmentWgsl,
            ).some((binding) => binding.name === "rT")
        );
    const pbrBindingNames = new Set(
        (emit.pinnedVariants ?? []).flatMap((variant) =>
            variantBindings(
                variant.vertexWgsl,
                variant.fragmentWgsl,
            ).map((binding) => binding.name)
        ),
    );
    const metallicReflectanceMap = pbrBindingNames.has(
        "metallicReflectanceMap",
    );
    const reflectanceMap = pbrBindingNames.has("reflectanceMap");
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
            emit.morphStorage || nodeMorphStorage,
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
                [
                    nodeMorphStorage,
                    "a compiled node graph reaches MorphTargetsBlock and " +
                        "binds the pin's zero-target fallback when its mesh " +
                        "carries no targets",
                ],
            ],
            "no morph targets from the assets, scene source, or node graphs",
            "src/loader-gltf/gltf-feature-registry.ts morph row: " +
                "anyPrimitive(targets.length > 0) -> gltf-feature-morph.js; " +
                "src/material/node/node-renderable.ts binds each compiled " +
                "MorphTargetsBlock to mesh morph buffers or getEmptyMorph; " +
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
            "BBLITE_GPU_INSTANCE_COLORS",
            "capability",
            emit.gpuInstanceColors,
            [
                [
                    has("mesh:thin-instance-colors"),
                    "scene source reached mesh:thin-instance-colors " +
                        "(a per-instance RGBA stream widens the instance " +
                        "vertex layout)",
                ],
            ],
            "no thin-instance colour stream",
            "src/mesh/thin-instance.ts setThinInstanceColors: the pin " +
                "appends its own per-instance colour lane to the instance " +
                "layout when a material reads it",
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
            "BBLITE_MATERIAL_METALLIC_REFLECTANCE_MAP",
            "capability",
            metallicReflectanceMap,
            [
                [
                    has("material:metallic-reflectance") &&
                        metallicReflectanceMap,
                    "scene source reached material:metallic-reflectance " +
                        "and a composed variant binds metallicReflectanceMap",
                ],
            ],
            "no composed PBR variant binds metallicReflectanceMap",
            "src/material/pbr/set-metallic-reflectance.ts; fragments/" +
                "metallic-reflectance-fragment.ts binds the optional " +
                "metallicReflectanceMap pair",
            [
                "render_capabilities.hpp",
                "material_texture_slots.hpp",
                "variant table",
            ],
        ),
        checkedRow(
            "BBLITE_MATERIAL_REFLECTANCE_MAP",
            "capability",
            reflectanceMap,
            [
                [
                    has("material:metallic-reflectance") &&
                        reflectanceMap,
                    "scene source reached material:metallic-reflectance " +
                        "and a composed variant binds reflectanceMap",
                ],
            ],
            "no composed PBR variant binds reflectanceMap",
            "src/material/pbr/set-metallic-reflectance.ts; fragments/" +
                "metallic-reflectance-fragment.ts binds the optional " +
                "reflectanceMap pair",
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
            "BBLITE_MATERIAL_SPEC_GLOSS",
            "capability",
            emit.specularGlossiness,
            [
                [
                    spec.specularGlossiness,
                    "an asset uses KHR_materials_pbrSpecularGlossiness",
                ],
            ],
            "no asset uses KHR_materials_pbrSpecularGlossiness",
            "src/loader-gltf/gltf-ext-spec-gloss.ts (registry row " +
                "KHR_materials_pbrSpecularGlossiness): the workflow " +
                "replacement has no scene half, so an asset is the only " +
                "way in",
            [
                "render_capabilities.hpp",
                "material_texture_slots.hpp",
                "variant table",
            ],
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
            "BBLITE_SHADOWS",
            "capability",
            shadows.reached,
            [
                [
                    has("shadow:pcf"),
                    "scene source reached shadow:pcf",
                ],
                [
                    has("shadow:esm"),
                    "scene source reached shadow:esm",
                ],
            ],
            "not reached",
            "src/shadow/pcf-spotlight-shadow-generator.ts",
            ["render_capabilities.hpp"],
        ),
        checkedRow(
            "BBLITE_SHADOWS_ESM",
            "capability",
            shadows.esm,
            [
                // A conjunction with the families that HAVE a caster
                // material view, which is what the define gates -- and all
                // three do: the Standard and PBR ones through their own
                // `esm-shadow-view.ts`, the node one as a second composed
                // module of the graph itself.
                [
                    has("shadow:esm") && standardVariantCount > 0,
                    "scene source reached shadow:esm and the scene " +
                        "composes Standard variants",
                ],
                [
                    has("shadow:esm") && variantCount > 0,
                    "scene source reached shadow:esm and the scene " +
                        "composes PBR variants",
                ],
                [
                    has("shadow:esm") &&
                        (nodeShadowReceiverCount > 0 ||
                            nodeEsmCasterCount > 0),
                    "scene source reached shadow:esm and a composed node " +
                        "graph receives or casts",
                ],
            ],
            has("shadow:esm")
                ? "reached shadow:esm but composes no material family"
                : "not reached",
            "src/shadow/esm-directional-shadow-generator.ts",
            ["render_capabilities.hpp"],
        ),
        checkedRow(
            "BBLITE_STANDARD_SHADOWS",
            "capability",
            shadows.standard,
            [
                // One reason, because the define is a CONJUNCTION: the
                // receiver fragment this port composes is the Standard
                // family's, so a scene reaching a generator with no
                // Standard variant compiles no shadow code at all.
                [
                    (has("shadow:pcf") || has("shadow:esm")) &&
                        standardVariantCount > 0,
                    "scene source reached a shadow generator and the scene " +
                        "composes Standard variants",
                ],
            ],
            shadows.reached
                ? "reached a shadow generator but composes no Standard " +
                    "variant"
                : "not reached",
            "src/material/standard/fragments/std-shadow-fragment.ts",
            ["render_capabilities.hpp"],
        ),
        checkedRow(
            "BBLITE_PBR_SHADOWS",
            "capability",
            shadows.pbr,
            [
                // The same conjunction for the other receiver family:
                // `createPbrShadowFragment` wraps the same pinned core, so a
                // scene reaching a generator with no PBR variant compiles
                // none of the PBR receiver's bind path.
                [
                    (has("shadow:pcf") || has("shadow:esm")) &&
                        variantCount > 0,
                    "scene source reached a shadow generator and the scene " +
                        "composes PBR variants",
                ],
            ],
            shadows.reached
                ? "reached a shadow generator but composes no PBR variant"
                : "not reached",
            "src/material/pbr/fragments/pbr-shadow-fragment.ts",
            ["render_capabilities.hpp"],
        ),
        // The engine's own option. `createEngine` refuses it without
        // `useHighPrecisionMatrix`, which gates the width every composed
        // matrix is stored at -- the frame and the width are two flags and
        // two rows. A plain row rather than a checked one: there is one
        // derivation here, and `checkedRow` over it would compare an
        // expression against itself.
        row(
            "BBLITE_FLOATING_ORIGIN",
            "capability",
            has("renderer:floating-origin"),
            has("renderer:floating-origin")
                ? "scene source created its engine with useFloatingOrigin"
                : "not reached",
            "src/large-world/floating-origin.ts",
            ["render_capabilities.hpp", "renderer plan"],
        ),
        checkedRow(
            "BBLITE_NODE_SHADOWS",
            "capability",
            shadows.node,
            [
                // The node family's own half. Unlike the two composed
                // families this is not "a generator plus a variant": a node
                // graph's receiver is bindings appended to its OWN group 1
                // and its caster is a second module of that same graph, so
                // what reaches it is a composed graph that carries one or
                // the other.
                [
                    (has("shadow:pcf") || has("shadow:esm")) &&
                        (nodeShadowReceiverCount > 0 ||
                            nodeEsmCasterCount > 0),
                    "scene source reached a shadow generator and a composed " +
                        "node graph receives or casts",
                ],
            ],
            shadows.reached
                ? "reached a shadow generator but no node graph receives " +
                    "or casts"
                : "not reached",
            "src/material/node/node-shadow.ts",
            ["render_capabilities.hpp"],
        ),
        checkedRow(
            "BBLITE_SHADOW_RECEIVERS",
            "capability",
            shadows.receivers,
            [
                // The generator half, which no material family owns: the
                // maps, samplers, receiver blocks and caster pass exist for
                // whichever family composed a receiver to sample them.
                [
                    (has("shadow:pcf") || has("shadow:esm")) &&
                        (standardVariantCount > 0 || variantCount > 0),
                    "scene source reached a shadow generator and the scene " +
                        "composes a receiver in some family",
                ],
                // The node family reaches the same generator half without
                // composing a variant of its own: its receiver appends to
                // the graph's group 1 and mixes by a per-mesh uniform, and
                // its caster is a second module of that graph.
                [
                    (has("shadow:pcf") || has("shadow:esm")) &&
                        (nodeShadowReceiverCount > 0 ||
                            nodeEsmCasterCount > 0),
                    "scene source reached a shadow generator and a composed " +
                        "node graph receives or casts",
                ],
            ],
            shadows.reached
                ? "reached a shadow generator but composes no receiver"
                : "not reached",
            "src/shader/fragments/shadow-fragment-core.ts",
            ["render_capabilities.hpp"],
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
        row(
            "BBLITE_STANDARD_VARIANTS",
            "capability",
            standardVariantCount > 0,
            standardVariantCount > 0
                ? `${standardVariantCount} Standard variant(s) composed ` +
                    "by the pin over the scene's .babylon and scene-code " +
                    "Standard materials"
                : "no Standard materials compose variants",
            "the pin's own composed Standard stages " +
                "(src/material/standard/standard-template.ts and its " +
                "fragments), emitted as standard_variants.hpp beside the " +
                "composed stages",
            ["render_capabilities.hpp", "variant table"],
        ),
        row(
            "BBLITE_NODE_VARIANTS",
            "capability",
            nodeVariantCount > 0,
            nodeVariantCount > 0
                ? `${nodeVariantCount} node graph(s) compiled by the ` +
                    "pin's own node-material emitter for this scene"
                : "no node materials compile graphs",
            "the pin's own node-material emitter " +
                "(src/material/node/node-material.ts " +
                "parseNodeMaterialFromSnippet), one module per graph, " +
                "emitted as node_variants.hpp beside the two stages each " +
                "deploys",
            ["render_capabilities.hpp", "variant table"],
        ),
        // The two derived defines. `render_capabilities.hpp` states each as
        // a preprocessor expression over the three counts above; the rows
        // derive the same disjunctions from the same emit options, so the
        // inventory names which family switched the shared machinery on.
        row(
            "BBLITE_PINNED_MATERIALS",
            "capability",
            variantCount > 0 ||
                standardVariantCount > 0 ||
                nodeVariantCount > 0,
            variantCount > 0 ||
                standardVariantCount > 0 ||
                nodeVariantCount > 0
                ? "derived: a composed family " +
                    `(${[
                        ...(variantCount > 0 ? ["PBR"] : []),
                        ...(standardVariantCount > 0 ? ["Standard"] : []),
                        ...(nodeVariantCount > 0 ? ["node"] : []),
                    ].join(", ")}) draws through the pin's own group scheme`
                : "no composed family reaches the pinned group scheme",
            "native-architecture: the derived define " +
                "`BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_VARIANTS > 0 " +
                "|| BBLITE_NODE_VARIANTS > 0` gates the shared per-pass " +
                "scene/lights frame state the three composed families bind",
            ["render_capabilities.hpp"],
        ),
        row(
            "BBLITE_PINNED_MATERIAL_VARIANTS",
            "capability",
            variantCount > 0 || standardVariantCount > 0,
            variantCount > 0 || standardVariantCount > 0
                ? "derived: a material family " +
                    `(${[
                        ...(variantCount > 0 ? ["PBR"] : []),
                        ...(standardVariantCount > 0 ? ["Standard"] : []),
                    ].join(", ")}) reaches the thin-instance arm and the ` +
                    "geometry contract"
                : "no material family composes variants",
            "native-architecture: the derived define " +
                "`BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_VARIANTS > 0` " +
                "gates the two material families' thin-instance arm and " +
                "geometry contract, which a node graph does not reach",
            ["render_capabilities.hpp"],
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
    const { emit, features } = inputs;
    const customShaderFamilies = emit.spriteCustomShaders
        .map((shader) => shader.family)
        .join(", ");
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
        checkedRow(
            "nodeVisibility",
            "emit-option",
            emit.nodeVisibility,
            [
                [
                    emit.gltfNodeVisibility,
                    "an asset uses KHR_node_visibility",
                ],
                [
                    features.includes("mesh:visible"),
                    "scene code writes mesh.visible",
                ],
            ],
            "no asset uses KHR_node_visibility and no scene code " +
                "writes mesh.visible",
            "src/scene/scene-node.ts visible?: boolean; " +
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
        checkedRow(
            "gpuInstanceColors",
            "emit-option",
            emit.gpuInstanceColors,
            [
                [
                    features.includes("mesh:thin-instance-colors"),
                    "scene source reached mesh:thin-instance-colors, so " +
                        "the instance vertex layout widens by the pin's " +
                        "colour lane",
                ],
            ],
            "no thin-instance colour stream",
            "src/mesh/thin-instance.ts setThinInstanceColors: the pin " +
                "appends its own per-instance colour lane to the instance " +
                "layout when a material reads it",
            ["render_capabilities.hpp"],
        ),
        row(
            "pinnedSkeletonPalette",
            "emit-option",
            emit.pinnedSkeletonPalette ?? false,
            (emit.pinnedSkeletonPalette ?? false)
                ? "the composed variants carry the pin's own skeleton " +
                    "mesh bit, so the bone palette rides its per-bone " +
                    "texture (which caps no joint count)"
                : "no composed variant carries the skeleton bit; a " +
                    "skinned asset would take the transcribed 64-matrix " +
                    "uniform palette",
            "src/loader-gltf/gltf-feature-skeleton.ts: the pin uploads " +
                "its bone palette as a per-bone texture; which transport " +
                "a scene takes is decided by whether its composed " +
                "variants carry the pinned skeleton mesh bit " +
                "(pinnedFeaturesCarrySkeleton over the renderable " +
                "mesh-feature table, cli.ts)",
            ["loader flag"],
        ),
        row(
            "spriteCustomShaders",
            "emit-option",
            emit.spriteCustomShaders.length > 0,
            emit.spriteCustomShaders.length > 0
                ? `${emit.spriteCustomShaders.length} scene-code custom ` +
                    "fragment(s) composed into the pin's own builder(s): " +
                    customShaderFamilies
                : "no scene-code sprite-family custom shaders",
            "src/sprite/sprite-custom-shader.ts makeCustomSpriteWgsl + " +
                "src/sprite/billboard-custom-shader.ts " +
                "makeCustomBillboardWgsl: the pin composes one custom " +
                "module per family from the same prologue with the " +
                "caller's fragment spliced in",
            ["deployed shaders"],
        ),
        row(
            "effects",
            "emit-option",
            emit.effects.length > 0,
            emit.effects.length > 0
                ? `${emit.effects.length} createEffectWrapper ` +
                    "descriptor(s), each composed as the pin's own " +
                    "fullscreen vertex stage plus the caller's fragment " +
                    "and deployed under both entry points"
                : "no effect wrappers",
            "src/effect/effect-renderer.ts createEffectWrapper " +
                "(DEFAULT_VERTEX_WGSL plus the caller's fragment); the " +
                "emitted effect_variants.hpp carries each descriptor's " +
                "uniform layout",
            ["deployed shaders"],
        ),
        row(
            "plainSpriteLayer",
            "emit-option",
            emit.plainSpriteLayer,
            emit.plainSpriteLayer
                ? "a scene-code layer draws the stock sprite program"
                : "every scene-code layer opts into a custom shader, so " +
                    "the stock fragment deploys only if a node-particle " +
                    "bridge needs it (the bridges answer for their own " +
                    "layers from the pin's pass table)",
            "src/sprite/sprite-pipeline.ts makeSpriteWgsl: the stock " +
                "fragment deploys only where a plain layer draws with it; " +
                "upstream-lower.ts ORs this option with the " +
                "node-particle-derived plain half",
            ["deployed shaders"],
        ),
        row(
            "plainBillboardSystem",
            "emit-option",
            emit.plainBillboardSystem,
            emit.plainBillboardSystem
                ? "a scene-code system draws the stock billboard program"
                : "every scene-code system opts into a custom shader, so " +
                    "the stock pair deploys only if a node-particle " +
                    "system needs it (mode 4's second pass draws the " +
                    "stock program over the same instances)",
            "src/sprite/billboard-pipeline.ts makeBillboardWgsl: the " +
                "stock pair deploys only where a plain system draws with " +
                "it; upstream-lower.ts ORs this option with the " +
                "node-particle-derived plain half",
            ["deployed shaders"],
        ),
    ];
}

function compositionRows(
    inputs: FeatureActivationInputs,
): FeatureActivationRow[] {
    const { composition, emit, specialization: spec, features } = inputs;
    const variantCount = (emit.pinnedVariants ?? []).length;
    const standardVariantCount = (emit.pinnedStandardVariants ?? []).length;
    const nodeVariantCount = (emit.nodeVariants ?? []).length;
    const taskCount = emit.geometryOutputTasks.length;
    const passCount = emit.postProcessTasks.length;
    const kinds = composition.lightKinds;
    // The two sprite-family halves compose independently; the row names
    // whichever this scene reached.
    const spriteFamilies = [
        ...(features.includes("renderer:sprite") ? ["2D sprite"] : []),
        ...(features.includes("sprite:billboard") ? ["billboard"] : []),
    ];
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
            composition.toneMappingStates.includes(true),
            [
                [
                    features.includes("environment:env"),
                    "the upstream .env loader enables tone mapping",
                ],
                [
                    inputs.assetJoinedFeatures.has("environment:ibl"),
                    "an asset-carried EXT_lights_image_based environment " +
                        "enables tone mapping",
                ],
                [
                    composition.mutableToneMappingEnabled,
                    "scene code can assign toneMappingEnabled at runtime, " +
                        "so both states are composed",
                ],
            ],
            "the reached loaders leave tone mapping off",
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
                    features.includes(
                        "material:pbr-linear-image-processing",
                    ),
                    "scene source reached linear PBR image processing",
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
        row(
            "post-process:stages",
            "composition",
            passCount > 0,
            passCount > 0
                ? `${passCount} post-process pass(es), composed by running ` +
                    `each effect's own factory: ${[
                        ...new Set(
                            emit.postProcessTasks.map(
                                (task) => task.intrinsic,
                            ),
                        ),
                    ].join(", ")}`
                : "no post-process passes",
            "src/frame-graph/post-process-task.ts getShaderModule, over " +
                "each effect module's own _shader record",
            ["deployed shaders"],
        ),
        row(
            "standard-variants:stages",
            "composition",
            standardVariantCount > 0,
            standardVariantCount > 0
                ? `${standardVariantCount} Standard variant(s) composed ` +
                    "by the pin over the scene's .babylon and scene-code " +
                    "Standard materials, deployed under the variant-std- " +
                    "stems beside standard_variants.hpp"
                : "no Standard materials compose variants",
            "src/material/standard/standard-template.ts and its " +
                "fragments, composed per (material, mesh bits, scene arm) " +
                "by the pin's own Standard composer",
            ["variant table", "deployed shaders"],
        ),
        row(
            "node-variants:stages",
            "composition",
            nodeVariantCount > 0,
            nodeVariantCount > 0
                ? `${nodeVariantCount} node graph(s) compiled by the ` +
                    "pin's own node-material emitter, one module per " +
                    "graph deployed under both entry points beside " +
                    "node_variants.hpp"
                : "no node materials compile graphs",
            "src/material/node/node-material.ts " +
                "parseNodeMaterialFromSnippet + the pin's own " +
                "node-material emitter; each module keeps the pin's own " +
                "group scheme under the node- stems",
            ["variant table", "deployed shaders"],
        ),
        row(
            "splat:stages",
            "composition",
            features.includes("loader:splat"),
            features.includes("loader:splat")
                ? "the pin's own Gaussian-splat module, split at its two " +
                    "entry points (splat.vert/splat.frag)"
                : "no splat assets",
            "src/mesh/GaussianSplatting/gaussian-splatting-pipeline.ts " +
                "WGSL: the pin ships the module text itself; nothing " +
                "composes",
            ["deployed shaders"],
        ),
        row(
            "splat:shader-fragments",
            "composition",
            emit.splatShaderModule !== undefined,
            emit.splatShaderModule !== undefined
                ? "the pin's own applyGsFragments spliced this scene's " +
                    "GsShaderFragment plugins into the splat module and " +
                    "ran its field-name mangler over the result"
                : "no loadSplat call passed shader fragments",
            "src/mesh/GaussianSplatting/gaussian-splatting-pipeline.ts " +
                "applyGsFragments: upstream inlines its mangling table so " +
                "a plugin-free scene tree-shakes it away, and the call " +
                "site passing the list is the opt-in",
            ["deployed shaders"],
        ),
        row(
            "shader-material:programs",
            "composition",
            emit.shaderPrograms.length > 0,
            emit.shaderPrograms.length > 0
                ? `${emit.shaderPrograms.length} shader-material ` +
                    `program(s) composed into deployed stages: ${
                        emit.shaderPrograms
                            .map((program) => program.name)
                            .join(", ")
                    }`
                : "no shader materials (the line family, a mesh plus a " +
                    "ShaderMaterial, rides this list too)",
            "src/material/shader/shader-material.ts: each program's WGSL " +
                "composes through the scene-local variant table, and the " +
                "line system's own stages travel as one of these programs",
            ["deployed shaders"],
        ),
        row(
            "sprite-billboard:stages",
            "composition",
            spriteFamilies.length > 0,
            spriteFamilies.length > 0
                ? "the pinned sprite-family builders' text reconstructed " +
                    `for the reached permutations (${
                        spriteFamilies.join(", ")
                    })`
                : "no sprite or billboard renderer",
            "src/sprite/sprite-pipeline.ts makeSpriteWgsl + " +
                "src/sprite/billboard-pipeline.ts makeBillboardWgsl: the " +
                "pin's own builders, reconstructed per reached " +
                "permutation (stock, custom, uv-scroll, cutout, " +
                "axis-locked, particle Multiply)",
            ["deployed shaders"],
        ),
        row(
            "effect-wrapper:stages",
            "composition",
            emit.effects.length > 0,
            emit.effects.length > 0
                ? `${emit.effects.length} composed effect module(s): the ` +
                    "pin's fullscreen vertex stage concatenated with each " +
                    "caller's fragment, one module per descriptor"
                : "no effect wrappers compose stages",
            "src/effect/effect-renderer.ts createEffectWrapper: " +
                "DEFAULT_VERTEX_WGSL plus the caller's fragment, in one " +
                "module carrying both entry points",
            ["deployed shaders"],
        ),
    ];
}

/**
 * One variant-key creation-order row. The counts are the per-creation
 * `gltfAssetsBefore` values the compose layer uses to place scene rows among
 * glTF rows. An interleaved input records the composition path; an ordered
 * input records that the former refusal condition was checked and absent.
 */
function interleaveRow(
    name: string,
    kind: "mesh" | "PBR material",
    counts: readonly number[],
    gltfAssetCount: number,
    upstreamProvenance: string,
): FeatureActivationRow {
    const interleaved = counts.some(
        (before) => before !== gltfAssetCount,
    );
    if (interleaved) {
        return row(
            name,
            "composition",
            true,
            `composed ${counts.length} scene-code ${kind} creation(s) ` +
                `through ${gltfAssetCount} glTF load(s) in their recorded ` +
                "handle order",
            upstreamProvenance,
            ["variant table"],
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
    const { specialization: spec, emit, features, gltfAssetNames } = inputs;
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
                        "pinned loader's node-order walk while scene-code " +
                        "builders append where reached; recordSceneMesh in " +
                        "compiler.ts records gltfAssetsBefore per creation, " +
                        "and compose-pipeline.ts interleaves those rows); " +
                        "the pin composes shaders at run time and keys no " +
                        "static table",
                ),
                interleaveRow(
                    "refusal:scene-material-interleave",
                    "PBR material",
                    inputs.interleave.scenePbrMaterialGltfAssetsBefore,
                    inputs.interleave.gltfAssetCount,
                    "native-architecture: the generated variant table " +
                        "keys materials by creation-order handle (each " +
                        "glTF load and scene-code creation appends where " +
                        "reached; compilePbrMaterialOptions records " +
                        "gltfAssetsBefore per creation, and " +
                        "compose-pipeline.ts maps those rows to absolute " +
                        "handles); the pin composes per-material at run " +
                        "time and keys no static table",
                ),
            ]),
        row(
            "refusal:physics-shapes",
            "generation-refusal",
            false,
            features.includes("physics:aggregate")
                ? "checked: every reached physics aggregate names one of " +
                    "the primitive shapes " +
                    "createPrimitivePhysicsShapeHandle builds"
                : "no physics aggregates to check",
            "src/physics/havok.ts createPrimitivePhysicsShapeHandle: the " +
                "reached slice is the four mesh-free primitives; " +
                "CONVEX_HULL, MESH, CONTAINER and HEIGHTFIELD refuse at " +
                "the intrinsic (src/compiler/intrinsics/physics.ts) rather " +
                "than at the pin's own throw inside createPhysicsAggregate",
            gate,
        ),
        row(
            "refusal:ktx-format",
            "generation-refusal",
            false,
            features.includes("texture:compressed")
                ? "checked: every loadKtxTexture2D call lists a " +
                    "block-compression suffix, so generation packages the " +
                    "candidate the validated D3D12 adapter would pick"
                : "no compressed-texture loads to check",
            "src/texture/compressed-formats.ts: the pin keeps every " +
                "suffix whose device feature the adapter reports and falls " +
                "back to the base image; generation makes the same choice " +
                "once over texture-compression-bc " +
                "(src/compiler/compressed-texture.ts), and a call listing " +
                "no block-compression suffix refuses rather than packaging " +
                "the pin's fallback image — a different texture the golden " +
                "does not render",
            gate,
        ),
        row(
            "refusal:splat-format",
            "generation-refusal",
            false,
            features.includes("loader:splat")
                ? "checked: every splat asset parsed as plain PLY or the " +
                    ".splat row layout"
                : "no splat assets to check",
            "src/loader-splat/splat-data.ts: a compressed or " +
                "spherical-harmonic PLY needs the pin's second parser and " +
                "its own SH pipeline, and a .sog/.spz needs a ZIP/gzip " +
                "decoder before either; the packager refuses both rather " +
                "than emitting a row buffer the renderer would draw wrong " +
                "(src/splat-packager.ts)",
            gate,
        ),
        row(
            "refusal:node-particle-live-set",
            "generation-refusal",
            false,
            (emit.nodeParticles ?? []).length > 0
                ? `checked ${(emit.nodeParticles ?? []).length} frozen ` +
                    "node-particle system(s): every registered one holds " +
                    "updateSpeed 0 with a further step measured as the " +
                    "identity, and every one carries an unflipped texture"
                : "no frozen node-particle systems to check",
            "src/particle/particle-scene.ts registerNodeParticleSet " +
                "installs the pin's per-frame animate+sync callback, which " +
                "one frozen state answers only when a further step is the " +
                "identity; a live set (updateSpeed != 0 or a step that " +
                "moves particles), a texture-less system, or a " +
                "flipped-upload texture block refuses at generation " +
                "(src/lowering/node-particle-lowerer.ts assertBakeable)",
            gate,
        ),
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
