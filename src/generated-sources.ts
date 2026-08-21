// The single authority for which generated native sources a feature set
// reaches.
//
// Two places used to hold this mapping as parallel if-chains: the
// compiler's manifest/CMake projection and the upstream lowerer's
// emission sequence. Every feature that produces a source had to be added
// to both, and forgetting one produced a missing-file configure error at
// best or a source written but never compiled at worst. The table is the
// membership authority; the emitters in `upstream-lower.ts` are checked
// against it in both directions at generation time, so a disagreement is
// a loud failure instead of a silent drift.
//
// Row order is the manifest order (`manifest.generatedSources`, pinned by
// the compiler tests) and, since the emitter loop follows the same table,
// the emission order.
import type { Feature } from "./compiler/types.js";

export interface GeneratedSourceRule {
    source: string;
    /** Reached when ANY listed feature is present; empty means always. */
    features: readonly Feature[];
}

export const generatedSourceRules: readonly GeneratedSourceRule[] = [
    { source: "upstream/src/engine.cpp", features: [] },
    { source: "upstream/src/scene_core.cpp", features: [] },
    {
        source: "upstream/src/animation_property.cpp",
        features: ["animation:property"],
    },
    {
        source: "upstream/src/animation_group.cpp",
        features: ["animation:gltf-groups"],
    },
    {
        source: "upstream/src/camera_arc_rotate.cpp",
        features: [
            "camera:arc-rotate",
            "camera:default",
            "camera:free",
        ],
    },
    {
        source: "upstream/src/camera_controls.cpp",
        features: [
            "camera:arc-rotate",
            "camera:default",
            "camera:free",
        ],
    },
    {
        source: "upstream/src/camera_free.cpp",
        features: ["camera:free"],
    },
    {
        source: "upstream/src/camera_default.cpp",
        features: ["camera:default"],
    },
    {
        source: "upstream/src/camera_orthographic.cpp",
        features: ["camera:orthographic"],
    },
    {
        source: "upstream/src/env_parse.cpp",
        features: ["environment:env"],
    },
    {
        source: "upstream/src/environment.cpp",
        features: ["environment:env"],
    },
    {
        source: "upstream/src/environment_hdr.cpp",
        features: ["environment:hdr"],
    },
    {
        source: "upstream/src/environment_dds.cpp",
        features: ["environment:dds"],
    },
    {
        source: "upstream/src/light_matrix.cpp",
        features: [
            "light:hemispheric",
            "light:directional",
            "light:spot",
            "light:point",
        ],
    },
    {
        source: "upstream/src/light_hemispheric.cpp",
        features: ["light:hemispheric"],
    },
    {
        source: "upstream/src/light_directional.cpp",
        features: ["light:directional"],
    },
    {
        source: "upstream/src/light_point.cpp",
        features: ["light:point"],
    },
    {
        source: "upstream/src/light_spot.cpp",
        features: ["light:spot"],
    },
    {
        source: "upstream/src/image_skybox.cpp",
        features: ["background:image-skybox"],
    },
    {
        source: "upstream/src/gltf_glb_parser.cpp",
        features: ["loader:gltf"],
    },
    {
        source: "upstream/src/gltf_loader.cpp",
        features: ["loader:gltf"],
    },
    {
        source: "upstream/src/babylon_loader.cpp",
        features: ["loader:babylon"],
    },
    {
        source: "upstream/src/sprite_2d.cpp",
        features: ["sprite:2d"],
    },
    {
        source: "upstream/src/billboard_system.cpp",
        features: ["sprite:billboard"],
    },
    {
        source: "upstream/src/node_particles.cpp",
        features: ["particle:node"],
    },
    {
        source: "upstream/src/renderer_plan.cpp",
        features: ["renderer:pbr"],
    },
    {
        source: "upstream/src/frame_graph_geometry.cpp",
        features: ["renderer:geometry-output"],
    },
    {
        source: "upstream/src/frame_graph_post_process.cpp",
        features: ["renderer:post-process"],
    },
    {
        source: "upstream/src/material_pbr.cpp",
        features: ["material:pbr"],
    },
    {
        source: "upstream/src/material_views.cpp",
        features: ["material:no-color-view"],
    },
    {
        source: "upstream/src/splat_geometry.cpp",
        features: ["loader:splat"],
    },
    {
        source: "upstream/src/splat_sort.cpp",
        features: ["loader:splat"],
    },
    {
        source: "upstream/src/splat_loader.cpp",
        features: ["loader:splat"],
    },
    {
        source: "upstream/src/material_render_textures.cpp",
        features: [
            "material:standard-diffuse-render-texture",
            "material:standard-emissive-render-texture",
        ],
    },
    {
        source: "upstream/src/material_grid.cpp",
        features: ["material:grid"],
    },
    {
        source: "upstream/src/texture_file.cpp",
        features: ["texture:file"],
    },
    {
        source: "upstream/src/texture_pixels.cpp",
        features: ["texture:pixels"],
    },
    {
        source: "upstream/src/material_shader.cpp",
        features: ["material:shader"],
    },
    {
        source: "upstream/src/effect_renderer.cpp",
        features: ["effect:wrapper"],
    },
    {
        source: "upstream/src/material_node.cpp",
        features: ["material:node"],
    },
    {
        source: "upstream/src/material_standard.cpp",
        features: ["material:standard"],
    },
    {
        source: "upstream/src/mesh_factories.cpp",
        features: [
            "mesh:box",
            "mesh:from-data",
            "mesh:ground",
            "mesh:morph-targets",
            "mesh:plane",
            "mesh:sphere",
            "mesh:thin-instances",
            "mesh:thin-instances-dynamic",
            "mesh:torus",
        ],
    },
];

export function reachedGeneratedSources(
    features: readonly string[],
): string[] {
    return generatedSourceRules
        .filter(
            (rule) =>
                rule.features.length === 0 ||
                rule.features.some((feature) =>
                    features.includes(feature),
                ),
        )
        .map((rule) => rule.source);
}

/**
 * The shared sprite-atlas header, which is the sprite module's but is
 * included by every generated source that resolves a frame through it:
 * `sprite_2d.cpp`, `billboard_system.cpp` and `node_particles.cpp`.
 *
 * Stated here rather than at the two places that act on it, because it is
 * the same question the table above answers for sources — which features
 * bring a generated file into existence — and a header whose reach drifts
 * from its includers fails in the native build with nothing pointing back.
 */
export const sharedSpriteAtlasHeaderFeatures = [
    "sprite:2d",
    "sprite:billboard",
] as const;

export function reachesSharedSpriteAtlasHeader(
    features: readonly string[],
): boolean {
    return sharedSpriteAtlasHeaderFeatures.some((feature) =>
        features.includes(feature),
    );
}
