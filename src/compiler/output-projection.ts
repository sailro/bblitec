import { EmissionMap } from "./emission-transaction.js";
import type { Feature } from "./types.js";
import { reachesShadowGenerator } from "../shadow-capabilities.js";
import { reachedGeneratedSources } from "../generated-sources.js";
import {
    renderSourceUnits,
    sceneDeclarations,
    type UnitDeclaration,
    type ApplicationCpp,
    type NativeDefinition,
    type NativeFunctionDefinition,
    type DataPreamble,
} from "./source-units.js";
import {
    outlineFunctionBody,
    outlineFunctionDefinition,
    type OutlinedSegment,
} from "./body-outlining.js";

/**
 * The output projection: the feature→sources authority and the renders
 * that turn a finished compilation into application C++ and
 * `features.cmake`. Everything here is a pure function of
 * the values the entry orchestrator hands over — the walk itself lives
 * in `compiler.ts`.
 */

export const featureSources: Record<Feature, string[]> = {
    "text:data": [],
    "text:layout": ["src/pal_text_layout.cpp"],
    "text:weight": [],
    "text:renderable": [],
    "renderer:text": ["src/pal_sdl_gpu_sprite.cpp"],
    "animation:gltf-groups": [],
    "animation:property": [],
    "animation:property-blending": [],
    "animation:weight-fades": [],
    "animation:managed-groups": [],
    "animation:gltf-blending": [],
    "animation:gltf-additive": [],
    "animation:gltf-group-time": [],
    "animation:gltf-group-speed": [],
    "animation:gltf-group-mask": [],
    core: ["src/pal.cpp"],
    "platform:workers": [],
    "platform:http": ["src/pal_http.cpp"],
    "platform:packaged-fetch": [],
    "platform:window": ["src/pal_window_realm.cpp", "src/pal_media_query.cpp"],
    "backend:sdl": ["src/pal_sdl.cpp", "src/pal_image.cpp"],
    "engine:device-recovery": [],
    "engine:dispose": [],
    "engine:gpu-retirement": [],
    "engine:gpu-task-timing": [],
    "compute:storage-texture": [],
    "compute:texture-mipmaps": [],
    "compute:storage-buffer": [],
    "compute:storage-readback": [],
    "compute:task": [],
    "compute:task-execution": [],
    "compute:frame-graph": [],
    "compute:shader": [],
    "compute:dispatch": [],
    "compute:bindings": [],
    "compute:one-shot": [],
    "compute:binding-decl": [],
    "compute:uniform-buffer": [],
    "compute:uniform-layout": [],
    "compute:uniform-writer": [],
    "compute:uniform-arena": [],
    // Browser Gamepad polling maps to SDL's standard gamepad API in the
    // platform translation unit already selected by backend:sdl.
    "input:gamepad": [],
    "input:dom": [],
    "camera:arc-rotate": [],
    "camera:default": [],
    "camera:free": [],
    "camera:configurable-free": [],
    "camera:geospatial": [],
    "camera:orthographic": [],
    "camera:world-matrix-version": [],
    "camera:view-projection": [],
    "environment:ibl": [],
    "environment:env": [],
    "environment:hdr": [],
    "environment:dds": [],
    "environment:sky-atmosphere": [],
    "light:parameters": [],
    "environment:procedural-sky": [],
    "background:ground": [],
    "background:dds-environment": [],
    "background:skybox": [],
    "background:image-skybox": [],
    "background:solid-skybox": [],
    "light:hemispheric": [],
    "light:directional": [],
    "light:point": [],
    "light:spot": [],
    "light:included-meshes": [],
    "light:clustered": [],
    "loader:babylon": [],
    "loader:gltf": [],
    "loader:gltf-variants": [],
    "loader:gltf-cameras": [],
    "loader:gltf-bone-control": [],
    "loader:splat": [],
    "loader:splat-bake": [],
    "loader:splat-data": [],
    "loader:splat-sh": [],
    "loader:splat-sog": [],
    "loader:splat-spz": [],
    "material:pbr": [],
    "material:source-texture-read": [],
    "material:clearcoat": [],
    "material:sheen": [],
    "material:sheen-albedo-scaling": [],
    "material:clearcoat-f0-remap": [],
    "material:pbr-gamma-albedo": [],
    "material:iridescence": [],
    "material:lightmap": [],
    "material:local-cubemap": [],
    "renderer:surface": [],
    "material:anisotropy": [],
    "material:metallic-reflectance": [],
    "material:tracking": [],
    "material:emissive": [],
    "material:no-color-view": [],
    "material:node": [],
    "material:node-inputs": [],
    "material:shader": [],
    // Storage buffers are owned by the common runtime record and uploaded by
    // whichever already-reached scene renderer is selected.
    "material:shader-storage": [],
    "material:standard": [],
    "material:standard-diffuse-render-texture": [],
    "material:standard-diffuse-pixels-texture": [],
    "material:standard-diffuse-solid-texture": [],
    "material:standard-diffuse-file-texture": [],
    "material:standard-uv-transform": [],
    "material:plugins": [],
    "material:pbr-plugin-vertex-data": [],
    "material:plugin-index": [],
    "material:plugin-textures": [],
    "material:standard-emissive-render-texture": [],
    "material:standard-emissive-file-texture": [],
    "material:standard-lightmap": [],
    "material:standard-vertex-colors": [],
    "material:standard-skeleton": [],
    "material:standard-uv-offset": [],
    "mesh:vertex-alpha": [],
    "mesh:box": [],
    "mesh:csg": [],
    "mesh:csg2": [],
    "mesh:from-data": [],
    "mesh:update-positions": [],
    "mesh:resize-geometry": [],
    "mesh:ground": [],
    "mesh:ground-heightmap": [],
    "mesh:lines": [],
    "mesh:morph-targets": [],
    "mesh:visible": [],
    "mesh:pickable": [],
    "mesh:vat": [],
    "mesh:vat-instances": [],
    "mesh:skeleton": [],
    "mesh:transform-node": [],
    "mesh:mirrored": [],
    "mesh:plane": [],
    "mesh:sphere": [],
    "mesh:thin-instances": [],
    "mesh:thin-instance-colors": [],
    "mesh:thin-instances-dynamic": [],
    "mesh:thin-instance-gpu-culling": [],
    "mesh:cylinder": [],
    "mesh:capsule": [],
    "mesh:disc": [],
    "mesh:extrude": [],
    "mesh:polyhedron": [],
    "mesh:ribbon": [],
    "mesh:torus": [],
    "mesh:torus-knot": [],
    "mesh:tube": [],
    "mesh:parenting": [],
    "mesh:clone": [],
    "mesh:geometry-access": [],
    "math:normalize-vec3": [],
    "math:quaternion": [],
    "math:mat4-create": [],
    "math:mat4-invert": [],
    "math:look-direction": [],
    "picking:gpu": [],
    "picking:detailed": [],
    "picking:billboard": [],
    "gizmo:utility-layer": [],
    "gizmo:camera": [],
    "gizmo:light": [],
    "gizmo:axis-drag": [],
    "gizmo:axis-scale": [],
    "gizmo:plane-drag": [],
    "gizmo:plane-rotation": [],
    "gizmo:position": [],
    "gizmo:pointer-drag": [],
    "gizmo:rotation": [],
    "gizmo:scale": [],
    "gizmo:bounding-box": [],
    "scene:remove": [],
    "scene:node-transforms": [],
    "shadow:esm": [],
    "shadow:pcf": [],
    "shadow:pcf-directional": [],
    "shadow:csm": [],
    "shadow:task": [],
    "shadow:morph-bounds": [],
    "sprite:2d": [],
    "sprite:2d-depth-host": [],
    "sprite:2d-y-sort": [],
    "sprite:uv-scroll": [],
    "sprite:custom-shader": [],
    "texture:file": [],
    "texture:compressed": [],
    "texture:pixels": [],
    "sprite:billboard": [],
    // A frozen node-particle system draws through the billboard family; the
    // simulation itself is baked at generation, so nothing of the pin's own
    // particle runtime compiles.
    "particle:node": [],
    // The rigid-body solver. `havok.ts` itself is Babylon behaviour and is
    // generated like every other pinned module; what this translation unit
    // carries is the `HP_*` surface the pin calls on the `hknp` module it
    // is handed -- a third-party library behind a fixed entry-point list,
    // which is the same role SDL plays and so the same boundary.
    "physics:world": ["src/pal_physics_bullet.cpp"],
    "physics:aggregate": [],
    "physics:queries": [],
    "physics:character-controller": [],
    "physics:container": [],
    "physics:viewer": ["src/pal_physics_debug.cpp"],
    "physics:constraints": [],
    "physics:heightfield": [],
    // The trigger drain rides in the same generated physics module the
    // world already brings, and in the same PAL translation unit; what
    // the feature records is which pinned module a scene reached.
    "physics:trigger": [],
    // Multi-region floating origin. Like the trigger drain it rides in the
    // physics module the world already brings and in the same PAL
    // translation unit; what the feature records is that a scene opted the
    // world into region-local simulation.
    "physics:floating-origin": [],
    "physics:thin-instances": [],
    // The Detour/Recast surface the pin calls on the module
    // createNavigationPluginAsync loads -- the same third-party-
    // library-behind-a-fixed-entry-point boundary the physics PAL
    // draws.
    "navigation:recast": ["src/pal_navigation_recast.cpp"],
    // The tile-cache arm lives in the same translation unit the recast
    // feature already brings; what the feature adds is the library behind
    // it and the half of that file the guard compiles.
    "navigation:tile-cache": [],
    "navigation:crowd": [],
    // The stepper is generated rather than a PAL source, so like every
    // other lowered family it brings no file of its own here.
    "sprite:animation": [],
    // The Web Audio surface the pinned `src/audio/*.ts` calls on the
    // browser -- `AudioContext`, `GainNode`, `AudioParam` and their
    // siblings. Same boundary as the two above: a third-party engine
    // (LabSound, itself a fork of WebKit's WebAudio) behind a fixed
    // entry-point list, with SDL3 as its platform stream. Everything
    // Babylon does with those nodes stays generated.
    "audio:engine": ["src/pal_audio_labsound.cpp"],
    "audio:buffer-source": [],
    "audio:decoded-buffer": [],
    "audio:decode-wav": [],
    "audio:decode-wv": [],
    "audio:decode-mpc": [],
    "audio:decode-flac": [],
    "audio:decode-mp3": [],
    "audio:decode-opus": [],
    "audio:decode-ogg": [],
    "audio:oscillator": [],
    "audio:biquad-filter": [],
    "audio:stereo-panner": [],
    "sprite:billboard-axis-locked": [],
    "sprite:billboard-cutout": [],
    "sprite:billboard-custom-shader": [],
    "renderer:sprite": ["src/pal_sdl_gpu_sprite.cpp"],
    "renderer:canvas": ["src/pal_sdl_gpu_sprite.cpp"],
    // The scene-less fullscreen-effect path: an EffectRenderer is its own
    // rendering context on the engine, exactly as a SpriteRenderer is, so a
    // scene registering one and no SceneContext compiles no scene renderer
    // and draws from this translation unit instead.
    "renderer:effect": ["src/pal_sdl_gpu_effect.cpp"],
    // Render-target allocation is shared by scene and scene-less task graphs;
    // the implementation is generated and therefore adds no PAL source.
    "frame-graph:resources": [],
    "frame-graph:surface-target": [],
    // A standalone FrameGraphContext has its own task-only driver. It does
    // not pull the scene renderer, camera math, mesh upload, or image loader.
    "renderer:frame-graph": ["src/pal_sdl_gpu_frame_graph.cpp"],
    "effect:wrapper": [],
    "effect:task": [],
    "renderer:scene": ["src/pal_sdl_gpu.cpp"],
    "renderer:transmission": [],
    "material:pbr-linear-image-processing": [],
    "renderer:fog": [],
    "renderer:clip-plane": [],
    "renderer:geometry-output": [],
    "renderer:post-process": [],
    "renderer:screen-space": [],
    "flow-graph:interactivity": [],
    "renderer:high-precision-matrix": [],
    "renderer:floating-origin": [],
    // Dialogs, selected-path reads, and atomic downloads are isolated in
    // their own PAL unit. Blob/object-URL values stay header-only.
    "browser:file": ["src/pal_file.cpp"],
    // The generated scene talks only to bblite's retained UI IR. RmlUi and
    // its SDL_GPU adapter remain an optional PAL implementation detail.
    "ui:rml": ["src/pal_ui_rml.cpp", "src/pal_image.cpp"],
    // Selects the SVG-enabled pinned RmlUi artifact; rendering remains in the
    // same UI PAL translation unit.
    "ui:inline-svg": [],
    // The JSON bridge is header-only: the writer, the dynamic parsed value
    // and the codecs generated beside the records they serialize. What the
    // feature brings is the parser library CMake links behind it.
    "data:json": [],
    "data:locale": ["src/pal_locale.cpp"],
    // Web Storage's platform half. `localStorage` has no Babylon
    // declaration behind it, so like the frame conductor's timers it is a
    // PAL service -- and its own translation unit, so every other
    // executable carries neither the filesystem code nor the preference
    // directory it would create.
    "storage:local": ["src/pal_storage.cpp"],
};

