/**
 * Lowers the pinned shadow family into a header both backends execute.
 *
 * The subsystem splits exactly where the pin splits it. `shadow-base.ts` and
 * `pcf-spotlight-shadow-generator.ts` are plain math over plain data — a
 * light-space view matrix, a perspective volume from the cone angle, a 4x4
 * multiply, and the clip-space bias the caster pass bakes into its own
 * view-projection — so the *shape* is the contract and every one of them is
 * lowered from its own AST rather than restated here. What the generator
 * builds around them is GPU state (a depth texture, a comparison sampler,
 * two uniform buffers), which is the PAL's, so this header carries the
 * pinned constants that describe it and generation asserts each against the
 * declaration that states it.
 *
 * One asymmetry is worth naming because it decides two matrices rather than
 * one. `renderPcfShadowMap` packs the *unbiased* `viewProj` into
 * `sg._lightMatrix` — what the receiver samples with — and hands the
 * *biased* one to the shadow camera, which is what the caster pass renders
 * through. Baking the bias into both would shift the comparison twice.
 */
import ts from "typescript";
import type { LoweredSource, LoweringContext } from "./context.js";
import {
    type PinnedBinding,
    PinnedNumericLowerer,
} from "./pinned-numeric-lowerer.js";
import {
    lowerPinnedFunction,
    lowerMat4InvertCpp,
    lowerTupleComponents,
} from "./pinned-function-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import { nativeDepthCompare } from "./pinned-depth-state.js";
import { doubleLiteral, floatLiteral } from "../cpp-literals.js";
import { pinnedTrsComposition } from "./pinned-trs.js";
import type { ComposedEsmShadow } from "../pinned-esm-shadow.js";

const baseModule = "src/shadow/shadow-base.ts";
const spotModule = "src/shadow/pcf-spotlight-shadow-generator.ts";
const hooksModule = "src/shadow/pcf-shadow-task-hooks.ts";
const pcfDirectionalModule =
    "src/shadow/pcf-directional-shadow-generator.ts";
const esmModule = "src/shadow/esm-directional-shadow-generator.ts";
const csmModule = "src/shadow/csm-directional-shadow-generator.ts";
const csmHooksModule = "src/shadow/csm-shadow-task-hooks.ts";
const sceneModule = "src/scene/scene-core.ts";

/** The `<cmath>` names these bodies reach, from the shared pinned table. */
const mathCalls = pinnedNumericMathCalls();

/**
 * The statement inventory of the pinned `_computeCsmCascades`, which
 * `update_csm_cascades` restates whole: the frame's scalars and scratch
 * views, the split loop, the light direction's normalize and degenerate-up
 * guard, the frustum inverse, the caster bounds, and the cascade loop.
 */
const CSM_CASCADE_FIT_INVENTORY: readonly string[] = [
    ...Array<string>(15).fill("variable statement"),
    "for statement",
    ...Array<string>(4).fill("variable statement"),
    ...Array<string>(3).fill("expression statement"),
    "if statement",
    ...Array<string>(3).fill("variable statement"),
    "expression statement",
    "variable statement",
    "variable statement",
    "for statement",
    "return statement",
];

/**
 * The per-cascade body of that loop: the split, the corner transforms, the
 * centroid and its light view, the light-space bounds, the eye, the
 * caster-Z tighten, the world-space bias arm, the ortho-view and its texel
 * snap, and the receiver block's stores.
 */
const CSM_CASCADE_LOOP_INVENTORY: readonly string[] = [
    "variable statement",
    "for statement",
    "for statement",
    "expression statement",
    "variable statement",
    "other statement",
    ...Array<string>(3).fill("expression statement"),
    ...Array<string>(3).fill("variable statement"),
    "if statement",
    ...Array<string>(4).fill("variable statement"),
    "expression statement",
    "variable statement",
    "variable statement",
    "if statement",
    "if statement",
    "variable statement",
    "expression statement",
    "variable statement",
    "variable statement",
    "if statement",
    ...Array<string>(4).fill("variable statement"),
    ...Array<string>(4).fill("expression statement"),
];

/**
 * The `?? <literal>` default a pinned option read resolves to.
 *
 * Two spellings reach this: most factories bind a `const x = cfg.x ?? d`
 * local, while the CSM one packs a few straight into its config literal as
 * `_x: cfg.x ?? d`. Both are the same expression under a different parent,
 * so the reader takes the INITIALIZER and each caller says where it found
 * it.
 */
function nullishDefaultValue(
    context: LoweringContext,
    initializer: ts.Expression,
    label: string,
    file: ts.SourceFile,
): number {
    const nullish = context.nullishDefault(initializer);
    if (!nullish) {
        return context.contractError(
            initializer,
            `Expected pinned '${label}' to resolve through '??'.`,
        );
    }
    return context.numericValue(nullish.right, file);
}

function optionDefault(
    context: LoweringContext,
    declaration: ts.FunctionDeclaration,
    local: string,
    file: ts.SourceFile,
): number {
    return nullishDefaultValue(
        context,
        context.variableInitializer(declaration, local),
        local,
        file,
    );
}

/**
 * The pin's own floating-origin offset, as the three scalars both matrix
 * builders take.
 *
 * `renderPcfShadowMap` and `renderEsmShadowMap` both read the active
 * camera's world translation and hand it in, so the light view and the
 * caster fold land in the same eye-relative frame the mesh worlds are packed
 * into. With the mode off the caller passes the zero vector, which is what
 * the pin's own `foCam ? ... : 0` resolves to. Stated once because both
 * builders take the same three, for the same reason.
 */
const eyeOffsetBindings: readonly (readonly [string, PinnedBinding])[] = [
    ["offX", { cpp: "eye.x", type: "scalar" }],
    ["offY", { cpp: "eye.y", type: "scalar" }],
    ["offZ", { cpp: "eye.z", type: "scalar" }],
];

/**
 * `buildLightViewMatrix`, whole: the light-space basis, from six scalars.
 *
 * The body is scalars into one returned `new F32([...])`, so the return hook
 * lowers that literal's sixteen elements in place — each a JavaScript double
 * the pin rounds once at its own `F32` store, which is what the
 * `static_cast<float>` per element reproduces.
 */
function lowerBuildLightViewMatrix(context: LoweringContext): string {
    const { declaration } = context.functionDeclaration(
        baseModule,
        "buildLightViewMatrix",
    );
    return lowerPinnedFunction(
        context,
        baseModule,
        "buildLightViewMatrix",
        ["dirX", "dirY", "dirZ", "px", "py", "pz"].map((pinned) => ({
            pinned,
            kind: "number" as const,
            cpp: pinned,
        })),
        {
            cppName: "build_light_view_matrix",
            inline: true,
            calls: mathCalls,
            returns: {
                type: "std::array<float, 16>",
                value: (lowerer, expression) =>
                    matrixLiteral(context, lowerer, expression, declaration),
            },
        },
    );
}

/**
 * `buildLightViewMatrixInto`, whole: the cascade fit's own copy of the
 * light-space basis, written into caller-owned storage rather than a fresh
 * `F32`. The CSM module keeps its own so the cascade fit allocates nothing
 * per frame; the arithmetic is the shared builder's, and lowering the copy
 * from its own declaration is what keeps that true rather than asserted.
 */
function lowerBuildLightViewMatrixInto(context: LoweringContext): string {
    return lowerPinnedFunction(
        context,
        csmHooksModule,
        "buildLightViewMatrixInto",
        [
            {
                pinned: "out",
                kind: "mat4" as const,
                annotation: "Float32Array",
                cpp: "out",
            },
            ...["dirX", "dirY", "dirZ", "px", "py", "pz"].map((pinned) => ({
                pinned,
                kind: "number" as const,
                cpp: pinned,
            })),
        ],
        {
            cppName: "build_light_view_matrix_into",
            inline: true,
            calls: mathCalls,
            returns: "void",
        },
    );
}

/**
 * `mat4InvertToRefOrIdentity`, whole: the cascade fit's allocation-free
 * inverse, which writes the identity for a singular input where
 * `mat4Invert` returns null. Lowered from its own declaration like the
 * light-view basis above, so the singular arm and the sixteen lanes are
 * the pin's rather than a proof that they still match `mat4Invert`.
 */
function lowerMat4InvertToRefOrIdentity(context: LoweringContext): string {
    return lowerPinnedFunction(
        context,
        "src/math/mat4-invert-to-ref.ts",
        "mat4InvertToRefOrIdentity",
        [
            {
                pinned: "input",
                kind: "mat4Const" as const,
                annotation: "Mat4",
                cpp: "input",
            },
            {
                pinned: "result",
                kind: "mat4" as const,
                annotation: "Mat4",
                cpp: "result",
            },
        ],
        {
            cppName: "mat4_invert_to_ref_or_identity",
            inline: true,
            calls: mathCalls,
            returns: "void",
        },
    );
}

/**
 * `orthoViewInto`, whole: the orthographic off-centre projection
 * multiplied straight into the affine light view, one column at a time,
 * each lane rounded once at the pin's own float store.
 */
function lowerOrthoViewInto(context: LoweringContext): string {
    return lowerPinnedFunction(
        context,
        csmHooksModule,
        "orthoViewInto",
        [
            {
                pinned: "out",
                kind: "mat4" as const,
                annotation: "Float32Array",
                cpp: "out",
            },
            { pinned: "view", kind: "matrix" as const, cpp: "view" },
            ...["l", "r", "b", "t", "n", "f"].map((pinned) => ({
                pinned,
                kind: "number" as const,
                cpp: pinned,
            })),
        ],
        {
            cppName: "ortho_view_into",
            inline: true,
            calls: mathCalls,
            returns: "void",
        },
    );
}

/**
 * `multiply4x4`, whole.
 *
 * Its accumulator is `new F32(16)` — a constant length, so the translator
 * gives it the fixed matrix and the pin's own nested walk stores into that
 * directly.
 */
function lowerMultiply4x4(context: LoweringContext): string {
    const { declaration } = context.functionDeclaration(
        baseModule,
        "multiply4x4",
    );
    return lowerPinnedFunction(
        context,
        baseModule,
        "multiply4x4",
        ["a", "b"].map((pinned) => ({
            pinned,
            kind: "matrix" as const,
            cpp: pinned,
        })),
        {
            cppName: "multiply_4x4",
            inline: true,
            calls: mathCalls,
            returns: {
                type: "std::array<float, 16>",
                value: (lowerer, expression) => {
                    if (!expression || !ts.isIdentifier(expression)) {
                        return context.contractError(
                            declaration,
                            "Expected pinned multiply4x4 to return its " +
                                "accumulator.",
                        );
                    }
                    return lowerer.expression(expression);
                },
            },
        },
    );
}

/**
 * `biasViewProjection`, whole.
 *
 * Babylon's clip-space linear bias, halved for WebGPU's [0, 1] depth range
 * and added into each column's z row. It reaches only the caster pass: the
 * receiver's own light matrix stays unbiased.
 */
function lowerBiasViewProjection(context: LoweringContext): string {
    const { declaration } = context.functionDeclaration(
        hooksModule,
        "biasViewProjection",
    );
    return lowerPinnedFunction(
        context,
        hooksModule,
        "biasViewProjection",
        [
            { pinned: "viewProj", kind: "matrix", cpp: "view_projection" },
            { pinned: "bias", kind: "number", cpp: "bias" },
        ],
        {
            cppName: "bias_view_projection",
            inline: true,
            calls: mathCalls,
            returns: {
                type: "std::array<float, 16>",
                value: (lowerer, expression) => {
                    if (!expression || !ts.isIdentifier(expression)) {
                        return context.contractError(
                            declaration,
                            "Expected pinned biasViewProjection to return " +
                                "its biased copy.",
                        );
                    }
                    return lowerer.expression(expression);
                },
            },
        },
    );
}

/** A returned `new F32([...])` as a `std::array<float, 16>` construction. */
function matrixLiteral(
    context: LoweringContext,
    lowerer: PinnedNumericLowerer,
    expression: ts.Expression | undefined,
    declaration: ts.Node,
): string {
    const lowered = lowerTupleComponents(context, lowerer, expression, {
        arity: 16,
        at: declaration,
        insideF32: true,
        cast: "static_cast<float>",
    });
    return `std::array<float, 16>{\n        ${lowered.join(",\n        ")}}`;
}

/**
 * `_computeSpotLightMatrix`, whole.
 *
 * The pin reads the light through `light.direction` / `light.position` /
 * `light.angle`, so those three paths bind to the native light record's own
 * lanes by their full pinned text; the floating-origin offsets it also takes
 * are bound to their pinned defaults' value, since no reached scene enables
 * large-world rendering. The returned object literal becomes the struct
 * below, field by field from the pin's own initializers.
 */
/**
 * Assert one pinned signature, parameter by parameter.
 *
 * Both light-matrix lowerers below take the same shape -- named parameters,
 * an annotation on the ones this port binds, and three floating-origin
 * offsets that must still default to zero for the emitted signature to be
 * allowed to drop them. Stating it once means a pin that moves either
 * signature is answered in one place rather than in two that have already
 * been observed to drift.
 */
function assertPinnedSignature(
    context: LoweringContext,
    file: ts.SourceFile,
    declaration: ts.FunctionDeclaration,
    symbol: string,
    expected: readonly (readonly [string, string])[],
): void {
    if (declaration.parameters.length !== expected.length) {
        context.contractError(
            declaration,
            `Expected pinned ${symbol} to take (` +
                `${expected.map(([name]) => name).join(", ")}).`,
        );
    }
    declaration.parameters.forEach((parameter, index) => {
        const [pinned, annotation] = expected[index]!;
        if (
            !ts.isIdentifier(parameter.name) ||
            parameter.name.text !== pinned
        ) {
            context.contractError(
                parameter,
                `Expected pinned ${symbol} parameter ${index} to be ` +
                    `'${pinned}'.`,
            );
        }
        if (annotation && parameter.type?.getText(file) !== annotation) {
            context.contractError(
                parameter,
                `Expected pinned ${symbol} parameter '${pinned}' to be ` +
                    `annotated '${annotation}'.`,
            );
        }
        // An unannotated parameter is one of the floating-origin offsets.
        // No reached scene enables large-world rendering, so the emitted
        // signature drops them -- but only while the pin still defaults
        // them to the value that makes dropping them exact.
        if (!annotation) {
            const initializer = parameter.initializer;
            if (
                !initializer ||
                context.numericValue(initializer, file) !== 0
            ) {
                context.contractError(
                    parameter,
                    `Expected pinned ${symbol} '${pinned}' to default to 0.`,
                );
            }
        }
    });
}

