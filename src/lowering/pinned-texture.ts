import type { LoweringContext } from "./context.js";
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

/** Texture allocation facts and mip arithmetic, read/lowered from the pin. */
export function pinnedTextureHeader(context: LoweringContext): string {
    const module = "src/frame-graph/transmission.ts";
    const { file, declaration } = context.functionDeclaration(module, "createRenderTaskTransmission");
    const extent = (name: string): number => context.numericValue(context.variableInitializer(declaration, name), file);
    const width = extent("width"), height = extent("height");
    if (width !== height || !Number.isInteger(width) || width <= 0) {
        context.contractError(declaration, "Native transmission requires a positive square pinned extent.");
    }
    const samplerFile = context.sourceFile("src/resource/trilinear-anisotropic-sampler.ts");
    const sampler = context.objectInitializer(samplerFile, "_trilinearAnisotropicDesc");
    const anisotropy = context.numericValue(context.propertyInitializer(sampler, "maxAnisotropy"), samplerFile);
    const calls = pinnedNumericMathCalls();
    const dimensions = [
        { pinned: "width", kind: "number" as const, cpp: "width" },
        { pinned: "height", kind: "number" as const, cpp: "height" },
    ];
    const mip = lowerPinnedFunction(context, "src/texture/mip-count.ts", "mipLevelCount", dimensions, {
        cppName: "mip_level_count", returns: "double", inline: true, calls,
    });
    const biased = lowerPinnedFunction(context, "src/texture/mip-count.ts", "biasedMipLevelCount", [
        ...dimensions, { pinned: "lodBias", kind: "number", cpp: "lod_bias" },
    ], { cppName: "biased_mip_level_count", returns: "double", inline: true, calls });
    calls.set("biasedMipLevelCount", args => `biased_mip_level_count(${args.join(", ")})`);
    // The reached render-task surface supplies no transmission override. The
    // absent optional properties still carry their JS absence into the body.
    const transmission = lowerPinnedFunction(context, module, "transmissionMipLevelCount", [
        { pinned: "cfg", kind: "record", cpp: "cfg", annotation: 'RenderTask["_config"]["transmission"]',
            specialized: true, binding: { cpp: "false", type: "bool", staticallyAbsent: true } },
        ...dimensions,
    ], {
        cppName: "transmission_mip_level_count", returns: "double", inline: true, calls,
        memberBindings: new Map([
            ["cfg?.generateMipmaps", { cpp: "false", type: "bool", absentCpp: "true" }],
            ["cfg?.mipLevelCount", { cpp: "0.0", type: "scalar", absentCpp: "true" }],
        ]),
    });
    return `#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <bblite/js_data.hpp>

namespace bbl::upstream {
// ${context.provenance(module, "createRenderTaskTransmission")}
inline constexpr std::uint32_t transmission_grab_size = ${width};
// ${context.provenance("src/resource/trilinear-anisotropic-sampler.ts", "getTrilinearAnisotropicSampler")}
inline constexpr std::uint32_t transmission_sampler_max_anisotropy = ${anisotropy};
${mip}
${biased}
${transmission}
}
`;
}