export const featureOrder = Object.keys(featureSources) as Feature[];

/** A manifest feature name as the `Feature` it must be, refusing any other. */
export function asFeatures(names: readonly string[]): Feature[] {
    return names.map((name) => {
        const feature = featureOrder.find((candidate) => candidate === name);
        if (feature === undefined)
            throw new Error(`Unknown runtime feature '${name}'.`);
        return feature;
    });
}

/**
 * The features a reached feature brings with it, listed once for both
 * places a feature enters the set: the compiler's reach and the asset join.
 * Each implied feature is reached before the one that implies it, with the
 * same site, and its own implications follow in turn.
 */
const featureImplications: Partial<Record<Feature, readonly Feature[]>> = {
    "compute:task-execution": [
        "compute:task",
        "compute:dispatch",
        "compute:shader",
        "compute:bindings",
    ],
    "environment:procedural-sky": [
        "environment:sky-atmosphere",
        "environment:ibl",
        "compute:texture-mipmaps",
        "platform:packaged-fetch",
    ],
    "compute:texture-mipmaps": [
        "compute:storage-texture",
        "compute:task",
        "compute:frame-graph",
    ],
    "compute:frame-graph": ["compute:task-execution"],
    "compute:storage-readback": ["compute:storage-buffer"],
    "compute:bindings": [
        "compute:binding-decl",
        "compute:shader",
        "compute:storage-texture",
        "compute:uniform-buffer",
    ],
    "compute:one-shot": ["compute:task"],
};