function lowerComputeSpotLightMatrix(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        spotModule,
        "_computeSpotLightMatrix",
    );
    const expected: readonly (readonly [string, string])[] = [
        ["light", "SpotLight"],
        ["near", "number"],
        ["far", "number"],
        ["offX", ""],
        ["offY", ""],
        ["offZ", ""],
    ];
    assertPinnedSignature(
        context,
        file,
        declaration,
        "_computeSpotLightMatrix",
        expected,
    );
    const bindings = new Map<string, PinnedBinding>([
        ["light.direction.x", { cpp: "light.direction.x", type: "scalar" }],
        ["light.direction.y", { cpp: "light.direction.y", type: "scalar" }],
        ["light.direction.z", { cpp: "light.direction.z", type: "scalar" }],
        ["light.position.x", { cpp: "light.position.x", type: "scalar" }],
        ["light.position.y", { cpp: "light.position.y", type: "scalar" }],
        ["light.position.z", { cpp: "light.position.z", type: "scalar" }],
        // `angle` is the full cone angle the pinned factory stored; the
        // native record keeps its cosine for shading and the angle itself
        // for this projection.
        ["light.angle", { cpp: "light.angle", type: "scalar" }],
        // `near`/`far` are Windows macro names.
        ["near", { cpp: "near_plane", type: "scalar" }],
        ["far", { cpp: "far_plane", type: "scalar" }],
        ...eyeOffsetBindings,
    ]);
    const lowerer: PinnedNumericLowerer = new PinnedNumericLowerer(file, {
        bindings,
        calls: new Map([
            ...mathCalls,
            [
                "buildLightViewMatrix",
                (a: readonly string[]): string =>
                    `build_light_view_matrix(${a.join(", ")})`,
            ],
            [
                "multiply4x4",
                (a: readonly string[]): string =>
                    `multiply_4x4(${a.join(", ")})`,
            ],
        ]),
        matrixCalls: new Set(["buildLightViewMatrix", "multiply4x4"]),
        returnValue: (expression): string => {
            const returned = expression
                ? context.unwrapExpression(expression)
                : undefined;
            if (!returned || !ts.isObjectLiteralExpression(returned)) {
                return context.contractError(
                    declaration,
                    "Expected pinned _computeSpotLightMatrix to return an " +
                        "object literal.",
                );
            }
            const fields: readonly (readonly [string, string])[] = [
                ["_view", "view"],
                ["_viewProj", "view_projection"],
                ["_near", "near_plane"],
                ["_far", "far_plane"],
            ];
            const values = fields.map(([pinned]) =>
                lowerer.expression(
                    context.propertyInitializer(returned, pinned),
                ),
            );
            return (
                `ShadowLightMatrix{\n        ${values[0]},\n` +
                `        ${values[1]},\n        ${values[2]},\n` +
                `        ${values[3]}}`
            );
        },
    });
    const body = declaration.body!.statements
        .flatMap((statement) => lowerer.statement(statement, "    "))
        .join("\n");
    // `view` and `proj` come out of the translator as `std::array<float,16>`
    // and `std::vector<float>` respectively; the multiply takes the fixed
    // form, so the call site narrows the allocated one.
    return `// ${context.provenance(spotModule, "_computeSpotLightMatrix")}
inline ShadowLightMatrix compute_spot_light_matrix(
    const LightRecord& light,
    double near_plane,
    double far_plane,
    Vec3d eye) {
${body}
}`;
}

/**
 * The pinned orthographic fit, lowered from its own body.
 *
 * A directional light has no position to project from, so the pin sizes the
 * light-space volume to the casters themselves: it folds every caster's
 * eight world-space AABB corners into light space and fits X/Y to that
 * box. The fold walks meshes, which the translator has no types for, so the
 * caster carrier and its member spellings are supplied here while the
 * arithmetic stays the pin's.
 */
function lowerComputeDirectionalLightMatrix(
    context: LoweringContext,
): string {
    const { file, declaration } = context.functionDeclaration(
        baseModule,
        "computeDirectionalLightMatrix",
    );
    const expected: readonly (readonly [string, string])[] = [
        ["light", "DirectionalLight"],
        ["casterMeshes", "readonly Mesh[]"],
        ["orthoMinZ", "number"],
        ["orthoMaxZ", "number"],
        ["offX", ""],
        ["offY", ""],
        ["offZ", ""],
    ];
    assertPinnedSignature(
        context,
        file,
        declaration,
        "computeDirectionalLightMatrix",
        expected,
    );
    const bindings = new Map<string, PinnedBinding>([
        ["light.direction.x", { cpp: "light.direction.x", type: "scalar" }],
        ["light.direction.y", { cpp: "light.direction.y", type: "scalar" }],
        ["light.direction.z", { cpp: "light.direction.z", type: "scalar" }],
        ["light.position.x", { cpp: "light.position.x", type: "scalar" }],
        ["light.position.y", { cpp: "light.position.y", type: "scalar" }],
        ["light.position.z", { cpp: "light.position.z", type: "scalar" }],
        ["orthoMinZ", { cpp: "ortho_min_z", type: "scalar" }],
        ["orthoMaxZ", { cpp: "ortho_max_z", type: "scalar" }],
        ...eyeOffsetBindings,
    ]);
    const lowerer: PinnedNumericLowerer = new PinnedNumericLowerer(file, {
        bindings,
        calls: new Map([
            ...mathCalls,
            [
                "buildLightViewMatrix",
                (a: readonly string[]): string =>
                    `build_light_view_matrix(${a.join(", ")})`,
            ],
            [
                "multiply4x4",
                (a: readonly string[]): string =>
                    `multiply_4x4(${a.join(", ")})`,
            ],
            [
                "Number.isFinite",
                (a: readonly string[]): string =>
                    `std::isfinite(${a.join(", ")})`,
            ],
        ]),
        matrixCalls: new Set(["buildLightViewMatrix", "multiply4x4"]),
        // The caster walk. Each element exposes the three things the fold
        // reads; the PAL fills them because a mesh's world matrix is its to
        // compose. `boundMin`/`boundMax` bind to the present arm, which is
        // the specialization the carrier makes true -- see
        // `shadow_caster_bounds_fallback` for the absent one.
        forOf: (iterated, element) => {
            if (iterated !== "casterMeshes") return undefined;
            return {
                range: "casters",
                bindings: new Map<string, PinnedBinding>([
                    [
                        `${element}.worldMatrix`,
                        { cpp: `${element}.world`, type: "f32" },
                    ],
                    [
                        `${element}.boundMin`,
                        { cpp: `${element}.bounds_min`, type: "f32" },
                    ],
                    [
                        `${element}.boundMax`,
                        { cpp: `${element}.bounds_max`, type: "f32" },
                    ],
                ]),
            };
        },
        booleanOr: true,
        returnValue: (expression): string => {
            const returned = expression
                ? context.unwrapExpression(expression)
                : undefined;
            if (!returned || !ts.isObjectLiteralExpression(returned)) {
                return context.contractError(
                    declaration,
                    "Expected pinned computeDirectionalLightMatrix to " +
                        "return an object literal.",
                );
            }
            const fields = ["_view", "_viewProj", "_near", "_far"] as const;
            const values = fields.map((pinned) =>
                lowerer.expression(
                    context.propertyInitializer(returned, pinned),
                ),
            );
            return (
                `ShadowLightMatrix{
        ${values[0]},
` +
                `        ${values[1]},
        ${values[2]},
` +
                `        ${values[3]}}`
            );
        },
    });
    const body = declaration.body!.statements
        .flatMap((statement) => lowerer.statement(statement, "    "))
        .join("\n");
    return `// ${context.provenance(
        baseModule,
        "computeDirectionalLightMatrix",
    )}
inline ShadowLightMatrix compute_directional_light_matrix(
    const LightRecord& light,
    const std::vector<ShadowCaster>& casters,
    double ortho_min_z,
    double ortho_max_z,
    Vec3d eye) {
${body}
}`;
}

/**
 * The receiver UBO's field order, asserted rather than restated.
 *
 * `writeShadowUboFields` is a copy into a flat 24-float array, and the
 * composed fragment declares the same bytes as
 * `{ lightMatrix, depthValues, shadowsInfo }`. What matters is that the two
 * agree, so the pinned writer's own index writes are checked against the
 * mirrored struct's offsets and the struct is what the runtime fills.
 */
function assertShadowUboLayout(context: LoweringContext): void {
    const { file, declaration } = context.functionDeclaration(
        baseModule,
        "writeShadowUboFields",
    );
    const expected = new Map<number, string>([
        [16, "sg._depthValues[0]!"],
        [17, "sg._depthValues[1]!"],
        [18, "0"],
        [19, "0"],
        [20, "sg._shadowsInfo[0]!"],
        [21, "sg._shadowsInfo[1]!"],
        [22, "sg._shadowsInfo[2]!"],
        [23, "sg._shadowsInfo[3]!"],
    ]);
    for (const store of context.pinnedElementStores(declaration, "out")) {
        const index = context.numericValue(
            store.left.argumentExpression,
            file,
        );
        const shape = expected.get(index);
        if (shape === undefined) {
            context.contractError(
                store.left,
                `Pinned writeShadowUboFields writes float ${index}, which ` +
                    "the mirrored receiver block does not carry.",
            );
        }
        context.assertExpressionShape(
            store.right,
            shape,
            `Pinned shadow UBO float ${index}`,
        );
        expected.delete(index);
    }
    if (expected.size !== 0) {
        context.contractError(
            declaration,
            "Pinned writeShadowUboFields no longer writes floats " +
                `${[...expected.keys()].join(", ")}.`,
        );
    }
    // The light matrix takes the first sixteen through the shared packer.
    context.callExpression(declaration, "packMat4IntoF32");
}

/**
 * `_computeCsmCascades`, held to its own shape.
 *
 * The fit this port emits is a mirror of that function rather than a
 * lowering of it — it allocates per-cascade tuple arrays, branches on the
 * `stabilizeCascades` arm this port refuses, and folds a thin-instance
 * caster AABB behind a WeakMap cache, none of which the pinned-function
 * lowerer expresses. A mirror needs the same guard the mirrored receiver
 * block has, so every step the emitted body restates is matched against
 * the pin's own expression here: a formula that moves upstream fails
 * generation by name instead of drifting.
 */
function assertCsmCascadeFit(context: LoweringContext): void {
    const { declaration } = context.functionDeclaration(
        csmHooksModule,
        "_computeCsmCascades",
    );
    const initializerShapes = (
        root: ts.Node,
        shapes: readonly (readonly [string, string])[],
    ): void => {
        for (const [source, label] of shapes) {
            const split = source.indexOf(" = ");
            context.assertExpressionShape(
                context.variableInitializer(root, source.slice(0, split)),
                source.slice(split + 3),
                `Pinned CSM ${label}`,
            );
        }
    };
    initializerShapes(
        declaration,
        [
            // The split: a logarithmic and a uniform partition, blended.
            ["p = (i + 1) / n", "cascade split fraction"],
            ["log = minZ * ratio ** p", "logarithmic partition"],
            ["uniform = minZ + range * p", "uniform partition"],
            [
                "d = cfg._lambda * (log - uniform) + uniform",
                "split blend",
            ],
            // The slice: each cascade's far end steps its own length down
            // the near-to-far ray from where the previous one stopped.
            [
                "split = prevSplit + frustumLengths[c]! / cameraRange",
                "cascade split",
            ],
            // The eye sits behind the slice along the light direction.
            ["eyeX = cx + dx * minEz", "shadow camera eye"],
            ["viewMaxZ = maxEz - minEz", "fitted depth range"],
            // The texel snap on the fitted transform's own translation.
            [
                "offX = (Math.round(ox) - ox) * (2 / cfg._mapSize)",
                "texel snap offset",
            ],
        ],
    );
    // The stores, which are statements rather than declarations: the two
    // per-cascade lanes the receiver block carries, the split carried
    // forward, the caster-Z tighten -- `depthClamp = false` behaviour,
    // narrowing the fitted range to the casters rather than widening it --
    // the snap applied in place, and the three pinned helpers the fit
    // reaches, each lowered or matched on its own above.
    for (const [source, label] of [
        [
            "frustumLengths[i] = d - (i === 0 ? minZ : viewFrustumZ[i - 1]!)",
            "slice length",
        ],
        ["viewFrustumZ[i] = d", "split distance"],
        ["prevSplit = split", "split carried forward"],
        ["viewMaxZ = Math.min(viewMaxZ, cMaxZ)", "caster-Z tighten"],
        ["transform[12] = transform[12]! + offX", "texel snap store"],
        [
            "orthoViewInto(transform, view, minX, maxX, minY, maxY, viewMinZ, viewMaxZ)",
            "cascade ortho-view",
        ],
        [
            "mat4InvertToRefOrIdentity(vp as never, invViewProj as never)",
            "frustum inverse",
        ],
        [
            "buildLightViewMatrixInto(view, dx, dy, dz, eyeX, eyeY, eyeZ)",
            "cascade light view",
        ],
    ] as const) {
        context.expectShapeCount(declaration, source, `Pinned CSM ${label}`);
    }
    // The world-space bias widens the far plane by its own amount. This
    // port refuses `worldSpaceBias`, so the arm is not restated -- but it
    // has to stay behind that option, or a pin that made it unconditional
    // would move every cascade's far plane past what the mirror fits.
    const worldBias = context.findNodes(
        declaration,
        (node): node is ts.IfStatement =>
            ts.isIfStatement(node) &&
            context.expressionMatchesShape(node.expression, "cfg._worldSpaceBias"),
    )[0];
    if (
        !worldBias ||
        !context.hasNode(
            worldBias.thenStatement,
            (node) =>
                ts.isBinaryExpression(node) &&
                context.expressionMatchesShape(node, "viewMaxZ += cfg._worldSpaceBias"),
        )
    ) {
        context.contractError(
            declaration,
            "Expected the pinned CSM far-plane widening to stay behind cfg._worldSpaceBias.",
        );
    }
    // The body is restated whole, so its statement inventory is pinned:
    // an added, removed or reordered statement moves no shape above and
    // would otherwise pass.
    context.assertStatementInventory(
        declaration,
        declaration.body!.statements,
        "_computeCsmCascades",
        "update_csm_cascades restates the whole body",
        CSM_CASCADE_FIT_INVENTORY,
    );
    const cascadeLoop = context.findNodes(
        declaration,
        (node): node is ts.ForStatement =>
            ts.isForStatement(node) &&
            node.initializer !== undefined &&
            ts.isVariableDeclarationList(node.initializer) &&
            node.initializer.declarations[0]?.name.getText() === "c",
    )[0];
    if (!cascadeLoop || !ts.isBlock(cascadeLoop.statement)) {
        context.contractError(
            declaration,
            "Expected the pinned CSM cascade loop `for (let c ...)` with a block body.",
        );
    }
    context.assertStatementInventory(
        cascadeLoop,
        cascadeLoop.statement.statements,
        "the _computeCsmCascades cascade loop",
        "update_csm_cascades restates every cascade's fit",
        CSM_CASCADE_LOOP_INVENTORY,
    );
    // The caster matrix's own bias, applied to the last column's z lane of
    // the receiver transform after the receiver block was written. This
    // port renders every cascade through the PCF family's already-lowered
    // `bias_view_projection`, which halves the bias itself and adds it into
    // each column's z row scaled by that column's w -- the same lane for an
    // orthographic transform, whose w row is (0, 0, 0, 1) -- so what has to
    // hold is that the CSM hook still passes `_bias * 0.5`, adds it to
    // lane 14 alone, and reaches its world-space arm only under a
    // `worldSpaceBias` this port refuses.
    const { declaration: bias } = context.functionDeclaration(
        csmHooksModule,
        "_biasViewProjection",
    );
    context.expectShapeCount(
        bias,
        "matrix[14] = matrix[14]! + clipOffset",
        "Pinned CSM caster bias lane",
    );
    const { declaration: render } = context.functionDeclaration(
        csmHooksModule,
        "renderCsmShadowMap",
    );
    context.assertExpressionShape(
        context.variableInitializer(render, "clipBias"),
        "cfg._worldSpaceBias === null ? cfg._bias * 0.5 : " +
            "csmWorldBiasClipOffset(cfg._worldSpaceBias, cascades._near[i]!, cascades._far[i]!)",
        "Pinned CSM caster bias",
    );
    context.expectShapeCount(
        render,
        "_biasViewProjection(cascades._transforms[i]!, clipBias)",
        "Pinned CSM caster bias application",
    );
}

/**
 * `_writeCsmUbo`'s own float order, asserted against the mirrored block.
 *
 * The cascaded receiver's block is not `writeShadowUboFields`': the pin
 * writes it in one place, `out` is 80 floats rather than 24, and the two
 * per-cascade lanes are written by loops rather than by numbered stores. So
 * each store is matched by the SHAPE of its index against the shape of its
 * value, which is what keeps `CsmInfoUniforms` a mirror rather than a guess.
 *
 * The one value read back out is the blend factor a zero
 * `cascadeBlendPercentage` stands for: the pin's own "disable" magnitude,
 * which a receiver's `clamp(...) * csmParams.y` then saturates with.
 */
