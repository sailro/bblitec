import { LoweringContext } from "./context.js";
import { lowerTextFunctions } from "./text-records.js";

/**
 * The standalone text renderer, lowered whole from the pin: its layers, its
 * per-layer GPU records, uploads and render bundles, its per-frame update
 * and record passes and its registration on the engine surface. The
 * backends call the lowered update and record for each registered renderer.
 */
export class TextRendererLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public header(): string {
        const { declarations, definitions } = lowerTextFunctions(
            this.context,
            "renderer",
            ["records", "gpu"],
        );
        return `#pragma once
#include <bblite/text_renderer.hpp>
#include <bblite/upstream_text_gpu.hpp>
#include <stdexcept>
namespace bbl {
${declarations}
${definitions}
/** A source write to one component of \`layer.positionPx\`. */
inline void text_write_position_px(TextLayerState& layer, int axis, double value) {
    if (axis == 0)
        layer.position_px.x = value;
    else if (axis == 1)
        layer.position_px.y = value;
    else
        throw std::out_of_range("Text layer position component");
}
} // namespace bbl
`;
    }
}