export function impliedFeatures(feature: Feature): readonly Feature[] {
    return [
        // Every raw Web Audio node and asset feature is implemented by the
        // one engine PAL and is reachable only through one of its contexts,
        // even when the creating call lives in a deferred platform callback
        // lowered after another audio callback first reached a node family.
        ...(feature.startsWith("audio:") && feature !== "audio:engine"
            ? (["audio:engine"] as const)
            : []),
        ...(featureImplications[feature] ?? []),
    ];
}

/**
 * Everything a feature list selects in the native build, from the feature
 * tables: the PAL translation units (two features can name the same unit,
 * and CMake must list it once), the generated sources, and the
 * `features.cmake` that lists both beside the application units. Whoever
 * finishes a feature list -- the compiler, the asset join -- projects it
 * through here, so a feature is declared the same way wherever it entered.
 */
export function projectFeatures(
    features: readonly Feature[],
    applicationSources: readonly string[],
): { runtimeSources: string[]; generatedSources: string[]; cmake: string } {
    const runtimeSources = [
        ...new Set(features.flatMap((feature) => featureSources[feature])),
    ];
    const generatedSources = reachedGeneratedSources(features);
    return {
        runtimeSources,
        generatedSources,
        cmake: renderFeaturesCmake(
            features,
            runtimeSources,
            generatedSources,
            applicationSources,
        ),
    };
}