function assertCsmUboLayout(
    context: LoweringContext,
): { disabledBlendFactor: number } {
    const { file, declaration } = context.functionDeclaration(
        csmHooksModule,
        "_writeCsmUbo",
    );
    // Every cascade transform lands at a 16-float stride through `set`, and
    // the fill is what leaves an unwritten slot zero.
    context.callExpression(declaration, "fill");
    context.assertExpressionShape(
        context.callExpression(declaration, "set"),
        "out.set(cascades._transforms[i]!, i * 16)",
        "Pinned CSM cascade-transform store",
    );
    const expected = new Map<string, string>([
        ["64 + i", "cascades._viewFrustumZ[i]!"],
        ["68 + i", "cascades._frustumLengths[i]!"],
        ["72", "cfg._darkness"],
        ["73", "cfg._mapSize"],
        ["74", "1 / cfg._mapSize"],
        ["75", "cfg._frustumEdgeFalloff"],
        ["76", "n"],
        // Its value is a ternary rather than a shape, so the entry stands
        // for the STORE and the arm below reads the magnitude out of it.
        ["77", ""],
    ]);
    let disabledBlendFactor: number | undefined;
    for (const store of context.pinnedElementStores(declaration, "out")) {
        const index = store.left.argumentExpression.getText(file).trim();
        if (index === "77") {
            // `cfg._cascadeBlendPercentage === 0 ? <disabled> : 1 / ...`.
            const blend = context.unwrapExpression(store.right);
            if (
                !ts.isConditionalExpression(blend) ||
                !context.expressionMatchesShape(
                    blend.condition,
                    "cfg._cascadeBlendPercentage === 0",
                ) ||
                !context.expressionMatchesShape(
                    blend.whenFalse,
                    "1 / cfg._cascadeBlendPercentage",
                )
            ) {
                context.contractError(
                    store.right,
                    "Expected the CSM blend factor to be the pin's " +
                        "reciprocal with a disabled arm.",
                );
            }
            disabledBlendFactor = context.numericValue(blend.whenTrue, file);
            expected.delete(index);
            continue;
        }
        const shape = expected.get(index);
        if (shape === undefined) {
            context.contractError(
                store.left,
                `Pinned _writeCsmUbo writes float ${index}, which the ` +
                    "mirrored cascade block does not carry.",
            );
        }
        context.assertExpressionShape(
            store.right,
            shape,
            `Pinned CSM UBO float ${index}`,
        );
        expected.delete(index);
    }
    if (expected.size !== 0) {
        context.contractError(
            declaration,
            "Pinned _writeCsmUbo no longer writes floats " +
                `${[...expected.keys()].join(", ")}.`,
        );
    }
    return { disabledBlendFactor: disabledBlendFactor! };
}

/**
 * Every named local's `??` fallback in one pinned factory.
 *
 * The three generator factories resolve their options the same way -- one
 * `const x = cfg.x ?? <default>` per option -- so the read is stated once
 * and each family names only its own list.
 */
function pinnedOptionDefaults<Name extends string>(
    context: LoweringContext,
    module: string,
    factory: string,
    names: readonly Name[],
): Record<Name, number> {
    const { file, declaration } = context.functionDeclaration(module, factory);
    return Object.fromEntries(
        names.map((name) => [
            name,
            optionDefault(context, declaration, name, file),
        ]),
    ) as Record<Name, number>;
}

/** The pinned ESM-directional defaults, each read from its own `??`. */
export interface PinnedEsmDefaults {
    mapSize: number;
    depthScale: number;
    bias: number;
    blurKernel: number;
    blurScale: number;
    darkness: number;
    frustumEdgeFalloff: number;
    orthoMinZ: number;
    orthoMaxZ: number;
}

function esmDefaults(context: LoweringContext): PinnedEsmDefaults {
    return pinnedOptionDefaults(
        context,
        esmModule,
        "createEsmDirectionalShadowGenerator",
        [
            "mapSize",
            "depthScale",
            "bias",
            "blurKernel",
            "blurScale",
            "darkness",
            "frustumEdgeFalloff",
            "orthoMinZ",
            "orthoMaxZ",
        ],
    );
}

/**
 * Read from `createPcfDirectionalShadowGenerator`'s own `??` chain.
 *
 * The factory is the spot generator's GPU state over the ESM's
 * caster-fitted volume, and its defaults follow that split: `mapSize`,
 * `bias` and `darkness` are its own, while `near`/`far` give way to the
 * ortho pair `computeDirectionalLightMatrix` takes.
 */
function pcfDirectionalDefaults(context: LoweringContext) {
    return pinnedOptionDefaults(
        context,
        pcfDirectionalModule,
        "createPcfDirectionalShadowGenerator",
        ["mapSize", "bias", "darkness", "orthoMinZ", "orthoMaxZ"],
    );
}

/** The pinned defaults a CSM generator's cascade fit and receiver read. */
function csmDefaults(context: LoweringContext) {
    const { file, declaration } = context.functionDeclaration(
        csmModule,
        "createCsmDirectionalShadowGenerator",
    );
    const cascades = context.unwrapExpression(
        context.variableInitializer(declaration, "numCascades"),
    );
    if (
        !ts.isCallExpression(cascades) ||
        cascades.expression.getText(file) !== "Math.min" ||
        cascades.arguments.length !== 2
    ) {
        context.contractError(
            cascades,
            "Expected CSM cascade count to be clamped with Math.min.",
        );
    }
    const requested = context.unwrapExpression(cascades.arguments[0]!);
    if (
        !ts.isBinaryExpression(requested) ||
        requested.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
    ) {
        context.contractError(
            requested,
            "Expected CSM cascade count to resolve through '??'.",
        );
    }
    // Two independent facts: the clamp fixes the receiver block's
    // `array<mat4x4, MAX>` and the record's cascade arrays, the `??` fixes
    // what a scene naming no count gets. They happen to agree in this pin,
    // and neither is derived from the other here.
    const max = context.numericValue(cascades.arguments[1]!, file);
    const fallback = context.numericValue(requested.right, file);
    const csmCfg = context.unwrapExpression(
        context.variableInitializer(declaration, "csmCfg"),
    );
    if (!ts.isObjectLiteralExpression(csmCfg)) {
        context.contractError(csmCfg, "Expected CSM config object literal.");
    }
    // A lane the factory packs straight into `csmCfg` rather than into a
    // local first: the same `cfg.x ?? default`, read off the property.
    const cfgDefault = (name: string): number =>
        nullishDefaultValue(
            context,
            context.propertyInitializer(csmCfg, name),
            name,
            file,
        );
    return {
        mapSize: optionDefault(context, declaration, "mapSize", file),
        numCascades: fallback,
        // `Math.min(cfg.numCascades ?? 4, 4)`: the clamp is what fixes the
        // receiver block's `array<mat4x4, 4>` and the record's cascade
        // arrays, so it is read rather than assumed to equal the default.
        maxCascades: max,
        lambda: cfgDefault("_lambda"),
        cascadeBlendPercentage: cfgDefault("_cascadeBlendPercentage"),
        bias: optionDefault(context, declaration, "bias", file),
        darkness: optionDefault(context, declaration, "darkness", file),
        frustumEdgeFalloff: optionDefault(
            context,
            declaration,
            "frustumEdgeFalloff",
            file,
        ),
    };
}

/**
 * The record field each factory's lane locals stand for.
 *
 * A lane is packed from the values the factory closed over, and this port
 * keeps those on the generator record instead -- so lowering a lane is
 * lowering its expression with the locals renamed. Every name the three
 * factories use is here; one they add fails by name rather than packing a
 * zero.
 */
const shadowLaneLocals: Readonly<Record<string, string>> = {
    darkness: "generator.darkness",
    mapSize: "map_size",
    far: "generator.far_plane",
    depthScale: "generator.depth_scale",
    frustumEdgeFalloff: "generator.frustum_edge_falloff",
};

/**
 * One `new F32([...])` lane of a shadow generator, as C++ float expressions.
 *
 * `_depthValues` and `_shadowsInfo` are the two the receiver block carries,
 * and the three factories pack them from three different combinations --
 * `[0, far]` against `[0, 1]`, and `[darkness, mapSize, 1/mapSize, 0]`
 * against `[darkness, 0, depthScale, falloff]`. Reading them here is what
 * stops that table from being re-typed into a fork this port maintains by
 * hand: a pin that moves a lane moves the emitted block with it.
 */
function shadowLane(
    context: LoweringContext,
    declaration: ts.FunctionDeclaration,
    file: ts.SourceFile,
    local: string,
    width: number,
): readonly string[] {
    const initializer = context.unwrapExpression(
        context.variableInitializer(declaration, local),
    );
    const elements =
        ts.isNewExpression(initializer) &&
        initializer.arguments?.length === 1 &&
        ts.isArrayLiteralExpression(initializer.arguments[0]!)
            ? initializer.arguments[0]!.elements
            : undefined;
    if (!elements || elements.length !== width) {
        return context.contractError(
            initializer,
            `Expected pinned '${local}' to be a ${width}-element F32 literal.`,
        );
    }
    return elements.map((element) =>
        lowerShadowLaneElement(context, element, file, local),
    );
}

/** One lane element, at the float width the pin's own `F32` store rounds to. */
function lowerShadowLaneElement(
    context: LoweringContext,
    node: ts.Expression,
    file: ts.SourceFile,
    local: string,
): string {
    const expression = context.unwrapExpression(node);
    if (ts.isNumericLiteral(expression)) {
        return floatLiteral(context.numericValue(expression, file));
    }
    if (ts.isIdentifier(expression)) {
        return `static_cast<float>(${shadowLaneField(context, expression)})`;
    }
    if (
        ts.isBinaryExpression(expression) &&
        expression.operatorToken.kind === ts.SyntaxKind.SlashToken
    ) {
        // `1.0 / mapSize`, the only arithmetic the three lanes carry. Divided
        // at double width and rounded once, which is what the pin's own `F32`
        // store does to it.
        const operand = (side: ts.Expression): string => {
            const inner = context.unwrapExpression(side);
            return ts.isNumericLiteral(inner)
                ? doubleLiteral(context.numericValue(inner, file))
                : shadowLaneField(context, inner);
        };
        return (
            "static_cast<float>(" +
            `${operand(expression.left)} / ${operand(expression.right)})`
        );
    }
    return context.contractError(
        expression,
        `Pinned lane '${local}' carries an expression this port ` +
            "does not lower.",
    );
}

/** The record field a lane local names, or a refusal naming the local. */
function shadowLaneField(
    context: LoweringContext,
    expression: ts.Expression,
): string {
    if (!ts.isIdentifier(expression)) {
        return context.contractError(
            expression,
            "Expected a pinned lane local.",
        );
    }
    const field = shadowLaneLocals[expression.text];
    return field === undefined
        ? context.contractError(
              expression,
              `Pinned lane reads an unmapped local '${expression.text}'.`,
          )
        : field;
}

/**
 * The receiver-block arms, one per pinned generator factory.
 *
 * Ordered so the two filters that name themselves come first and the spot
 * generator is the fallthrough, which is the shape the record's own
 * `ShadowFilter` default takes.
 */
const shadowBlockFamilies: readonly {
    module: string;
    factory: string;
    filter?: string;
}[] = [
    {
        module: esmModule,
        factory: "createEsmDirectionalShadowGenerator",
        filter: "esm_directional",
    },
    {
        module: pcfDirectionalModule,
        factory: "createPcfDirectionalShadowGenerator",
        filter: "pcf_directional",
    },
    {
        module: spotModule,
        factory: "createPcfSpotlightShadowGenerator",
    },
];

/** Every family's two lanes, as the emitted block's arms. */
function shadowBlockArms(context: LoweringContext): string {
    return shadowBlockFamilies
        .map(({ module, factory, filter }) => {
            const { file, declaration } = context.functionDeclaration(
                module,
                factory,
            );
            const depth = shadowLane(
                context,
                declaration,
                file,
                "_depthValues",
                2,
            );
            const info = shadowLane(
                context,
                declaration,
                file,
                "_shadowsInfo",
                4,
            );
            // The pin writes two depth values into a four-float lane, so the
            // trailing pair is the padding `writeShadowUboFields` leaves zero.
            const body = [
                `        block.depthValues = {${depth.join(", ")}, 0.0f, 0.0f};`,
                `        block.shadowsInfo = {${info.join(", ")}};`,
                "        return block;",
            ].join("\n");
            return filter === undefined
                ? `    {\n${body}\n    }`
                : `    if (generator.filter == ShadowFilter::${filter}) {\n` +
                      `${body}\n    }`;
        })
        .join("\n");
}

/**
 * The pin's own AABB fallback for a caster with no bounds.
 *
 * `computeDirectionalLightMatrix` reads `mesh.boundMin ?? [-0.5, -0.5,
 * -0.5]`. The lowered fold binds the present arm, so the absent one has to
 * reach the carrier the PAL fills -- from the pin's literal, never retyped.
 */
function esmCasterBoundsFallback(
    context: LoweringContext,
): { min: readonly number[]; max: readonly number[] } {
    const { file, declaration } = context.functionDeclaration(
        baseModule,
        "computeDirectionalLightMatrix",
    );
    const literal = (local: string): readonly number[] => {
        const initializer = context.unwrapExpression(
            context.variableInitializer(declaration, local),
        );
        if (
            !ts.isBinaryExpression(initializer) ||
            initializer.operatorToken.kind !==
                ts.SyntaxKind.QuestionQuestionToken ||
            !ts.isArrayLiteralExpression(initializer.right) ||
            initializer.right.elements.length !== 3
        ) {
            return context.contractError(
                initializer,
                `Expected pinned '${local}' to fall back to a 3-element ` +
                    "array literal.",
            );
        }
        return initializer.right.elements.map((element) =>
            context.numericValue(element, file),
        );
    };
    return { min: literal("boundMin"), max: literal("boundMax") };
}

/** One pinned PCF-spot default, read from its own `??`. */
export interface PinnedPcfSpotDefaults {
    mapSize: number;
    bias: number;
    darkness: number;
    near: number;
    /** The `light.range === MAX_VALUE` arm's constant. */
    far: number;
}

function pcfSpotDefaults(context: LoweringContext): PinnedPcfSpotDefaults {
    const { file, declaration } = context.functionDeclaration(
        spotModule,
        "createPcfSpotlightShadowGenerator",
    );
    const far = context.unwrapExpression(
        context.variableInitializer(declaration, "far"),
    );
    if (
        !ts.isBinaryExpression(far) ||
        far.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
    ) {
        context.contractError(far, "Expected pinned 'far' to use '??'.");
    }
    context.assertExpressionShape(
        far.right,
        "_light.range === Number.MAX_VALUE ? 10000 : _light.range",
        "Pinned PCF spot far fallback",
    );
    const fallback = context.unwrapExpression(far.right);
    if (!ts.isConditionalExpression(fallback)) {
        return context.contractError(fallback, "Expected a conditional.");
    }
    return {
        mapSize: optionDefault(context, declaration, "mapSize", file),
        bias: optionDefault(context, declaration, "bias", file),
        darkness: optionDefault(context, declaration, "darkness", file),
        near: optionDefault(context, declaration, "near", file),
        far: context.numericValue(fallback.whenTrue, file),
    };
}

