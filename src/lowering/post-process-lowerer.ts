import ts from "typescript";
import {
    POST_PROCESS_EFFECTS,
    postProcessEffect,
    slotOption,
    type PostProcessEffect,
} from "../post-process-effects.js";
import type { PostProcessTaskManifest } from "../compiler/types.js";
import { LoweredSource, LoweringContext } from "./context.js";
import { blendSide, nativeBlendFactor } from "./pinned-blend-table.js";
import {
    PINNED_ARITHMETIC_OPERATORS,
    pinnedMathCall,
} from "./pinned-operators.js";

const TASK_MODULE = "src/frame-graph/post-process-task.ts";

/**
 * The post-process pass, lowered from the one module every effect builds on.
 *
 * `createPostProcessTask` is the whole mechanism: one fullscreen triangle, a
 * bind group of sampler, source view, the effect's extra views and its uniform
 * block, and a target that is either the one the caller named or one made from
 * the source's descriptor. What an effect adds is text — composed by the pin
 * and deployed verbatim (`src/pinned-post-process.ts`) — and a `writeUniforms`
 * body, which is emitted here from the pin's own AST so a changed formula
 * arrives as generated C++ rather than drifting.
 */
export class PostProcessLowerer {
    public constructor(
        private readonly context: LoweringContext,
        private readonly tasks: readonly PostProcessTaskManifest[],
    ) {}

    /** The pin's own `alphaModeToBlend`, mode to four WebGPU factors. */
    private blendModes = new Map<number, readonly string[]>();

    public lowerTaskRecords(): LoweredSource {
        const effects = this.reachedEffects();
        this.assertTaskContracts();
        for (const effect of effects) {
            this.assertEffectContracts(effect);
        }
        const symbols = [
            "createPostProcessTask",
            ...effects.map((effect) => effect.intrinsic),
        ].join(",");
        return {
            modulePath: TASK_MODULE,
            symbolName: symbols,
            header: this.header(),
            source: this.source(effects),
        };
    }

    /** The effects this scene reached, in the pin's own declaration order. */
    private reachedEffects(): PostProcessEffect[] {
        const reached = new Set(this.tasks.map((task) => task.intrinsic));
        return POST_PROCESS_EFFECTS.filter((effect) =>
            reached.has(effect.intrinsic),
        );
    }