/**
 * The features.cmake render, a pure function of the three lists so a caller
 * that augments the manifest's features after compilation (the CLI joins the
 * assets' own KHR_lights_punctual kinds there) re-renders the same authority
 * instead of patching the string.
 */
export function renderFeaturesCmake(
    features: readonly Feature[],
    runtimeSources: readonly string[],
    generatedSources: readonly string[],
    applicationSources: readonly string[] = ["main.cpp"],
): string {
    const sourceLines = runtimeSources
        .map((source) => `    "\${BBLITE_NATIVE_ROOT}/${source}"`)
        .join("\n");
    const generatedSourceLines = generatedSources
        .map((source) => `    "\${BBLITE_GENERATED_DIR}/${source}"`)
        .join("\n");
    const featureLines = features
        .map((feature) => `    "${feature}"`)
        .join("\n");
    return `# Generated by bblitec. Included by native/CMakeLists.txt.
set(BBLITE_RUNTIME_FEATURES
${featureLines}
)

set(BBLITE_RUNTIME_SOURCES
${sourceLines}
)

set(BBLITE_GENERATED_SOURCES
${generatedSourceLines}
)

set(BBLITE_APPLICATION_SOURCES
${applicationSources.map((source) => `    "\${BBLITE_GENERATED_DIR}/${source}"`).join("\n")}
)
`;
}

function nativeIdentifierCounts(body: readonly string[]): Map<string, number> {
    const counts = new EmissionMap<string, number>();
    for (const line of body) {
        for (const name of line.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
            counts.set(name, (counts.get(name) ?? 0) + 1);
        }
    }
    return counts;
}

/** Instrumentation erasure can leave a pure, unread performance.now initializer.
 * A live clock read remains in the entry and the PAL stage guard rejects it. */
export function constructorEntryBody(body: readonly string[]): string[] {
    const counts = nativeIdentifierCounts(body);
    const deadClock =
        /^\s*(?:\[\[maybe_unused\]\] )?(?:auto|double) ([A-Za-z_][A-Za-z0-9_]*) = bbl::pal::performance_milliseconds\(\);\s*$/;
    return body.map((block) =>
        block
            .split("\n")
            .filter((line) => {
                const match = deadClock.exec(line);
                return !match || counts.get(match[1]!) !== 1;
            })
            .join("\n"),
    );
}

/** Names for the functions outlined out of one application's bodies. */
function outlinedNames(): () => string {
    let next = 0;
    return () => `bbl_outlined_${next++}`;
}

function markUnreferencedLocals(body: string[]): void {
    // Initialized locals, and the empty `std::optional<...>` storage a
    // materialized module predeclares for a nullable resource: a browser-only
    // element whose writers the bake erased is declared and never read.
    //
    // `static` is part of the declaration because a local the entry body
    // binds AFTER `startEngine` is hoisted to static storage for the
    // deferred continuation that reads it — and a binding whose only later
    // reader is a barrier (`await splat.firstSortReady`) is exactly the
    // shape this pass exists for. Attributes precede the specifier, so the
    // insertion point is the same one.
    const declaration =
        /^(\s*)((?:static )?(?:(?:auto|double) |std::optional<[^;=]*> ))([A-Za-z_][A-Za-z0-9_]*)(?: = |;)/;
    const counts = nativeIdentifierCounts(body);
    for (const [index, block] of body.entries()) {
        // Deferred callbacks are captured as one body entry containing
        // several physical lines. Inspect each of those lines so a local
        // whose only browser-instrumentation reader was erased is treated
        // exactly like the same declaration in the outer entry body.
        body[index] = block
            .split("\n")
            .map((line) => {
                const match = declaration.exec(line);
                return match && counts.get(match[3]!) === 1
                    ? `${match[1]}[[maybe_unused]] ${line.trimStart()}`
                    : line;
            })
            .join("\n");
    }
}

