import ts from "typescript";

import type { LoweredSource, LoweringContext } from "./context.js";

const renderTargetModule = "src/engine/render-target.ts";
const rttModule = "src/texture/rtt.ts";

/** Lowers render-target allocation independently of any renderer or task family. */
export class RenderTargetLowerer {
    public constructor(private readonly context: LoweringContext) {
        this.context.functionDeclaration(renderTargetModule, "createRenderTarget");
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
            "createRenderTargetTexture",
        );
        const missingColour = (name: string): boolean =>
            !this.context.hasNode(
                declaration,
                (node) =>
                    ts.isPrefixUnaryExpression(node) &&
                    node.operator === ts.SyntaxKind.ExclamationToken &&
                    this.context.propertyPath(node.operand)?.at(-1) === name,
            );
        if (missingColour("_colorTexture") || missingColour("_colorView")) {
            this.context.contractError(
                declaration,
                "Expected the render-target texture to fork on the " +
                    "absence of a colour texture and view.",
            );
        }
        for (const [property, value] of [
            ["aspect", "depth-only"],
            ["_sampleType", "depth"],
        ] as const) {
            if (
                !this.context.hasNode(
                    declaration,
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
        for (const sampler of ["getNearestSampler", "getBilinearSampler"] as const) {
            if (!this.context.hasCall(declaration, sampler)) {
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

namespace bbl {

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
    });
    return RenderTargetHandle{
        static_cast<std::uint32_t>(engine.render_targets.size() - 1)};
}

RenderTargetTexture create_render_target_texture(
    Engine& engine,
    RenderTargetOptions options) {
    if (options.width == 0 || options.height == 0) {
        throw std::runtime_error(
            "Render target textures require fixed dimensions.");
    }
    if (!options.has_color && options.has_depth) {
        options.sampled_depth = true;
    }
    const RenderTargetHandle target =
        create_render_target(engine, options);
    return RenderTargetTexture{
        target,
        render_target_texture(target),
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
