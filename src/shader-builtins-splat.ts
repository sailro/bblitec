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
    pinnedSplatModuleWgsl,
    type PinnedSplatShModule,
} from "./pinned-splat-fragments.js";
import { packagedWgsl } from "./pinned-wgsl-build.js";

/**
 * What one pinned splat module spells its shared declarations as.
 *
 * The two the pin ships are not one text with a flag: the stock module is a
 * `?raw` file miniray minified (`struct S`, `var<uniform> u:S`,
 * `@vertex fn vs(`), while the SH module is BUILT by
 * `buildShShaderSource` from tagged templates, so its declarations carry
 * the build step's spelling and the anchors below are spelled from source
 * and packaged the same way. The split is the same operation over both, so
 * the anchors travel as data and the splitter is written once -- a second
 * copy of it would agree until one module moved.
 */
interface SplatShaderDialect {
    /** The uniform block's own `struct` head. */
    uniformStruct: string;
    /** The varying struct's head, repeated into the fragment file. */
    varyingStruct: string;
    /** The uniform declaration, whose `;` ends the block. */
    uniformDeclaration: string;
    /** Where the vertex stage begins. */
    vertexEntry: string;
    /** Where the fragment stage begins. */
    fragmentEntry: string;
    /** Declarations whose absence means the pin moved a resource. */
    anchors: readonly string[];
}

/**
 * The stock module's dialect, read off the module itself: its text is
 * miniray's, mangled names included, so each declaration is asserted by
 * shape and its name read back rather than spelled here.
 */
function stockDialect(wgsl: string): SplatShaderDialect {
    const shape = (pattern: RegExp, what: string): RegExpExecArray => {
        const match = pattern.exec(wgsl);
        if (!match) {
            throw new Error(
                `Pinned Gaussian-splat WGSL no longer declares ${what}.`,
            );
        }
        return match;
    };
    const [, uniform, uniformStruct] = shape(
        /@group\(1\) @binding\(0\) var<uniform> (\w+):(\w+);/,
        "its uniform block",
    ) as unknown as [string, string, string];
    const sampler = shape(
        /@group\(1\) @binding\(1\) var (\w+):sampler;/,
        "its sampler",
    )[1]!;
    const textures = [2, 3, 4, 5].map(
        (binding) =>
            shape(
                new RegExp(
                    `@group\\(1\\) @binding\\(${binding}\\) var (\\w+):texture_2d<f32>;`,
                ),
                `its data texture at binding ${binding}`,
            )[1]!,
    );
    const varying = shape(
        /@vertex fn vs\([^)]*\)->(\w+)\{/,
        "its vertex entry's varying struct",
    )[1]!;
    return {
        uniformStruct: `struct ${uniformStruct}{`,
        varyingStruct: `struct ${varying}{`,
        uniformDeclaration: `var<uniform> ${uniform}:${uniformStruct}`,
        vertexEntry: "@vertex fn vs(",
        fragmentEntry: "@fragment fn fs(",
        anchors: [
            `@group(1) @binding(0) var<uniform> ${uniform}:${uniformStruct};`,
            `@group(1) @binding(1) var ${sampler}:sampler;`,
            ...textures.map(
                (name, index) =>
                    `@group(1) @binding(${index + 2}) var ${name}:texture_2d<f32>;`,
            ),
            "@vertex fn vs(",
            "@fragment fn fs(",
            "@builtin(position) pos:vec4<f32>",
        ],
    };
}

