/**
 * The feature-keyed native macros, and the headers generation writes them to.
 *
 * Each macro is 1 when the scene's final feature list (the compiler's reach
 * plus the asset join) satisfies its row and 0 otherwise. Every macro gets
 * a header of its own, `bblite/features/<name>.hpp`, and every native or
 * generated file that tests one includes that header: a translation unit's
 * inputs are then exactly the activation facts its include closure reads,
 * so a regeneration that flips one fact rebuilds only the units that read
 * it, and a unit whose facts agree across two scenes compiles to the same
 * cache key in both. Macros the generator decides from composed output live
 * in `render_capabilities.hpp`; build options stay CMake's.
 */
import type { Feature } from "./compiler/types.js";
import { shadowGeneratorFeatures } from "./shadow-capabilities.js";

/** What a macro row reads. */
export interface FeatureMacroReach {
    /** The final feature list, after the asset join. */
    readonly features: readonly string[];
    /** The image codecs packaged assets reach (`features.cmake`). */
    readonly imageCodecs: readonly string[];
}

interface FeatureMacro {
    readonly macro: string;
    /** 1 when any of these features is reached. */
    readonly anyOf?: readonly Feature[];
    /** 1 when every one of these features is reached. */
    readonly allOf?: readonly Feature[];
    /** 1 when a packaged asset reaches an image codec. */
    readonly imageDecoder?: true;
}