    /**
     * The pass's own contracts. Each one is something the emitted PAL pass
     * does, anchored where the pin decides it.
     */
    private assertTaskContracts(): void {
        const { declaration: createTask } =
            this.context.functionDeclaration(
                TASK_MODULE,
                "createPostProcessTask",
            );
        // The pass draws three vertices with no vertex buffer: the emitted
        // PAL draw is that call, so it is pinned here.
        if (
            !this.context.hasNode(
                createTask,
                (node) =>
                    ts.isCallExpression(node) &&
                    ts.isPropertyAccessExpression(node.expression) &&
                    node.expression.name.text === "draw" &&
                    node.arguments.length === 1 &&
                    ts.isNumericLiteral(node.arguments[0]!) &&
                    node.arguments[0].text === "3",
            )
        ) {
            this.context.contractError(
                createTask,
                "Expected the fullscreen triangle's three-vertex draw.",
            );
        }
        for (const [property, expected] of [
            ["sourceSamplingMode", 'config.sourceSamplingMode ?? "linear"'],
            ["alphaMode", "config.alphaMode ?? 0"],
            ["viewport", "config.viewport ?? null"],
            ["clear", "config.clear ?? true"],
        ] as const) {
            this.context.assertExpressionShape(
                this.context.propertyInitializer(
                    this.context.objectInitializer(createTask, "task"),
                    property,
                ),
                expected,
                `Post-process '${property}' default`,
            );
        }

        // The internal target the pass makes when the caller named none: the
        // source's format at one sample and the source's own size, which is
        // what the emitted `create_post_process_task` copies.
        const { declaration: createInternalTarget } =
            this.context.functionDeclaration(
                TASK_MODULE,
                "createInternalTarget",
            );
        const descriptor = this.context.objectInitializer(
            createInternalTarget,
            "desc",
        );
        for (const [property, expected] of [
            ["format", "srcDesc.format"],
            ["samples", "1"],
            ["size", "srcDesc.size"],
        ] as const) {
            this.context.assertExpressionShape(
                this.context.propertyInitializer(descriptor, property),
                expected,
                `Post-process internal target '${property}'`,
            );
        }

        // The viewport rectangle. It is NOT the copy task's: the far edges
        // round up here and down there, so the two cannot share a resolver.
        const { declaration: applyViewport } =
            this.context.functionDeclaration(
                TASK_MODULE,
                "applyViewport",
            );
        for (const [name, expected] of [
            ["x", "Math.floor(viewport.x * rt._width)"],
            [
                "y",
                "Math.floor((1 - viewport.y - viewport.height) * rt._height)",
            ],
            [
                "w",
                "Math.ceil((viewport.x + viewport.width) * rt._width) - x",
            ],
            ["h", "Math.ceil((1 - viewport.y) * rt._height) - y"],
        ] as const) {
            this.context.assertExpressionShape(
                this.context.variableInitializer(applyViewport, name),
                expected,
                `Post-process viewport '${name}'`,
            );
        }
        if (
            !this.context.hasNode(
                applyViewport,
                (node) =>
                    ts.isCallExpression(node) &&
                    ts.isPropertyAccessExpression(node.expression) &&
                    node.expression.name.text === "setScissorRect",
            )
        ) {
            this.context.contractError(
                applyViewport,
                "Expected the post-process viewport scissor.",
            );
        }

        // The uniform block's size is rounded to sixteen bytes, and its
        // binding follows the extra textures.
        const { declaration: align16 } =
            this.context.functionDeclaration(TASK_MODULE, "align16");
        this.assertSingleReturn(
            align16,
            "Math.ceil(value / 16) * 16",
            "Post-process uniform alignment",
        );
        const { declaration: uniformBinding } =
            this.context.functionDeclaration(
                TASK_MODULE,
                "getUniformBinding",
            );
        this.assertSingleReturn(
            uniformBinding,
            "task._shader.uniformBinding ?? 2 + (task._shader.extraTextures?.length ?? 0)",
            "Post-process uniform binding",
        );

        // The bind group the emitted pass fills: the sampler, the source
        // view, then the effect's extra views, then the uniform block at the
        // binding above. Both PALs bind in exactly this order.
        const { declaration: gpuState } =
            this.context.functionDeclaration(
                TASK_MODULE,
                "createPostProcessGpuState",
            );
        const bindings = this.context
            .findNodes(
                gpuState,
                (node): node is ts.ObjectLiteralExpression =>
                    ts.isObjectLiteralExpression(node) &&
                    node.properties.some(
                        (property) =>
                            property.name !== undefined &&
                            this.context.propertyName(property.name) ===
                                "binding",
                    ),
            )
            .map((entry) =>
                this.context.propertyInitializer(entry, "binding"),
            );
        const expectedBindings = [
            "0",
            "1",
            "getUniformBinding(task)",
            "2 + i",
        ];
        if (bindings.length !== expectedBindings.length) {
            this.context.contractError(
                gpuState,
                `Expected ${expectedBindings.length} post-process bind-group entries, found ${bindings.length}.`,
            );
        }
        for (const [index, expected] of expectedBindings.entries()) {
            this.context.assertExpressionShape(
                bindings[index]!,
                expected,
                `Post-process bind-group entry ${index}`,
            );
        }

        this.blendModes = this.readBlendModes();
    }

