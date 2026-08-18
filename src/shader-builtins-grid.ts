/**
 * GridMaterial WGSL, built by evaluating the pinned template functions.
 *
 * `grid-material.ts`'s `buildVertexSource`/`buildFragmentSource` are private
 * but pure template functions, so — the sprite lowerer's precedent — their
 * AST is evaluated with the option flags bound and the *returned strings* are
 * what gets emitted. The native fragment keeps the transcription's runtime
 * option gates (one generated fragment serves every grid material a scene
 * data file can describe), but each gated arm is now the pin's own built
 * text: the two `gridIsOnLine` bodies, the two grid-combine folds, the
 * transparent-opacity clamp, and the premultiply all come out of builder
 * evaluations at the option sets that produce them.
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
 * Anything the evaluator cannot fold, and any built string missing a piece
 * this file must gate, throws naming the pinned symbol — a changed template
 * stops generation instead of silently keeping a copy.
 */
import ts from "typescript";
import { extractWgslFunction } from "./pinned-shader-composer.js";

function gridLiftError(what: string): never {
    throw new Error(`Pinned Babylon Lite grid template changed: ${what}.`);
}

// ---------------------------------------------------------------------------
// Template evaluation (the sprite lowerer's bounded evaluator, extended with
// the option-record property reads and `&&` folds the grid builders use)
// ---------------------------------------------------------------------------

type GridFlags = Readonly<Record<string, boolean>>;
type GridScopeValue = string | boolean | GridFlags;

function unwrapExpression(expression: ts.Expression): ts.Expression {
    let current = expression;
    while (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isNonNullExpression(current)
    ) {
        current = current.expression;
    }
    return current;
}

function functionDeclarationOf(
    file: ts.SourceFile,
    name: string,
): ts.FunctionDeclaration {
    for (const statement of file.statements) {
        if (
            ts.isFunctionDeclaration(statement) &&
            statement.name?.text === name &&
            statement.body !== undefined
        ) {
            return statement;
        }
    }
    return gridLiftError(`no function '${name}'`);
}

function evaluateBoolean(
    expression: ts.Expression,
    scope: ReadonlyMap<string, GridScopeValue>,
): boolean {
    const node = unwrapExpression(expression);
    if (ts.isIdentifier(node)) {
        const bound = scope.get(node.text);
        if (typeof bound !== "boolean") {
            gridLiftError(`'${node.text}' is not a bound flag`);
        }
        return bound;
    }
    if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression)
    ) {
        const record = scope.get(node.expression.text);
        if (record === undefined || typeof record !== "object") {
            gridLiftError(
                `'${node.expression.text}' is not a bound option record`,
            );
        }
        const flag = record[node.name.text];
        if (typeof flag !== "boolean") {
            gridLiftError(
                `option '${node.name.text}' is not a bound flag`,
            );
        }
        return flag;
    }
    if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind ===
            ts.SyntaxKind.AmpersandAmpersandToken
    ) {
        return (
            evaluateBoolean(node.left, scope) &&
            evaluateBoolean(node.right, scope)
        );
    }
    return gridLiftError(
        `a condition this evaluator cannot fold (${
            ts.SyntaxKind[node.kind]
        })`,
    );
}

function evaluateString(
    file: ts.SourceFile,
    expression: ts.Expression,
    scope: ReadonlyMap<string, GridScopeValue>,
): string {
    const node = unwrapExpression(expression);
    if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)
    ) {
        return node.text;
    }
    if (ts.isTemplateExpression(node)) {
        let text = node.head.text;
        for (const span of node.templateSpans) {
            text += evaluateString(file, span.expression, scope);
            text += span.literal.text;
        }
        return text;
    }
    if (ts.isIdentifier(node)) {
        const bound = scope.get(node.text);
        if (typeof bound !== "string") {
            gridLiftError(`'${node.text}' is not a resolved string`);
        }
        return bound;
    }
    if (ts.isConditionalExpression(node)) {
        return evaluateString(
            file,
            evaluateBoolean(node.condition, scope)
                ? node.whenTrue
                : node.whenFalse,
            scope,
        );
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.arguments.length !== 1) {
            gridLiftError(
                `'${node.expression.text}' is no longer a single-argument builder`,
            );
        }
        return evaluateTemplateFunction(
            file,
            node.expression.text,
            evaluateBoolean(node.arguments[0]!, scope),
        );
    }
    return gridLiftError(
        `an expression this evaluator cannot fold (${
            ts.SyntaxKind[node.kind]
        })`,
    );
}

function evaluateTemplateFunction(
    file: ts.SourceFile,
    name: string,
    argument: GridScopeValue,
): string {
    const declaration = functionDeclarationOf(file, name);
    const parameter = declaration.parameters[0];
    if (
        declaration.parameters.length !== 1 ||
        parameter === undefined ||
        !ts.isIdentifier(parameter.name)
    ) {
        gridLiftError(
            `'${name}' no longer takes a single named parameter`,
        );
    }
    const scope = new Map<string, GridScopeValue>([
        [parameter.name.text, argument],
    ]);
    for (const statement of declaration.body!.statements) {
        if (ts.isVariableStatement(statement)) {
            for (const binding of statement.declarationList.declarations) {
                if (
                    !ts.isIdentifier(binding.name) ||
                    binding.initializer === undefined
                ) {
                    gridLiftError(
                        `an unsupported binding in '${name}'`,
                    );
                }
                scope.set(
                    binding.name.text,
                    evaluateString(file, binding.initializer, scope),
                );
            }
            continue;
        }
        if (ts.isReturnStatement(statement)) {
            if (statement.expression === undefined) {
                gridLiftError(`'${name}' returns nothing`);
            }
            return evaluateString(file, statement.expression, scope);
        }
        gridLiftError(`an unsupported statement in '${name}'`);
    }
    return gridLiftError(`'${name}' has no return statement`);
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

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
    return evaluateTemplateFunction(file, "buildFragmentSource", {
        ...options,
        hasOpacity,
    });
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
    const built = evaluateTemplateFunction(
        gridMaterial,
        "buildVertexSource",
        hasOpacity,
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
