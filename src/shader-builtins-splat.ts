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
 * fragment file. The fragment stage of the STOCK module reads no resources
 * at all — the four data textures are sampled in the vertex stage — so
 * nothing else moves, and both stages keep the pin's own group and binding
 * numbers. The compaction pass and the `.slots` sidecar re-home them for
 * SDL_GPU the way they do for the skinning bone texture.
 *
 * A `loadSplat` that passes `GsShaderFragment` plugins composes a different
 * module, and the split then carries two more things across:
 *
 * - the plugin **helper functions**, which upstream splices at
 *   `GS_FRAGMENT_DEFINITIONS` — between the two entry points, so they belong
 *   with the fragment stage that calls them;
 * - the **uniform block**, because a plugin body may read it. The pin's own
 *   bind-group layout is what says so: `getOrCreatePipeline` declares
 *   binding 0 `SS.VERTEX | SS.FRAGMENT` while the four data textures stay
 *   vertex-only, so the uniform is the one resource a fragment plugin is
 *   allowed to reach. It is declared whenever plugins are applied and left
 *   for the compiler to drop when nothing reads it: a block no stage reads
 *   does not survive Tint, and the `.slots` sidecar — not this text — is
 *   what the SDL_GPU PAL binds against.
 */

import {
    extractPackagedStringLiteral,
    readPinnedLibraryModule,
} from "./pinned-shader-composer.js";
import { splatPipelineModule } from "./pinned-splat-fragments.js";

/** The pin's own module, split at its two entry points. */
export interface SplatShaderSource {
    /** Struct S, the group-1 bindings, struct A, and the texel lookup. */
    prologue: string;
    /** Struct S and its group-1 binding alone — what a plugin may read. */
    uniformBlock: string;
    /** `@vertex fn vs(...) -> A { ... }`. */
    vertexStage: string;
    /** Struct A alone — all the stock fragment stage needs. */
    varyingStruct: string;
    /** What the plugins spliced at `GS_FRAGMENT_DEFINITIONS`, if anything. */
    fragmentDefinitions: string;
    /** `@fragment fn fs(...) -> ... { ... }`, plugin slots resolved. */
    fragmentStage: string;
    /** Whether plugins were applied, which is what the fragment file adds. */
    hasFragments: boolean;
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
 * Reads and splits the pinned Gaussian-splat WGSL, or the module the pin's
 * own splicer composed for a scene's plugins.
 *
 * Every anchor asserted here is one this port folds somewhere else: the six
 * group-1 bindings are what the backends build a bind group from, the two
 * entry-point names are what the pipelines name, and the four-component
 * texel fetch is the layout `buildSplatGeometry` packs. A pin that moves any
 * of them refuses generation rather than compiling a shader whose resources
 * this port binds in the wrong order.
 */
export function pinnedSplatShader(
    composedModule?: string,
): SplatShaderSource {
    if (!composedModule && cached) return cached;
    const stock = extractPackagedStringLiteral(
        readPinnedLibraryModule(splatPipelineModule),
        "WGSL",
    );
    const wgsl = composedModule ?? stock;

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

    const uniformStart = wgsl.indexOf("struct S{");
    const varyingStart = wgsl.indexOf("struct A{");
    const vertexStart = wgsl.indexOf("@vertex fn vs(");
    const fragmentStart = wgsl.indexOf("@fragment fn fs(");
    if (
        uniformStart < 0 ||
        varyingStart < 0 ||
        vertexStart < 0 ||
        fragmentStart < 0
    ) {
        throw new Error("Pinned Gaussian-splat WGSL lost an entry point.");
    }
    const uniformEnd =
        wgsl.indexOf(";", wgsl.indexOf("var<uniform> u:S", uniformStart)) + 1;
    const varyingEnd = declarationSpan(wgsl, varyingStart);
    const vertexEnd = declarationSpan(wgsl, vertexStart);

    // Splicing plugins must not have touched anything ahead of the
    // definitions slot. The mangler upstream runs over the whole composed
    // string is idempotent on a base the bundler already shortened, and
    // that is the property this checks rather than assumes.
    if (composedModule && wgsl.slice(0, vertexEnd) !== stock.slice(0, vertexEnd)) {
        throw new Error(
            "Splicing Gaussian-splat shader fragments rewrote the vertex " +
                "half of the pinned module.",
        );
    }

    // The plugin splice points, which the stock module reaches with none.
    const withoutSlots = (text: string): string =>
        text.replace(/\/\*GS_FRAGMENT_\w+\*\//g, "");

    const source: SplatShaderSource = {
        prologue: wgsl.slice(0, vertexStart),
        uniformBlock: wgsl.slice(uniformStart, uniformEnd),
        vertexStage: wgsl.slice(vertexStart, vertexEnd),
        varyingStruct: wgsl.slice(varyingStart, varyingEnd),
        fragmentDefinitions: withoutSlots(
            wgsl.slice(vertexEnd, fragmentStart),
        ).trim(),
        fragmentStage: withoutSlots(wgsl.slice(fragmentStart)),
        hasFragments: composedModule !== undefined,
    };
    if (!composedModule) cached = source;
    return source;
}

export function splatVertexWgsl(
    provenance: string,
    composedModule?: string,
): string {
    const shader = pinnedSplatShader(composedModule);
    return `// ${provenance}
${shader.prologue}
${shader.vertexStage}
`;
}

export function splatFragmentWgsl(
    provenance: string,
    composedModule?: string,
): string {
    const shader = pinnedSplatShader(composedModule);
    // No bindings without plugins: the density is computed from the
    // varyings alone. With them, the pin's own layout lets a plugin body
    // read the uniform block, so it is declared beside the varyings.
    const head = shader.hasFragments
        ? `${shader.uniformBlock}
${shader.varyingStruct}
${shader.fragmentDefinitions}
`
        : `${shader.varyingStruct}
`;
    return `// ${provenance}
${head}${shader.fragmentStage}
`;
}