export const featureMacros: readonly FeatureMacro[] = [
    { macro: "BBLITE_DEVICE_RECOVERY", anyOf: ["engine:device-recovery"] },
    { macro: "BBLITE_GPU_TASK_TIMING", anyOf: ["engine:gpu-task-timing"] },
    { macro: "BBLITE_COMPUTE_TEXTURES", anyOf: ["compute:storage-texture"] },
    { macro: "BBLITE_COMPUTE_MIPMAPS", anyOf: ["compute:texture-mipmaps"] },
    {
        macro: "BBLITE_COMPUTE_BUFFERS",
        anyOf: ["compute:storage-buffer", "compute:uniform-buffer"],
    },
    { macro: "BBLITE_COMPUTE_SHADERS", anyOf: ["compute:shader"] },
    { macro: "BBLITE_COMPUTE_FRAME_GRAPH", anyOf: ["compute:frame-graph"] },
    { macro: "BBLITE_STORAGE_READBACK", anyOf: ["compute:storage-readback"] },
    { macro: "BBLITE_COMPUTE_BINDINGS", anyOf: ["compute:bindings"] },
    { macro: "BBLITE_WORKERS", anyOf: ["platform:workers"] },
    { macro: "BBLITE_OFFSCREEN_SURFACES", anyOf: ["platform:window"] },
    { macro: "BBLITE_MESH_POSITION_UPDATE", anyOf: ["mesh:update-positions"] },
    { macro: "BBLITE_HAS_IMAGE_DECODER", imageDecoder: true },
    { macro: "BBLITE_HAS_GAMEPAD", anyOf: ["input:gamepad"] },
    { macro: "BBLITE_HAS_DOM_INPUT", anyOf: ["input:dom"] },
    { macro: "BBLITE_HAS_BROWSER_FILE", anyOf: ["browser:file"] },
    { macro: "BBLITE_HAS_UI", anyOf: ["ui:rml"] },
    { macro: "BBLITE_HAS_PBR_RENDERER", anyOf: ["renderer:scene"] },
    { macro: "BBLITE_HAS_SPRITE_RENDERER", anyOf: ["renderer:sprite"] },
    {
        macro: "BBLITE_HAS_SPRITES",
        anyOf: [
            "sprite:2d",
            "sprite:billboard",
            "sprite:animation",
            "renderer:sprite",
        ],
    },
    { macro: "BBLITE_HAS_GIZMOS", anyOf: ["gizmo:utility-layer"] },
    // A shadow generator's own records, reached by either filter; the
    // directional and cascaded factories reach `shadow:pcf` beside their own
    // feature, and `shadow:task` schedules without owning a generator.
    { macro: "BBLITE_HAS_SHADOWS", anyOf: shadowGeneratorFeatures },
    { macro: "BBLITE_HAS_CANVAS_RENDERER", anyOf: ["renderer:canvas"] },
    { macro: "BBLITE_HAS_EFFECT_RENDERER", anyOf: ["renderer:effect"] },
    {
        macro: "BBLITE_HAS_FRAME_GRAPH_RENDERER",
        anyOf: ["renderer:frame-graph"],
    },
    { macro: "BBLITE_HAS_EFFECT_WRAPPER", anyOf: ["effect:wrapper"] },
    // The pin's mesh-phase Standard extension, reached only through
    // enableMaterialUvTransform().
    {
        macro: "BBLITE_HAS_STANDARD_UV_TRANSFORM",
        anyOf: ["material:standard-uv-transform"],
    },
    // A plugin's texture/sampler pairs bind only through the pin's bridges,
    // which the opt-in registers: a scene attaching plugins without
    // enableMaterialPlugins composes plugin-free and compiles none of this.
    {
        macro: "BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES",
        allOf: ["material:plugin-textures", "material:plugins"],
    },
    { macro: "BBLITE_HAS_EFFECT_TASK", anyOf: ["effect:task"] },
    { macro: "BBLITE_HAS_TEXT", anyOf: ["text:renderable", "renderer:text"] },
    { macro: "BBLITE_HAS_TEXT_RENDERABLE", anyOf: ["text:renderable"] },
    { macro: "BBLITE_HAS_TEXT_RENDERER", anyOf: ["renderer:text"] },
    { macro: "BBLITE_HAS_BILLBOARDS", anyOf: ["sprite:billboard"] },
    { macro: "BBLITE_HAS_SPLATS", anyOf: ["loader:splat"] },
    { macro: "BBLITE_HAS_PICKING", anyOf: ["picking:gpu"] },
    { macro: "BBLITE_HAS_DETAILED_PICKING", anyOf: ["picking:detailed"] },
    { macro: "BBLITE_HAS_CLUSTERED_LIGHTS", anyOf: ["light:clustered"] },
    { macro: "BBLITE_SHADOWS_CSM", anyOf: ["shadow:csm"] },
    { macro: "BBLITE_SHADOW_MORPH_BOUNDS", anyOf: ["shadow:morph-bounds"] },
    { macro: "BBLITE_PHYSICS_VIEWER", anyOf: ["physics:viewer"] },
    { macro: "BBLITE_HAS_PHYSICS_QUERIES", anyOf: ["physics:queries"] },
    { macro: "BBLITE_HAS_PHYSICS_CONSTRAINTS", anyOf: ["physics:constraints"] },
    { macro: "BBLITE_HAS_PHYSICS_TRIGGER", anyOf: ["physics:trigger"] },
    { macro: "BBLITE_HAS_PHYSICS_HEIGHTFIELD", anyOf: ["physics:heightfield"] },
    {
        macro: "BBLITE_HAS_PHYSICS_CHARACTER",
        anyOf: ["physics:character-controller"],
    },
    {
        macro: "BBLITE_HAS_PHYSICS_FLOATING_ORIGIN",
        anyOf: ["physics:floating-origin"],
    },
    { macro: "BBLITE_HAS_NAV_CROWD", anyOf: ["navigation:crowd"] },
    { macro: "BBLITE_HAS_NAV_TILE_CACHE", anyOf: ["navigation:tile-cache"] },
    // Every audio feature implies audio:engine (`impliedFeatures`), so each
    // arm below is 0 in a scene without the engine.
    { macro: "BBLITE_HAS_AUDIO", anyOf: ["audio:engine"] },
    { macro: "BBLITE_HAS_AUDIO_BUFFER_SOURCE", anyOf: ["audio:buffer-source"] },
    { macro: "BBLITE_HAS_AUDIO_DECODE_FILE", anyOf: ["audio:decoded-buffer"] },
    { macro: "BBLITE_AUDIO_DECODE_WAV", anyOf: ["audio:decode-wav"] },
    { macro: "BBLITE_AUDIO_DECODE_WV", anyOf: ["audio:decode-wv"] },
    { macro: "BBLITE_AUDIO_DECODE_MPC", anyOf: ["audio:decode-mpc"] },
    { macro: "BBLITE_AUDIO_DECODE_FLAC", anyOf: ["audio:decode-flac"] },
    { macro: "BBLITE_AUDIO_DECODE_MP3", anyOf: ["audio:decode-mp3"] },
    { macro: "BBLITE_AUDIO_DECODE_OPUS", anyOf: ["audio:decode-opus"] },
    { macro: "BBLITE_AUDIO_DECODE_OGG", anyOf: ["audio:decode-ogg"] },
    { macro: "BBLITE_HAS_AUDIO_OSCILLATOR", anyOf: ["audio:oscillator"] },
    { macro: "BBLITE_HAS_AUDIO_BIQUAD_FILTER", anyOf: ["audio:biquad-filter"] },
    { macro: "BBLITE_HAS_AUDIO_STEREO_PANNER", anyOf: ["audio:stereo-panner"] },
    {
        macro: "BBLITE_HAS_GEOMETRY_OUTPUT",
        anyOf: ["renderer:geometry-output"],
    },
    { macro: "BBLITE_HAS_POST_PROCESS", anyOf: ["renderer:post-process"] },
    { macro: "BBLITE_HAS_SCREEN_SPACE", anyOf: ["renderer:screen-space"] },
];