/** The depth state the pin's own shadow target names. */
interface PinnedShadowTarget {
    /** `dFormat`, as the pin spells it. */
    format: string;
    /** `samples`. */
    samples: number;
    /** `_depthCompare`, as this runtime's own enumerator. */
    compare: string;
    /** `_depthClearValue`. */
    clear: number;
}

/**
 * The GPU state the generator builds, read here and emitted below.
 *
 * Each of these is a value the pin states once and both backends have to
 * agree with. Reading them is not enough on its own — a value a PAL types
 * out anyway goes stale whatever this asserts — so the target's four
 * decisions are RETURNED and emitted as constants, the way
 * `pinned-depth-state.ts` emits the convention they are the exception to.
 */
function assertPcfResourceContracts(
    context: LoweringContext,
): PinnedShadowTarget {
    const { file, declaration } = context.functionDeclaration(
        spotModule,
        "createPcfSpotlightShadowGenerator",
    );
    const texture = context.callObjectArgument(
        declaration,
        "createTexture",
    );
    if (
        context.stringValue(
            context.propertyInitializer(texture, "format"),
            file,
        ) !== "depth32float"
    ) {
        context.contractError(
            texture,
            "Pinned PCF shadow map is no longer depth32float.",
        );
    }
    context.assertExpressionShape(
        context.propertyInitializer(texture, "usage"),
        "TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING",
        "Pinned PCF shadow map usage",
    );
    const sampler = context.callObjectArgument(
        declaration,
        "createSampler",
    );
    for (const [property, value] of [
        ["compare", "less"],
        ["magFilter", "linear"],
        ["minFilter", "linear"],
    ] as const) {
        if (
            context.stringValue(
                context.propertyInitializer(sampler, property),
                file,
            ) !== value
        ) {
            context.contractError(
                sampler,
                `Pinned PCF receiver sampler '${property}' is no longer ` +
                    `'${value}'.`,
            );
        }
    }
    // `shadowsInfo` is what the composed fragment reads by index, and the
    // params UBO's depthScale slot carries the texel size for PCF.
    context.assertExpressionShape(
        context.variableInitializer(declaration, "_shadowsInfo"),
        "new F32([darkness, mapSize, 1.0 / mapSize, 0])",
        "Pinned PCF shadowsInfo",
    );
    context.assertExpressionShape(
        context.variableInitializer(declaration, "_depthValues"),
        "new F32([0, far])",
        "Pinned PCF depth values",
    );
    // The render target the task wraps: standard-Z, cleared far, one sample.
    const { file: baseFile, declaration: targetDeclaration } =
        context.functionDeclaration(baseModule, "createShadowRenderTarget");
    const descriptor = context.returnObject(targetDeclaration);
    const target = context.propertyInitializer(descriptor, "_descriptor");
    if (!ts.isObjectLiteralExpression(context.unwrapExpression(target))) {
        context.contractError(target, "Expected a descriptor literal.");
    }
    const targetLiteral = context.unwrapExpression(
        target,
    ) as ts.ObjectLiteralExpression;
    // The one sample count this runtime has no enumerator for: a
    // multisampled shadow map would need a resolve before the receiver
    // could sample it, which the pin does not build. Read rather than
    // asserted away: what the PALs apply is this value, so a pin that
    // changed it would change what they apply and not merely fail here.
    const samples = context.numericValue(
        context.propertyInitializer(targetLiteral, "samples"),
        baseFile,
    );
    if (samples !== 1) {
        context.contractError(
            targetLiteral,
            "Pinned shadow render target is no longer single-sample.",
        );
    }
    const format = context.stringValue(
        context.propertyInitializer(targetLiteral, "dFormat"),
        baseFile,
    );
    if (format !== "depth32float") {
        context.contractError(
            targetLiteral,
            `Pinned shadow map is '${format}', which this runtime has no ` +
                "sampled depth format for.",
        );
    }
    return {
        format,
        samples,
        compare: nativeDepthCompare(
            context.stringValue(
                context.propertyInitializer(targetLiteral, "_depthCompare"),
                baseFile,
            ),
        ),
        clear: context.numericValue(
            context.propertyInitializer(targetLiteral, "_depthClearValue"),
            baseFile,
        ),
    };
}

/**
 * The pinned render gate, anchored where each generator states it.
 *
 * All three `render*ShadowMap` hooks open the same way: read the casters'
 * summed version and the light's world-matrix version, and return before
 * the matrix fit, the caster pass and (for ESM) both blur passes when
 * nothing moved since the last render. The single-map generators fold the
 * floating-origin offset's version in beside those two; the CSM one folds
 * the active camera's change key and aspect instead, because its cascade is
 * fitted to the camera frustum. `forceRefreshEveryFrame` disables the gate,
 * and a fresh task state's `-1` sentinels make the first frame render.
 *
 * Each condition is asserted against the pin's own text and the mirrored
 * C++ below is what both backends execute, so a pin that changes which
 * versions gate the render refuses generation here rather than leaving the
 * port refreshing on a different rule.
 */
function assertShadowRenderGateContracts(context: LoweringContext): void {
    const singleMapGate =
        "!sg._config._forceRefreshEveryFrame && " +
        "casterVersion === state._lastCasterVersion && " +
        "lightVersion === state._lastLightVersion && " +
        "foVersion === state._lastFoVersion";
    for (const [module, renderer, ensure, stateLocal] of [
        [esmModule, "renderEsmShadowMap", "ensureEsmShadowTaskState", "taskState"],
        [hooksModule, "renderPcfShadowMap", "ensurePcfShadowTaskState", "state"],
    ] as const) {
        const { file, declaration } = context.functionDeclaration(
            module,
            renderer,
        );
        context.expectShapeCount(
            declaration,
            singleMapGate,
            `${renderer} render gate`,
        );
        // The three signals the gate compares, each read where the pin
        // reads it: the caster sum, the light's world version, and the
        // floating-origin camera's version (zero with the mode off).
        context.expectShapeCount(
            declaration,
            "casterVersionSum(casterMeshes)",
            `${renderer} caster version read`,
        );
        context.expectShapeCount(
            declaration,
            "sg._light.worldMatrixVersion",
            `${renderer} light version read`,
        );
        context.expectShapeCount(
            declaration,
            "foCam ? foCam.worldMatrixVersion : 0",
            `${renderer} floating-origin version read`,
        );
        // A fresh task state renders its first frame: every `_last*` lane
        // starts at -1, which no live version sum equals.
        const { declaration: ensureDeclaration } =
            context.functionDeclaration(module, ensure);
        // The identity test that makes `caster_list_version` the right
        // mirror: the pin rebuilds this state — fresh -1 sentinels, so a
        // forced next render — exactly when `ensure*` is handed a new
        // caster ARRAY, not new contents.
        context.expectShapeCount(
            ensureDeclaration,
            "existing._casterMeshes === casterMeshes",
            `${ensure} caster-array identity`,
        );
        const taskState = context.unwrapExpression(
            context.variableInitializer(ensureDeclaration, stateLocal),
        );
        if (!ts.isObjectLiteralExpression(taskState)) {
            context.contractError(
                taskState,
                `Expected pinned ${ensure} to build its state literal.`,
            );
        }
        for (const lane of [
            "_lastCasterVersion",
            "_lastLightVersion",
            "_lastFoVersion",
        ]) {
            if (
                context.numericValue(
                    context.propertyInitializer(taskState, lane),
                    file,
                ) !== -1
            ) {
                context.contractError(
                    taskState,
                    `Expected pinned ${ensure} to seed ${lane} at -1.`,
                );
            }
        }
    }
    // The CSM gate swaps the floating-origin term for the camera the
    // cascade is fitted to: its change key and the fitted aspect.
    const { declaration: csmRender } = context.functionDeclaration(
        csmHooksModule,
        "renderCsmShadowMap",
    );
    context.expectShapeCount(
        csmRender,
        "!cfg._forceRefreshEveryFrame && " +
            "casterVersion === state._lastCasterVersion && " +
            "lightVersion === state._lastLightVersion && " +
            "camVersion === state._lastCamVersion && " +
            "camAspect === state._lastCamAspect",
        "renderCsmShadowMap render gate",
    );
    // The caster sum itself: worldMatrixVersion (bumped eagerly per write
    // and pushed down the subtree, which is `MeshRecord::transform_version`
    // to the letter) plus the thin-instance pool's version, with the pin's
    // `~~` mapping an absent pool to the zero an unbound `instance_version`
    // holds.
    const { declaration: sumDeclaration } = context.functionDeclaration(
        baseModule,
        "casterVersionSum",
    );
    context.expectShapeCount(
        sumDeclaration,
        "sum += mesh.worldMatrixVersion + " +
            "~~(mesh.thinInstances?._version as number)",
        "casterVersionSum per-caster term",
    );
    // `forceRefreshEveryFrame ?? false` on all four factories. ESM, CSM and
    // PCF DIRECTIONAL carry it into the record: what the emitted gate's
    // disable flag defaults from. The PCF SPOT factory reads the same
    // default while the port still refuses the option there, so its anchor
    // holds the shape a future pin could quietly start carrying somewhere
    // the port drops it.
    const { declaration: esmFactory } = context.functionDeclaration(
        esmModule,
        "createEsmDirectionalShadowGenerator",
    );
    context.expectShapeCount(
        esmFactory,
        "cfg.forceRefreshEveryFrame ?? false",
        "ESM forceRefreshEveryFrame default",
    );
    const { declaration: csmFactory } = context.functionDeclaration(
        csmModule,
        "createCsmDirectionalShadowGenerator",
    );
    context.expectShapeCount(
        csmFactory,
        "cfg.forceRefreshEveryFrame ?? false",
        "CSM forceRefreshEveryFrame default",
    );
    const { declaration: pcfDirectionalFactory } =
        context.functionDeclaration(
            pcfDirectionalModule,
            "createPcfDirectionalShadowGenerator",
        );
    context.expectShapeCount(
        pcfDirectionalFactory,
        "cfg.forceRefreshEveryFrame ?? false",
        "PCF directional forceRefreshEveryFrame default",
    );
    const { declaration: spotFactory } = context.functionDeclaration(
        spotModule,
        "createPcfSpotlightShadowGenerator",
    );
    context.expectShapeCount(
        spotFactory,
        "cfg.forceRefreshEveryFrame ?? false",
        "PCF spot forceRefreshEveryFrame default",
    );
    // The morph-bounds provider. Its expansion is transcribed rather than
    // lowered -- the pinned body is a method on an object literal, which
    // `lowerPinnedFunction` does not reach -- so the shape is pinned here
    // instead, and these two lines are what a pinned change has to survive.
    // Without them an upstream edit to the weighting compiles clean and
    // fits a different volume.
    const { declaration: morphProvider } = context.functionDeclaration(
        "src/shadow/enable-morph-target-shadows.ts",
        "enableMorphTargetShadows",
    );
    context.expectShapeCount(
        morphProvider,
        "enableDeformableShadowBounds(generator, morphBoundsProvider)",
        "morph-target shadow bounds registration",
    );
    context.expectShapeCount(
        context.sourceFile("src/shadow/enable-morph-target-shadows.ts"),
        "min[axis] = min[axis]! + targetMin[axis]! * weight",
        "morph-target shadow bounds expansion",
    );
}

/** The pinned WebGPU filter string, as this header's own enum. */
function esmFilter(filter: string): string {
    if (filter === "linear") return "linear";
    if (filter === "nearest") return "nearest";
    throw new Error(
        `The pinned ESM factory asked for a '${filter}' filter, which ` +
            "this port has no name for.",
    );
}

/** The pinned WebGPU format string, as this header's own enum. */
function esmTextureFormat(format: string): string {
    if (format === "rgba16float") return "rgba16_float";
    if (format === "depth32float") return "depth32_float";
    throw new Error(
        `The pinned ESM factory built a '${format}' texture, which this ` +
            "port has no format for.",
    );
}

/** Where one generator's blur stages deploy, by ESM reach ordinal. */
export function esmBlurStem(index: number): string {
    return `shadow-blur-${index}`;
}

/**
 * The resources each ESM generator's own factory asked its device for.
 *
 * Nothing here is described: the descriptors are what the pinned factory
 * built when generation ran it, so a pin that changed a format, an extent
 * or a usage changes this table without anything being re-read.
 */
export function esmShadowHeader(
    provenance: string,
    shadows: readonly ComposedEsmShadow[],
): string {
    const rows = shadows.map((shadow, index) => {
        const textures = shadow.textures
            .map(
                (texture) =>
                    `            {${texture.width}u, ` +
                    `${texture.height}u, EsmTextureFormat::${
                        esmTextureFormat(texture.format)
                    }},`,
            )
            .join("\n");
        const directions = shadow.blurDirections
            .map(
                (values) =>
                    `            {${values
                        .map((value) => floatLiteral(value))
                        .join(", ")}},`,
            )
            .join("\n");
        return `    // Generator ${index}: ${
            shadow.textures[0]!.width
        }x${shadow.textures[0]!.height} map, blurred at ${
            shadow.textures[2]!.width
        }x${shadow.textures[2]!.height}.
    EsmShadowResources{
        std::array<EsmTextureDescriptor, 4>{{
${textures}
        }},
        std::array<std::array<float, 4>, 2>{{
${directions}
        }},
        EsmTextureFormat::${esmTextureFormat(shadow.blurTargetFormat)},
        {EsmFilter::${esmFilter(shadow.blurSampler.magFilter)}, ` +
            `EsmFilter::${esmFilter(shadow.blurSampler.minFilter)}},
    },`;
    });
    return `#pragma once

// ${provenance}

#include <algorithm>
#include <array>
#include <cstdint>

#include <bblite/runtime.hpp>

namespace bbl::upstream {

/**
 * The formats the pinned ESM factory asked for. Only these two appear
 * because only these two were recorded; a pin that used another fails at
 * generation rather than being mapped onto a neighbour here.
 */
enum class EsmTextureFormat {
    rgba16_float,
    depth32_float,
};

/** One texture the pinned ESM factory built, with its own descriptor. */
struct EsmTextureDescriptor {
    std::uint32_t width;
    std::uint32_t height;
    EsmTextureFormat format;
};

/** The filters \`getBilinearSampler\`'s descriptor named. */
enum class EsmFilter {
    nearest,
    linear,
};

/**
 * One generator's resources, in the pinned factory's own creation order:
 * the ESM colour map, its depth buffer, and the two blur halves. The
 * receiver samples the LAST of them, which is what \`sg._depthTexture\` is.
 */
struct EsmShadowResources {
    std::array<EsmTextureDescriptor, 4> textures;
    /** \`blurHData\` then \`blurVData\`: one texel step per pass. */
    std::array<std::array<float, 4>, 2> blur_directions;
    /** The one colour target \`blurPipeline\` declares. */
    EsmTextureFormat blur_target_format;
    /** \`getBilinearSampler\`'s magnify and minify filters. */
    struct {
        EsmFilter magnify;
        EsmFilter minify;
    } blur_sampler;
};

inline constexpr std::array<EsmShadowResources, ${shadows.length}>
    esm_shadow_resources{{
${rows.join("\n")}
}};

} // namespace bbl::upstream
`;
}

/**
 * `createShadowParamsUBO`, whole: the caster block the ESM view reads.
 *
 * The pinned factory writes four of eight floats and leaves the rest zero,
 * and the composed caster fragment declares those eight as
 * `{ biasAndScale, depthValues }`. Lowering the writer's own body is what
 * keeps the two agreeing: a pin that moved `depthScale` to another lane
 * moves this emission with it.
 */
