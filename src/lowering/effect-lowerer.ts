/**
 * The fullscreen-effect family, lowered from `src/effect/effect-renderer.ts`.
 *
 * There is very little to compose here and that is the point: the pin builds
 * one shader module as `vertexWGSL ?? DEFAULT_VERTEX_WGSL` concatenated with
 * the caller's fragment, so what this port owns is the concatenation and the
 * vertex stage is *lifted* out of the pinned module rather than written down.
 * A pin that changes the fullscreen triangle, the varying it carries, or the
 * entry-point name changes what deploys here, and one that stops declaring the
 * constant fails generation instead.
 *
 * Everything else the pin decides about the pass — the three-vertex draw, the
 * `triangle-list` topology, culling off, no depth attachment, and the sample
 * count coming from the *output target* — is fixed-function state each PAL
 * sets, and is asserted here so it is checked in one place rather than twice.
 */
import ts from "typescript";
import type { LoweredSource, LoweringContext } from "./context.js";

const effectModule = "src/effect/effect-renderer.ts";

/** The stems the two deployed stages of one effect take. */
export function effectStageStems(
    index: number,
): { vertexStem: string; fragmentStem: string } {
    return {
        vertexStem: `effect-${index}.vert`,
        fragmentStem: `effect-${index}.frag`,
    };
}

export class EffectLowerer {
    /**
     * The pin's own fullscreen-triangle stage, lifted once.
     *
     * Both it and the pass contract belong to the pinned module rather than
     * to any one descriptor, so a scene building three effects reads and
     * checks them once between the three.
     */
    private readonly vertexWgsl: string;

    public constructor(private readonly context: LoweringContext) {
        this.assertPassContract();
        const file = this.context.sourceFile(effectModule);
        this.vertexWgsl = this.context.stringValue(
            this.context.variableInitializer(file, "DEFAULT_VERTEX_WGSL"),
            file,
        );
    }

    /**
     * The pin's own module text for one descriptor's fragment body:
     * `getShaderModule`'s own template, evaluated — the vertex stage, one
     * newline, then the caller's fragment.
     */
    public composeModule(fragmentWgsl: string): string {
        return `${this.vertexWgsl}\n${fragmentWgsl}`;
    }

