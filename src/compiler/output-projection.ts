import type { Feature } from "./types.js";
import { reachesShadowGenerator } from "../shadow-capabilities.js";

/**
 * The output projection: the feature→sources authority and the renders
 * that turn a finished compilation into its two emitted artifacts,
 * `main.cpp` and `features.cmake`. Everything here is a pure function of
 * the values the entry orchestrator hands over — the walk itself lives
 * in `compiler.ts`.
 */

export const featureSources: Record<Feature, string[]> = {
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
    "core": ["src/pal.cpp"],
    "backend:sdl": ["src/pal_sdl.cpp"],
    "camera:arc-rotate": [],
    "camera:default": [],
    "camera:free": [],
    "camera:orthographic": [],
    "camera:view-projection": [],
    "environment:ibl": [],
    "environment:env": [],
    "environment:hdr": [],
    "environment:dds": [],
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
    "loader:splat-sh": [],
    "loader:splat-spz": [],
    "material:pbr": [],
    "material:clearcoat": [],
    "material:sheen": [],
    "material:sheen-albedo-scaling": [],
    "material:clearcoat-f0-remap": [],
    "material:pbr-gamma-albedo": [],
    "material:iridescence": [],
    "material:lightmap": [],
    "material:anisotropy": [],
    "material:metallic-reflectance": [],
    "material:tracking": [],
    "material:emissive": [],
    "material:no-color-view": [],
    "material:grid": [],
    "material:node": [],
    "material:shader": [],
    "material:standard": [],
    "material:standard-diffuse-render-texture": [],
    "material:standard-diffuse-pixels-texture": [],
    "material:standard-diffuse-solid-texture": [],
    "material:standard-diffuse-file-texture": [],
    "material:standard-uv-transform": [],
    "material:plugins": [],
    "material:plugin-index": [],
    "material:plugin-textures": [],
    "material:standard-emissive-render-texture": [],
    "material:standard-emissive-file-texture": [],
    "material:standard-vertex-colors": [],
    "mesh:box": [],
    "mesh:csg": [],
    "mesh:from-data": [],
    "mesh:update-positions": [],
    "mesh:ground": [],
    "mesh:ground-heightmap": [],
    "mesh:lines": [],
    "mesh:morph-targets": [],
    "mesh:visible": [],
    "mesh:pickable": [],
    "mesh:vat": [],
    "mesh:vat-instances": [],
    "mesh:transform-node": [],
    "mesh:mirrored": [],
    "mesh:plane": [],
    "mesh:sphere": [],
    "mesh:thin-instances": [],
    "mesh:thin-instance-colors": [],
    "mesh:thin-instances-dynamic": [],
    "mesh:thin-instance-gpu-culling": [],
    "mesh:cylinder": [],
    "mesh:disc": [],
    "mesh:extrude": [],
    "mesh:polyhedron": [],
    "mesh:ribbon": [],
    "mesh:torus": [],
    "mesh:torus-knot": [],
    "mesh:tube": [],
    "mesh:parenting": [],
    "mesh:geometry-access": [],
    "math:normalize-vec3": [],
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
    "gizmo:rotation": [],
    "gizmo:scale": [],
    "gizmo:bounding-box": [],
    "scene:remove": [],
    "shadow:esm": [],
    "shadow:pcf": [],
    "shadow:pcf-directional": [],
    "shadow:csm": [],
    "shadow:task": [],
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
    // The trigger drain rides in the same generated physics module the
    // world already brings, and in the same PAL translation unit; what
    // the feature records is which pinned module a scene reached.
    "physics:trigger": [],
    // Multi-region floating origin. Like the trigger drain it rides in the
    // physics module the world already brings and in the same PAL
    // translation unit; what the feature records is that a scene opted the
    // world into region-local simulation.
    "physics:floating-origin": [],
    // The Detour/Recast surface the pin calls on the module
    // createNavigationPluginAsync loads -- the same third-party-
    // library-behind-a-fixed-entry-point boundary the physics PAL
    // draws.
    "navigation:recast": ["src/pal_navigation_recast.cpp"],
    // The tile-cache arm lives in the same translation unit the recast
    // feature already brings; what the feature adds is the library behind
    // it and the half of that file the guard compiles.
    "navigation:tile-cache": [],
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
    "audio:oscillator": [],
    "audio:biquad-filter": [],
    "audio:stereo-panner": [],
    "sprite:billboard-axis-locked": [],
    "sprite:billboard-cutout": [],
    "sprite:billboard-custom-shader": [],
    "renderer:sprite": ["src/pal_sdl_gpu_sprite.cpp"],
    // The scene-less fullscreen-effect path: an EffectRenderer is its own
    // rendering context on the engine, exactly as a SpriteRenderer is, so a
    // scene registering one and no SceneContext compiles no scene renderer
    // and draws from this translation unit instead.
    "renderer:effect": ["src/pal_sdl_gpu_effect.cpp"],
    // Render-target allocation is shared by scene and scene-less task graphs;
    // the implementation is generated and therefore adds no PAL source.
    "frame-graph:resources": [],
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
    "renderer:high-precision-matrix": [],
    "renderer:floating-origin": [],
    // Dialogs, selected-path reads, and atomic downloads are isolated in
    // their own PAL unit. Blob/object-URL values stay header-only.
    "browser:file": ["src/pal_file.cpp"],
    // The generated scene talks only to bblite's retained UI IR. RmlUi and
    // its SDL_GPU adapter remain an optional PAL implementation detail.
    "ui:rml": ["src/pal_ui_rml.cpp"],
    // Selects the SVG-enabled pinned RmlUi artifact; rendering remains in the
    // same UI PAL translation unit.
    "ui:inline-svg": [],
    // The JSON bridge is header-only: the writer, the dynamic parsed value
    // and the codecs generated beside the records they serialize. What the
    // feature brings is the parser library CMake links behind it.
    "data:json": [],
    // Web Storage's platform half. `localStorage` has no Babylon
    // declaration behind it, so like the frame conductor's timers it is a
    // PAL service -- and its own translation unit, so every other
    // executable carries neither the filesystem code nor the preference
    // directory it would create.
    "storage:local": ["src/pal_storage.cpp"],
};