function lowerShadowParamsBlock(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        baseModule,
        "createShadowParamsUBO",
    );
    const lowerer = new PinnedNumericLowerer(file, {
        bindings: new Map<string, PinnedBinding>([
            ["engine", { cpp: "0.0", type: "scalar" }],
            ["bias", { cpp: "generator.bias", type: "scalar" }],
            ["depthScale", { cpp: "generator.depth_scale", type: "scalar" }],
        ]),
        calls: new Map([
            [
                "createUniformBuffer",
                // The buffer is the PAL's to make; what the pin decides
                // is the bytes, so only the fill is lowered.
                (a: readonly string[]): string => a[1] ?? "data",
            ],
        ]),
        maybeUnusedConst: true,
        // The pin returns the buffer it filled; what this emits is the
        // fill, so the local those writes landed in IS the return value.
        returnValue: (): string => "data",
    });
    const body = declaration.body!.statements
        .flatMap((statement) => lowerer.statement(statement, "    "))
        .join("\n");
    return `// ${context.provenance(baseModule, "createShadowParamsUBO")}
inline std::array<float, 8> shadow_params_block(
    const ShadowGeneratorRecord& generator) {
${body}
}

/** Its size, for the caster stages that bind it. */
inline constexpr std::size_t shadow_params_block_bytes =
    8 * sizeof(float);`;
}

/** The generated header carrying the pinned shadow family. */
export function pinnedShadowHeader(context: LoweringContext): string {
    assertShadowUboLayout(context);
    assertShadowRenderGateContracts(context);
    const target = assertPcfResourceContracts(context);
    const defaults = pcfSpotDefaults(context);
    const esm = esmDefaults(context);
    const pcfDirectional = pcfDirectionalDefaults(context);
    const csm = csmDefaults(context);
    assertCsmCascadeFit(context);
    const csmUbo = assertCsmUboLayout(context);
    const mat4Invert = lowerMat4InvertCpp(context).replace(
        "\nstd::optional<std::array<float, 16>> mat4_invert(",
        "\ninline std::optional<std::array<float, 16>> mat4_invert(",
    );
    const casterFallback = esmCasterBoundsFallback(context);
    const trs = pinnedTrsComposition(context);
    const floats = (values: readonly number[]): string =>
        values.map((value) => floatLiteral(value)).join(", ");
    return `#pragma once

// ${context.provenance(baseModule, "buildLightViewMatrix")}
// ${context.provenance(spotModule, "createPcfSpotlightShadowGenerator")}

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <optional>
#include <vector>

#include <bblite/js_data.hpp>
#include <bblite/runtime.hpp>
#include <bblite/upstream/renderer_plan.hpp>

namespace bbl::upstream {

/** The pin's own defaults for a spot-light PCF generator. */
inline constexpr std::uint32_t pcf_spot_default_map_size =
    ${defaults.mapSize}u;
inline constexpr double pcf_spot_default_bias = ${
        context.doubleLiteral(defaults.bias)
    };
inline constexpr double pcf_spot_default_darkness = ${
        context.doubleLiteral(defaults.darkness)
    };
inline constexpr double pcf_spot_default_near = ${
        context.doubleLiteral(defaults.near)
    };
/** \`light.range === Number.MAX_VALUE ? 10000 : light.range\`. */
inline constexpr double pcf_spot_unbounded_far = ${
        context.doubleLiteral(defaults.far)
    };

/** The pin's own defaults for a directional-light PCF generator. */
inline constexpr std::uint32_t pcf_directional_default_map_size =
    ${pcfDirectional.mapSize}u;
inline constexpr double pcf_directional_default_bias = ${
        context.doubleLiteral(pcfDirectional.bias)
    };
inline constexpr double pcf_directional_default_darkness = ${
        context.doubleLiteral(pcfDirectional.darkness)
    };
inline constexpr double pcf_directional_default_ortho_min_z = ${
        context.doubleLiteral(pcfDirectional.orthoMinZ)
    };
inline constexpr double pcf_directional_default_ortho_max_z = ${
        context.doubleLiteral(pcfDirectional.orthoMaxZ)
    };

/** Defaults read from createCsmDirectionalShadowGenerator's own config. */
inline constexpr std::uint32_t csm_default_map_size = ${csm.mapSize}u;
inline constexpr std::uint32_t csm_default_num_cascades = ${csm.numCascades}u;
/**
 * The factory's \`Math.min(cfg.numCascades ?? N, MAX)\` clamp.
 *
 * The receiver block declares \`array<mat4x4<f32>, MAX>\` whatever a scene
 * asks for, so this bound -- not the default above -- is what the cascade
 * arrays and the 320-byte block are sized by.
 */
inline constexpr std::uint32_t csm_max_cascades = ${csm.maxCascades}u;
inline constexpr double csm_default_lambda = ${context.doubleLiteral(csm.lambda)};
inline constexpr double csm_default_cascade_blend_percentage = ${
        context.doubleLiteral(csm.cascadeBlendPercentage)
    };
inline constexpr double csm_default_bias = ${context.doubleLiteral(csm.bias)};
inline constexpr double csm_default_darkness = ${context.doubleLiteral(csm.darkness)};
inline constexpr double csm_default_frustum_edge_falloff = ${
        context.doubleLiteral(csm.frustumEdgeFalloff)
    };

/**
 * The pin's own shadow target, which is its ONE exception to this port's
 * depth convention: \`createShadowRenderTarget\` names standard-Z where
 * \`pinned_depth_state.hpp\` carries the reverse-Z every other family takes.
 * Emitted from that descriptor rather than typed into either PAL, for the
 * same reason the convention it excepts is.
 */
inline constexpr DepthCompare shadow_map_depth_compare =
    DepthCompare::${target.compare};
inline constexpr float shadow_map_depth_clear = ${floatLiteral(target.clear)};
/** \`samples\` on that same descriptor. */
inline constexpr std::uint32_t shadow_map_samples = ${target.samples}u;

/**
 * The receiver block the composed fragment declares
 * (\`shadowInfo_NUniforms\`), mirrored field for field over the pinned
 * writer's own float order.
 */
struct ShadowInfoUniforms {
    std::array<float, 16> lightMatrix{};
    std::array<float, 4> depthValues{};
    std::array<float, 4> shadowsInfo{};
};
static_assert(sizeof(ShadowInfoUniforms) == 96);

/**
 * The CASCADED receiver's own block (\`csmInfo_NUniforms\`), which is a
 * different declaration and a different size.
 *
 * \`createCsmDirectionalShadowGenerator\` allocates it as
 * \`new Float32Array(80)\` and \`_writeCsmUbo\` fills it; the field order
 * here mirrors that writer's own float order, asserted against it at
 * generation.
 */
struct CsmInfoUniforms {
    std::array<std::array<float, 16>, csm_max_cascades> cascadeTransforms{};
    std::array<float, 4> viewFrustumZ{};
    std::array<float, 4> frustumLengths{};
    std::array<float, 4> shadowsInfo{};
    std::array<float, 4> csmParams{};
};
static_assert(sizeof(CsmInfoUniforms) == 320);

/**
 * What one generator publishes to its receivers: the bytes of ITS OWN
 * block, and how many there are.
 *
 * A single-map receiver's block is 96 bytes and a cascaded one's is 320,
 * and which one a row binds is the GENERATOR's answer rather than the
 * row's -- \`createShadowFragment\` picks a receiver's declaration from its
 * light's own filter, so a size fixed at the binding site would be right
 * for one family and wrong for the other. Both PALs read the size from
 * here.
 *
 * It is the CASCADE block's size unconditionally, not this scene's widest.
 * That costs a PCF- or ESM-only scene 224 bytes per generator in
 * \`ShadowRefreshState::blocks\` and in each backend's own generator
 * record, and 224 bytes per generator per frame in the memcmp that
 * decides whether to re-upload. Sizing it to the reached families needs
 * the same \`BBLITE_SHADOWS_CSM\` define that would gate the cascaded
 * third of this header out of those scenes, because
 * \`pinnedShadowHeader\` is not handed the feature list; both are one
 * entry in [TODO](../../TODO.md)'s shadow-family item. Stating the cost
 * here rather than in the doc's aspiration is what makes that entry
 * worth acting on.
 */
inline constexpr std::size_t shadow_receiver_block_bytes =
    sizeof(CsmInfoUniforms);

struct ShadowReceiverBlock {
    alignas(16) std::array<std::byte, shadow_receiver_block_bytes> bytes{};
    std::uint32_t size = 0;
    friend bool operator==(
        const ShadowReceiverBlock&,
        const ShadowReceiverBlock&) = default;
};

/** One typed block, as the bytes a receiver binds. */
template <typename Block>
inline ShadowReceiverBlock shadow_receiver_bytes(const Block& block) {
    static_assert(sizeof(Block) <= shadow_receiver_block_bytes);
    ShadowReceiverBlock out{};
    std::memcpy(out.bytes.data(), &block, sizeof(Block));
    out.size = static_cast<std::uint32_t>(sizeof(Block));
    return out;
}

/** The pin's own defaults for a directional ESM generator. */
inline constexpr std::uint32_t esm_default_map_size = ${esm.mapSize}u;
inline constexpr double esm_default_depth_scale = ${
        context.doubleLiteral(esm.depthScale)
    };
inline constexpr double esm_default_bias = ${
        context.doubleLiteral(esm.bias)
    };
inline constexpr std::uint32_t esm_default_blur_kernel = ${
        esm.blurKernel
    }u;
inline constexpr std::uint32_t esm_default_blur_scale = ${
        esm.blurScale
    }u;
inline constexpr double esm_default_darkness = ${
        context.doubleLiteral(esm.darkness)
    };
inline constexpr double esm_default_frustum_edge_falloff = ${
        context.doubleLiteral(esm.frustumEdgeFalloff)
    };
inline constexpr double esm_default_ortho_min_z = ${
        context.doubleLiteral(esm.orthoMinZ)
    };
inline constexpr double esm_default_ortho_max_z = ${
        context.doubleLiteral(esm.orthoMaxZ)
    };

/** What \`_computeSpotLightMatrix\` returns. */
struct ShadowLightMatrix {
    std::array<float, 16> view{};
    std::array<float, 16> view_projection{};
    double near_plane = 0.0;
    double far_plane = 0.0;
};

/**
 * One caster, as \`computeDirectionalLightMatrix\` reads it.
 *
 * The pin walks \`Mesh\` objects; composing a mesh's world matrix is the
 * PAL's, so the PAL fills this carrier and the fold stays the pin's.
 */
struct ShadowCaster {
    std::array<double, 16> world{};
    /**
     * One active thin-instance matrix for the CSM caster fold. The pin
     * transforms a bound corner through this matrix and only then through
     * mesh.world; retaining both preserves that exact two-step arithmetic.
     */
    std::array<float, 16> instance{};
    bool has_instance = false;
    std::array<float, 3> bounds_min{};
    std::array<float, 3> bounds_max{};
};

/**
 * One caster's \`mesh.worldMatrix\`, composed by the pin's own writer.
 *
 * \`computeDirectionalLightMatrix\` multiplies each caster's AABB corners
 * through it. An unparented mesh keeps the double-width local composition;
 * a parented one reads the shared scene-graph composition, because the pin's
 * world matrix includes every mesh/transform-node ancestor.
 *
 * Kept at the composition's own DOUBLE width, unlike the narrowed world every
 * GPU consumer takes: the fit's first act is to subtract the eye from cell
 * 12, and \`MeshRecord::position\` is a \`Vec3d\` precisely so that
 * large-minus-large happens at full width. Narrowing here and widening back
 * inside the fold would round the large coordinate first, which at five
 * million units is half a unit of shadow-volume placement.
 */
inline std::array<double, 16> shadow_caster_local(
    const MeshRecord& mesh) {
${trs.composeLocalBody}\
    return local;
}

inline std::array<double, 16> shadow_caster_world(
    const Engine& engine,
    const MeshRecord& mesh) {
    std::array<double, 16> local{};
    if (
        mesh.parent.value < engine.meshes.size() ||
        mesh.transform_parent.value < engine.transform_nodes.size()) {
        const std::array<float, 16> parented =
            mesh_world_matrix(engine, mesh);
        std::copy(parented.begin(), parented.end(), local.begin());
    } else {
        local = shadow_caster_local(mesh);
    }
    return apply_mesh_outer_transform(mesh, local);
}

/** The pin's own \`mesh.boundMin ?? [...]\` fallback, for a caster with none. */
inline constexpr std::array<float, 3> shadow_caster_bounds_fallback_min{
    ${floats(casterFallback.min)}};
inline constexpr std::array<float, 3> shadow_caster_bounds_fallback_max{
    ${floats(casterFallback.max)}};


/**
 * enableMorphTargetShadows' bounds provider, as the caster fit reads it.
 *
 * The pin builds a PROXY mesh over the caster whose boundMin/boundMax are
 * these, and bumps a version so the fit refreshes; this port has one caster
 * carrier and fills its bounds directly, which is the same thing without the
 * prototype chain. The base is the mesh's own AABB -- upstream
 * computeAabb(mesh._cpuPositions), which is exactly what this port already
 * folded into geometry.bounds_min/max at load.
 *
 * Each target contributes its DELTA buffer's own AABB scaled by that
 * target's weight, and a NEGATIVE weight swaps which end of the range moves
 * which bound. Live, not folded at creation: the weights are what the scene
 * animates, and the whole point of the provider is that the ortho volume
 * follows them. Without it the fit bounds a scrambled mesh by its unmorphed
 * box and clips the caster.
 */
inline void expand_morph_caster_bounds(
    const std::vector<std::array<Vec3, 2>>& target_ranges,
    const float* weights,
    std::size_t weight_count,
    std::array<float, 3>& bounds_min,
    std::array<float, 3>& bounds_max) {
    for (std::size_t target = 0; target < target_ranges.size(); ++target) {
        const float weight =
            target < weight_count ? weights[target] : 0.0f;
        // The pin's guard tests the weight for FALSINESS, so a NaN weight
        // skips the target rather than poisoning the box. An equality
        // test against zero would let one through, and a NaN bound makes
        // the whole ortho fit NaN rather than one caster wrong.
        if (!(weight != 0.0f)) continue;
        const Vec3& low = target_ranges[target][0];
        const Vec3& high = target_ranges[target][1];
        const Vec3& target_min = weight < 0.0f ? high : low;
        const Vec3& target_max = weight < 0.0f ? low : high;
        const std::array<float, 3> min_axes{
            target_min.x, target_min.y, target_min.z};
        const std::array<float, 3> max_axes{
            target_max.x, target_max.y, target_max.z};
        for (std::size_t axis = 0; axis < 3; ++axis) {
            bounds_min[axis] = bounds_min[axis] + min_axes[axis] * weight;
            bounds_max[axis] = bounds_max[axis] + max_axes[axis] * weight;
        }
    }
}

/**
 * The pin's cached per-target computeAabb, filled on first use.
 *
 * Upstream this is a WeakMap keyed on the mesh and invalidated when its
 * positions or target list change. Here the deltas live on the geometry,
 * and the one writer that can replace them -- createMorphTargets -- drops
 * this cache in the same breath, which is the same invalidation moved to
 * the write. The length test below is therefore a fill test, not the
 * freshness test it would have to be on its own: a replacement that kept
 * the length would not change it.
 */
inline void ensure_morph_target_ranges(const ModelGeometry& geometry) {
    if (geometry.morph_bounds.size() == geometry.morph_positions.size()) {
        return;
    }
    geometry.morph_bounds.clear();
    geometry.morph_bounds.reserve(geometry.morph_positions.size());
    for (const std::vector<Vec3>& deltas : geometry.morph_positions) {
        Vec3 low{
            std::numeric_limits<float>::infinity(),
            std::numeric_limits<float>::infinity(),
            std::numeric_limits<float>::infinity()};
        Vec3 high{
            -std::numeric_limits<float>::infinity(),
            -std::numeric_limits<float>::infinity(),
            -std::numeric_limits<float>::infinity()};
        for (const Vec3& delta : deltas) {
            low.x = std::min(low.x, delta.x);
            low.y = std::min(low.y, delta.y);
            low.z = std::min(low.z, delta.z);
            high.x = std::max(high.x, delta.x);
            high.y = std::max(high.y, delta.y);
            high.z = std::max(high.z, delta.z);
        }
        geometry.morph_bounds.push_back(
            std::array<Vec3, 2>{low, high});
    }
}

${lowerBuildLightViewMatrix(context)}

${lowerBuildLightViewMatrixInto(context)}

${lowerMat4InvertToRefOrIdentity(context)}

${lowerOrthoViewInto(context)}

${lowerMultiply4x4(context)}

${lowerComputeSpotLightMatrix(context)}

${lowerComputeDirectionalLightMatrix(context)}

${lowerBiasViewProjection(context)}

${mat4Invert}

${lowerShadowParamsBlock(context)}

/**
 * The receiver block for one generator, in the pinned writer's field order.
 *
 * \`writeShadowUboFields\` packs the light matrix, then the two depth values
 * with two zero floats behind them, then the four \`shadowsInfo\` lanes;
 * generation asserts each of those writes against this layout. What goes
 * IN those lanes is each factory's own, and is read from it.
 */
inline ShadowInfoUniforms shadow_info_block(
    const ShadowGeneratorRecord& generator) {
    [[maybe_unused]] const double map_size =
        static_cast<double>(generator.map_size);
    ShadowInfoUniforms block{};
    block.lightMatrix = generator.light_matrix;
    // \`_depthValues\` and \`_shadowsInfo\`, derived where they are read: each
    // pinned factory packs them from the values its own record carries,
    // so caching the packed form would be a second copy a later setter
    // could leave stale. The three factories pack three DIFFERENT
    // combinations, which is why the filter decides here rather than at
    // creation -- and why the arms are read off those factories.
${shadowBlockArms(context)}
}

// ${context.provenance(csmHooksModule, "_writeCsmUbo")}
/**
 * The CASCADED receiver's block, in \`_writeCsmUbo\`'s own float order.
 *
 * The pin fills its 80 floats: the N cascade transforms at 16-float
 * strides, the split distances at 64 and the slice lengths at 68, then the
 * four \`shadowsInfo\` lanes and the two \`csmParams\` the cascade select and
 * the cross-fade read. A slot past the cascade count is never read -- the
 * WGSL loop bound is \`csmParams.x\` -- and stays the zero \`out.fill(0)\`
 * leaves.
 */
inline CsmInfoUniforms csm_info_block(
    const ShadowGeneratorRecord& generator) {
    const double map_size = static_cast<double>(generator.map_size);
    const std::size_t count = generator.csm_cascades.size();
    CsmInfoUniforms block{};
    for (std::size_t index = 0; index < count; ++index) {
        block.cascadeTransforms[index] =
            generator.csm_cascades[index].transform;
        block.viewFrustumZ[index] = static_cast<float>(
            generator.csm_cascades[index].view_frustum_z);
        block.frustumLengths[index] = static_cast<float>(
            generator.csm_cascades[index].frustum_length);
    }
    block.shadowsInfo = {
        static_cast<float>(generator.darkness),
        static_cast<float>(map_size),
        static_cast<float>(1.0 / map_size),
        static_cast<float>(generator.frustum_edge_falloff)};
    block.csmParams = {
        static_cast<float>(count),
        static_cast<float>(
            generator.csm_cascade_blend_percentage == 0.0
                ? ${context.doubleLiteral(csmUbo.disabledBlendFactor)}
                : 1.0 / generator.csm_cascade_blend_percentage),
        0.0f,
        0.0f};
    return block;
}

/** Whichever block this generator's receivers bind. */
inline ShadowReceiverBlock shadow_receiver_block(
    const ShadowGeneratorRecord& generator) {
    return generator.filter == ShadowFilter::csm_directional
        ? shadow_receiver_bytes(csm_info_block(generator))
        : shadow_receiver_bytes(shadow_info_block(generator));
}

// ${context.provenance(
        esmModule,
        "renderEsmShadowMap",
        `${hooksModule}#renderPcfShadowMap, ` +
            `${csmHooksModule}#renderCsmShadowMap, and ` +
            `${baseModule}#casterVersionSum`,
    )}