/**
 * What the main.cpp render reads off the finished walk. The two function
 * members keep their calls at the exact point in the render where the
 * orchestrator used to make them: the data-type preamble renders after
 * the include decisions, and the local marking runs only once the body
 * is complete.
 */
interface MainCppProjection {
    source: string;
    workers?: {
        namespace: string | undefined;
        declarations: string;
        windowOptions?: string;
        hasEngine?: boolean;
    };
    features: readonly Feature[];
    jsDataReached: boolean;
    /** Whether the entry body itself decodes an image (drawn-atlas records). */
    imageDecodeReached: boolean;
    runtimeMeshProfiles?: boolean;
    jsRandomReached: boolean;
    audioSessionReached?: boolean;
    continuationStorageReached?: boolean;
    /** A reached constructed promise can end a synchronous activation at its await. */
    pendingActivations?: boolean;
    throwReached: boolean;
    postProcessCompositeCount: number;
    screenSpaceTaskCount: number;
    renderDataPreamble: () => DataPreamble;
    nativeFunctions: readonly NativeFunctionDefinition[];
    staticNativeDeclarations: readonly string[];
    /** The emitted entry-body lines; the render marks unused locals in place. */
    body: string[];
    /** The admitted entry statements before the sole top-level startEngine. */
    physicsDebugConstructionBody?: readonly string[];
    /** The native type of an emitted local, when the compiler registered one. */
    bindingType: (name: string) => string | undefined;
}