    /**
     * The runtime half: the two records a scene fills after creation, and the
     * two ways it schedules the draw.
     *
     * There is no shader work and no layout work here, because both were
     * settled at generation. What survives is the pin's own state: which
     * wrapper a renderer or task draws, its clear state, and the uniform and
     * texture slots the setters write.
     */
    public lowerFactory(): LoweredSource {
        return {
            modulePath: effectModule,
            symbolName: "createEffectWrapper,createEffectRenderer",
            header: "",
            source: `// ${this.provenance()}
#include <bblite/runtime.hpp>
#include <bblite/upstream/effect_variants.hpp>

#include <stdexcept>
#include <string>
#include <utility>

namespace bbl {

// createEffectWrapper: a pure-state handle. createBindingSlots allocates one
// slot per declared binding, which generation already resolved into the
// variant table, so creating the record is filling the texture slots the
// descriptor named.
EffectWrapperHandle create_effect_wrapper(
    Engine& engine,
    std::uint32_t variant) {
    const upstream::EffectVariantEntry& entry =
        upstream::effect_variants.at(variant);
    EffectWrapperRecord wrapper;
    wrapper.variant = variant;
    for (std::size_t index = 0; index < entry.binding_count; ++index) {
        const upstream::EffectVariantBinding& binding =
            upstream::effect_variant_bindings.at(entry.first_binding + index);
        if (binding.kind != upstream::EffectBindingKind::texture) continue;
        EffectTextureSlot slot;
        slot.name = std::string(binding.name);
        wrapper.textures.push_back(std::move(slot));
    }
    engine.effect_wrappers.push_back(std::move(wrapper));
    return EffectWrapperHandle{
        static_cast<std::uint32_t>(engine.effect_wrappers.size() - 1)};
}

// setEffectUniforms: the single-payload arm, which writes the wrapper's
// first uniform slot. The pin refuses a wrapper with no uniform binding and
// so does this.
void set_effect_uniforms(
    Engine& engine,
    EffectWrapperHandle effect,
    const std::vector<float>& values) {
    EffectWrapperRecord& wrapper = engine.effect_wrappers.at(effect.value);
    const upstream::EffectVariantEntry& entry =
        upstream::effect_variants.at(wrapper.variant);
    std::uint32_t bytes = 0;
    for (std::size_t index = 0; index < entry.binding_count; ++index) {
        const upstream::EffectVariantBinding& binding =
            upstream::effect_variant_bindings.at(entry.first_binding + index);
        if (binding.kind != upstream::EffectBindingKind::uniform) continue;
        bytes = binding.uniform_bytes;
        break;
    }
    if (bytes == 0) {
        throw std::runtime_error(
            "setEffectUniforms: wrapper has no uniform binding.");
    }
    if (values.size() * sizeof(float) > bytes) {
        throw std::runtime_error(
            "setEffectUniforms: payload exceeds the uniform binding size.");
    }
    wrapper.uniform_values = values;
    wrapper.uniform_values.resize(bytes / sizeof(float), 0.0f);
    wrapper.uniforms_dirty = true;
}

// setEffectTexture: the slot the binding name owns.
void set_effect_texture(
    Engine& engine,
    EffectWrapperHandle effect,
    const std::string& name,
    SolidTexture texture) {
    EffectWrapperRecord& wrapper = engine.effect_wrappers.at(effect.value);
    for (EffectTextureSlot& slot : wrapper.textures) {
        if (slot.name != name) continue;
        slot.texture = texture;
        slot.set = true;
        return;
    }
    throw std::runtime_error(
        "setEffectTexture: unknown texture binding '" + name + "'.");
}

EffectRendererHandle create_effect_renderer(
    Engine& engine,
    EffectWrapperHandle effect,
    EffectRendererOptions options) {
    EffectRendererRecord renderer;
    renderer.effect = effect;
    renderer.clear = options.clear;
    renderer.clear_color = options.clear_color;
    engine.effect_renderers.push_back(renderer);
    return EffectRendererHandle{
        static_cast<std::uint32_t>(engine.effect_renderers.size() - 1)};
}

// registerEffectRenderer: registration order is draw order across rendering
// contexts, as it is for the sprite half.
void register_effect_renderer(
    Engine& engine,
    EffectRendererHandle renderer) {
    for (const EffectRendererHandle& registered :
         engine.registered_effect_renderers) {
        if (registered.value == renderer.value) return;
    }
    engine.registered_effect_renderers.push_back(renderer);
}

TaskHandle create_effect_render_task(
    Engine& engine,
    Scene&,
    EffectTaskOptions options) {
    if (options.target.value >= engine.render_targets.size()) {
        throw std::runtime_error("Effect render task target is invalid.");
    }
    FrameTaskRecord task;
    task.kind = FrameTaskKind::effect;
    task.effect = std::move(options);
    engine.frame_tasks.push_back(std::move(task));
    return TaskHandle{
        static_cast<std::uint32_t>(engine.frame_tasks.size() - 1)};
}

} // namespace bbl
`,
        };
    }

    public provenance(): string {
        return this.context.provenance(
            effectModule,
            "createEffectWrapper",
            "DEFAULT_VERTEX_WGSL",
        );
    }