/**
 * \`casterVersionSum\`: the casters' summed change signal.
 *
 * The pin sums \`mesh.worldMatrixVersion\` — bumped eagerly on every own
 * transform write and pushed down the subtree by \`world-matrix-state.ts\`,
 * which is \`mark_mesh_dirty\`'s contract for
 * \`MeshRecord::transform_version\` to the letter — plus the thin-instance
 * pool's \`_version\`, with \`~~\` mapping an absent pool to the zero an
 * unbound \`instance_version\` holds. Versions only grow, so an equal sum
 * means no term moved.
 *
 * A caster of a generator with morph-target bounds carries a THIRD term,
 * which is the pin's proxy mesh: \`enableDeformableShadowBounds\` defines
 * the proxy's \`worldMatrixVersion\` as the source's plus its own
 * \`_version\`, and bumps that whenever the recomputed bounds change. The
 * fit reads the proxy, so upstream a morph WEIGHT change re-renders the
 * shadow map even though no transform moved. Summing the weight version
 * here is that same signal: without it a scene that animates weights and
 * does not also force a refresh would hold a shadow map for a pose the
 * mesh has left.
 */
inline std::uint64_t shadow_caster_version_sum(
    const Engine& engine,
    const std::vector<MeshHandle>& caster_meshes,
    bool morph_shadow_bounds) {
    std::uint64_t sum = 0;
    for (const MeshHandle handle : caster_meshes) {
        if (handle.value >= engine.meshes.size()) continue;
        const MeshRecord& mesh = engine.meshes[handle.value];
        sum += mesh.transform_version + mesh.instance_version;
        if (morph_shadow_bounds) sum += mesh.morph_weights_version;
    }
    return sum;
}

/**
 * The \`_last*\` lanes a pinned task state keeps between frames, one per
 * generator and per backend, exactly as \`EsmTaskState\` / \`PcfTaskState\`
 * / \`CsmTaskState\` keep them on the task. \`rendered\` stands for the
 * pin's \`-1\` sentinels: a state that never rendered cannot skip.
 */
struct ShadowRefreshGate {
    std::uint64_t last_caster_version = 0;
    std::uint64_t last_caster_list_version = 0;
    Vec3 last_light_position{};
    Vec3 last_light_direction{};
    Vec3d last_fo_offset{};
    std::array<float, 16> last_camera_view_projection{};
    double last_camera_near = 0.0;
    double last_camera_far = 0.0;
    bool rendered = false;
    /** This frame's verdict, written beside the gate test by the shared
     *  \`refresh_shadow_generators\` walk and read by each backend's task
     *  loop: whether the caster pass (and, ESM, both blur passes) runs or
     *  the map keeps its last — bit-identical — content. Seeded due so a
     *  generator the walk has not visited renders rather than skips. */
    bool due = true;
};

/**
 * The CSM gate's camera terms — \`_cameraChangeKey(camera)\` and the
 * fitted aspect — as the values the single-map fit actually consumes: the
 * camera view-projection (the aspect is folded into its projection) and
 * the near/far pair the split formula reads directly.
 */
struct CsmCameraKey {
    std::array<float, 16> view_projection{};
    double near_plane = 0.0;
    double far_plane = 0.0;
};

/**
 * The pinned render gate: whether this generator's map must re-render.
 *
 * Every \`render*ShadowMap\` hook opens with the same test and returns
 * before the matrix fit, the caster pass and (ESM) both blur passes when
 * it holds; the map textures persist, so the receiver keeps sampling last
 * render's — bit-identical — content. The signals are the pin's own:
 *
 * - the casters' version sum, plus the caster LIST's identity — the pin
 *   rebuilds its task state (and so re-renders) when \`ensure*\` is handed
 *   a new caster array, which is what \`caster_list_version\` counts;
 * - the light's world-matrix version. The record has no counter, so the
 *   gate compares the two fields that version tracks — the light's
 *   position and direction — which every writer, setter and animated
 *   glTF light pose alike, goes through. A same-value write re-renders
 *   upstream and skips here, which no pixel can tell apart. A spot's
 *   \`angle\` IS a fit input, but writing it moves neither signal: the
 *   pin keys \`worldMatrixVersion\`, which an angle write does not bump,
 *   so BOTH sides keep the stale map — the port mirrors the pin's
 *   insensitivity, not just its coverage. Its \`range\` reaches neither
 *   side's fit at all: both resolve it into the projection's far plane
 *   at creation.
 * - single-map generators: the floating-origin offset the fit subtracts
 *   (the pin keys the FO camera's version; off the mode both sides hold
 *   constants). The CSM generator keys its fitted camera instead, and no
 *   floating-origin term — its own gate has none.
 *
 * \`forceRefreshEveryFrame\` disables the gate outright, and the first
 * frame always renders. The lanes update only on a render, as the pin's
 * do — except a forced generator's, which nothing can ever read again.
 */
inline bool shadow_refresh_due(
    const Engine& engine,
    const ShadowGeneratorRecord& generator,
    const LightRecord& light,
    Vec3d eye,
    const CsmCameraKey* csm_camera,
    ShadowRefreshGate& gate) {
    // The pin evaluates \`_forceRefreshEveryFrame\` first in its own
    // \`&&\` chain, so nothing else is read on a forced frame; returning
    // here is that same order, minus the version sum and the lane updates
    // a flag fixed at creation makes unreadable.
    if (generator.force_refresh_every_frame) return true;
    const std::uint64_t caster_version = shadow_caster_version_sum(
        engine, generator.caster_meshes, generator.morph_shadow_bounds);
    const bool camera_unchanged = csm_camera == nullptr
        ? eye.x == gate.last_fo_offset.x &&
            eye.y == gate.last_fo_offset.y &&
            eye.z == gate.last_fo_offset.z
        : csm_camera->view_projection ==
                gate.last_camera_view_projection &&
            csm_camera->near_plane == gate.last_camera_near &&
            csm_camera->far_plane == gate.last_camera_far;
    if (
        gate.rendered &&
        caster_version == gate.last_caster_version &&
        generator.caster_list_version == gate.last_caster_list_version &&
        light.position.x == gate.last_light_position.x &&
        light.position.y == gate.last_light_position.y &&
        light.position.z == gate.last_light_position.z &&
        light.direction.x == gate.last_light_direction.x &&
        light.direction.y == gate.last_light_direction.y &&
        light.direction.z == gate.last_light_direction.z &&
        camera_unchanged) {
        return false;
    }
    gate.rendered = true;
    gate.last_caster_version = caster_version;
    gate.last_caster_list_version = generator.caster_list_version;
    gate.last_light_position = light.position;
    gate.last_light_direction = light.direction;
    gate.last_fo_offset = eye;
    if (csm_camera != nullptr) {
        gate.last_camera_view_projection = csm_camera->view_projection;
        gate.last_camera_near = csm_camera->near_plane;
        gate.last_camera_far = csm_camera->far_plane;
    }
    return true;
}

/**
 * \`renderEsmShadowMap\`'s matrices, refreshed from the light and casters.
 *
 * Unlike the spot generator's, the ESM light matrix is NOT biased for the
 * caster pass: \`renderEsmShadowMap\` hands \`matrix._viewProj\` to both
 * \`sg._lightMatrix\` and \`updateShadowCameraBase\`, so one matrix serves
 * the receiver and the caster pass alike.
 */
inline void fit_directional_shadow(
    ShadowGeneratorRecord& generator,
    const LightRecord& light,
    const std::vector<ShadowCaster>& casters,
    Vec3d eye) {
    const ShadowLightMatrix matrix = compute_directional_light_matrix(
        light,
        casters,
        generator.ortho_min_z,
        generator.ortho_max_z,
        eye);
    generator.light_matrix = matrix.view_projection;
    generator.caster_view = matrix.view;
    generator.caster_view_projection = matrix.view_projection;
    // A directional light has no position to project from, so the near and
    // far planes come back OUT of the caster fit rather than going in.
    generator.near_plane = matrix.near_plane;
    generator.far_plane = matrix.far_plane;
}

inline void update_esm_directional_shadow(
    ShadowGeneratorRecord& generator,
    const LightRecord& light,
    const std::vector<ShadowCaster>& casters,
    Vec3d eye) {
    fit_directional_shadow(generator, light, casters, eye);
}

/**
 * \`renderPcfShadowMap\`'s two matrices, refreshed from the light.
 *
 * The receiver keeps the unbiased view-projection and the caster pass
 * renders through the biased one, which is the pin's own split: baking the
 * bias into the matrix the receiver samples with would shift the comparison
 * on both sides at once.
 */
inline void update_pcf_spot_shadow(
    ShadowGeneratorRecord& generator,
    const LightRecord& light,
    Vec3d eye) {
    const ShadowLightMatrix matrix = compute_spot_light_matrix(
        light,
        generator.near_plane,
        generator.far_plane,
        eye);
    generator.light_matrix = matrix.view_projection;
    generator.caster_view = matrix.view;
    generator.caster_view_projection =
        bias_view_projection(matrix.view_projection, generator.bias);
}

/**
 * The same two matrices for a DIRECTIONAL PCF generator.
 *
 * \`createPcfDirectionalShadowGenerator\` hands \`renderPcfShadowMap\` a
 * builder that calls \`computeDirectionalLightMatrix\` instead of the spot
 * volume, and nothing else about the generator changes -- so this is the
 * ESM's matrix source under the PCF's bias split. A directional light has
 * no position to project from, so the near and far planes come back OUT of
 * the caster fit rather than going in.
 */
inline void update_pcf_directional_shadow(
    ShadowGeneratorRecord& generator,
    const LightRecord& light,
    const std::vector<ShadowCaster>& casters,
    Vec3d eye) {
    fit_directional_shadow(generator, light, casters, eye);
    // The PCF split the spot generator also takes: the receiver keeps the
    // unbiased view-projection and the caster pass renders through the
    // biased one. It is the ONLY thing separating this from the ESM fit
    // above, which is why the fit itself is shared.
    generator.caster_view_projection =
        bias_view_projection(generator.light_matrix, generator.bias);
}

/**
 * \`_computeCsmCascades\`: one camera-frustum slice fitted per cascade.
 *
 * The split blends the pin's logarithmic and uniform partitions, each
 * slice's eight world corners are folded into a light-space AABB, the
 * caster AABB tightens the Z range, the orthographic projection is
 * multiplied straight into the cascade's light view, and the result is
 * texel-snapped in place. Every cascade keeps the PCF family's own matrix
 * split: the receiver samples with the unbiased \`transform\`, and that
 * cascade's caster pass renders through the biased copy.
 *
 * The pin computes into preallocated scratch storage and rounds at each
 * Float32Array store; the doubles below are its JavaScript numbers and
 * each \`static_cast<float>\` is one of those stores.
 */