    /**
     * The blend each alpha mode selects, read as the data it is.
     *
     * `alphaModeToBlend` is a switch of object literals in the pin's own
     * WebGPU spelling, and `pinned-blend-table.ts` already reads that shape
     * for the sprite families — so the emitted table is what the pin says
     * rather than a copy typed here that would agree only until the next
     * bump. A factor with no enumerator on this side fails generation.
     */
    private readBlendModes(): Map<number, readonly string[]> {
        const { declaration: alphaModeToBlend } =
            this.context.functionDeclaration(
                TASK_MODULE,
                "alphaModeToBlend",
            );
        const modes = new Map<number, readonly string[]>();
        for (const clause of this.context.findNodes(
            alphaModeToBlend,
            (node): node is ts.CaseClause => ts.isCaseClause(node),
        )) {
            const mode = this.context.numericValue(
                this.context.unwrapExpression(clause.expression),
                clause.getSourceFile(),
            );
            const state = this.context.findNodes(
                clause,
                (node): node is ts.ObjectLiteralExpression =>
                    ts.isObjectLiteralExpression(node) &&
                    node.properties.some(
                        (property) =>
                            property.name !== undefined &&
                            this.context.propertyName(property.name) ===
                                "color",
                    ),
            )[0];
            if (!state) {
                this.context.contractError(
                    clause,
                    `Post-process alpha mode ${mode} names no blend state.`,
                );
            }
            const label = `post-process alpha mode ${mode}`;
            modes.set(mode, [
                ...blendSide(this.context, state, "color", label),
                ...blendSide(this.context, state, "alpha", label),
            ]);
        }
        if (modes.size === 0) {
            this.context.contractError(
                alphaModeToBlend,
                "Expected at least one blended post-process alpha mode.",
            );
        }
        return modes;
    }

    private assertSingleReturn(
        declaration: ts.FunctionDeclaration,
        expected: string,
        label: string,
    ): void {
        const returns = this.context.findNodes(
            declaration,
            (node): node is ts.ReturnStatement =>
                ts.isReturnStatement(node),
        );
        if (returns.length !== 1 || !returns[0]!.expression) {
            this.context.contractError(
                declaration,
                `${label}: expected one return expression.`,
            );
        }
        this.context.assertExpressionShape(
            returns[0]!.expression!,
            expected,
            label,
        );
    }

    /**
     * The effect's own halves: the defaults its `??` fallbacks state and the
     * options its factory makes settable. Both are read out of the table this
     * repository keeps, so a pin that moves either fails rather than composing
     * a pass against a stale default.
     */
    private assertEffectContracts(effect: PostProcessEffect): void {
        const { file, declaration } = this.context.functionDeclaration(
            effect.module,
            effect.intrinsic,
        );
        const fallbacks = new Map<string, ts.Expression>();
        for (const node of this.context.findNodes(
            declaration,
            (candidate): candidate is ts.BinaryExpression =>
                ts.isBinaryExpression(candidate) &&
                candidate.operatorToken.kind ===
                    ts.SyntaxKind.QuestionQuestionToken,
        )) {
            const path = this.context.propertyPath(node.left);
            if (path?.[0] === "config" && path.length === 2) {
                fallbacks.set(
                    path[1]!,
                    this.context.unwrapExpression(node.right),
                );
            }
        }
        // An extra texture has no fallback -- the pin reads it straight off
        // the descriptor -- so what is checked is that the descriptor still
        // names it, which is what the emitted binding order depends on.
        for (const texture of effect.extraTextures) {
            if (
                !this.context.hasNode(
                    declaration,
                    (node) =>
                        ts.isPropertyAccessExpression(node) &&
                        ts.isIdentifier(node.expression) &&
                        node.expression.text === "config" &&
                        node.name.text === texture,
                )
            ) {
                this.context.contractError(
                    declaration,
                    `Expected ${effect.intrinsic} to read '${texture}'.`,
                );
            }
        }
        for (const slot of effect.params) {
            if (slot.runtime) {
                continue;
            }
            const { option, component } = slotOption(slot);
            const found = fallbacks.get(option);
            if (!found) {
                this.context.contractError(
                    declaration,
                    `Expected ${effect.intrinsic} to default '${option}'.`,
                );
            }
            if (!component) {
                this.expectNumber(found, slot.fallback, file, {
                    intrinsic: effect.intrinsic,
                    option: slot.path,
                });
                continue;
            }
            // A vector option defaults as a whole object, so the component
            // fallback is read out of that object rather than off the option.
            if (!ts.isObjectLiteralExpression(found)) {
                this.context.contractError(
                    found,
                    `Expected ${effect.intrinsic} to default '${option}' with an object literal.`,
                );
            }
            this.expectNumber(
                this.context.propertyInitializer(found, component),
                slot.fallback,
                file,
                { intrinsic: effect.intrinsic, option: slot.path },
            );
        }
    }

