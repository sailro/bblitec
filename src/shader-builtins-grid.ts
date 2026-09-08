/**
 * GridMaterial WGSL, built by evaluating the pinned template functions.
 *
 * `grid-material.ts`'s `buildVertexSource`/`buildFragmentSource` are private
 * but pure template functions, so — as for every other pinned shader-text
 * builder — their AST is evaluated by the shared `PinnedShaderText` with the
 * option record bound and the *returned strings* are what gets emitted. The
 * native fragment keeps runtime option gates (one generated fragment serves
 * every grid material a scene data file can describe), but each gated arm is
 * the pin's own built text: the two `gridIsOnLine` bodies, the two
 * grid-combine folds, the transparent-opacity clamp, and the premultiply all
 * come out of builder evaluations at the option sets that produce them.
 *
 * The documented re-homings, mirroring the background lift:
 * - `@group`/`@binding` move to SDL_GPU's register spaces (vertex uniforms in
 *   space 1, fragment uniforms in space 3), and the pin's named uniforms
 *   flatten into the plan's `GridUniforms` vec4s (`mainColor` ->
 *   `mainColor.rgb`, `gridOffset` -> `gridOffsetVisibility.xyz`,
 *   `visibility` -> `gridOffsetVisibility.w`).
 * - The vertex stage folds the pin's `projection*(view*(world*position))`
 *   into the plan's premultiplied view-projection over the pre-transformed
 *   world-space position attribute, and reads the object-space position and
 *   normal from the shared model vertex layout's dedicated attributes.
 *
 * Anything the evaluator cannot fold refuses naming the pinned node, and any
 * built string missing a piece this file must gate throws naming the piece —
 * a changed template stops generation instead of silently keeping a copy.
 */
import ts from "typescript";
import { LoweringContext } from "./lowering/context.js";
import { PinnedShaderText } from "./lowering/pinned-shader-text.js";
import { extractWgslFunction } from "./pinned-shader-composer.js";
import { sharedUpstreamStore } from "./upstream-source.js";

const gridModule = "src/material/grid/grid-material.ts";

function gridLiftError(what: string): never {
    throw new Error(`Pinned Babylon Lite grid template changed: ${what}.`);
}

/**
 * The context the shared evaluator reads the grid module through.
 *
 * The renderer hands this file the grid module it already resolved, so the
 * supplied source stands in for the store's copy of that one module and
 * every other module still resolves through the shared store -- the same
 * evaluator, over the same file, whether the caller is the renderer or a
 * test doctoring the template.
 */
class GridSourceContext extends LoweringContext {
    public constructor(private readonly gridMaterial: ts.SourceFile) {
        super(sharedUpstreamStore());
    }

    public override sourceFile(modulePath: string): ts.SourceFile {
        return modulePath === gridModule
            ? this.gridMaterial
            : super.sourceFile(modulePath);
    }
}

/** The one attribute permutation the native layout carries. */
const hasOpacity = false;

function builtFragment(
    file: ts.SourceFile,
    options: {
        antialias: boolean;
        useMaxLine: boolean;
        transparent: boolean;
        preMultiplyAlpha: boolean;
    },
): string {
    return new PinnedShaderText(new GridSourceContext(file)).evaluate(
        gridModule,
        "buildFragmentSource",
        new Map([["opts", { ...options, hasOpacity }]]),
    );
}

/** Requires `text` inside `source`, naming the missing piece otherwise. */
function requireText(source: string, text: string, what: string): string {
    if (!source.includes(text)) {
        gridLiftError(`${what} ('${text}' is gone)`);
    }
    return text;
}

/**
 * Merges the pin's two `gridIsOnLine` specializations under the runtime
 * antialias gate. Both bodies share the builder's fixed prefix through
 * `fr=fr/d;`; the antialiased arm runs first behind the gate and the hard
 * cutoff remains the fall-through, which is exactly the transcription's
 * runtime shape with the pin's own bytes in both arms.
 */