inline void update_csm_cascades(
    ShadowGeneratorRecord& generator,
    const LightRecord& light,
    const CameraRecord& camera,
    double aspect,
    const std::vector<ShadowCaster>& casters) {
    const double near_z = camera.near_plane;
    const double far_z = camera.far_plane;
    const double camera_range = far_z - near_z;
    // \`cfg._shadowMaxZ ?? far\`: an unset one is the camera's own far plane,
    // which generation cannot see, so the record carries the absence.
    const double shadow_max_z =
        generator.csm_shadow_max_z.value_or(far_z);
    const double max_distance =
        (shadow_max_z < far_z && shadow_max_z >= near_z)
            ? std::min((shadow_max_z - near_z) / (far_z - near_z), 1.0)
            : 1.0;
    constexpr double min_distance = 0.0;
    const double min_z = near_z + min_distance * camera_range;
    const double max_z = near_z + max_distance * camera_range;
    const double range = max_z - min_z;
    const double ratio = max_z / min_z;
    // Clamped by the factory, where the pin clamps it.
    const std::size_t count = generator.csm_num_cascades;

    generator.csm_cascades.assign(count, ShadowCascade{});
    // Each slice's length is the distance from the previous split, the
    // first from the near plane; the split fractions below are rebuilt by
    // accumulating those lengths, exactly as the pin walks them.
    for (std::size_t index = 0; index < count; ++index) {
        const double p =
            static_cast<double>(index + 1) / static_cast<double>(count);
        const double logarithmic = min_z * std::pow(ratio, p);
        const double uniform = min_z + range * p;
        const double distance =
            generator.csm_lambda * (logarithmic - uniform) + uniform;
        ShadowCascade& slice = generator.csm_cascades[index];
        slice.view_frustum_z = distance;
        slice.frustum_length = distance -
            (index == 0
                ? min_z
                : generator.csm_cascades[index - 1].view_frustum_z);
    }

    double direction_x = light.direction.x;
    double direction_y = light.direction.y;
    double direction_z = light.direction.z;
    const double direction_length =
        bbl::js::hypot_js({direction_x, direction_y, direction_z});
    const double safe_length = direction_length == 0.0 ? 1.0 : direction_length;
    direction_x /= safe_length;
    direction_y /= safe_length;
    direction_z /= safe_length;
    if (std::abs(direction_y) >= 1.0) direction_z = 1e-13;

    const std::array<float, 16> view_projection =
        build_view_projection(camera, aspect);
    std::array<float, 16> inverse{};
    mat4_invert_to_ref_or_identity(view_projection, inverse);
    // \`transformCoordInto\`: a point through a 4x4 with the perspective
    // divide, written back over its input.
    const auto transform_point = [](
        std::array<double, 3>& point,
        const std::array<float, 16>& matrix) {
        const double x = point[0];
        const double y = point[1];
        const double z = point[2];
        const double tx = static_cast<double>(matrix[0]) * x +
            static_cast<double>(matrix[4]) * y +
            static_cast<double>(matrix[8]) * z + matrix[12];
        const double ty = static_cast<double>(matrix[1]) * x +
            static_cast<double>(matrix[5]) * y +
            static_cast<double>(matrix[9]) * z + matrix[13];
        const double tz = static_cast<double>(matrix[2]) * x +
            static_cast<double>(matrix[6]) * y +
            static_cast<double>(matrix[10]) * z + matrix[14];
        const double tw = static_cast<double>(matrix[3]) * x +
            static_cast<double>(matrix[7]) * y +
            static_cast<double>(matrix[11]) * z + matrix[15];
        point[0] = tx / tw;
        point[1] = ty / tw;
        point[2] = tz / tw;
    };
    // The pin's reverse-Z NDC corners: near at z=1, far at z=0.
    constexpr std::array<std::array<double, 3>, 8> ndc{{
        {{-1.0,  1.0, 1.0}}, {{ 1.0,  1.0, 1.0}},
        {{ 1.0, -1.0, 1.0}}, {{-1.0, -1.0, 1.0}},
        {{-1.0,  1.0, 0.0}}, {{ 1.0,  1.0, 0.0}},
        {{ 1.0, -1.0, 0.0}}, {{-1.0, -1.0, 0.0}},
    }};

    // \`_castersWorldAabbInto\`, once for every cascade: the union of each
    // caster's eight world-space bound corners.
    double caster_min_x = std::numeric_limits<double>::infinity();
    double caster_min_y = std::numeric_limits<double>::infinity();
    double caster_min_z = std::numeric_limits<double>::infinity();
    double caster_max_x = -std::numeric_limits<double>::infinity();
    double caster_max_y = -std::numeric_limits<double>::infinity();
    double caster_max_z = -std::numeric_limits<double>::infinity();
    for (const ShadowCaster& caster : casters) {
        for (std::size_t corner = 0; corner < 8; ++corner) {
            const double local_x = (corner & 1u)
                ? caster.bounds_max[0] : caster.bounds_min[0];
            const double local_y = (corner & 2u)
                ? caster.bounds_max[1] : caster.bounds_min[1];
            const double local_z = (corner & 4u)
                ? caster.bounds_max[2] : caster.bounds_min[2];
            const double instance_x = caster.has_instance
                ? caster.instance[0] * local_x +
                    caster.instance[4] * local_y +
                    caster.instance[8] * local_z + caster.instance[12]
                : local_x;
            const double instance_y = caster.has_instance
                ? caster.instance[1] * local_x +
                    caster.instance[5] * local_y +
                    caster.instance[9] * local_z + caster.instance[13]
                : local_y;
            const double instance_z = caster.has_instance
                ? caster.instance[2] * local_x +
                    caster.instance[6] * local_y +
                    caster.instance[10] * local_z + caster.instance[14]
                : local_z;
            const double world_x = caster.world[0] * instance_x +
                caster.world[4] * instance_y + caster.world[8] * instance_z +
                caster.world[12];
            const double world_y = caster.world[1] * instance_x +
                caster.world[5] * instance_y + caster.world[9] * instance_z +
                caster.world[13];
            const double world_z = caster.world[2] * instance_x +
                caster.world[6] * instance_y + caster.world[10] * instance_z +
                caster.world[14];
            caster_min_x = std::min(caster_min_x, world_x);
            caster_min_y = std::min(caster_min_y, world_y);
            caster_min_z = std::min(caster_min_z, world_z);
            caster_max_x = std::max(caster_max_x, world_x);
            caster_max_y = std::max(caster_max_y, world_y);
            caster_max_z = std::max(caster_max_z, world_z);
        }
    }
    const bool has_casters = std::isfinite(caster_min_x);

    double previous_split = 0.0;
    for (std::size_t cascade = 0; cascade < count; ++cascade) {
        const double split =
            previous_split +
            generator.csm_cascades[cascade].frustum_length / camera_range;

        std::array<std::array<double, 3>, 8> corners = ndc;
        for (auto& corner : corners) {
            transform_point(corner, inverse);
        }
        // Both ends of the slice ride the same near-to-far ray, so the far
        // corner is written from the ORIGINAL near corner before that one
        // is moved to the slice's own near plane.
        for (std::size_t index = 0; index < 4; ++index) {
            const auto near_corner = corners[index];
            const auto far_corner = corners[index + 4];
            for (std::size_t axis = 0; axis < 3; ++axis) {
                const double ray = far_corner[axis] - near_corner[axis];
                corners[index + 4][axis] = near_corner[axis] + ray * split;
                corners[index][axis] =
                    near_corner[axis] + ray * previous_split;
            }
        }
        previous_split = split;

        double center_x = 0.0;
        double center_y = 0.0;
        double center_z = 0.0;
        for (const auto& corner : corners) {
            center_x += corner[0];
            center_y += corner[1];
            center_z += corner[2];
        }
        center_x /= 8.0;
        center_y /= 8.0;
        center_z /= 8.0;

        // The non-stabilized arm: a temporary light view centred on the
        // centroid fits a tight box, and the corners are transformed in
        // place through it.
        std::array<float, 16> center_view{};
        build_light_view_matrix_into(
            center_view, direction_x, direction_y, direction_z,
            center_x, center_y, center_z);
        double min_x = std::numeric_limits<double>::infinity();
        double min_y = std::numeric_limits<double>::infinity();
        double min_eye_z = std::numeric_limits<double>::infinity();
        double max_x = -std::numeric_limits<double>::infinity();
        double max_y = -std::numeric_limits<double>::infinity();
        double max_eye_z = -std::numeric_limits<double>::infinity();
        for (auto& corner : corners) {
            transform_point(corner, center_view);
            min_x = std::min(min_x, corner[0]);
            max_x = std::max(max_x, corner[0]);
            min_y = std::min(min_y, corner[1]);
            max_y = std::max(max_y, corner[1]);
            min_eye_z = std::min(min_eye_z, corner[2]);
            max_eye_z = std::max(max_eye_z, corner[2]);
        }

        const double eye_x = center_x + direction_x * min_eye_z;
        const double eye_y = center_y + direction_y * min_eye_z;
        const double eye_z = center_z + direction_z * min_eye_z;
        std::array<float, 16> view{};
        build_light_view_matrix_into(
            view, direction_x, direction_y, direction_z, eye_x, eye_y, eye_z);
        double view_min_z = 0.0;
        double view_max_z = max_eye_z - min_eye_z;

        // \`depthClamp = false\` behaviour: every caster stays inside the
        // clip volume, so no GPU depth-clip feature is required.
        if (has_casters) {
            double caster_view_min_z = std::numeric_limits<double>::infinity();
            double caster_view_max_z = -std::numeric_limits<double>::infinity();
            for (std::size_t corner = 0; corner < 8; ++corner) {
                const double world_x =
                    (corner & 1u) ? caster_max_x : caster_min_x;
                const double world_y =
                    (corner & 2u) ? caster_max_y : caster_min_y;
                const double world_z =
                    (corner & 4u) ? caster_max_z : caster_min_z;
                const double z = view[2] * world_x + view[6] * world_y +
                    view[10] * world_z + view[14];
                caster_view_min_z = std::min(caster_view_min_z, z);
                caster_view_max_z = std::max(caster_view_max_z, z);
            }
            if (caster_view_min_z <= view_max_z) {
                view_min_z = std::min(view_min_z, caster_view_min_z);
                view_max_z = std::min(view_max_z, caster_view_max_z);
            }
        }
        // The pin widens the far plane by its world-space bias here; that
        // option is refused at generation, so the arm is not restated.

        std::array<float, 16> transform_matrix{};
        ortho_view_into(
            transform_matrix, view, min_x, max_x, min_y, max_y,
            view_min_z, view_max_z);
        // Texel snap on the transform's own translation, which is the
        // world origin's projection: the non-stabilized anchor.
        const double clip_x = transform_matrix[12];
        const double clip_y = transform_matrix[13];
        const double snap_x = clip_x * (generator.map_size / 2.0);
        const double snap_y = clip_y * (generator.map_size / 2.0);
        const double snap_offset_x =
            (bbl::js::round_js(snap_x) - snap_x) * (2.0 / generator.map_size);
        const double snap_offset_y =
            (bbl::js::round_js(snap_y) - snap_y) * (2.0 / generator.map_size);
        transform_matrix[12] = static_cast<float>(
            static_cast<double>(transform_matrix[12]) + snap_offset_x);
        transform_matrix[13] = static_cast<float>(
            static_cast<double>(transform_matrix[13]) + snap_offset_y);

        ShadowCascade& fitted = generator.csm_cascades[cascade];
        fitted.transform = transform_matrix;
        fitted.view = view;
        fitted.caster_view_projection =
            bias_view_projection(transform_matrix, generator.bias);
    }
}

} // namespace bbl::upstream
`;
}

/**
 * The native shadow surface: the generator factory, its caster-input
 * registration, and the scene registration that installs the task.
 *
 * The pin's `ShadowTask` is a scheduler over per-generator `RenderTask`s
 * (`ensurePcfShadowTaskState` builds one depth-only task per generator and
 * adds each caster through its material's own no-colour view), and this
 * repository already carries that render task. So what is emitted is the
 * same construction: a depth-only target over the generator's map, a task
 * naming the generator, and one caster mesh per no-colour view — added
 * ahead of the scene's own tasks the way `ensureShadowTask` unshifts the
 * scheduler.
 */
/**
 * One generator factory, as the three pinned families spell it.
 *
 * They differ in the light kind they demand, the options struct they take,
 * the fields they copy across and whether they fit a matrix eagerly. What
 * they share -- the handle check, the kind check, the record, the
 * `push_back` and the handle it returns -- is written once here, because a
 * fourth family should cost a row rather than a fourth copy of the frame.
 *
 * A directional generator writes no matrix at creation: its light matrix is
 * fitted to the CASTERS, which are registered after this returns, so the
 * first fit happens at the task's first frame.
 */
function shadowGeneratorFactory(spec: {
    name: string;
    options: string;
    article: string;
    lightKind: "spot" | "directional";
    filter?: string;
    fields: readonly string[];
    tail?: string;
}): string {
    const assignments = spec.fields
        .map((field) => `    generator.${field} = options.${field};`)
        .join("\n");
    return `ShadowGeneratorHandle create_${spec.name}_shadow_generator(
    Engine& engine,
    LightHandle light,
    ${spec.options} options) {
    if (light.value >= engine.lights.size()) {
        throw std::runtime_error("Invalid shadow generator light handle.");
    }
    if (engine.lights[light.value].kind != LightKind::${spec.lightKind}) {
        throw std::runtime_error(
            "${spec.article} requires a ${spec.lightKind} light.");
    }
    ShadowGeneratorRecord generator;
${spec.filter === undefined
        ? ""
        : `    generator.filter = ShadowFilter::${spec.filter};\n`}\
${assignments}
${spec.tail === undefined ? "" : `${spec.tail}\n`}\
    engine.shadow_generators.push_back(std::move(generator));
    return ShadowGeneratorHandle{
        static_cast<std::uint32_t>(engine.shadow_generators.size() - 1)};
}
`;
}

export function shadowFactorySource(
    context: LoweringContext,
    // The scene's own feature list, asked directly rather than through one
    // positional boolean per family: which generators it reached is already
    // stated there, and a fourth family would otherwise be a fourth
    // unlabelled argument at every call site.
    features: readonly string[] = [],
    // Whether any composed node graph carries an ESM caster module. A node
    // caster takes neither family's no-colour view -- its own module was
    // compiled beside the receiver's -- so the arm below exists only for a
    // scene that reached one. Not a feature: it is a property of what the
    // compose layer produced, not of what the scene asked for.
    nodeEsmCasters = false,
    // A node PCF caster is the pin's NODE_NO_COLOR_OUTPUT view: the same
    // graph recompiled with an empty colour-target list.
    nodePcfCasters = false,
): LoweredSource {
    // A PCF-only scene emits neither the ESM factory nor the caster view it
    // would ask for -- the view's own translation unit is not compiled
    // either.
    const esmShadows = features.includes("shadow:esm");
    // The directional PCF generator shares every resource the spot one
    // builds and differs only in the volume its light matrix is fitted with,
    // so what this gates is the factory alone -- no caster view, no second
    // map format, no receiver arm.
    const pcfDirectionalShadows = features.includes(
        "shadow:pcf-directional",
    );
    // The cascaded generator: a layered map, one caster pass per
    // cascade, and the 320-byte cascade block its receivers bind.
    const csmShadows = features.includes("shadow:csm");
    // One family's caster view, under the filter its task carries. The node
    // family has a second compiled module for both modes: ESM adds its
    // shadow-params binding, while PCF uses NODE_NO_COLOR_OUTPUT and adds no
    // caster-only binding.
    const nodeCasters = nodeEsmCasters || nodePcfCasters;
    const casterView = (family: "standard" | "pbr" | "node"): string => {
        const noColor = family === "node"
            ? `create_node_no_color_material_view(engine, material)`
            : `create_${family}_no_color_material_view(engine, material)`;
        if (!esmShadows) return noColor;
        // The ESM view is defined per FAMILY, and the node family's exists
        // only where a composed node graph carries an ESM caster module --
        // so the cell for a scene that reaches an ESM generator whose
        // casters are all Standard or PBR has nothing to call. It is also
        // unreachable: with no such module a node material cannot be that
        // generator's caster at all. Say so by name rather than falling
        // back to the no-colour view, which writes the wrong depth
        // encoding into an ESM map.
        const esmView = family !== "node" || nodeEsmCasters
            ? `create_${family}_esm_shadow_material_view(
                        engine,
                        material,
                        handle)`
            : `throw std::runtime_error(
                        "This scene composed no node ESM caster module, "
                        "so a node material cannot cast into an ESM "
                        "shadow generator.")`;
        return `(esm
                    ? ${esmView}
                    : ${noColor})`;
    };
    // The two contracts the emitted registration mirrors, read so a pin that
    // moves either fails here rather than leaving the emission stale.
    const { declaration: registerDeclaration } = context.functionDeclaration(
        sceneModule,
        "registerSceneWithShadowSupport",
    );
    context.callExpression(registerDeclaration, "ensureShadowTask");
    const { file: coreFile, declaration: ensureDeclaration } =
        context.functionDeclaration(sceneModule, "ensureShadowTask");
    const unshift = context.callExpression(ensureDeclaration, "unshift");
    if (
        !ts.isPropertyAccessExpression(unshift.expression) ||
        unshift.expression.expression.getText(coreFile) !==
            "scene._frameGraph._tasks"
    ) {
        context.contractError(
            unshift,
            "Expected the shadow task to be unshifted onto the scene's " +
                "frame-graph task list.",
        );
    }
    const { declaration: stateDeclaration } = context.functionDeclaration(
        hooksModule,
        "ensurePcfShadowTaskState",
    );
    const taskOptions = context.callObjectArgument(
        stateDeclaration,
        "createRenderTask",
    );
    if (
        context.propertyInitializer(taskOptions, "clr").kind !==
        ts.SyntaxKind.TrueKeyword
    ) {
        context.contractError(
            taskOptions,
            "Expected the PCF shadow task to clear its depth attachment.",
        );
    }
    if (csmShadows) {
        // The cascaded task state, whose per-layer construction
        // `build_shadow_task` mirrors: one CLEARING depth-only task per
        // cascade over a single-layer view of the generator's own depth
        // array, which is borrowed rather than owned.
        const { declaration: csmState } = context.functionDeclaration(
            csmHooksModule,
            "ensureCsmShadowTaskState",
        );
        const csmTaskOptions = context.callObjectArgument(
            csmState,
            "createRenderTask",
        );
        if (
            context.propertyInitializer(csmTaskOptions, "clr").kind !==
            ts.SyntaxKind.TrueKeyword
        ) {
            context.contractError(
                csmTaskOptions,
                "Expected each CSM cascade task to clear its layer.",
            );
        }
        const objectLiteral = (
            expression: ts.Expression,
            what: string,
        ): ts.ObjectLiteralExpression => {
            const node = context.unwrapExpression(expression);
            return ts.isObjectLiteralExpression(node)
                ? node
                : context.contractError(
                      node,
                      `Expected the pinned CSM ${what} to be an object ` +
                          "literal.",
                  );
        };
        const csmTarget = objectLiteral(
            context.variableInitializer(csmState, "rt"),
            "cascade render target",
        );
        // The map is the pin's one standard-Z target, and the cascade's
        // view of it is BORROWED -- the depth array belongs to the
        // generator, so no cascade owns or releases it.
        const csmDescriptor = objectLiteral(
            context.propertyInitializer(csmTarget, "_descriptor"),
            "cascade target descriptor",
        );
        for (const [owner, name, shape] of [
            [csmDescriptor, "dFormat", '"depth32float"'],
            [csmDescriptor, "_depthCompare", '"less-equal"'],
            [csmTarget, "_ownsDepthTexture", "false"],
        ] as const) {
            context.assertExpressionShape(
                context.propertyInitializer(owner, name),
                shape,
                `Pinned CSM cascade target '${name}'`,
            );
        }
        context.assertExpressionShape(
            context.variableInitializer(csmState, "layerView"),
            'sg._depthTexture.createView({ dimension: "2d", ' +
                "baseArrayLayer: i, arrayLayerCount: 1 })",
            "Pinned CSM cascade layer view",
        );
        // Every caster is added to every cascade below its own cap. The cap
        // is `setShadowCasterMaxCascade`, which this port refuses -- so the
        // arm must stay the `?? i` identity that makes the test vacuous.
        context.expectShapeCount(
            csmState,
            "i <= (mesh._shadowMaxCascade ?? i)",
            "Pinned CSM caster cascade cap",
        );
    }
    return {
        modulePath: spotModule,
        symbolName: "createPcfSpotlightShadowGenerator",
        header: "",
        source: `// ${context.provenance(
            spotModule,
            "createPcfSpotlightShadowGenerator",
            `${baseModule}#createShadowRenderTarget, ${hooksModule}#ensurePcfShadowTaskState, and ${sceneModule}#registerSceneWithShadowSupport`,
        )}