export const featureOrder = Object.keys(featureSources) as Feature[];

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
): string {
    const sourceLines = runtimeSources.map((source) => `    "\${BBLITE_NATIVE_ROOT}/${source}"`).join("\n");
    const generatedSourceLines = generatedSources
        .map((source) => `    "\${BBLITE_GENERATED_DIR}/${source}"`)
        .join("\n");
    const featureLines = features.map((feature) => `    "${feature}"`).join("\n");
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
`;
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
    const counts = new Map<string, number>();
    for (const line of body) {
        for (const name of line.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
            counts.set(name, (counts.get(name) ?? 0) + 1);
        }
    }
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
export interface MainCppProjection {
    features: readonly Feature[];
    jsDataReached: boolean;
    /** Whether the entry body itself decodes an image (drawn-atlas records). */
    imageDecodeReached: boolean;
    jsRandomReached: boolean;
    throwReached: boolean;
    postProcessCompositeCount: number;
    renderDataPreamble: () => string;
    nativeFunctionPrototypes: readonly string[];
    nativeFunctionDefinitions: readonly string[];
    staticNativeDeclarations: readonly string[];
    /** Whether the scene reaches the voxel save/load file boundary. */
    voxelFileStorageReached: boolean;
    /** The emitted entry-body lines; the render marks unused locals in place. */
    body: string[];
}

export function renderMainCpp(projection: MainCppProjection): string {
    const {
        features,
        jsDataReached,
        imageDecodeReached,
        jsRandomReached,
        throwReached,
        postProcessCompositeCount,
        renderDataPreamble,
        nativeFunctionPrototypes,
        nativeFunctionDefinitions,
        staticNativeDeclarations,
        voxelFileStorageReached,
        body,
    } = projection;
    // Scene code names a blend descriptor and a layer at the call
    // site, so the factories the sprite lowerer emits have to be visible
    // to main.cpp.
    const spriteInclude = features.includes("sprite:2d")
        ? "#include <bblite/upstream/sprite_layer.hpp>\n"
        : "";
    const billboardInclude = features.includes(
        "sprite:billboard",
    )
        ? "#include <bblite/upstream/billboard_system.hpp>\n"
        : "";
    // The frame stepper: scene code creates a manager, plays
    // animations on it and steps it, all by name.
    const spriteAnimationInclude = features.includes(
        "sprite:animation",
    )
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
        ? "#include <bblite/upstream/physics.hpp>\n"
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
        ? "#include <bblite/pal_audio.hpp>\n"
        : "";
    // Keyed on this translation unit's own decode emission, not on
    // `texture:file`: the texture loaders decode inside their own generated
    // TUs, so only a drawn-atlas record puts `bbl::pal::decode_image` here.
    const imageInclude = imageDecodeReached
        ? "#include <bblite/pal_image.hpp>\n"
        : "";
    const uiInclude = features.includes("ui:rml")
        ? "#include <bblite/pal_ui.hpp>\n"
        : "";
    // The shadow family: main.cpp names the pinned generator defaults its
    // factory call resolves an omitted option to.
    const shadowInclude = reachesShadowGenerator(features)
        ? "#include <bblite/upstream/pinned_shadow.hpp>\n"
        : "";
    const cameraMathInclude =
        features.some((feature) =>
            feature.startsWith("camera:"),
        )
            ? "#include <bblite/upstream/camera_math.hpp>\n"
            : "";
    const cameraProjectionInclude = features.includes(
        "camera:view-projection",
    )
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
    const jsDataInclude =
        (jsDataReached ? "#include <bblite/js_data.hpp>\n" : "") +
        (features.includes("data:json")
            ? "#include <bblite/js_json.hpp>\n"
            : "") +
        (features.includes("storage:local")
            ? "#include <bblite/js_storage.hpp>\n"
            : "") +
        (features.includes("browser:file")
            ? "#include <bblite/js_file.hpp>\n"
            : "") +
        (voxelFileStorageReached
            ? "#include <bblite/js_voxel_file.hpp>\n"
            : "");
    // A composite's factory is generated, so the scene calls it by a name
    // only its own generated header declares.
    const postProcessInclude =
        postProcessCompositeCount > 0
            ? "#include <bblite/upstream/frame_graph_post_process.hpp>\n"
            : "";
    const preambleSections: string[] = [];
    if (staticNativeDeclarations.length > 0) {
        preambleSections.push(
            staticNativeDeclarations.join("\n"),
        );
    }
    const dataPreamble =
        renderDataPreamble();
    if (dataPreamble.length > 0) {
        preambleSections.push(dataPreamble);
    }
    if (nativeFunctionPrototypes.length > 0) {
        preambleSections.push(
            [
                "namespace bblscene {",
                "",
                ...nativeFunctionPrototypes,
                "",
                ...nativeFunctionDefinitions,
                "}  // namespace bblscene",
            ].join("\n"),
        );
    }
    // The body is finished, so a local nothing referenced is now
    // decidable — mark those, and only those.
    markUnreferencedLocals(body);
    const preamble =
        preambleSections.length > 0
            ? `\n${preambleSections.join("\n\n")}\n`
            : "";
    const seedRandom = jsRandomReached
        ? "        bbl::js::seed_random(1u);\n"
        : "";
    return `// Generated by bblitec. Do not edit.
#include <bblite/runtime.hpp>
#include <bblite/pal.hpp>
${jsDataInclude}${cameraMathInclude}${cameraProjectionInclude}${clusteredInclude}${normalizeVec3Include}${spriteInclude}${billboardInclude}${spriteAnimationInclude}${nodeParticleInclude}${physicsInclude}${navigationInclude}${audioInclude}${imageInclude}${uiInclude}${shadowInclude}${postProcessInclude}
#include <cmath>
#include <exception>
#include <iostream>${throwReached ? "\n#include <stdexcept>" : ""}
${preamble}
int main() {
    try {
${seedRandom}${body.join("\n")}
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "Babylon Lite native error: " << error.what() << '\\n';
        return 1;
    }
}
`;
}