    /** One pinned numeric default, against the value this table carries. */
    private expectNumber(
        expression: ts.Expression,
        expected: number,
        file: ts.SourceFile,
        label: { intrinsic: string; option: string },
    ): void {
        const value = this.context.numericValue(
            this.context.unwrapExpression(expression),
            file,
        );
        if (value !== expected) {
            this.context.contractError(
                expression,
                `${label.intrinsic} default for '${label.option}' changed; expected ${expected}, found ${value}.`,
            );
        }
    }

    private header(): string {
        return `#pragma once

#include <bblite/runtime.hpp>

#include <cstdint>

namespace bbl::upstream {

/**
 * The rectangle a normalized post-process viewport covers. The type is the
 * frame graph's own; only the rounding differs from a copy task's, and that
 * difference is the pin's — the far edges round up here and down there.
 */
PixelViewport resolve_post_process_viewport(
    const NormalizedViewport& viewport,
    std::uint32_t target_width,
    std::uint32_t target_height);

/** The blend an alpha mode selects, in the runtime's own factor vocabulary. */
struct PostProcessBlend {
    bool enabled = false;
    BlendFactors factors{};
};

PostProcessBlend post_process_blend(std::uint32_t alpha_mode);

/** The bytes a pass uploads, written by the effect's own pinned writer. */
void write_post_process_uniforms(
    const Engine& engine,
    PostProcessTaskOptions& task,
    std::uint32_t output_width,
    std::uint32_t output_height,
    std::uint32_t source_width,
    std::uint32_t source_height,
    float* data);

} // namespace bbl::upstream
`;
    }

    /** The pin's own switch, as the emitted table's case arms. */
    private blendCases(): string {
        return [...this.blendModes.entries()]
            .map(
                ([mode, factors]) =>
                    `        case ${mode}u:\n` +
                    `            return PostProcessBlend{\n` +
                    `                true,\n` +
                    `                BlendFactors{\n` +
                    factors
                        .map(
                            (factor) =>
                                `                    BlendFactor::${nativeBlendFactor(
                                    factor,
                                )},\n`,
                        )
                        .join("") +
                    `                },\n` +
                    `            };\n`,
            )
            .join("");
    }

