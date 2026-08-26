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
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import { nativeDepthCompare } from "./pinned-depth-state.js";
import { floatLiteral } from "../cpp-literals.js";
import { pinnedTrsComposition } from "./pinned-trs.js";
import type { ComposedEsmShadow } from "../pinned-esm-shadow.js";

const baseModule = "src/shadow/shadow-base.ts";
const spotModule = "src/shadow/pcf-spotlight-shadow-generator.ts";
const hooksModule = "src/shadow/pcf-shadow-task-hooks.ts";
const esmModule = "src/shadow/esm-directional-shadow-generator.ts";
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
    const returned = expression
        ? context.unwrapExpression(expression)
        : undefined;
    if (
        !returned ||
        !ts.isNewExpression(returned) ||
        !ts.isIdentifier(returned.expression) ||
        returned.expression.text !== "F32" ||
        returned.arguments?.length !== 1 ||
        !ts.isArrayLiteralExpression(returned.arguments[0]!)
    ) {
        return context.contractError(
            declaration,
            "Expected the pinned body to return `new F32([...])`.",
        );
    }
    const elements = returned.arguments[0].elements;
    if (elements.length !== 16) {
        return context.contractError(
            declaration,
            `Expected sixteen matrix elements, found ${elements.length}.`,
        );
    }
    const lowered = elements.map(
        (element) => `static_cast<float>(${lowerer.expression(element)})`,
    );
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
        ["offX", { cpp: "0.0", type: "scalar" }],
        ["offY", { cpp: "0.0", type: "scalar" }],
        ["offZ", { cpp: "0.0", type: "scalar" }],
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
    double far_plane) {
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
        ["offX", { cpp: "0.0", type: "scalar" }],
        ["offY", { cpp: "0.0", type: "scalar" }],
        ["offZ", { cpp: "0.0", type: "scalar" }],
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
    double ortho_max_z) {
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
    const { file, declaration } = context.functionDeclaration(
        esmModule,
        "createEsmDirectionalShadowGenerator",
    );
    const read = (local: string): number =>
        optionDefault(context, declaration, local, file);
    return {
        mapSize: read("mapSize"),
        depthScale: read("depthScale"),
        bias: read("bias"),
        blurKernel: read("blurKernel"),
        blurScale: read("blurScale"),
        darkness: read("darkness"),
        frustumEdgeFalloff: read("frustumEdgeFalloff"),
        orthoMinZ: read("orthoMinZ"),
        orthoMaxZ: read("orthoMaxZ"),
    };
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
}`;
}

/** The generated header carrying the pinned shadow family. */
export function pinnedShadowHeader(context: LoweringContext): string {
    assertShadowUboLayout(context);
    const target = assertPcfResourceContracts(context);
    const defaults = pcfSpotDefaults(context);
    const esm = esmDefaults(context);
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
#include <vector>

#include <bblite/js_data.hpp>
#include <bblite/runtime.hpp>

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
    std::array<float, 16> world{};
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
 */
inline std::array<float, 16> shadow_caster_world(const MeshRecord& mesh) {
${trs.composeLocalBody}\
    std::array<float, 16> result{};
    for (std::size_t cell = 0; cell < 16; ++cell) {
        result[cell] = static_cast<float>(local[cell]);
    }
    return result;
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

${lowerShadowParamsBlock(context)}

/**
 * The receiver block for one generator, in the pinned writer's field order.
 *
 * \`writeShadowUboFields\` packs the light matrix, then the two depth values
 * with two zero floats behind them, then the four \`shadowsInfo\` lanes;
 * generation asserts each of those writes against this layout.
 */
inline ShadowInfoUniforms shadow_info_block(
    const ShadowGeneratorRecord& generator) {
    const double map_size = static_cast<double>(generator.map_size);
    ShadowInfoUniforms block{};
    block.lightMatrix = generator.light_matrix;
    // \`_depthValues\` and \`_shadowsInfo\`, derived where they are read: each
    // pinned factory packs them from the values its own record carries, so
    // caching the packed form would be a second copy a later setter could
    // leave stale. The two factories pack DIFFERENT lanes, which is why the
    // filter decides here rather than at creation.
    if (generator.filter == ShadowFilter::esm_directional) {
        block.depthValues = {0.0f, 1.0f, 0.0f, 0.0f};
        block.shadowsInfo = {
            static_cast<float>(generator.darkness),
            0.0f,
            static_cast<float>(generator.depth_scale),
            static_cast<float>(generator.frustum_edge_falloff),
        };
        return block;
    }
    block.depthValues = {
        0.0f,
        static_cast<float>(generator.far_plane),
        0.0f,
        0.0f,
    };
    block.shadowsInfo = {
        static_cast<float>(generator.darkness),
        static_cast<float>(map_size),
        static_cast<float>(1.0 / map_size),
        0.0f,
    };
    return block;
}

/**
 * \`renderEsmShadowMap\`'s matrices, refreshed from the light and casters.
 *
 * Unlike the spot generator's, the ESM light matrix is NOT biased for the
 * caster pass: \`renderEsmShadowMap\` hands \`matrix._viewProj\` to both
 * \`sg._lightMatrix\` and \`updateShadowCameraBase\`, so one matrix serves
 * the receiver and the caster pass alike.
 */
inline void update_esm_directional_shadow(
    ShadowGeneratorRecord& generator,
    const LightRecord& light,
    const std::vector<ShadowCaster>& casters) {
    const ShadowLightMatrix matrix = compute_directional_light_matrix(
        light,
        casters,
        generator.ortho_min_z,
        generator.ortho_max_z);
    generator.light_matrix = matrix.view_projection;
    generator.caster_view = matrix.view;
    generator.caster_view_projection = matrix.view_projection;
    generator.near_plane = matrix.near_plane;
    generator.far_plane = matrix.far_plane;
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
    const LightRecord& light) {
    const ShadowLightMatrix matrix = compute_spot_light_matrix(
        light,
        generator.near_plane,
        generator.far_plane);
    generator.light_matrix = matrix.view_projection;
    generator.caster_view = matrix.view;
    generator.caster_view_projection =
        bias_view_projection(matrix.view_projection, generator.bias);
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
export function shadowFactorySource(
    context: LoweringContext,
    // Whether this scene reaches an ESM generator. A PCF-only scene
    // emits neither the ESM factory nor the caster view it would ask
    // for -- the view's own translation unit is not compiled either.
    esmShadows = false,
): LoweredSource {
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

ShadowGeneratorHandle create_pcf_spotlight_shadow_generator(
    Engine& engine,
    LightHandle light,
    PcfSpotShadowOptions options) {
    if (light.value >= engine.lights.size()) {
        throw std::runtime_error("Invalid shadow generator light handle.");
    }
    if (engine.lights[light.value].kind != LightKind::spot) {
        throw std::runtime_error(
            "A PCF spotlight shadow generator requires a spot light.");
    }
    ShadowGeneratorRecord generator;
    generator.map_size = options.map_size;
    generator.bias = options.bias;
    generator.darkness = options.darkness;
    generator.near_plane = options.near_plane;
    generator.far_plane = options.far_plane;
    upstream::update_pcf_spot_shadow(generator, engine.lights[light.value]);
    engine.shadow_generators.push_back(std::move(generator));
    return ShadowGeneratorHandle{
        static_cast<std::uint32_t>(engine.shadow_generators.size() - 1)};
}

${!esmShadows ? "" : `ShadowGeneratorHandle create_esm_directional_shadow_generator(
    Engine& engine,
    LightHandle light,
    EsmDirectionalShadowOptions options) {
    if (light.value >= engine.lights.size()) {
        throw std::runtime_error("Invalid shadow generator light handle.");
    }
    if (engine.lights[light.value].kind != LightKind::directional) {
        throw std::runtime_error(
            "An ESM shadow generator requires a directional light.");
    }
    ShadowGeneratorRecord generator;
    generator.filter = ShadowFilter::esm_directional;
    generator.map_size = options.map_size;
    generator.bias = options.bias;
    generator.darkness = options.darkness;
    generator.depth_scale = options.depth_scale;
    generator.frustum_edge_falloff = options.frustum_edge_falloff;
    generator.ortho_min_z = options.ortho_min_z;
    generator.ortho_max_z = options.ortho_max_z;
    generator.esm_index = options.esm_index;
    // The light matrix fits the CASTERS, which are registered after this
    // factory returns, so the first fit happens at the task's first frame.
    engine.shadow_generators.push_back(std::move(generator));
    return ShadowGeneratorHandle{
        static_cast<std::uint32_t>(engine.shadow_generators.size() - 1)};
}
`}
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
    const std::vector<MeshHandle> casters =
        engine.shadow_generators[handle.value].caster_meshes;
    for (const MeshHandle mesh : casters) {
        const MaterialHandle material = engine.meshes[mesh.value].material;
        if (material.value >= engine.materials.size()) {
            throw std::runtime_error(
                "A shadow caster mesh carries no material.");
        }
        // Which view: \`getEsmShadowView\` for the ESM task, the depth-only
        // one for the PCF task. Both are the pin's own per-family factory.
        const MaterialHandle view =
            engine.materials[material.value].standard_material
                ? ${esmShadows ? `(esm
                    ? create_standard_esm_shadow_material_view(
                        engine,
                        material,
                        handle)
                    : create_standard_no_color_material_view(
                        engine,
                        material))` : `create_standard_no_color_material_view(
                    engine,
                    material)`}
                : create_pbr_no_color_material_view(engine, material);
        add_render_task_mesh(engine, task_handle, mesh, view);
    }
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
}

} // namespace bbl
`,
    };
}
