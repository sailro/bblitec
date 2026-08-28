import ts from "typescript";
import {
    POST_PROCESS_EFFECTS,
    postProcessComposite,
    postProcessEffect,
    slotOption,
    type PostProcessEffect,
} from "../post-process-effects.js";
import type { PostProcessTaskManifest } from "../compiler/types.js";
import {
    COMPOSITION_NAME,
    type ComposedComposite,
    type CompositeTextureRef,
} from "../pinned-post-process.js";
import {
    doubleLiteral as dvalue,
    stringLiteral,
} from "../cpp-literals.js";
import { LoweredSource, LoweringContext } from "./context.js";
import { blendSide, nativeBlendFactor } from "./pinned-blend-table.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

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
        private readonly composites: readonly ComposedComposite[] = [],
        /**
         * A preformatted " (reached from <file:line>)" suffix naming the
         * scene call site that pulled the post-process family in, appended
         * to the composite refusals; empty when the caller has no site.
         */
        private readonly refusalSite: string = "",
    ) {
        this.passes = postProcessPassOrder(tasks, composites);
    }

    /**
     * Every pass this scene records, by the stage index it deploys at.
     *
     * The plain effects come first in reach order -- the compiler numbered
     * them before anything was composed -- and each composite's own chain
     * follows. One table indexes both because a pass is a pass once composed:
     * what differs is only who decided its config. Computed once: the writer
     * dispatch, the emitted records and the deployed stage table all have to
     * agree on it, and a second derivation is a second thing to keep in step.
     */
    private readonly passes: readonly PostProcessPassOrder[];

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
        const reached = new Set(
            this.passes.map((pass) => pass.intrinsic),
        );
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
            effect.declaredIn ?? effect.intrinsic,
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
    PostProcessPassOptions& task,
    std::uint32_t output_width,
    std::uint32_t output_height,
    std::uint32_t source_width,
    std::uint32_t source_height,
    float* data);

} // namespace bbl::upstream
${this.compositeDeclarations()}`;
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
    PostProcessPassOptions& task,
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
${this.uniformCases()}
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
    if (options.passes.empty()) {
        throw std::runtime_error("Post-process task records no pass.");
    }
    for (PostProcessPassOptions& pass : options.passes) {
        if (
            pass.source.source == RenderTextureSource::render_target &&
            pass.source.target.value >= engine.render_targets.size()) {
            throw std::runtime_error("Post-process source is invalid.");
        }
        // prepareOutputTarget: the caller's target, or one made from the
        // source's own descriptor at a single sample.
        if (pass.target.value != invalid_handle) {
            if (pass.target.value >= engine.render_targets.size()) {
                throw std::runtime_error("Post-process target is invalid.");
            }
            pass.output_target = pass.target;
            continue;
        }
        if (pass.source.source != RenderTextureSource::render_target) {
            throw std::runtime_error(
                "A post-process pass with no target needs a render-target "
                "source to size its own.");
        }
        const RenderTargetRecord& source =
            engine.render_targets[pass.source.target.value];
        RenderTargetOptions internal;
        internal.samples = 1u;
        internal.has_color = true;
        internal.has_depth = false;
        internal.width = source.width;
        internal.height = source.height;
        pass.output_target = create_render_target(engine, internal);
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
    // The pin's composite forwards to every sub-pass, and a plain effect is
    // the same call over a list of one.
    for (PostProcessPassOptions& pass : task.post_process.passes) {
        pass.uniforms_dirty = true;
    }
}

${this.compositeFactories()}
} // namespace bbl
`;
    }

    /** Every reached composite's factory, and the header lines that declare
     *  them, in the order the scene reached them. */
    private compositeFactories(): string {
        let shaderIndex = this.tasks.length;
        const factories: string[] = [];
        for (const [index, composite] of this.composites.entries()) {
            factories.push(
                this.compositeFactory(composite, index, shaderIndex),
            );
            shaderIndex += composite.passes.length;
        }
        return factories.length > 0 ? `${factories.join("\n\n")}\n` : "";
    }

    private compositeDeclarations(): string {
        if (this.composites.length === 0) {
            return "";
        }
        const declarations = this.composites
            .map(
                (_composite, index) =>
                    `TaskHandle create_composite_post_process_task_${index}(\n` +
                    "    Engine& engine,\n" +
                    "    Scene& scene,\n" +
                    "    PostProcessCompositeInputs inputs);",
            )
            .join("\n\n");
        return `\nnamespace bbl {\n\n${declarations}\n\n} // namespace bbl\n`;
    }

    /**
     * One composite's factory, as the chain its own factory built.
     *
     * The pin's composite creates its intermediates and then its passes over
     * them, so this emits exactly that: `create_render_target` per
     * intermediate, in the order the composite made them, then one
     * `create_post_process_task` holding every pass. Nothing here decides the
     * chain — it is read off the run, which is why a composite needs no
     * per-effect code in this port at all.
     */
    private compositeFactory(
        composite: ComposedComposite,
        index: number,
        firstShaderIndex: number,
    ): string {
        const lines: string[] = [];
        for (const [slot, target] of composite.intermediates.entries()) {
            lines.push(
                `    RenderTargetOptions ${intermediate(slot)}_options;`,
                `    ${intermediate(slot)}_options.samples = 1u;`,
                `    ${intermediate(slot)}_options.has_color = true;`,
                `    ${intermediate(
                    slot,
                )}_options.scale_source = inputs.source;`,
                `    ${intermediate(
                    slot,
                )}_options.width_ratio = ${dvalue(target.widthRatio)};`,
                `    ${intermediate(
                    slot,
                )}_options.height_ratio = ${dvalue(target.heightRatio)};`,
            );
            if (target.format) {
                lines.push(
                    `    ${intermediate(slot)}_options.format = ` +
                        `${nativeTextureFormat(
                            target.format,
                            target.label,
                            this.refusalSite,
                        )};`,
                    `    ${intermediate(slot)}_options.has_format = true;`,
                );
            }
            lines.push(
                `    const RenderTargetHandle ${intermediate(slot)} =`,
                `        create_render_target(engine, ${intermediate(
                    slot,
                )}_options);`,
                "",
            );
        }
        const reference = (
            texture: CompositeTextureRef,
            asTarget: boolean,
        ): string => {
            if (texture.kind === "internal") {
                return asTarget ? "RenderTargetHandle{}" : "RenderTextureRef{}";
            }
            if (texture.kind === "intermediate") {
                const handle = intermediate(texture.index);
                return asTarget ? handle : `render_target_texture(${handle})`;
            }
            if (texture.option === "sourceTexture") {
                return asTarget
                    ? "inputs.source"
                    : "render_target_texture(inputs.source)";
            }
            if (texture.option === "targetTexture") {
                if (!asTarget) {
                    throw new Error(
                        "A composite pass reads the task's own output " +
                            `target.${this.refusalSite}`,
                    );
                }
                return "inputs.target";
            }
            const slot = compositeExtraIndex(
                composite,
                texture.option,
                this.refusalSite,
            );
            return `inputs.extra_textures[${slot}]`;
        };
        const passes = composite.passes.map((pass, slot) => {
            const extras = pass.extraTextures
                .map((texture) => reference(texture, false))
                .join(", ");
            return (
                `        PostProcessPassOptions{\n` +
                `            ${passName(pass.name, this.refusalSite)},\n` +
                `            ${firstShaderIndex + slot}u,\n` +
                `            ${reference(pass.source, false)},\n` +
                `            ${reference(pass.target, true)},\n` +
                `            PostProcessSampling::${nativeSampling(
                    pass.sampling,
                    pass.name,
                    this.refusalSite,
                )},\n` +
                `            ${pass.alphaMode}u,\n` +
                `            ${pass.viewport ? "true" : "false"},\n` +
                `            NormalizedViewport{${
                    pass.viewport
                        ? [
                              pass.viewport.x,
                              pass.viewport.y,
                              pass.viewport.width,
                              pass.viewport.height,
                          ]
                              .map((value) => dvalue(value))
                              .join(", ")
                        : ""
                }},\n` +
                `            ${pass.clear ? "true" : "false"},\n` +
                `            {${extras}},\n` +
                `            inputs.camera,\n` +
                `            {${pass.params
                    .map((value) => dvalue(value))
                    .join(", ")}},\n` +
                `        }`
            );
        });
        return `TaskHandle create_composite_post_process_task_${index}(
    Engine& engine,
    Scene& scene,
    PostProcessCompositeInputs inputs) {
${lines.join("\n")}    PostProcessTaskOptions options;
    options.name = inputs.name;
    options.passes = {
${passes.join(",\n")},
    };
    return create_post_process_task(engine, scene, std::move(options));
}`;
    }

    /**
     * The writer dispatch, one arm per effect rather than per pass.
     *
     * Two passes of the same effect run the same writer -- depth of field's
     * six blurs differ only in the direction their parameters carry -- so
     * their stage indices share a case and the body is lowered once.
     */
    private uniformCases(): string {
        const byEffect = new Map<string, number[]>();
        for (const pass of this.passes) {
            const indices = byEffect.get(pass.intrinsic) ?? [];
            indices.push(pass.shaderIndex);
            byEffect.set(pass.intrinsic, indices);
        }
        return [...byEffect]
            .map(([intrinsic, indices]) => {
                const effect = postProcessEffect(intrinsic);
                if (!effect) {
                    throw new Error(
                        `Reached post-process effect '${intrinsic}' has no descriptor.`,
                    );
                }
                const labels = indices
                    .map((index) => `        case ${index}u:`)
                    .join("\n");
                return `${labels} {
${this.uniformWriterBody(effect)}
            break;
        }`;
            })
            .join("\n");
    }

    /**
     * The effect's `writeUniforms`, statement by statement through the
     * shared `PinnedNumericLowerer`.
     *
     * The pin writes into a `Float32Array`, so every expression evaluates in
     * double and rounds once at the store — the translator's own rule. A
     * runtime slot is refreshed first, which is what the chromatic factory's
     * `record` override does before the write. What used to be this file's
     * private walker survives as the binding table below: the effect-path
     * resolver, spelled as the names a pinned body may read.
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
        const { file, declaration } = this.context.propertyFunction(
            effect.module,
            effect.declaredIn ?? effect.intrinsic,
            "writeUniforms",
        );
        // The effect's own state, spelled onto the records the emitted
        // writer reads: `params.<path>` by descriptor slot (first slot wins,
        // the way the descriptor's own lookup did), the camera planes where
        // the effect binds a camera, and the pass's two attachment extents.
        // A read outside this table fails generation, as it did before.
        const bindings = new Map<string, PinnedBinding>([
            ["data", { cpp: "data", type: "f32" }],
            [
                "task.outputTexture._width",
                {
                    cpp: "static_cast<double>(output_width)",
                    type: "scalar",
                },
            ],
            [
                "task.outputTexture._height",
                {
                    cpp: "static_cast<double>(output_height)",
                    type: "scalar",
                },
            ],
            [
                "config.sourceTexture._width",
                {
                    cpp: "static_cast<double>(source_width)",
                    type: "scalar",
                },
            ],
            [
                "config.sourceTexture._height",
                {
                    cpp: "static_cast<double>(source_height)",
                    type: "scalar",
                },
            ],
        ]);
        for (const [slot, parameter] of effect.params.entries()) {
            const key = `params.${parameter.path}`;
            if (!bindings.has(key)) {
                bindings.set(key, {
                    cpp: `task.params[${slot}]`,
                    type: "scalar",
                });
            }
        }
        if (effect.usesCamera) {
            bindings.set("camera.nearPlane", {
                cpp: "engine.cameras[task.camera.value].near_plane",
                type: "scalar",
            });
            bindings.set("camera.farPlane", {
                cpp: "engine.cameras[task.camera.value].far_plane",
                type: "scalar",
            });
        }
        // A name the effect module declares itself -- `extract-highlights.ts`
        // raises its threshold through a module-scope `TO_GAMMA_SPACE` --
        // resolves in the translator against that declaration, so only what
        // the module does NOT declare is bound above.
        const lowerer = new PinnedNumericLowerer(file, {
            bindings,
            calls: pinnedNumericMathCalls(),
        });
        for (const statement of declaration.body.statements) {
            lines.push(...lowerer.statement(statement, "            "));
        }
        return lines.join("\n");
    }
}

/** The sampler a pass asked for, refusing a mode this port does not carry. */
function nativeSampling(
    mode: string,
    name: string,
    refusalSite = "",
): string {
    if (mode !== "nearest" && mode !== "linear") {
        throw new Error(
            `A composite's pass '${name}' samples in '${mode}', which is ` +
                `neither of the two modes the pass carries.${refusalSite}`,
        );
    }
    return mode;
}