export function renderMainCpp(projection: MainCppProjection): ApplicationCpp {
    const {
        features,
        jsDataReached,
        imageDecodeReached,
        jsRandomReached,
        throwReached,
        postProcessCompositeCount,
        screenSpaceTaskCount,
        renderDataPreamble,
        staticNativeDeclarations,
    } = projection;
    // The body is finished, so a local nothing referenced is now
    // decidable — mark those, and only those.
    markUnreferencedLocals(projection.body);
    // A large entry body moves its statements to functions that other
    // translation units compile; a worker realm's entry keeps its own.
    const allocateName = outlinedNames();
    const outlined = projection.workers
        ? { lines: projection.body, segments: [] }
        : outlineFunctionBody({
              lines: projection.body,
              parameters: projection.audioSessionReached
                  ? [
                        {
                            name: "bbl_audio_session",
                            type: "std::shared_ptr<bbl::pal::AudioSession>",
                        },
                    ]
                  : [],
              bindingType: projection.bindingType,
              allocateName,
          });
    const body = outlined.lines;
    const segmentsOf = (
        source: string,
        segments: readonly OutlinedSegment[],
    ): NativeFunctionDefinition[] =>
        segments.map((segment) => ({
            kind: "function",
            source,
            prototype: segment.prototype,
            lines: segment.lines,
        }));
    // So does a large function definition, into its own source's units.
    const nativeFunctions: readonly NativeFunctionDefinition[] = [
        ...projection.nativeFunctions.flatMap((fn) => {
            if (fn.kind !== "function") return [fn];
            const definition = outlineFunctionDefinition({
                lines: fn.lines,
                bindingType: projection.bindingType,
                allocateName,
            });
            return [
                { ...fn, lines: definition.lines },
                ...segmentsOf(fn.source, definition.segments),
            ];
        }),
        ...segmentsOf(projection.source, outlined.segments),
    ];
    const nativeFunctionPrototypes = nativeFunctions.flatMap((fn) =>
        fn.prototype === undefined ? [] : [fn.prototype],
    );
    const nativeFunctionDefinitions = nativeFunctions.flatMap(({ lines }) => [
        ...lines,
        "",
    ]);
    // Scene code names a blend descriptor and a layer at the call
    // site, so the factories the sprite lowerer emits have to be visible
    // to main.cpp.
    const spriteInclude = features.includes("sprite:2d")
        ? "#include <bblite/upstream/sprite_layer.hpp>\n"
        : "";
    const textInclude =
        features.includes("text:data") || features.includes("text:renderable")
            ? "#include <bblite/upstream_text.hpp>\n#include <bblite/upstream/text_data.hpp>\n" +
              (features.includes("text:layout")
                  ? "#include <bblite/upstream_text_update.hpp>\n"
                  : "") +
              (features.includes("text:weight")
                  ? "#include <bblite/upstream_text_weight.hpp>\n"
                  : "") +
              (features.includes("renderer:text")
                  ? "#include <bblite/upstream_text_renderer.hpp>\n"
                  : "")
            : "";
    const billboardInclude = features.includes("sprite:billboard")
        ? "#include <bblite/upstream/billboard_system.hpp>\n"
        : "";
    // The frame stepper: scene code creates a manager, plays
    // animations on it and steps it, all by name.
    const spriteAnimationInclude = features.includes("sprite:animation")
        ? "#include <bblite/upstream/sprite_animation.hpp>\n"
        : "";
    // The frozen node-particle bridge: main.cpp calls the two folded
    // pinned functions by name.
    const nodeParticleInclude = features.includes("particle:node")
        ? "#include <bblite/upstream/node_particles.hpp>\n"
        : "";
    // The rigid-body family: main.cpp calls the generated world and
    // aggregate factories by name.
    const physicsInclude = features.includes("physics:world")
        ? "#include <bblite/upstream/physics.hpp>\n" +
          (features.includes("physics:character-controller")
              ? "#include <bblite/upstream/character_controller.hpp>\n"
              : "")
        : "";
    // The navigation family: main.cpp reaches the generated plugin,
    // navmesh build, debug geometry and raycast by name.
    const navigationInclude = features.includes("navigation:recast")
        ? "#include <bblite/upstream/navigation.hpp>\n"
        : "";
    // The audio family: main.cpp reaches the PAL's Web Audio surface
    // directly for now -- the pinned engine/bus/sub-graph modules are not
    // lowered yet (TODO), so the intrinsics emit `bbl::pal::audio_*`.
    const audioInclude = features.includes("audio:engine")
        ? "#include <bblite/pal_audio.hpp>\n" +
          (projection.workers ? "#include <bblite/pal_audio_async.hpp>\n" : "")
        : "";
    // Keyed on this translation unit's own decode emission, not on
    // `texture:file`: the texture loaders decode inside their own generated
    // TUs, so only a drawn-atlas record puts `bbl::pal::decode_image` here.
    const imageInclude = imageDecodeReached
        ? "#include <bblite/pal_image.hpp>\n"
        : "";
    const bakedMeshInclude =
        features.includes("mesh:csg") || features.includes("mesh:csg2")
            ? "#include <bblite/baked_mesh.hpp>\n"
            : "";
    const uiInclude = features.includes("ui:rml")
        ? "#include <bblite/pal_ui.hpp>\n"
        : "";
    // The shadow family: main.cpp names the pinned generator defaults its
    // factory call resolves an omitted option to.
    const shadowInclude = reachesShadowGenerator(features)
        ? "#include <bblite/upstream/pinned_shadow.hpp>\n"
        : "";
    const cameraMathInclude = features.some((feature) =>
        feature.startsWith("camera:"),
    )
        ? "#include <bblite/upstream/camera_math.hpp>\n"
        : "";
    // The geospatial factory, its orientation setter and the pinned
    // recompute both reach live in their own generated translation unit.
    const cameraGeospatialInclude = features.includes("camera:geospatial")
        ? "#include <bblite/upstream/camera_geospatial.hpp>\n"
        : "";
    const cameraProjectionInclude =
        (projection.runtimeMeshProfiles &&
            features.includes("renderer:scene")) ||
        features.includes("camera:view-projection")
            ? "#include <bblite/upstream/renderer_plan.hpp>\n"
            : "";
    // The clustered light field's four entry points are declared by its
    // own generated header, because the container it hands back is a
    // generated record.
    const clusteredInclude = features.includes("light:clustered")
        ? "#include <bblite/upstream/clustered_light.hpp>\n"
        : "";
    // The pin's tuple normalization, which scene code calls by name.
    const normalizeVec3Include = features.includes("math:normalize-vec3")
        ? "#include <bblite/upstream/pinned_normalize_vec3.hpp>\n"
        : "";
    const lookDirectionInclude = features.includes("math:look-direction")
        ? "#include <bblite/upstream/pinned_look_direction.hpp>\n"
        : "";
    const mat4InvertInclude = features.includes("math:mat4-invert")
        ? "#include <bblite/upstream/pinned_mat4_invert.hpp>\n"
        : "";
    const jsDataInclude =
        (features.includes("math:quaternion")
            ? "#include <bblite/upstream/pinned_quaternion.hpp>\n"
            : "") +
        (features.includes("math:mat4-create")
            ? "#include <bblite/upstream/pinned_mat4_create.hpp>\n"
            : "") +
        (jsDataReached || jsRandomReached
            ? "#include <bblite/js_data.hpp>\n"
            : "") +
        (features.includes("material:node-inputs")
            ? "#include <bblite/node_material.hpp>\n"
            : "") +
        (features.includes("data:json")
            ? "#include <bblite/js_json.hpp>\n"
            : "") +
        (features.includes("data:locale")
            ? "#include <bblite/pal_locale.hpp>\n"
            : "") +
        (features.includes("platform:http")
            ? "#include <bblite/pal_http.hpp>\n"
            : "") +
        (features.includes("platform:packaged-fetch")
            ? "#include <bblite/pal_packaged_fetch.hpp>\n"
            : "") +
        (features.includes("storage:local")
            ? "#include <bblite/js_storage.hpp>\n"
            : "") +
        (features.includes("browser:file")
            ? "#include <bblite/js_file.hpp>\n"
            : "");
    // A composite's factory is generated, so the scene calls it by a name
    // only its own generated header declares; a screen-space task's is the
    // same shape under its own header.
    const postProcessInclude =
        (postProcessCompositeCount > 0
            ? "#include <bblite/upstream/frame_graph_post_process.hpp>\n"
            : "") +
        (screenSpaceTaskCount > 0
            ? "#include <bblite/upstream/frame_graph_screen_space.hpp>\n"
            : "");
    const preambleSections: string[] = [];
    if (staticNativeDeclarations.length > 0) {
        preambleSections.push(staticNativeDeclarations.join("\n"));
    }
    const dataPreamble = renderDataPreamble();
    // Without a renderer no draw reads composition profiles.
    const meshProfileFallback =
        projection.runtimeMeshProfiles && !features.includes("renderer:scene")
            ? `namespace bbl::upstream {
inline void begin_scene_mesh_profile(Engine&, std::uint32_t) {}
}`
            : "";
    if (meshProfileFallback) preambleSections.push(meshProfileFallback);
    if (dataPreamble.standalone.length > 0) {
        preambleSections.push(dataPreamble.standalone);
    }
    if (
        nativeFunctionPrototypes.length > 0 ||
        nativeFunctionDefinitions.length > 0
    ) {
        preambleSections.push(
            [
                "namespace bblscene {",
                "",
                ...nativeFunctionPrototypes,
                ...(nativeFunctionPrototypes.length > 0 ? [""] : []),
                ...nativeFunctionDefinitions,
                "}  // namespace bblscene",
            ].join("\n"),
        );
    }
    const preamble =
        preambleSections.length > 0
            ? `\n${preambleSections.join("\n\n")}\n`
            : "";
    const seedRandom = jsRandomReached
        ? "        bbl::js::seed_random(1u);\n"
        : "";
    const workerInclude = projection.workers
        ? "#include <bblite/pal_worker.hpp>\n#include <bblite/js_promise_all.hpp>\n#include <bblite/js_binding.hpp>\n#include <bblite/pal_canvas.hpp>\n" +
          (features.includes("platform:window")
              ? "#include <bblite/pal_window_realm.hpp>\n"
              : "") +
          (projection.workers.hasEngine || features.includes("backend:sdl")
              ? "#include <bblite/pal_async_engine.hpp>\n"
              : "")
        : "";
    const workerNamespace = projection.workers?.namespace;
    // A module's initialization returns before timers and native completions.
    // Its direct audio contexts live until the owning realm is torn down.
    const audioSession = projection.audioSessionReached
        ? "        auto bbl_audio_session = std::make_shared<bbl::pal::AudioSession>();\n" +
          (projection.workers
              ? "        bbl::pal::EventLoop::current().defer_cleanup([bbl_audio_session] { static_cast<void>(bbl_audio_session); });\n"
              : "")
        : "";
    const entryBody = `${audioSession}${seedRandom}${body.join("\n")}`;
    const workerEntry = workerNamespace
        ? `void initialize([[maybe_unused]] bbl::pal::WorkerRealm& realm) {\n${entryBody}\n}\n`
        : projection.workers?.windowOptions
          ? `int main() {\n    return bbl::pal::run_window_application([]([[maybe_unused]] bbl::pal::WorkerRealm& realm) {\n${entryBody}\n    }, ${projection.workers.windowOptions});\n}\n`
          : projection.workers
            ? `int main() {\n    try {\n        const bbl::js::RealmScope state;\n        bbl::pal::EventLoop loop;\n        bbl::pal::WorkerRealm realm(loop);\n        loop.run([&] {\n${entryBody}\n        });\n        return 0;\n    } catch (...) {\n        return bbl::report_uncaught_error(std::current_exception());\n    }\n}\n`
            : undefined;
    const includes = `// Generated by bblitec. Do not edit.
#include <bblite/runtime.hpp>
${(
    [
        ["compute:storage-texture", "pal_compute_storage_texture"],
        ["engine:gpu-task-timing", "pal_gpu_task_timing"],
        ["compute:texture-mipmaps", "pal_compute_texture_mipmaps"],
        ["environment:procedural-sky", "pal_procedural_sky_environment"],
        ["environment:sky-atmosphere", "upstream/procedural_sky_atmosphere"],
        ["light:parameters", "upstream/light_parameters"],
        ["compute:storage-buffer", "pal_gpu_storage_buffer"],
        ["compute:storage-readback", "pal_gpu_storage_readback"],
        ["compute:binding-decl", "pal_compute_binding"],
        ["compute:shader", "pal_compute_shader"],
        ["compute:dispatch", "pal_compute_dispatch"],
        ["compute:bindings", "pal_compute_bindings"],
        ["compute:one-shot", "pal_compute_one_shot"],
        ["compute:task", "pal_compute_task"],
        ["compute:task-execution", "pal_compute_task_execution"],
        ["compute:frame-graph", "pal_compute_frame_graph"],
        ["compute:uniform-arena", "pal_compute_uniform_arena"],
        ["compute:uniform-writer", "pal_compute_uniform_writer"],
        ["compute:uniform-layout", "pal_compute_uniform"],
        ["compute:uniform-buffer", "pal_uniform_buffer"],
    ] satisfies [Feature, string][]
)
    .filter(([feature]) => features.includes(feature))
    .map(([, header]) => `#include <bblite/${header}.hpp>\n`)
    .join("")}\