/** Where a macro's header is included from: `bblite/features/has_ui.hpp`. */
export function featureMacroInclude(macro: string): string {
    if (!/^BBLITE_[A-Z0-9_]+$/.test(macro))
        throw new Error(`'${macro}' is not a bblite macro name.`);
    return `bblite/features/${macro.slice("BBLITE_".length).toLowerCase()}.hpp`;
}

function describe(row: FeatureMacro): string {
    if (row.imageDecoder) return "a packaged asset reaches an image codec";
    if (row.allOf) return `the scene reaches ${row.allOf.join(" and ")}`;
    return `the scene reaches ${(row.anyOf ?? []).join(" or ")}`;
}

/** Whether a row's macro is 1 for this reach. */
export function featureMacroValue(
    row: FeatureMacro,
    reach: FeatureMacroReach,
): boolean {
    if (row.imageDecoder) return reach.imageCodecs.length > 0;
    if (row.allOf)
        return row.allOf.every((feature) => reach.features.includes(feature));
    return (row.anyOf ?? []).some((feature) =>
        reach.features.includes(feature),
    );
}

/**
 * Every macro's header, keyed by its include path, for the value `value`
 * gives each row. The text depends on the macro's value alone, so equal
 * facts are equal bytes in every tree.
 */
export function renderFeatureMacroHeaders(
    value: (row: FeatureMacro) => boolean,
): ReadonlyMap<string, string> {
    return new Map(
        featureMacros.map((row) => [
            featureMacroInclude(row.macro),
            `// Generated by bblitec: 1 when ${describe(row)}.\n#pragma once\n` +
                `#define ${row.macro} ${value(row) ? 1 : 0}\n`,
        ]),
    );
}

/** Every macro's header for one scene's reach. */
export function featureMacroHeaders(
    reach: FeatureMacroReach,
): ReadonlyMap<string, string> {
    return renderFeatureMacroHeaders((row) => featureMacroValue(row, reach));
}

/** The macros a feature keys, for the activation inventory. */
export function featureMacrosOf(feature: string): string[] {
    return featureMacros
        .filter(
            (row) =>
                row.anyOf?.some((candidate) => candidate === feature) ||
                row.allOf?.some((candidate) => candidate === feature),
        )
        .map((row) => row.macro);
}