/**
 * A sub-pass's name, as the pin derives it: the composite's own name plus a
 * suffix. The composite's name is the scene's, known only at run time, so the
 * suffix is what generation carries.
 */
function passName(name: string, refusalSite = ""): string {
    if (!name.startsWith(COMPOSITION_NAME)) {
        throw new Error(
            `A composite named a pass '${name}', which does not derive from ` +
                `the name it was given.${refusalSite}`,
        );
    }
    return `inputs.name + ${stringLiteral(
        name.slice(COMPOSITION_NAME.length),
    )}`;
}

/** A composite's own intermediate target, by the order it created them. */
function intermediate(index: number): string {
    return `intermediate_${index}`;
}

/**
 * Where a composite's config option sits in the inputs' texture list. The
 * order is the descriptor's, which is also the order the compiler emitted the
 * scene's textures in.
 */
function compositeExtraIndex(
    composite: ComposedComposite,
    option: string,
    refusalSite = "",
): number {
    const descriptor = postProcessComposite(composite.intrinsic);
    const slot = descriptor?.extraTextures.indexOf(option) ?? -1;
    if (slot < 0) {
        throw new Error(
            `${composite.intrinsic} builds a pass reading '${option}', ` +
                `which its descriptor does not name as a texture.${refusalSite}`,
        );
    }
    return slot;
}