${projection.continuationStorageReached ? "#include <bblite/continuation_storage.hpp>\n" : ""}${projection.pendingActivations ? "#include <bblite/js_synchronous_promise.hpp>\n" : ""}#include <bblite/pal.hpp>
${features.includes("input:dom") ? "#include <bblite/pal_dom_events.hpp>\n" : ""}${workerInclude}${textInclude}${jsDataInclude}${cameraMathInclude}${cameraGeospatialInclude}${cameraProjectionInclude}${clusteredInclude}${normalizeVec3Include}${lookDirectionInclude}${mat4InvertInclude}${spriteInclude}${billboardInclude}${spriteAnimationInclude}${nodeParticleInclude}${physicsInclude}${navigationInclude}${audioInclude}${imageInclude}${bakedMeshInclude}${uiInclude}${shadowInclude}${postProcessInclude}
#include <bblite/uncaught_error.hpp>
#include <cmath>
#include <exception>
#include <iostream>${throwReached ? "\n#include <stdexcept>" : ""}
`;
    const finish = (entry: string): ApplicationCpp => {
        const declarations = projection.workers?.declarations ?? "";
        const standaloneBody = `${preamble}${entry}`;
        const cpp =
            includes +
            declarations +
            (workerNamespace
                ? `\nnamespace ${workerNamespace} {\n${standaloneBody}\n}\n`
                : standaloneBody);
        const definitions: NativeDefinition[] = [...dataPreamble.definitions];
        for (const fn of nativeFunctions) {
            if (fn.kind === "function")
                definitions.push({
                    source: fn.source,
                    definition: fn.lines.join("\n"),
                });
        }
        const shared: UnitDeclaration[] = [
            ...staticNativeDeclarations.map((declaration) => ({
                scene: false,
                text: `inline ${declaration}`,
            })),
            ...(meshProfileFallback
                ? [{ scene: false, text: meshProfileFallback }]
                : []),
            ...sceneDeclarations(dataPreamble.shared),
            ...nativeFunctionPrototypes.map((prototype) => ({
                scene: true,
                text: prototype,
            })),
        ];
        return renderSourceUnits({
            source: projection.source,
            realm: workerNamespace,
            includes: includes + declarations + "\n",
            declarations: shared,
            definitions,
            templates: nativeFunctions.flatMap((fn) =>
                fn.kind === "template"
                    ? [{ name: fn.name, definition: fn.lines.join("\n") }]
                    : [],
            ),
            entry,
            cpp,
        });
    };
    if (workerEntry) return finish(`\n${workerEntry}`);
    let extraction = "";
    if (projection.physicsDebugConstructionBody) {
        const construction = constructorEntryBody(
            projection.physicsDebugConstructionBody,
        );
        markUnreferencedLocals(construction);
        extraction = `\n#include <bblite/pal_physics_debug.hpp>\n#include <string_view>\n
static void extract_physics_constructor_inputs(const char* output_path) {
    bbl::pal::PhysicsDebugExtractionScope extraction;
    {
${seedRandom}${construction.join("\n")}
    }
    extraction.write(output_path);
}\n`;
    }
    return finish(`${extraction}
int main(${extraction ? "int argc, char** argv" : ""}) {
    const bbl::js::CollectOnExit collect_on_exit;
    try {
${
    extraction
        ? `        if (argc == 3 && std::string_view(argv[1]) == "--physics-constructor-inputs") {
            extract_physics_constructor_inputs(argv[2]);
            return 0;
        }\n`
        : ""
}\
${projection.audioSessionReached ? "        auto bbl_audio_session = std::make_shared<bbl::pal::AudioSession>();\n" : ""}${seedRandom}${body.join("\n")}
        return 0;
    }${projection.pendingActivations ? ' catch (const bbl::js::PendingActivation&) {\n        std::cerr << "Babylon Lite native error: the entry awaited a constructed promise still pending, which the synchronous lowering cannot resume.\\n";\n        return 1;\n    }' : ""} catch (...) {
        return bbl::report_uncaught_error(std::current_exception());
    }
}
`);
}