const SH_DIALECT: SplatShaderDialect = {
    uniformStruct: packagedWgsl`struct U {`,
    varyingStruct: packagedWgsl`struct VOut {`,
    uniformDeclaration: packagedWgsl`var<uniform> u: U`,
    vertexEntry: packagedWgsl`@vertex\nfn vs(`,
    fragmentEntry: packagedWgsl`@fragment\nfn fs(`,
    anchors: [
        packagedWgsl`@group(1) @binding(0) var<uniform> u: U;`,
        packagedWgsl`@group(1) @binding(1) var samp: sampler;`,
        packagedWgsl`@group(1) @binding(2) var centersTex: texture_2d<f32>;`,
        packagedWgsl`@group(1) @binding(3) var covATex: texture_2d<f32>;`,
        packagedWgsl`@group(1) @binding(4) var covBTex: texture_2d<f32>;`,
        packagedWgsl`@group(1) @binding(5) var colorsTex: texture_2d<f32>;`,
        // The one binding the stock module has no counterpart for, and the
        // reason the SH arm exists: the view-dependent colour is loaded
        // from packed unsigned texels in the VERTEX stage.
        packagedWgsl`@group(1) @binding(6) var shTexture0: texture_2d<u32>;`,
        packagedWgsl`eyePosition: vec3<f32>`,
        packagedWgsl`@vertex\nfn vs(`,
        packagedWgsl`@fragment\nfn fs(`,
        packagedWgsl`@builtin(position) pos: vec4<f32>`,
    ],
};

/** The pin's own module, split at its two entry points. */
export interface SplatShaderSource {
    /**
     * Whether the pin's splicer composed this text from plugins. It decides
     * one thing downstream -- whether the fragment file declares the
     * uniform block a plugin body may read.
     */
    spliced: boolean;
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

/** One split per distinct module text: the stock one, and each scene's. */
const cache = new Map<string, SplatShaderSource>();

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
    const stock = pinnedSplatModuleWgsl();
    return splitSplatShader(stockDialect(stock), stock, composedModule);
}

/**
 * The same split over the module `buildShShaderSource` produced.
 *
 * The base is the pin's own build for this scene's degree rather than a
 * packaged literal, so the "did splicing move the vertex half" check
 * compares against that build instead of against the stock text.
 */
export function pinnedSplatShShader(
    module: PinnedSplatShModule,
): SplatShaderSource {
    return splitSplatShader(
        SH_DIALECT,
        module.base,
        module.wgsl === module.base ? undefined : module.wgsl,
    );
}

function splitSplatShader(
    dialect: SplatShaderDialect,
    stock: string,
    composedModule?: string,
): SplatShaderSource {
    const key = `${dialect.vertexEntry}|${composedModule ?? stock}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const wgsl = composedModule ?? stock;

    for (const anchor of dialect.anchors) {
        if (!wgsl.includes(anchor)) {
            throw new Error(
                `Pinned Gaussian-splat WGSL no longer declares '${anchor}'.`,
            );
        }
    }

    const uniformStart = wgsl.indexOf(dialect.uniformStruct);
    const varyingStart = wgsl.indexOf(dialect.varyingStruct);
    const vertexStart = wgsl.indexOf(dialect.vertexEntry);
    const fragmentStart = wgsl.indexOf(dialect.fragmentEntry);
    if (
        uniformStart < 0 ||
        varyingStart < 0 ||
        vertexStart < 0 ||
        fragmentStart < 0
    ) {
        throw new Error("Pinned Gaussian-splat WGSL lost an entry point.");
    }
    const uniformEnd =
        wgsl.indexOf(
            ";",
            wgsl.indexOf(dialect.uniformDeclaration, uniformStart),
        ) + 1;
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
        spliced: composedModule !== undefined,
        prologue: wgsl.slice(0, vertexStart),
        uniformBlock: wgsl.slice(uniformStart, uniformEnd),
        vertexStage: wgsl.slice(vertexStart, vertexEnd),
        varyingStruct: wgsl.slice(varyingStart, varyingEnd),
        fragmentDefinitions: withoutSlots(
            wgsl.slice(vertexEnd, fragmentStart),
        ).trim(),
        fragmentStage: withoutSlots(wgsl.slice(fragmentStart)),
    };
    cache.set(key, source);
    return source;
}

export function splatVertexWgsl(
    provenance: string,
    shader: SplatShaderSource,
): string {
    return `// ${provenance}
${shader.prologue}
${shader.vertexStage}
`;
}

export function splatFragmentWgsl(
    provenance: string,
    shader: SplatShaderSource,
): string {
    // No bindings without plugins: the density is computed from the
    // varyings alone. With them, the pin's own layout lets a plugin body
    // read the uniform block, so it is declared beside the varyings.
    const head = shader.spliced
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