    private source(effects: readonly PostProcessEffect[]): string {
        const provenance = this.context.provenance(
            TASK_MODULE,
            "createPostProcessTask",
            effects
                .map((effect) => `${effect.module}#${effect.intrinsic}`)
                .join(", "),
        );
        return `// ${provenance}
#include <bblite/upstream/frame_graph_post_process.hpp>

#include <bblite/js_data.hpp>

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <utility>

namespace bbl::upstream {

PixelViewport resolve_post_process_viewport(
    const NormalizedViewport& viewport,
    std::uint32_t target_width,
    std::uint32_t target_height) {
    const double width = static_cast<double>(target_width);
    const double height = static_cast<double>(target_height);
    const std::int32_t x =
        static_cast<std::int32_t>(std::floor(viewport.x * width));
    const std::int32_t y = static_cast<std::int32_t>(
        std::floor((1.0 - viewport.y - viewport.height) * height));
    return PixelViewport{
        x,
        y,
        static_cast<std::int32_t>(
            std::ceil((viewport.x + viewport.width) * width)) -
            x,
        static_cast<std::int32_t>(
            std::ceil((1.0 - viewport.y) * height)) -
            y,
    };
}

PostProcessBlend post_process_blend(std::uint32_t alpha_mode) {
    switch (alpha_mode) {
${this.blendCases()}        default:
            return PostProcessBlend{};
    }
}

void write_post_process_uniforms(
    const Engine& engine,
    PostProcessTaskOptions& task,
    std::uint32_t output_width,
    std::uint32_t output_height,
    std::uint32_t source_width,
    std::uint32_t source_height,
    float* data) {
    (void)engine;
    (void)output_width;
    (void)output_height;
    (void)source_width;
    (void)source_height;
    (void)data;
    switch (task.shader_index) {
${this.tasks
    .map((task) => this.uniformCase(task))
    .join("\n")}
        default:
            throw std::runtime_error(
                "Post-process pass has no generated uniform writer.");
    }
}

} // namespace bbl::upstream

namespace bbl {

TaskHandle create_post_process_task(
    Engine& engine,
    Scene&,
    PostProcessTaskOptions options) {
    if (
        options.source.source == RenderTextureSource::render_target &&
        options.source.target.value >= engine.render_targets.size()) {
        throw std::runtime_error("Post-process source is invalid.");
    }
    // prepareOutputTarget: the caller's target, or one made from the
    // source's own descriptor at a single sample.
    if (options.target.value != invalid_handle) {
        if (options.target.value >= engine.render_targets.size()) {
            throw std::runtime_error("Post-process target is invalid.");
        }
        options.output_target = options.target;
    } else {
        if (options.source.source != RenderTextureSource::render_target) {
            throw std::runtime_error(
                "A post-process pass with no target needs a render-target "
                "source to size its own.");
        }
        const RenderTargetRecord& source =
            engine.render_targets[options.source.target.value];
        RenderTargetOptions internal;
        internal.samples = 1u;
        internal.has_color = true;
        internal.has_depth = false;
        internal.width = source.width;
        internal.height = source.height;
        options.output_target = create_render_target(engine, internal);
    }
    FrameTaskRecord task;
    task.kind = FrameTaskKind::post_process;
    task.post_process = std::move(options);
    engine.frame_tasks.push_back(std::move(task));
    return TaskHandle{
        static_cast<std::uint32_t>(engine.frame_tasks.size() - 1)};
}

void update_post_process_uniforms(Engine& engine, TaskHandle handle) {
    if (handle.value >= engine.frame_tasks.size()) {
        throw std::runtime_error("Invalid frame task handle.");
    }
    FrameTaskRecord& task = engine.frame_tasks[handle.value];
    if (task.kind != FrameTaskKind::post_process) {
        throw std::runtime_error(
            "updateUniforms names a task that is not a post-process pass.");
    }
    task.post_process.uniforms_dirty = true;
}

} // namespace bbl
`;
    }

    /** One reached pass's writer, lowered from its effect's own body. */
    private uniformCase(task: PostProcessTaskManifest): string {
        const effect = postProcessEffect(task.intrinsic);
        if (!effect) {
            throw new Error(
                `Reached post-process effect '${task.intrinsic}' has no descriptor.`,
            );
        }
        const body = this.uniformWriterBody(effect);
        return `        case ${task.shaderIndex}u: {
${body}
            break;
        }`;
    }

    /**
     * The effect's `writeUniforms`, statement by statement.
     *
     * The pin writes into a `Float32Array`, so every expression evaluates in
     * double and rounds once at the store — the same rule the camera and
     * matrix ports follow. A runtime slot is refreshed first, which is what
     * the chromatic factory's `record` override does before the write.
     */
    private uniformWriterBody(effect: PostProcessEffect): string {
        const lines: string[] = [];
        if (effect.params.length === 0) {
            // An effect with no parameters composes no uniform block, so the
            // pin gives it no writer either -- the anaglyph reads only its
            // two textures.
            return "            // No uniform block.";
        }
        for (const [index, slot] of effect.params.entries()) {
            if (!slot.runtime) continue;
            lines.push(
                `            task.params[${index}] = static_cast<double>(${
                    slot.runtime === "sourceWidth"
                        ? "source_width"
                        : "source_height"
                });`,
            );
        }
        const { declaration } = this.context.propertyFunction(
            effect.module,
            effect.intrinsic,
            "writeUniforms",
        );
        const scope = new Map<string, string>();
        for (const statement of declaration.body.statements) {
            if (ts.isVariableStatement(statement)) {
                for (const binding of statement.declarationList
                    .declarations) {
                    if (
                        !ts.isIdentifier(binding.name) ||
                        !binding.initializer
                    ) {
                        this.context.contractError(
                            binding,
                            "Expected a named binding in writeUniforms.",
                        );
                    }
                    const name = binding.name.text;
                    lines.push(
                        `            const double ${name} = ${this.expression(
                            binding.initializer,
                            effect,
                            scope,
                        )};`,
                    );
                    scope.set(name, name);
                }
                continue;
            }
            if (
                !ts.isExpressionStatement(statement) ||
                !ts.isBinaryExpression(statement.expression) ||
                statement.expression.operatorToken.kind !==
                    ts.SyntaxKind.EqualsToken ||
                !ts.isElementAccessExpression(statement.expression.left) ||
                !ts.isIdentifier(statement.expression.left.expression) ||
                statement.expression.left.expression.text !== "data" ||
                !ts.isNumericLiteral(
                    statement.expression.left.argumentExpression,
                )
            ) {
                this.context.contractError(
                    statement,
                    "Expected writeUniforms to bind a local or store into data[i].",
                );
            }
            const index = Number(
                statement.expression.left.argumentExpression.text,
            );
            lines.push(
                `            data[${index}] = static_cast<float>(${this.expression(
                    statement.expression.right,
                    effect,
                    scope,
                )});`,
            );
        }
        return lines.join("\n");
    }