/**
 * The runtime's own name for a format a composite asked a target for.
 *
 * Only a format the composite *chose* reaches here: one it took off the source
 * is carried as "follows the source" and resolved by the backend against the
 * target it scales from. So there is no channel-order aliasing to assert --
 * a swapchain-shaped format arriving here would mean the composite named one,
 * which it does not, and is refused with everything else unlisted.
 */
function nativeTextureFormat(
    format: string,
    label: string,
    refusalSite = "",
): string {
    const native: Readonly<Record<string, string>> = {
        r16float: "TextureFormatClass::r16_float",
        r32float: "TextureFormatClass::r32_float",
        rgba8unorm: "TextureFormatClass::rgba8_unorm",
        rgba16float: "TextureFormatClass::rgba16_float",
    };
    const name = native[format];
    if (!name) {
        throw new Error(
            `A composite sizes '${label}' in '${format}', which this port's ` +
                `two backends do not both express.${refusalSite}`,
        );
    }
    return name;
}

/** One pass, by the stage index it deploys at. */
interface PostProcessPassOrder {
    shaderIndex: number;
    intrinsic: string;
}

/**
 * Every pass a scene records, in the one order the whole pipeline agrees on.
 *
 * The plain effects come first in reach order -- the compiler numbered them
 * before anything was composed -- and each composite's own chain follows. The
 * writer dispatch, the emitted records and the deployed stage table all index
 * by it, so it is derived here and nowhere else.
 */
export function postProcessPassOrder(
    tasks: readonly PostProcessTaskManifest[],
    composites: readonly ComposedComposite[],
): PostProcessPassOrder[] {
    const passes = tasks.map((task) => ({
        shaderIndex: task.shaderIndex,
        intrinsic: task.intrinsic,
    }));
    for (const composite of composites) {
        for (const pass of composite.passes) {
            passes.push({
                shaderIndex: passes.length,
                intrinsic: pass.intrinsic,
            });
        }
    }
    return passes;
}
