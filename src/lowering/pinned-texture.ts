import type { PinnedCallSpelling } from "./pinned-numeric-lowerer.js";
import type { LoweringContext } from "./context.js";
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";

/** `createRenderTaskTransmission`'s square grab extent. */
export function pinnedTransmissionGrabSize(context: LoweringContext): number {
    const { file, declaration } = context.functionDeclaration(
        "src/frame-graph/transmission.ts",
        "createRenderTaskTransmission",
    );
    const extent = (name: string): number =>
        context.numericValue(
            context.variableInitializer(declaration, name),
            file,
        );
    const width = extent("width"),
        height = extent("height");
    if (width !== height || !Number.isInteger(width) || width <= 0) {
        context.contractError(
            declaration,
            "Native transmission requires a positive square pinned extent.",
        );
    }
    return width;
}

/** Texture allocation facts and mip arithmetic, read/lowered from the pin. */
export function pinnedTextureHeader(context: LoweringContext): string {
    const module = "src/frame-graph/transmission.ts";
    const width = pinnedTransmissionGrabSize(context);
    const samplerFile = context.sourceFile(
        "src/resource/trilinear-anisotropic-sampler.ts",
    );
    const sampler = context.objectInitializer(
        samplerFile,
        "_trilinearAnisotropicDesc",
    );
    const anisotropy = context.numericValue(
        context.propertyInitializer(sampler, "maxAnisotropy"),
        samplerFile,
    );
    const calls = new Map<string, PinnedCallSpelling>();
    const dimensions = [
        { pinned: "width", kind: "number" as const, cpp: "width" },
        { pinned: "height", kind: "number" as const, cpp: "height" },
    ];
    const mip = lowerPinnedFunction(
        context,
        "src/texture/mip-count.ts",
        "mipLevelCount",
        dimensions,
        {
            cppName: "mip_level_count",
            returns: "double",
            inline: true,
            calls,
        },
    );
    const biased = lowerPinnedFunction(
        context,
        "src/texture/mip-count.ts",
        "biasedMipLevelCount",
        [...dimensions, { pinned: "lodBias", kind: "number", cpp: "lod_bias" }],
        {
            cppName: "biased_mip_level_count",
            returns: "double",
            inline: true,
            calls,
        },
    );
    calls.set(
        "biasedMipLevelCount",
        (args) => `biased_mip_level_count(${args.join(", ")})`,
    );
    // The reached render-task surface supplies no transmission override. The
    // absent optional properties still carry their JS absence into the body.
    const transmission = lowerPinnedFunction(
        context,
        module,
        "transmissionMipLevelCount",
        [
            {
                pinned: "cfg",
                kind: "record",
                cpp: "cfg",
                annotation: 'RenderTask["_config"]["transmission"]',
                specialized: true,
                binding: { cpp: "false", type: "bool", staticallyAbsent: true },
            },
            ...dimensions,
        ],
        {
            cppName: "transmission_mip_level_count",
            returns: "double",
            inline: true,
            calls,
            memberBindings: new Map([
                [
                    "cfg?.generateMipmaps",
                    { cpp: "false", type: "bool", absentCpp: "true" },
                ],
                [
                    "cfg?.mipLevelCount",
                    { cpp: "0.0", type: "scalar", absentCpp: "true" },
                ],
            ]),
        },
    );
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

/**
 * A render task's own grab settings (`enableRenderTaskTransmission`): the
 * pin's mip count and copy count over the options the task stores, each an
 * absent optional exactly when the pin's `cfg` member is undefined.
 */
export function pinnedTaskTransmissionHeader(context: LoweringContext): string {
    const module = "src/frame-graph/transmission.ts";
    const cfg = {
        pinned: "cfg",
        kind: "record" as const,
        cpp: "cfg",
        annotation: 'RenderTask["_config"]["transmission"]',
        specialized: true as const,
        binding: { cpp: "true", type: "bool" as const },
    };
    const calls = new Map<string, PinnedCallSpelling>([
        [
            "biasedMipLevelCount",
            (args) => `biased_mip_level_count(${args.join(", ")})`,
        ],
    ]);
    const mips = lowerPinnedFunction(
        context,
        module,
        "transmissionMipLevelCount",
        [
            cfg,
            { pinned: "width", kind: "number", cpp: "width" },
            { pinned: "height", kind: "number", cpp: "height" },
        ],
        {
            cppName: "task_transmission_mip_level_count",
            returns: "double",
            inline: true,
            calls,
            trailingParameters: [
                "std::optional<bool> generate_mipmaps",
                "std::optional<double> mip_level_count",
            ],
            memberBindings: new Map([
                [
                    "cfg?.generateMipmaps",
                    {
                        cpp: "generate_mipmaps.value_or(false)",
                        type: "bool",
                        absentCpp: "!generate_mipmaps.has_value()",
                    },
                ],
                [
                    "cfg?.mipLevelCount",
                    {
                        cpp: "mip_level_count.value_or(0.0)",
                        type: "scalar",
                        absentCpp: "!mip_level_count.has_value()",
                    },
                ],
            ]),
        },
    );
    const copies = lowerPinnedFunction(
        context,
        module,
        "normalizeCopyCount",
        [cfg],
        {
            cppName: "task_transmission_copy_count",
            returns: "double",
            inline: true,
            calls,
            trailingParameters: ["std::optional<double> copy_count"],
            memberBindings: new Map([
                [
                    "cfg?.copyCount",
                    {
                        cpp: "copy_count.value_or(0.0)",
                        type: "scalar",
                        absentCpp: "!copy_count.has_value()",
                        nullish: "!copy_count.has_value()",
                    },
                ],
            ]),
        },
    );
    return `#pragma once
#include <optional>
#include <bblite/upstream/pinned_texture.hpp>

namespace bbl::upstream {
${mips}
${copies}
}
`;
}
