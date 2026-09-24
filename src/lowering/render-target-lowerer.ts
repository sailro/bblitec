import ts from "typescript";

import type { LoweredSource, LoweringContext } from "./context.js";
import { lowerSurfaceRenderTargetSize } from "./render-target-size.js";
import { lowerRenderTargetLifecycle } from "./render-target-lifecycle.js";
import { recordAt } from "../compiler/record-access.js";

const renderTargetModule = "src/engine/render-target.ts";
const rttModule = "src/texture/rtt.ts";

/** Lowers render-target allocation independently of any renderer or task family. */
export class RenderTargetLowerer {
    public constructor(
        private readonly context: LoweringContext,
        private readonly surface = false,
    ) {
        this.context.functionDeclaration(
            renderTargetModule,
            "createRenderTarget",
        );
        this.assertPinnedRenderTargetTextureArms();
    }

    /**
     * `createRenderTargetTexture`, whole: both arms and the fork between
     * them. The native record preserves that fork as `has_color`, while the
     * returned texture reference selects the attachment the pin selected.
     */
    private assertPinnedRenderTargetTextureArms(): void {
        const { declaration } = this.context.functionDeclaration(
            rttModule,
            "_createRenderTargetTexture",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "hasColor"),
            "!!descriptor.format",
            "Render-target color selection",
        );
        const texture = this.context.unwrapExpression(
            this.context.variableInitializer(declaration, "texture"),
        );
        if (!ts.isConditionalExpression(texture))
            this.context.contractError(
                texture,
                "Expected color/depth texture selection.",
            );
        this.context.assertExpressionShape(
            texture.condition,
            "hasColor",
            "Render-target color predicate",
        );
        this.context.assertExpressionShape(
            texture.whenFalse,
            "depthTexture",
            "Render-target depth fallback",
        );
        const depth = this.context.functionDeclaration(
            "src/texture/rtt-depth.ts",
            "withSampledDepthTexture",
        ).declaration;
        for (const [property, value] of [
            ["aspect", "depth-only"],
            ["_sampleType", "depth"],
        ] as const) {
            if (
                !this.context.hasNode(
                    depth,
                    (node) =>
                        ts.isPropertyAssignment(node) &&
                        this.context.propertyName(node.name) === property &&
                        ts.isStringLiteral(node.initializer) &&
                        node.initializer.text === value,
                )
            ) {
                this.context.contractError(
                    declaration,
                    `Expected ${property}: '${value}'.`,
                );
            }
        }
        if (
            !this.context.hasNode(
                declaration,
                (node) =>
                    ts.isPropertyAssignment(node) &&
                    this.context.propertyName(node.name) === "invertY" &&
                    node.initializer.kind === ts.SyntaxKind.TrueKeyword,
            )
        ) {
            this.context.contractError(
                declaration,
                "Expected the colour render-target view to carry invertY: true.",
            );
        }
        for (const [owner, sampler] of [
            [depth, "getNearestSampler"],
            [declaration, "getBilinearSampler"],
        ] as const) {
            if (!this.context.hasCall(owner, sampler)) {
                this.context.contractError(
                    declaration,
                    `Expected ${sampler} for render-target views.`,
                );
            }
        }
    }

    public lower(): LoweredSource {
        return {
            modulePath: renderTargetModule,
            symbolName: "createRenderTarget,createRenderTargetTexture",
            header: "",
            source: `// ${this.context.provenance(
                renderTargetModule,
                "createRenderTarget",
                `${rttModule}#createRenderTargetTexture`,
            )}
#include <bblite/runtime.hpp>

#include <stdexcept>
#include <bblite/js_data.hpp>
${this.surface ? "#include <bblite/pal_async_engine.hpp>\n#include <bblite/js_aggregate_error.hpp>" : ""}

namespace bbl {

${lowerSurfaceRenderTargetSize(this.context)}
${this.surface ? lowerRenderTargetLifecycle(this.context) : ""}

RenderTargetHandle create_render_target(
    Engine& engine,
    RenderTargetOptions options) {
    if (!options.has_color && !options.has_depth) {
        throw std::runtime_error(
            "Render target requires a color or depth attachment.");
    }
    if ((options.width == 0) != (options.height == 0)) {
        throw std::runtime_error(
            "Render target fixed dimensions must both be non-zero.");
    }
    if (
        options.scale_source.value != invalid_handle &&
        options.scale_source.value >= engine.render_targets.size()) {
        throw std::runtime_error(
            "Render target scales from a target that does not exist yet.");
    }
    engine.render_targets.push_back(RenderTargetRecord{
        options.samples == 4 ? 4u : 1u,
        options.has_color,
        options.has_depth,
        options.sampled_depth,
        false,
        options.width,
        options.height,
        options.scale_source,
        options.width_ratio,
        options.height_ratio,
        options.format,
        options.has_format,
        options.shadow_map,
        // One, unless a cascaded shadow generator asked for one depth layer
        // per cascade.
        options.depth_layers == 0 ? 1u : options.depth_layers,
        options.scale_rounding,
        {},
        options.resolve_surface_size,
        {},
        options.depth_format,
    });
    return RenderTargetHandle{
        static_cast<std::uint32_t>(engine.render_targets.size() - 1)};
}

RenderTargetTexture create_render_target_texture(
    Engine& engine,
    RenderTargetOptions options,
    bool surface_sized) {
    if (!surface_sized && (options.width == 0 || options.height == 0)) {
        throw std::runtime_error(
            "Render target textures require fixed dimensions.");
    }
    if (surface_sized && (options.width != 0 || options.height != 0)) {
        throw std::runtime_error("Surface render target textures require surface dimensions.");
    }
    if (options.sampled_depth && (!options.has_depth || options.samples != 1)) {
        throw std::runtime_error("#650");
    }
    const RenderTargetHandle target =
        create_render_target(engine, options);
${this.surface ? `    if (surface_sized) ${recordAt("engine.render_targets", "target")}.lifecycle = make_render_target_lifecycle(engine, true);` : ""}
    RenderTextureRef depth;
    if (options.sampled_depth) {
        depth = render_target_texture(target);
        depth.depth_only = true;
    }
    return RenderTargetTexture{
        target,
        render_target_texture(target),
        depth,
    };
}

RenderTargetHandle swapchain_render_target(Engine& engine) {
    if (engine.swapchain_target.value == invalid_handle) {
        RenderTargetRecord target;
        target.samples = 1u;
        target.has_color = true;
        target.swapchain = true;
        engine.render_targets.push_back(target);
        engine.swapchain_target = RenderTargetHandle{
            static_cast<std::uint32_t>(engine.render_targets.size() - 1)};
    }
    return engine.swapchain_target;
}

RenderTextureRef render_target_texture(RenderTargetHandle target) {
    RenderTextureRef result;
    result.source = RenderTextureSource::render_target;
    result.target = target;
    return result;
}

} // namespace bbl
`,
        };
    }
}