function mergedGridIsOnLine(base: string, antialiased: string): string {
    const seam = "fr=fr/d;";
    const baseFn = extractWgslFunction(base, "gridIsOnLine");
    const antialiasedFn = extractWgslFunction(antialiased, "gridIsOnLine");
    const baseSeam = baseFn.indexOf(seam);
    const antialiasedSeam = antialiasedFn.indexOf(seam);
    if (baseSeam < 0 || antialiasedSeam < 0) {
        gridLiftError("gridIsOnLine no longer normalizes through 'fr=fr/d;'");
    }
    const prefix = baseFn.slice(0, baseSeam + seam.length);
    if (prefix !== antialiasedFn.slice(0, antialiasedSeam + seam.length)) {
        gridLiftError("gridIsOnLine arms no longer share their prefix");
    }
    const baseArm = baseFn.slice(baseSeam + seam.length, -1);
    const antialiasedArm = antialiasedFn.slice(
        antialiasedSeam + seam.length,
        -1,
    );
    return `${prefix}if (shaderUniforms.options.y>0.5){${antialiasedArm}}${baseArm}}`;
}

const gridUniformsWgsl = `struct GridUniforms {
    gridControl: vec4<f32>,
    mainColor: vec4<f32>,
    lineColor: vec4<f32>,
    gridOffsetVisibility: vec4<f32>,
    options: vec4<f32>,
}
@group(3) @binding(0) var<uniform> shaderUniforms: GridUniforms;`;

/** The flattened-member re-homing; each entry must land at least once. */
function flattenGridUniforms(source: string): string {
    let text = source;
    for (const [pattern, replacement] of [
        [/shaderUniforms\.mainColor\b/g, "shaderUniforms.mainColor.rgb"],
        [/shaderUniforms\.lineColor\b/g, "shaderUniforms.lineColor.rgb"],
        [
            /shaderUniforms\.gridOffset\b/g,
            "shaderUniforms.gridOffsetVisibility.xyz",
        ],
        [
            /shaderUniforms\.visibility\b/g,
            "shaderUniforms.gridOffsetVisibility.w",
        ],
    ] as const) {
        if (!pattern.test(text)) {
            gridLiftError(
                `fragment no longer reads ${pattern.source}`,
            );
        }
        pattern.lastIndex = 0;
        text = text.replace(pattern, replacement);
    }
    const allowed = new Set([
        "gridControl",
        "mainColor",
        "lineColor",
        "gridOffsetVisibility",
        "options",
    ]);
    for (const member of text.matchAll(/shaderUniforms\.(\w+)/g)) {
        if (!allowed.has(member[1]!)) {
            gridLiftError(
                `fragment reads '${member[0]}', which has no plan slot`,
            );
        }
    }
    return text;
}

