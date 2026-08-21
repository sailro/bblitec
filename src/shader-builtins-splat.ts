/**
 * The Gaussian-splat stages, lifted from the pin's own WGSL.
 *
 * `gaussian-splatting-pipeline.ts` ships one WGSL module holding both stages
 * — the EWA / Vrk projection of the 3D anisotropic Gaussian in `vs`, the
 * `exp(-r²)·α` density in `fs`. It is a packaged string literal in the
 * bundle, exactly like the HDR compute shaders, so it is EXTRACTED rather
 * than transcribed: a re-typed projection agrees with upstream only until
 * upstream changes it.
 *
 * The only edit is the split. Upstream hands WebGPU one module and lets it
 * pick both entry points; this backend compiles a stage per file, so the
 * shared prologue (the UBO, the data textures, the varying struct, the texel
 * lookup) goes to the vertex file and the varying struct is repeated in the
 * fragment file. The fragment stage reads no resources at all — the four
 * data textures are sampled in the vertex stage — so nothing else moves, and
 * both stages keep the pin's own group and binding numbers. The compaction
 * pass and the `.slots` sidecar re-home them for SDL_GPU the way they do for
 * the skinning bone texture.
 *
 * The plugin slots (`GS_FRAGMENT_*`) are left empty: splicing a caller's
 * fragment belongs with the scene that passes one.
 */

import {
    extractPackagedStringLiteral,
    readPinnedLibraryModule,
} from "./pinned-shader-composer.js";

/** The pin's own module, split at its two entry points. */
export interface SplatShaderSource {
    /** Struct S, the group-1 bindings, struct A, and the texel lookup. */
    prologue: string;
    /** `@vertex fn vs(...) -> A { ... }`. */
    vertexStage: string;
    /** Struct A alone — all the fragment stage needs. */
    varyingStruct: string;
    /** `@fragment fn fs(...) -> ... { ... }`, plugin slots removed. */
    fragmentStage: string;
}

/** The brace-matched span of a declaration starting at `start`. */
function declarationSpan(wgsl: string, start: number): number {
    const open = wgsl.indexOf("{", start);
    if (open < 0) {
        throw new Error("Pinned splat shader declaration has no body.");
    }
    let depth = 0;
    for (let index = open; index < wgsl.length; index += 1) {
        if (wgsl[index] === "{") depth += 1;
        else if (wgsl[index] === "}") {
            depth -= 1;
            if (depth === 0) return index + 1;
        }
    }
    throw new Error("Pinned splat shader declaration is unbalanced.");
}

let cached: SplatShaderSource | undefined;

/**
 * Reads and splits the pinned Gaussian-splat WGSL.
 *
 * Every anchor asserted here is one this port folds somewhere else: the six
 * group-1 bindings are what the backends build a bind group from, the two
 * entry-point names are what the pipelines name, and the four-component
 * texel fetch is the layout `buildSplatGeometry` packs. A pin that moves any
 * of them refuses generation rather than compiling a shader whose resources
 * this port binds in the wrong order.
 */
export function pinnedSplatShader(): SplatShaderSource {
    if (cached) return cached;
    const bundle = readPinnedLibraryModule(
        "mesh/GaussianSplatting/gaussian-splatting-pipeline.js",
    );
    const wgsl = extractPackagedStringLiteral(bundle, "WGSL");

    for (const anchor of [
        "@group(1) @binding(0) var<uniform> u:S;",
        "@group(1) @binding(1) var e:sampler;",
        "@group(1) @binding(2) var F:texture_2d<f32>;",
        "@group(1) @binding(3) var G:texture_2d<f32>;",
        "@group(1) @binding(4) var J:texture_2d<f32>;",
        "@group(1) @binding(5) var K:texture_2d<f32>;",
        "@vertex fn vs(",
        "@fragment fn fs(",
        "@builtin(position) pos:vec4<f32>",
    ]) {
        if (!wgsl.includes(anchor)) {
            throw new Error(
                `Pinned Gaussian-splat WGSL no longer declares '${anchor}'.`,
            );
        }
    }

    const varyingStart = wgsl.indexOf("struct A{");
    const vertexStart = wgsl.indexOf("@vertex fn vs(");
    const fragmentStart = wgsl.indexOf("@fragment fn fs(");
    if (varyingStart < 0 || vertexStart < 0 || fragmentStart < 0) {
        throw new Error("Pinned Gaussian-splat WGSL lost an entry point.");
    }
    const varyingEnd = declarationSpan(wgsl, varyingStart);
    const vertexEnd = declarationSpan(wgsl, vertexStart);

    // The plugin splice points, which this slice reaches with no fragments.
    const withoutSlots = (text: string): string =>
        text.replace(/\/\*GS_FRAGMENT_\w+\*\//g, "");

    cached = {
        prologue: wgsl.slice(0, vertexStart),
        vertexStage: wgsl.slice(vertexStart, vertexEnd),
        varyingStruct: wgsl.slice(varyingStart, varyingEnd),
        fragmentStage: withoutSlots(wgsl.slice(fragmentStart)),
    };
    return cached;
}

export function splatVertexWgsl(provenance: string): string {
    const shader = pinnedSplatShader();
    return `// ${provenance}
${shader.prologue}
${shader.vertexStage}
`;
}

export function splatFragmentWgsl(provenance: string): string {
    const shader = pinnedSplatShader();
    // No bindings: the density is computed from the varyings alone.
    return `// ${provenance}
${shader.varyingStruct}
${shader.fragmentStage}
`;
}
