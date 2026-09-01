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

/** The `?? <literal>` default a pinned option read resolves to. */
function optionDefault(
    context: LoweringContext,
    declaration: ts.FunctionDeclaration,
    local: string,
    file: ts.SourceFile,
): number {
    const initializer = context.unwrapExpression(
        context.variableInitializer(declaration, local),
    );
    if (
        !ts.isBinaryExpression(initializer) ||
        initializer.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
    ) {
        return context.contractError(
            initializer,
            `Expected pinned '${local}' to resolve through '??'.`,
        );
    }
    return context.numericValue(initializer.right, file);
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

/** Defaults which determine the retained first cascade of a CSM generator. */
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
    const max = context.numericValue(cascades.arguments[1]!, file);
    const fallback = context.numericValue(requested.right, file);
    if (max !== fallback) {
        context.contractError(
            cascades,
            "Expected the CSM cascade default and clamp to agree.",
        );
    }
    const csmCfg = context.unwrapExpression(
        context.variableInitializer(declaration, "csmCfg"),
    );
    if (!ts.isObjectLiteralExpression(csmCfg)) {
        context.contractError(csmCfg, "Expected CSM config object literal.");
    }
    const lambda = context.unwrapExpression(
        context.propertyInitializer(csmCfg, "_lambda"),
    );
    if (
        !ts.isBinaryExpression(lambda) ||
        lambda.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
    ) {
        context.contractError(lambda, "Expected CSM lambda to resolve through '??'.");
    }
    return {
        mapSize: optionDefault(context, declaration, "mapSize", file),
        numCascades: fallback,
        lambda: context.numericValue(lambda.right, file),
        bias: optionDefault(context, declaration, "bias", file),
        darkness: optionDefault(context, declaration, "darkness", file),
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
    // `forceRefreshEveryFrame ?? false` on all four factories. ESM and CSM
    // carry it into the record: what the emitted gate's disable flag
    // defaults from. The two PCF factories read the same default while the
    // port refuses the option there, so these anchors hold the shape a
    // future pin could quietly start carrying somewhere the port drops it.
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
    // Anchor the adapted fit to the exact camera-frustum function it mirrors.
    context.functionDeclaration(csmHooksModule, "_computeCsmCascades");
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

#include <array>
#include <cmath>
#include <cstdint>
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
inline constexpr double csm_default_lambda = ${context.doubleLiteral(csm.lambda)};
inline constexpr double csm_default_bias = ${context.doubleLiteral(csm.bias)};
inline constexpr double csm_default_darkness = ${context.doubleLiteral(csm.darkness)};

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
    std::array<float, 3> bounds_min{};
    std::array<float, 3> bounds_max{};
};

/**
 * One caster's \`mesh.worldMatrix\`, composed by the pin's own writer.
 *
 * \`computeDirectionalLightMatrix\` multiplies each caster's AABB corners
 * through it. A scene-code mesh has no parent, so its world matrix IS its
 * local TRS -- the same composition \`nav_mesh_world\` multiplies CPU
 * positions through, from the same single home.
 *
 * Kept at the composition's own DOUBLE width, unlike the narrowed world every
 * GPU consumer takes: the fit's first act is to subtract the eye from cell
 * 12, and \`MeshRecord::position\` is a \`Vec3d\` precisely so that
 * large-minus-large happens at full width. Narrowing here and widening back
 * inside the fold would round the large coordinate first, which at five
 * million units is half a unit of shadow-volume placement.
 */
inline std::array<double, 16> shadow_caster_world(const MeshRecord& mesh) {
${trs.composeLocalBody}\
    // A cloned imported hierarchy keeps its placement as an outer root
    // transform while the child mesh's local TRS remains authored. The pin's
    // \`mesh.worldMatrix\` already includes that parent. Apply the same XYZ
    // rotation and translation here before folding the caster bounds, at the
    // double width this fit deliberately retains.
    if (
        mesh.outer_rotation.x != 0.0f ||
        mesh.outer_rotation.y != 0.0f ||
        mesh.outer_rotation.z != 0.0f) {
        const double sin_x = std::sin(
            static_cast<double>(mesh.outer_rotation.x));
        const double cos_x = std::cos(
            static_cast<double>(mesh.outer_rotation.x));
        const double sin_y = std::sin(
            static_cast<double>(mesh.outer_rotation.y));
        const double cos_y = std::cos(
            static_cast<double>(mesh.outer_rotation.y));
        const double sin_z = std::sin(
            static_cast<double>(mesh.outer_rotation.z));
        const double cos_z = std::cos(
            static_cast<double>(mesh.outer_rotation.z));
        for (std::size_t column = 0; column < 4; ++column) {
            const std::size_t offset = column * 4;
            const double x0 = local[offset];
            const double y0 = local[offset + 1];
            const double z0 = local[offset + 2];
            const double x1 = x0;
            const double y1 = y0 * cos_x - z0 * sin_x;
            const double z1 = y0 * sin_x + z0 * cos_x;
            const double x2 = x1 * cos_y + z1 * sin_y;
            const double y2 = y1;
            const double z2 = -x1 * sin_y + z1 * cos_y;
            local[offset] = x2 * cos_z - y2 * sin_z;
            local[offset + 1] = x2 * sin_z + y2 * cos_z;
            local[offset + 2] = z2;
        }
    }
    local[12] += static_cast<double>(mesh.outer_position.x);
    local[13] += static_cast<double>(mesh.outer_position.y);
    local[14] += static_cast<double>(mesh.outer_position.z);
    return local;
}

/** The pin's own \`mesh.boundMin ?? [...]\` fallback, for a caster with none. */
inline constexpr std::array<float, 3> shadow_caster_bounds_fallback_min{
    ${floats(casterFallback.min)}};
inline constexpr std::array<float, 3> shadow_caster_bounds_fallback_max{
    ${floats(casterFallback.max)}};

${lowerBuildLightViewMatrix(context)}

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
 */
inline std::uint64_t shadow_caster_version_sum(
    const Engine& engine,
    const std::vector<MeshHandle>& caster_meshes) {
    std::uint64_t sum = 0;
    for (const MeshHandle handle : caster_meshes) {
        if (handle.value >= engine.meshes.size()) continue;
        const MeshRecord& mesh = engine.meshes[handle.value];
        sum += mesh.transform_version + mesh.instance_version;
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
    const std::uint64_t caster_version =
        shadow_caster_version_sum(engine, generator.caster_meshes);
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
 * The pin's first CSM cascade, retained as a single 2D PCF map.
 *
 * The native resource seam has one sampled depth texture per generator. A
 * CSM source still needs a camera-frustum fit, not the unrelated whole-caster
 * directional PCF fit. The split formula, float VP inversion, clone-aware
 * caster Z fit, texel snap and bias split remain the pin's own; farther
 * cascades conservatively fall outside this one-map resource.
 */
inline void update_csm_single_map_shadow(
    ShadowGeneratorRecord& generator,
    const LightRecord& light,
    const CameraRecord& camera,
    double aspect,
    const std::vector<ShadowCaster>& casters) {
    const double near_z = camera.near_plane;
    const double far_z = camera.far_plane;
    const double camera_range = far_z - near_z;
    const double p = 1.0 /
        static_cast<double>(generator.csm_num_cascades);
    const double logarithmic =
        near_z * std::pow(far_z / near_z, p);
    const double uniform = near_z + camera_range * p;
    const double split_distance =
        generator.csm_lambda * (logarithmic - uniform) + uniform;
    const double split = (split_distance - near_z) / camera_range;

    const std::array<float, 16> view_projection =
        build_view_projection(camera, aspect);
    const auto inverse_value = mat4_invert(view_projection);
    const std::array<float, 16>& inverse =
        inverse_value ? *inverse_value : view_projection;
    const auto transform = [&](double x, double y, double z) {
        const double tx = static_cast<double>(inverse[0]) * x +
            static_cast<double>(inverse[4]) * y +
            static_cast<double>(inverse[8]) * z + inverse[12];
        const double ty = static_cast<double>(inverse[1]) * x +
            static_cast<double>(inverse[5]) * y +
            static_cast<double>(inverse[9]) * z + inverse[13];
        const double tz = static_cast<double>(inverse[2]) * x +
            static_cast<double>(inverse[6]) * y +
            static_cast<double>(inverse[10]) * z + inverse[14];
        const double tw = static_cast<double>(inverse[3]) * x +
            static_cast<double>(inverse[7]) * y +
            static_cast<double>(inverse[11]) * z + inverse[15];
        return std::array<double, 3>{tx / tw, ty / tw, tz / tw};
    };
    constexpr std::array<std::array<double, 3>, 8> ndc{{
        {{-1.0,  1.0, 1.0}}, {{ 1.0,  1.0, 1.0}},
        {{ 1.0, -1.0, 1.0}}, {{-1.0, -1.0, 1.0}},
        {{-1.0,  1.0, 0.0}}, {{ 1.0,  1.0, 0.0}},
        {{ 1.0, -1.0, 0.0}}, {{-1.0, -1.0, 0.0}},
    }};
    std::array<std::array<double, 3>, 8> corners{};
    for (std::size_t index = 0; index < corners.size(); ++index) {
        corners[index] = transform(
            ndc[index][0], ndc[index][1], ndc[index][2]);
    }
    for (std::size_t index = 0; index < 4; ++index) {
        const auto near_corner = corners[index];
        const auto far_corner = corners[index + 4];
        for (std::size_t axis = 0; axis < 3; ++axis) {
            corners[index + 4][axis] = near_corner[axis] +
                (far_corner[axis] - near_corner[axis]) * split;
        }
    }

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

    double direction_x = light.direction.x;
    double direction_y = light.direction.y;
    double direction_z = light.direction.z;
    const double direction_length =
        std::hypot(direction_x, direction_y, direction_z);
    const double safe_length = direction_length == 0.0 ? 1.0 : direction_length;
    direction_x /= safe_length;
    direction_y /= safe_length;
    direction_z /= safe_length;
    if (std::abs(direction_y) >= 1.0) direction_z = 1e-13;

    const std::array<float, 16> center_view = build_light_view_matrix(
        direction_x, direction_y, direction_z,
        center_x, center_y, center_z);
    double min_x = std::numeric_limits<double>::infinity();
    double min_y = std::numeric_limits<double>::infinity();
    double min_eye_z = std::numeric_limits<double>::infinity();
    double max_x = -std::numeric_limits<double>::infinity();
    double max_y = -std::numeric_limits<double>::infinity();
    double max_eye_z = -std::numeric_limits<double>::infinity();
    for (const auto& corner : corners) {
        const double x = center_view[0] * corner[0] +
            center_view[4] * corner[1] + center_view[8] * corner[2] +
            center_view[12];
        const double y = center_view[1] * corner[0] +
            center_view[5] * corner[1] + center_view[9] * corner[2] +
            center_view[13];
        const double z = center_view[2] * corner[0] +
            center_view[6] * corner[1] + center_view[10] * corner[2] +
            center_view[14];
        min_x = std::min(min_x, x);
        max_x = std::max(max_x, x);
        min_y = std::min(min_y, y);
        max_y = std::max(max_y, y);
        min_eye_z = std::min(min_eye_z, z);
        max_eye_z = std::max(max_eye_z, z);
    }

    const double eye_x = center_x + direction_x * min_eye_z;
    const double eye_y = center_y + direction_y * min_eye_z;
    const double eye_z = center_z + direction_z * min_eye_z;
    const std::array<float, 16> view = build_light_view_matrix(
        direction_x, direction_y, direction_z, eye_x, eye_y, eye_z);
    double view_min_z = 0.0;
    double view_max_z = max_eye_z - min_eye_z;

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
            const double world_x = caster.world[0] * local_x +
                caster.world[4] * local_y + caster.world[8] * local_z +
                caster.world[12];
            const double world_y = caster.world[1] * local_x +
                caster.world[5] * local_y + caster.world[9] * local_z +
                caster.world[13];
            const double world_z = caster.world[2] * local_x +
                caster.world[6] * local_y + caster.world[10] * local_z +
                caster.world[14];
            caster_min_x = std::min(caster_min_x, world_x);
            caster_min_y = std::min(caster_min_y, world_y);
            caster_min_z = std::min(caster_min_z, world_z);
            caster_max_x = std::max(caster_max_x, world_x);
            caster_max_y = std::max(caster_max_y, world_y);
            caster_max_z = std::max(caster_max_z, world_z);
        }
    }
    if (std::isfinite(caster_min_x)) {
        double caster_view_min_z = std::numeric_limits<double>::infinity();
        double caster_view_max_z = -std::numeric_limits<double>::infinity();
        for (std::size_t corner = 0; corner < 8; ++corner) {
            const double world_x = (corner & 1u) ? caster_max_x : caster_min_x;
            const double world_y = (corner & 2u) ? caster_max_y : caster_min_y;
            const double world_z = (corner & 4u) ? caster_max_z : caster_min_z;
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

    std::array<float, 16> projection{};
    projection[0] = static_cast<float>(2.0 / (max_x - min_x));
    projection[5] = static_cast<float>(2.0 / (max_y - min_y));
    projection[10] = static_cast<float>(1.0 / (view_max_z - view_min_z));
    projection[12] = static_cast<float>(-(max_x + min_x) / (max_x - min_x));
    projection[13] = static_cast<float>(-(max_y + min_y) / (max_y - min_y));
    projection[14] = static_cast<float>(-view_min_z / (view_max_z - view_min_z));
    projection[15] = 1.0f;
    std::array<float, 16> transform_matrix = multiply_4x4(projection, view);
    const double offset_x =
        (std::round(transform_matrix[12] * generator.map_size / 2.0) -
         transform_matrix[12] * generator.map_size / 2.0) *
        (2.0 / generator.map_size);
    const double offset_y =
        (std::round(transform_matrix[13] * generator.map_size / 2.0) -
         transform_matrix[13] * generator.map_size / 2.0) *
        (2.0 / generator.map_size);
    std::array<float, 16> snap{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        static_cast<float>(offset_x), static_cast<float>(offset_y), 0.0f, 1.0f};
    projection = multiply_4x4(snap, projection);
    transform_matrix = multiply_4x4(projection, view);

    generator.light_matrix = transform_matrix;
    generator.caster_view = view;
    generator.caster_view_projection =
        bias_view_projection(transform_matrix, generator.bias);
    generator.near_plane = view_min_z;
    generator.far_plane = view_max_z;
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
    const csmSingleMapShadows = features.includes("shadow:csm-single-map");
    // One family's caster view, under the filter its task carries. The node
    // family has a second compiled module for both modes: ESM adds its
    // shadow-params binding, while PCF uses NODE_NO_COLOR_OUTPUT and adds no
    // caster-only binding.
    const nodeCasters = nodeEsmCasters || nodePcfCasters;
    const casterView = (family: "standard" | "pbr" | "node"): string => {
        const noColor = family === "node"
            ? `create_node_no_color_material_view(engine, material)`
            : `create_${family}_no_color_material_view(engine, material)`;
        return esmShadows
            ? `(esm
                    ? create_${family}_esm_shadow_material_view(
                        engine,
                        material,
                        handle)
                    : ${noColor})`
            : noColor;
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
    ],
})}
${!csmSingleMapShadows ? "" : shadowGeneratorFactory({
    name: "csm_directional",
    options: "CsmDirectionalShadowOptions",
    article: "A CSM directional shadow generator",
    lightKind: "directional",
    filter: "pcf_directional",
    fields: [
        "map_size",
        "bias",
        "darkness",
        "csm_num_cascades",
        "csm_lambda",
        "force_refresh_every_frame",
    ],
    tail: "    generator.csm_single_map = true;",
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
        ${nodeCasters ? `source.node_material
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
    if (generator.task.value >= engine.frame_tasks.size()) return;
    FrameTaskRecord& task = engine.frame_tasks[generator.task.value];
    task.render_meshes.clear();
    for (const MeshHandle mesh : generator.caster_meshes) {
        const MeshRecord& record = engine.meshes[mesh.value];
        // Invisible anchors participate in the light-volume fit but the
        // pin's normal renderable traversal does not draw them.
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
            generator.task,
            mesh,
            shadow_caster_view(engine, handle, material));
    }
}

} // namespace

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
    RenderTargetOptions target;
    target.samples = 1;
    // \`createShadowRenderTarget\` takes a colour texture for the ESM
    // generator and none for the PCF one, which is the difference between
    // storing an exponential depth and comparing a depth buffer.
    target.has_color = esm;
    target.has_depth = true;
    target.sampled_depth = !esm;
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
    RenderTaskOptions task;
    task.name = esm ? "esm" : "pcf";
    task.target = rt;
    task.clear = true;
    task.shadow_generator = handle;
    const TaskHandle task_handle =
        create_render_task(engine, scene, std::move(task));
    engine.shadow_generators[handle.value].task = task_handle;
    refresh_shadow_task_meshes(engine, handle);
    // ensureShadowTask unshifts the scheduler ahead of the scene's own
    // tasks, so every shadow map renders before the pass that samples it.
    add_task_at_start(scene, task_handle);
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
            scene.engine->shadow_generators[generator.value].task.value !=
            invalid_handle) {
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