    /**
     * The state both PALs build the pipeline with, checked against the pin.
     *
     * Each is fixed-function rather than text, so nothing downstream would
     * notice the pin changing one; this is where that change stops being
     * silent.
     */
    private assertPassContract(): void {
        const { declaration } = this.context.functionDeclaration(
            effectModule,
            "getEffectPipeline",
        );
        const argument = this.context.callObjectArgument(
            declaration,
            "createRenderPipeline",
        );
        this.context.assertExpressionShape(
            this.context.propertyInitializer(argument, "primitive"),
            '{ topology: "triangle-list" }',
            "effect pipeline primitive state",
        );
        this.context.assertExpressionShape(
            this.context.propertyInitializer(argument, "multisample"),
            "{ count: targetSignature._sampleCount }",
            "effect pipeline sample count",
        );
        for (const [stage, entryPoint] of [
            ["vertex", "effectFullscreenVertex"],
            ["fragment", "effectFragment"],
        ] as const) {
            const state = this.context.propertyInitializer(argument, stage);
            if (!ts.isObjectLiteralExpression(state)) {
                this.context.contractError(
                    state,
                    `Pinned effect pipeline '${stage}' is no longer an ` +
                        "object literal.",
                );
            }
            this.context.assertExpressionShape(
                this.context.propertyInitializer(state, "entryPoint"),
                `"${entryPoint}"`,
                `effect ${stage} entry point`,
            );
        }
        // The template this port actually reproduces. Lifting
        // DEFAULT_VERTEX_WGSL protects the constant; this protects the shape
        // around it, which is the half `composeModule` authors -- a pin that
        // changed the separator, inserted a prelude or swapped the two halves
        // would otherwise keep deploying a module the browser no longer
        // compiles. It is also where `vertexWGSL` is refused: the `??` IS the
        // decision the frontend declines to serve.
        this.context.assertExpressionShape(
            this.context.propertyInitializer(
                this.context.callObjectArgument(
                    this.context.functionDeclaration(
                        effectModule,
                        "getShaderModule",
                    ).declaration,
                    "createShaderModule",
                ),
                "code",
            ),
            "`${wrapper.options.vertexWGSL ?? DEFAULT_VERTEX_WGSL}\\n" +
                "${wrapper.options.fragmentWGSL}`",
            "effect shader module template",
        );

        // The defaults the frontend restates beside the descriptor it reads.
        // Each is a value the pin can change silently -- a working build that
        // renders the wrong thing -- so the shape each one restates is
        // asserted here, exactly as the pass state above is.
        const returnedExpression = (
            symbol: string,
            index = 0,
        ): ts.Expression => {
            const owner = this.context.functionDeclaration(
                effectModule,
                symbol,
            ).declaration;
            const returned = this.context.findNodes(
                owner,
                (node): node is ts.ReturnStatement =>
                    ts.isReturnStatement(node),
            )[index]?.expression;
            if (!returned) {
                this.context.contractError(
                    owner,
                    `Pinned ${symbol} no longer returns ${index + 1} ` +
                        "expression(s).",
                );
            }
            return returned;
        };
        this.context.assertExpressionShape(
            returnedExpression("align4"),
            "(value + 3) & ~3",
            "effect uniform alignment",
        );
        // Both arms: the frontend folds this lookup at generation, so a pin
        // that started matching on something else would silently bind a
        // sampler to a different texture.
        this.context.assertExpressionShape(
            returnedExpression("matchesBinding"),
            "layout.binding === bindingNameOrIndex",
            "effect binding index match",
        );
        this.context.assertExpressionShape(
            returnedExpression("matchesBinding", 1),
            "layout.name === bindingNameOrIndex || " +
                "String(layout.binding) === bindingNameOrIndex",
            "effect binding name match",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                this.context.functionDeclaration(
                    effectModule,
                    "createBindingSlots",
                ).declaration,
                "byteLength",
            ),
            "align4(layout.uniformByteLength ?? 16)",
            "effect uniform byte length default",
        );
        const renderer = this.context.functionDeclaration(
            effectModule,
            "createEffectRenderer",
        ).declaration;
        this.context.assertExpressionShape(
            this.context.variableInitializer(renderer, "clear"),
            "options?.clear !== false",
            "effect renderer clear default",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(renderer, "clearColor"),
            "options?.clearColor ?? { r: 0, g: 0, b: 0, a: 1 }",
            "effect renderer clear colour default",
        );
        // The task half states both defaults its own way: the clear colour is
        // assigned into the config, and the flag is read at the pass.
        const task = this.context.functionDeclaration(
            effectModule,
            "createEffectRenderTask",
        ).declaration;
        this.context.assertExpressionShape(
            this.context.callExpression(task, "applyColorAttachmentState")
                .arguments[3]!,
            "task._config.clear !== false",
            "effect task clear default",
        );
        this.context.assertExpressionShape(
            this.context.findNodes(
                task,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.QuestionQuestionEqualsToken,
            )[0]!,
            "config.clearColor ??= { r: 0, g: 0, b: 0, a: 1 }",
            "effect task clear colour default",
        );
        this.context.assertExpressionShape(
            this.context.propertyInitializer(
                this.context.objectInitializer(
                    this.context.functionDeclaration(
                        effectModule,
                        "createEffectWrapper",
                    ).declaration,
                    "wrapper",
                ),
                "name",
            ),
            'options.name ?? "effect-wrapper"',
            "effect wrapper name default",
        );

        // The three-vertex draw, in both of the pin's own recorders.
        for (const symbol of ["createEffectRenderTask", "createEffectRenderer"]) {
            const owner = this.context.functionDeclaration(
                effectModule,
                symbol,
            ).declaration;
            const draw = this.context.findNodes(
                owner,
                (node): node is ts.CallExpression =>
                    ts.isCallExpression(node) &&
                    ts.isPropertyAccessExpression(node.expression) &&
                    node.expression.name.text === "draw",
            )[0];
            if (!draw || draw.arguments.length !== 1) {
                this.context.contractError(
                    owner,
                    `Pinned ${symbol} no longer records a single draw call.`,
                );
            }
            this.context.assertExpressionShape(
                draw.arguments[0]!,
                "3",
                `${symbol} fullscreen vertex count`,
            );
        }
    }
}