export function gridFragmentWgsl(
    provenance: string,
    gridMaterial: ts.SourceFile,
): string {
    const base = builtFragment(gridMaterial, {
        antialias: false,
        useMaxLine: false,
        transparent: false,
        preMultiplyAlpha: false,
    });
    const antialiased = builtFragment(gridMaterial, {
        antialias: true,
        useMaxLine: false,
        transparent: false,
        preMultiplyAlpha: false,
    });
    const maxLine = builtFragment(gridMaterial, {
        antialias: false,
        useMaxLine: true,
        transparent: false,
        preMultiplyAlpha: false,
    });
    const transparent = builtFragment(gridMaterial, {
        antialias: false,
        useMaxLine: false,
        transparent: true,
        preMultiplyAlpha: false,
    });
    const premultiplied = builtFragment(gridMaterial, {
        antialias: false,
        useMaxLine: false,
        transparent: true,
        preMultiplyAlpha: true,
    });

    // The two grid-combine folds, each taken from the build that produces it.
    const sumFold = requireText(
        base,
        "let grid=clamp(x+y+z,0.0,1.0);",
        "additive grid fold",
    );
    const maxFold = requireText(
        maxLine,
        "let grid=clamp(max(max(x,y),z),0.0,1.0);",
        "max-line grid fold",
    );

    // The transparent-opacity clamp and the premultiply, taken as the exact
    // text the builders splice after `var opacity=1.0;`.
    const opacitySeam = "var opacity=1.0;";
    const opacityEnd = "return vec4<f32>(rgb,";
    const between = (built: string, what: string): string => {
        const start = built.indexOf(opacitySeam);
        const end = built.indexOf(opacityEnd, start);
        if (start < 0 || end < 0) {
            gridLiftError(`${what} opacity section`);
        }
        return built.slice(start + opacitySeam.length, end);
    };
    if (between(base, "base").length !== 0) {
        gridLiftError("opaque build gained an opacity arm");
    }
    const transparentArm = between(transparent, "transparent");
    const premultipliedArms = between(premultiplied, "premultiplied");
    if (!premultipliedArms.startsWith(transparentArm)) {
        gridLiftError(
            "premultiplied build no longer extends the transparent arm",
        );
    }
    const premultiplyArm = premultipliedArms.slice(transparentArm.length);
    if (premultiplyArm.length === 0) {
        gridLiftError("premultiply arm is empty");
    }

    // Assemble: the base build, with each option site replaced by the gated
    // union of the pin's own arms.
    let fragment = base;
    fragment = fragment.replace(
        extractWgslFunction(fragment, "gridIsOnLine"),
        mergedGridIsOnLine(base, antialiased),
    );
    fragment = fragment.replace(
        sumFold,
        `var grid=clamp(x+y+z,0.0,1.0);if (shaderUniforms.options.z>0.5){grid=${
            maxFold.slice("let grid=".length)
        }}`,
    );
    fragment = fragment.replace(
        opacitySeam,
        `${opacitySeam}if (shaderUniforms.options.x>0.5){${transparentArm}}` +
            `if (shaderUniforms.options.x>0.5 && shaderUniforms.options.w>0.5){${premultiplyArm}}`,
    );
    fragment = flattenGridUniforms(fragment);
    requireText(fragment, "@fragment fn mainFragment(", "fragment entry");
    return `// ${provenance}
${gridUniformsWgsl}

${fragment.trim()}
`;
}

export function gridVertexWgsl(
    provenance: string,
    gridMaterial: ts.SourceFile,
): string {
    const built = new PinnedShaderText(
        new GridSourceContext(gridMaterial),
    ).evaluate(
        gridModule,
        "buildVertexSource",
        new Map([["hasOpacity", hasOpacity]]),
    );
    // The pinned shader system multiplies three matrices right to left; the
    // plan premultiplies view-projection and pre-transforms the position
    // attribute by the world matrix, so the fold below is exact. The pin's
    // `input.position`/`input.normal` are object-space; natively they live in
    // the shared model layout's dedicated attributes.
    const transform =
        "shaderSystem.projection*(shaderSystem.view*(shaderSystem.world*vec4<f32>(input.position,1.0)))";
    requireText(built, transform, "vertex transform");
    let vertex = built.replace(
        transform,
        "uniforms.viewProjection*vec4<f32>(input.position,1.0)",
    );
    vertex = vertex.replace(
        requireText(
            vertex,
            "out.vPosition=input.position;",
            "vertex position varying",
        ),
        "out.vPosition=input.localPosition;",
    );
    vertex = vertex.replace(
        requireText(
            vertex,
            "out.vNormal=input.normal;",
            "vertex normal varying",
        ),
        "out.vNormal=input.localNormal;",
    );
    const leftover = /shaderSystem\.\w+/.exec(vertex);
    if (leftover) {
        gridLiftError(
            `vertex reads '${leftover[0]}', which has no plan slot`,
        );
    }
    return `// ${provenance}
struct VertexUniforms {
    viewProjection: mat4x4<f32>,
}
@group(1) @binding(0) var<uniform> uniforms: VertexUniforms;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(4) localPosition: vec3<f32>,
    @location(7) localNormal: vec3<f32>,
};

${vertex.trim()}
`;
}