#include <bblite/runtime.hpp>
#include <bblite/upstream/pinned_shadow.hpp>

#include <algorithm>
#include <stdexcept>
#include <utility>

namespace bbl {

${shadowGeneratorFactory({
    name: "pcf_spotlight",
    options: "PcfSpotShadowOptions",
    article: "A PCF spotlight shadow generator",
    lightKind: "spot",
    fields: ["map_size", "bias", "darkness", "near_plane", "far_plane"],
    // A first fit before any frame. The pin leaves `_lightMatrix` zero until
    // `renderPcfShadowMap` runs, so this is this port's own eagerness rather
    // than the factory's -- harmless because the refresh runs before the
    // first draw, and taken at the zero offset because a camera that has not
    // moved is the zero offset in either mode.
    tail: `    upstream::update_pcf_spot_shadow(
        generator, engine.lights[light.value], Vec3d{});`,
})}
${!pcfDirectionalShadows ? "" : shadowGeneratorFactory({
    name: "pcf_directional",
    options: "PcfDirectionalShadowOptions",
    article: "A PCF directional shadow generator",
    lightKind: "directional",
    filter: "pcf_directional",
    fields: [
        "map_size",
        "bias",
        "darkness",
        "ortho_min_z",
        "ortho_max_z",
        "force_refresh_every_frame",
    ],
})}
${!csmShadows ? "" : shadowGeneratorFactory({
    name: "csm_directional",
    options: "CsmDirectionalShadowOptions",
    article: "A CSM directional shadow generator",
    lightKind: "directional",
    filter: "csm_directional",
    fields: [
        "map_size",
        "csm_lambda",
        "csm_cascade_blend_percentage",
        "csm_shadow_max_z",
        "bias",
        "darkness",
        "frustum_edge_falloff",
        "force_refresh_every_frame",
    ],
    // \`Math.min(cfg.numCascades ?? N, MAX)\`, applied where the pin
    // applies it: the fit, the layered map and its caster passes then all
    // read one already-clamped count off the record.
    tail: `    generator.csm_num_cascades = std::min(
        options.csm_num_cascades, upstream::csm_max_cascades);`,
})}
${!esmShadows ? "" : shadowGeneratorFactory({
    name: "esm_directional",
    options: "EsmDirectionalShadowOptions",
    article: "An ESM shadow generator",
    lightKind: "directional",
    filter: "esm_directional",
    fields: [
        "map_size",
        "bias",
        "darkness",
        "depth_scale",
        "frustum_edge_falloff",
        "ortho_min_z",
        "ortho_max_z",
        "force_refresh_every_frame",
        "esm_index",
    ],
})}
namespace {

MaterialHandle shadow_caster_view(
    Engine& engine,
    ShadowGeneratorHandle handle,
    MaterialHandle material) {
    ShadowGeneratorRecord& generator =
        engine.shadow_generators[handle.value];
    for (std::size_t index = 0;
         index < generator.caster_material_sources.size();
         ++index) {
        if (generator.caster_material_sources[index].value == material.value) {
            return generator.caster_material_views[index];
        }
    }
${esmShadows ? `    const bool esm =
        generator.filter == ShadowFilter::esm_directional;
` : ""}\
    const MaterialRecord& source = engine.materials[material.value];
    const MaterialHandle view =
        source.shadow_caster_material.value != invalid_handle
            ? source.shadow_caster_material
            : ${nodeCasters ? `source.node_material
            ? ${casterView("node")}
            : ` : ""}source.standard_material
            ? ${casterView("standard")}
            : ${casterView("pbr")};
    generator.caster_material_sources.push_back(material);
    generator.caster_material_views.push_back(view);
    return view;
}

void refresh_shadow_task_meshes(
    Engine& engine,
    ShadowGeneratorHandle handle) {
    ShadowGeneratorRecord& generator =
        engine.shadow_generators[handle.value];
    if (generator.caster_tasks.empty()) return;
    // A cascaded generator owns one caster pass per cascade layer, and the
    // pin adds every caster to each of them (\`ensureCsmShadowTaskState\`
    // loops the caster set inside its per-cascade task build). One
    // generator's tasks therefore carry one mesh list, filled here once
    // per task.
    for (const TaskHandle task_handle : generator.caster_tasks) {
        FrameTaskRecord& task = engine.frame_tasks[task_handle.value];
        task.render_meshes.clear();
        for (const MeshHandle mesh : generator.caster_meshes) {
            const MeshRecord& record = engine.meshes[mesh.value];
            // Invisible anchors participate in the light-volume fit but
            // the pin's normal renderable traversal does not draw them.
            if (!record.visible) continue;
            const MaterialHandle material = record.material;
            if (material.value >= engine.materials.size()) {
                throw std::runtime_error(
                    std::string("Visible shadow caster '") + record.name +
                    "' (mesh " + std::to_string(mesh.value) +
                    ") carries invalid material " +
                    std::to_string(material.value) + ".");
            }
            add_render_task_mesh(
                engine,
                task_handle,
                mesh,
                shadow_caster_view(engine, handle, material));
        }
    }
}

} // namespace

// src/shadow/enable-morph-target-shadows.ts enableMorphTargetShadows:
// register the morph bounds provider on this generator. Upstream that
// installs a provider object into a WeakMap and wraps each caster in a
// proxy mesh whose boundMin/boundMax it rewrites per frame; this port has
// one caster carrier per fit, so the flag is read where that carrier is
// filled and the proxy has nothing left to do.
void enable_morph_target_shadows(
    Engine& engine,
    ShadowGeneratorHandle generator) {
    if (generator.value >= engine.shadow_generators.size()) {
        throw std::runtime_error("Invalid shadow generator handle.");
    }
    engine.shadow_generators[generator.value].morph_shadow_bounds = true;
}

void set_shadow_task_caster_meshes(
    Engine& engine,
    ShadowGeneratorHandle generator,
    std::vector<MeshHandle> caster_meshes) {
    if (generator.value >= engine.shadow_generators.size()) {
        throw std::runtime_error("Invalid shadow generator handle.");
    }
    for (const MeshHandle mesh : caster_meshes) {
        if (mesh.value >= engine.meshes.size()) {
            throw std::runtime_error("Invalid shadow caster mesh handle.");
        }
    }
    engine.shadow_generators[generator.value].caster_meshes =
        std::move(caster_meshes);
    // The pin's ensure hooks rebuild the task state when handed a new
    // caster array, and the fresh state's -1 sentinels force the next
    // render; this counter is what the render gate compares in their
    // place, so a re-registered list re-renders even when its version sum
    // happens to match the old list's.
    ++engine.shadow_generators[generator.value].caster_list_version;
    refresh_shadow_task_meshes(engine, generator);
}

namespace {

/**
 * One generator's depth-only pass, as ensurePcfShadowTaskState builds it.
 *
 * The target is createShadowRenderTarget's: no colour attachment, the
 * generator's own depth32float map at one sample, cleared to the
 * standard-Z far value. Each caster is added through its material's own
 * no-colour view, which is the same composition arm a scene-code
 * createStandardNoColorMaterialView reaches.
 *
 * A CASCADED generator is the same construction N times over ONE map:
 * \`createCsmDirectionalShadowGenerator\` allocates a \`depth32float\`
 * texture array of \`numCascades\` layers, and
 * \`ensureCsmShadowTaskState\` builds one clearing depth-only task per
 * layer against a single-layer view of it. Here the layers are one render
 * target -- one texture, one owner -- and the LAYER rides on each task,
 * so no pass borrows a depth texture it would also have to not release.
 */
void build_shadow_task(Scene& scene, ShadowGeneratorHandle handle) {
    Engine& engine = *scene.engine;
    if (engine.shadow_generators[handle.value].caster_meshes.empty()) {
        return;
    }
    const bool esm =${esmShadows ? `
        engine.shadow_generators[handle.value].filter ==
        ShadowFilter::esm_directional` : " false"};
    const std::uint32_t map_size =
        engine.shadow_generators[handle.value].map_size;
    const std::uint32_t layers =${csmShadows ? `
        engine.shadow_generators[handle.value].filter ==
                ShadowFilter::csm_directional
            ? engine.shadow_generators[handle.value].csm_num_cascades
            : 1u` : " 1u"};
    RenderTargetOptions target;
    target.samples = 1;
    // \`createShadowRenderTarget\` takes a colour texture for the ESM
    // generator and none for the PCF one, which is the difference between
    // storing an exponential depth and comparing a depth buffer.
    target.has_color = esm;
    target.has_depth = true;
    target.sampled_depth = !esm;
    // One layer per cascade; the receiver samples the whole array through
    // its \`texture_depth_2d_array\` row.
    target.depth_layers = layers;
    if (esm) {
        // The pinned factory's own format for the ESM map. At one sample the
        // colour attachment is sampleable in place, which is what the blur's
        // first pass reads.
        target.format = TextureFormatClass::rgba16_float;
        target.has_format = true;
    }
    // \`createShadowRenderTarget\`: the depth format, compare and clear the
    // map carries are the pinned shadow constants above, so the record says
    // WHICH target this is and reads the values from there.
    target.shadow_map = true;
    target.width = map_size;
    target.height = map_size;
    const RenderTargetHandle rt = create_render_target(engine, target);
    for (std::uint32_t layer = 0; layer < layers; ++layer) {
        RenderTaskOptions task;
        task.name = esm
            ? "esm"
            : layers > 1u ? "csm" + std::to_string(layer) : "pcf";
        task.target = rt;
        task.clear = true;
        task.shadow_generator = handle;
        task.depth_layer = layer;
        const TaskHandle task_handle =
            create_render_task(engine, scene, std::move(task));
        engine.shadow_generators[handle.value].caster_tasks.push_back(
            task_handle);
    }
    // Every cascade renders into a layer of this one target, and it is the
    // target -- not any one pass -- that the receiver's texture lookup
    // resolves through.
    engine.shadow_generators[handle.value].map_target = rt;
    refresh_shadow_task_meshes(engine, handle);
    // ensureShadowTask unshifts the scheduler ahead of the scene's own
    // tasks, so every shadow map renders before the pass that samples it.
    // Registered back to front, because each insert pushes the previous
    // one along: the cascades then stand in the pin's own layer order.
    const std::vector<TaskHandle>& caster_tasks =
        engine.shadow_generators[handle.value].caster_tasks;
    for (std::size_t index = caster_tasks.size(); index-- > 0;) {
        add_task_at_start(scene, caster_tasks[index]);
    }
}

} // namespace

void register_scene_with_shadow_support(Scene& scene) {
    if (!scene.engine) {
        throw std::runtime_error("Scene is not associated with an engine.");
    }
    // Idempotent, the way the pinned ensureShadowTask is: a re-registered
    // scene keeps the tasks it already carries.
    for (const LightHandle light : scene.lights) {
        if (light.value >= scene.engine->lights.size()) continue;
        const ShadowGeneratorHandle generator =
            scene.engine->lights[light.value].shadow_generator;
        if (generator.value >= scene.engine->shadow_generators.size()) {
            continue;
        }
        if (
            !scene.engine->shadow_generators[generator.value]
                 .caster_tasks.empty()) {
            continue;
        }
        build_shadow_task(scene, generator);
    }
    register_scene(scene);
    rebuild_scene_renderables(scene);
}

} // namespace bbl
`,
    };
}