    /** The bounded expression set a pinned uniform writer uses. */
    private expression(
        expression: ts.Expression,
        effect: PostProcessEffect,
        scope: ReadonlyMap<string, string>,
    ): string {
        const node = this.context.unwrapExpression(expression);
        if (ts.isNumericLiteral(node)) {
            return this.context.doubleLiteral(Number(node.text));
        }
        if (ts.isIdentifier(node)) {
            const local = scope.get(node.text);
            if (local) {
                return local;
            }
            return this.context.contractError(
                node,
                `writeUniforms reads an unbound name '${node.text}'.`,
            );
        }
        if (ts.isBinaryExpression(node)) {
            const operator = PINNED_ARITHMETIC_OPERATORS.get(
                node.operatorToken.kind,
            );
            if (operator) {
                return `(${this.expression(
                    node.left,
                    effect,
                    scope,
                )} ${operator} ${this.expression(
                    node.right,
                    effect,
                    scope,
                )})`;
            }
            if (
                node.operatorToken.kind === ts.SyntaxKind.BarBarToken
            ) {
                // JavaScript's numeric `||`: an extent of zero falls through
                // to the source's, which is what an unsized target reads.
                return `bbl::js::or_number(${this.expression(
                    node.left,
                    effect,
                    scope,
                )}, ${this.expression(node.right, effect, scope)})`;
            }
            return this.context.contractError(
                node,
                "writeUniforms uses an operator this port does not lower.",
            );
        }
        const math = pinnedMathCall(node);
        if (math) {
            return `${math.native}(${math.call.arguments
                .map((argument) =>
                    this.expression(argument, effect, scope),
                )
                .join(", ")})`;
        }
        const path = this.context.propertyPath(node);
        if (path) {
            const native = this.pathExpression(path, effect);
            if (native) {
                return native;
            }
        }
        return this.context.contractError(
            node,
            `writeUniforms reads '${node.getText(
                node.getSourceFile(),
            )}', which this port does not carry.`,
        );
    }

    /** What a pinned read of the effect's own state names natively. */
    private pathExpression(
        path: readonly string[],
        effect: PostProcessEffect,
    ): string | undefined {
        const joined = path.join(".");
        if (path[0] === "params") {
            const slot = effect.params.findIndex(
                (candidate) => candidate.path === path.slice(1).join("."),
            );
            return slot < 0
                ? undefined
                : `task.params[${slot}]`;
        }
        if (path[0] === "camera" && effect.usesCamera) {
            if (path[1] === "nearPlane" || path[1] === "farPlane") {
                const field =
                    path[1] === "nearPlane" ? "near_plane" : "far_plane";
                return `engine.cameras[task.camera.value].${field}`;
            }
            return undefined;
        }
        // The pass's own attachments: `task.outputTexture` is where it draws
        // and `config.sourceTexture` is what it samples.
        if (joined === "task.outputTexture._width") {
            return "static_cast<double>(output_width)";
        }
        if (joined === "task.outputTexture._height") {
            return "static_cast<double>(output_height)";
        }
        if (joined === "config.sourceTexture._width") {
            return "static_cast<double>(source_width)";
        }
        if (joined === "config.sourceTexture._height") {
            return "static_cast<double>(source_height)";
        }
        return undefined;
    }
}
