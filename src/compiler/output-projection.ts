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
    "environment:ibl": [],
    "environment:env": [],
    "environment:hdr": [],
    "environment:dds": [],
    "background:ground": [],
    "background:skybox": [],
    "background:image-skybox": [],
    "background:solid-skybox": [],
    "light:hemispheric": [],
    "light:directional": [],
    "light:point": [],
    "light:spot": [],
    "loader:babylon": [],
    "loader:gltf": [],
    "loader:gltf-variants": [],
    "loader:gltf-cameras": [],
    "loader:splat": [],
    "material:pbr": [],
    "material:clearcoat": [],
    "material:sheen": [],
    "material:sheen-albedo-scaling": [],
    "material:clearcoat-f0-remap": [],
    "material:pbr-gamma-albedo": [],
    "material:iridescence": [],
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
    "material:standard-diffuse-file-texture": [],
    "material:standard-uv-transform": [],
    "material:standard-emissive-render-texture": [],
    "material:standard-emissive-file-texture": [],
    "material:standard-vertex-colors": [],
    "mesh:box": [],
    "mesh:from-data": [],
    "mesh:ground": [],
    "mesh:ground-heightmap": [],
    "mesh:lines": [],
    "mesh:morph-targets": [],
    "mesh:plane": [],
    "mesh:sphere": [],
    "mesh:thin-instances": [],
    "mesh:thin-instance-colors": [],
    "mesh:thin-instances-dynamic": [],
    "mesh:torus": [],
    "mesh:tube": [],
    "scene:remove": [],
    "shadow:esm": [],
    "shadow:pcf": [],
    "shadow:task": [],
    "sprite:2d": [],
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
    // The Detour/Recast surface the pin calls on the module
    // createNavigationPluginAsync loads -- the same third-party-
    // library-behind-a-fixed-entry-point boundary the physics PAL
    // draws.
    "navigation:recast": ["src/pal_navigation_recast.cpp"],
    // The Web Audio surface the pinned `src/audio/*.ts` calls on the
    // browser -- `AudioContext`, `GainNode`, `AudioParam` and their
    // siblings. Same boundary as the two above: a third-party engine
    // (LabSound, itself a fork of WebKit's WebAudio) behind a fixed
    // entry-point list, with SDL3 as its platform stream. Everything
    // Babylon does with those nodes stays generated.
    "audio:engine": ["src/pal_audio_labsound.cpp"],
    "sprite:billboard-axis-locked": [],
    "sprite:billboard-cutout": [],
    "sprite:billboard-custom-shader": [],
    "renderer:sprite": ["src/pal_sdl_gpu_sprite.cpp"],
    // The scene-less fullscreen-effect path: an EffectRenderer is its own
    // rendering context on the engine, exactly as a SpriteRenderer is, so a
    // scene registering one and no SceneContext compiles no scene renderer
    // and draws from this translation unit instead.
    "renderer:effect": ["src/pal_sdl_gpu_effect.cpp"],
    "effect:wrapper": [],
    "effect:task": [],
    "renderer:pbr": ["src/pal_sdl_gpu.cpp"],
    "renderer:transmission": [],
    "renderer:fog": [],
    "renderer:geometry-output": [],
    "renderer:post-process": [],
    "renderer:floating-origin": [],
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
    const declaration =
        /^(\s*)((?:auto|double) )([A-Za-z_][A-Za-z0-9_]*) = /;
    const counts = new Map<string, number>();
    for (const line of body) {
        for (const name of line.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
            counts.set(name, (counts.get(name) ?? 0) + 1);
        }
    }
    for (const [index, line] of body.entries()) {
        const match = declaration.exec(line);
        if (!match || counts.get(match[3]!) !== 1) continue;
        body[index] =
            `${match[1]}[[maybe_unused]] ${line.trimStart()}`;
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
    jsRandomReached: boolean;
    throwReached: boolean;
    postProcessCompositeCount: number;
    renderDataPreamble: () => string;
    nativeFunctionPrototypes: readonly string[];
    nativeFunctionDefinitions: readonly string[];
    /** The emitted entry-body lines; the render marks unused locals in place. */
    body: string[];
}

export function renderMainCpp(projection: MainCppProjection): string {
    const {
        features,
        jsDataReached,
        jsRandomReached,
        throwReached,
        postProcessCompositeCount,
        renderDataPreamble,
        nativeFunctionPrototypes,
        nativeFunctionDefinitions,
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
    const jsDataInclude = jsDataReached
        ? "#include <bblite/js_data.hpp>\n"
        : "";
    // A composite's factory is generated, so the scene calls it by a name
    // only its own generated header declares.
    const postProcessInclude =
        postProcessCompositeCount > 0
            ? "#include <bblite/upstream/frame_graph_post_process.hpp>\n"
            : "";
    const preambleSections: string[] = [];
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
${jsDataInclude}${cameraMathInclude}${spriteInclude}${billboardInclude}${nodeParticleInclude}${physicsInclude}${navigationInclude}${audioInclude}${shadowInclude}${postProcessInclude}
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
