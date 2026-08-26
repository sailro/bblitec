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

const baseModule = "src/shadow/shadow-base.ts";
const spotModule = "src/shadow/pcf-spotlight-shadow-generator.ts";
const hooksModule = "src/shadow/pcf-shadow-task-hooks.ts";
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
    if (declaration.parameters.length !== expected.length) {
        context.contractError(
            declaration,
            "Expected pinned _computeSpotLightMatrix to take " +
                "(light, near, far, offX, offY, offZ).",
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
                `Expected pinned _computeSpotLightMatrix parameter ${index} ` +
                    `to be '${pinned}'.`,
            );
        }
        if (annotation && parameter.type?.getText(file) !== annotation) {
            context.contractError(
                parameter,
                `Expected pinned _computeSpotLightMatrix parameter ` +
                    `'${pinned}' to be annotated '${annotation}'.`,
            );
        }
        // The three offsets carry a floating-origin default of zero. No
        // reached scene enables large-world rendering, so the emitted
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
                    `Expected pinned _computeSpotLightMatrix '${pinned}' to ` +
                        "default to 0.",
                );
            }
        }
    });
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
    // could sample it, which the pin does not build.
    if (
        context.numericValue(
            context.propertyInitializer(targetLiteral, "samples"),
            baseFile,
        ) !== 1
    ) {
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

/** The generated header carrying the pinned shadow family. */
export function pinnedShadowHeader(context: LoweringContext): string {
    assertShadowUboLayout(context);
    const target = assertPcfResourceContracts(context);
    const defaults = pcfSpotDefaults(context);
    return `#pragma once

// ${context.provenance(baseModule, "buildLightViewMatrix")}
// ${context.provenance(spotModule, "createPcfSpotlightShadowGenerator")}

#include <array>
#include <cstdint>

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

/** What \`_computeSpotLightMatrix\` returns. */
struct ShadowLightMatrix {
    std::array<float, 16> view{};
    std::array<float, 16> view_projection{};
    double near_plane = 0.0;
    double far_plane = 0.0;
};

${lowerBuildLightViewMatrix(context)}

${lowerMultiply4x4(context)}

${lowerComputeSpotLightMatrix(context)}

${lowerBiasViewProjection(context)}

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
    // \`_depthValues\` and \`_shadowsInfo\`, derived where they are read: the
    // pinned factory packs them from the same three values the record
    // carries, so caching the packed form would be a second copy that a
    // later setter could leave stale.
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
export function shadowFactorySource(context: LoweringContext): LoweredSource {
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
    const std::uint32_t map_size =
        engine.shadow_generators[handle.value].map_size;
    RenderTargetOptions target;
    target.samples = 1;
    target.has_color = false;
    target.has_depth = true;
    target.sampled_depth = true;
    // \`createShadowRenderTarget\`: the depth format, compare and clear the
    // map carries are the pinned shadow constants above, so the record says
    // WHICH target this is and reads the values from there.
    target.shadow_map = true;
    target.width = map_size;
    target.height = map_size;
    const RenderTargetHandle rt = create_render_target(engine, target);
    RenderTaskOptions task;
    task.name = "pcf";
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
        const MaterialHandle view =
            engine.materials[material.value].standard_material
                ? create_standard_no_color_material_view(engine, material)
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
