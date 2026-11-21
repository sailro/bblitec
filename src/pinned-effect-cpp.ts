import { CppDefinitions, type CppModule } from "./cpp-definitions.js";
/**
 * Emits `upstream/effect_variants.hpp` — the C++ side of one `EffectWrapper`.
 *
 * An effect carries no records this port authors either: its bind-group
 * layout is the descriptor the scene wrote, and its module is the pin's
 * vertex stage around the caller's fragment. So the header is a transcript of
 * both — which stages to load, and what group 0 holds — and each PAL builds
 * its layout by walking one table rather than restating the descriptor.
 */
import { stringLiteral } from "./cpp-literals.js";
import type { EffectManifest } from "./compiler/types.js";
import { effectStageStems } from "./lowering/effect-lowerer.js";
import { nativeBlendFactor } from "./lowering/pinned-blend-table.js";

/** The native view dimension of each `viewDimension` an effect texture declares. */
const effectViewDimensions = {
    "2d": "texture_2d",
    "2d-array": "texture_2d_array",
    "3d": "texture_3d",
} as const;

export function pinnedEffectVariantsHeader(
    provenance: string,
    effects: readonly EffectManifest[],
): CppModule {
    const cpp = new CppDefinitions();
    if (effects.length === 0) {
        throw new Error("An effect scene composed no wrappers.");
    }
    const bindingRows: string[] = [];
    const entries: string[] = [];
    for (const [index, effect] of effects.entries()) {
        const stems = effectStageStems(index);
        const first = bindingRows.length;
        for (const binding of effect.bindings) {
            bindingRows.push(
                `    {${stringLiteral(binding.name)}, ${binding.binding}u, ` +
                    `EffectBindingKind::${binding.kind}, ` +
                    `${binding.uniformBytes}u, ` +
                    `${Math.max(0, binding.texture)}u, ` +
                    `${binding.textureSampleType === "depth"}, ` +
                    `EffectViewDimension::${effectViewDimensions[binding.viewDimension ?? "2d"]}, ` +
                    `${binding.comparison === true}},`,
            );
        }
        const blend = effect.blend
            ? `{${effect.blend.map((factor) => `BlendFactor::${nativeBlendFactor(factor)}`).join(", ")}}`
            : "{}";
        entries.push(
            `    {${stringLiteral(stems.vertexStem)}, ` +
                `${stringLiteral(stems.fragmentStem)}, ` +
                `${stringLiteral(effect.name)}, ` +
                `${first}, ${effect.bindings.length}, ` +
                `${effect.blend !== undefined}, ${blend}},`,
        );
    }
    return cpp.finish(`#pragma once

// ${provenance}

#include <bblite/runtime.hpp>

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace bbl::upstream {

/** The three kinds an \`EffectBindingLayout\` declares. */
enum class EffectBindingKind {
    uniform,
    texture,
    sampler,
};

/**
 * One bind-group entry, as the descriptor declared it.
 *
 * The pin takes this layout explicitly rather than reflecting it out of the
 * WGSL, so the descriptor is the authority and this row is that descriptor.
 * \`texture\` is already resolved: the pin looks a sampler's texture up by
 * \`textureBinding\` and falls back to the first texture slot, and generation
 * performs that lookup so a PAL reads one ordinal.
 */
struct EffectVariantBinding {
    std::string_view name;
    std::uint32_t binding;
    EffectBindingKind kind;
    /** The pin's align4 of \`uniformByteLength\`; zero for the other kinds. */
    std::uint32_t uniform_bytes;
    /** For a sampler: which texture slot it samples through, as a position in
     *  this effect's own texture rows -- so a PAL indexes its uploaded
     *  textures directly rather than rescanning for a binding number. */
    std::uint32_t texture;
    /** A declared depth texture; otherwise the pin's float sample layout. */
    bool depth_texture;
    /** A texture's declared \`viewDimension\`; the pin's 2d view otherwise. */
    EffectViewDimension view_dimension;
    /** A declared \`samplerType: "comparison"\` sampler; otherwise the pin's filtering one. */
    bool comparison_sampler;
};

${cpp.table("EffectVariantBinding", "effect_variant_bindings", bindingRows.length, `${bindingRows.join("\n") || "    // No reached effect declares one."}`)}

struct EffectVariantEntry {
    /** The deployed stem of each stage; both name one module. */
    std::string_view vertex_stem;
    std::string_view fragment_stem;
    /** The descriptor's own name, used to label GPU resources. */
    std::string_view name;
    /** Half-open range into the binding table above. */
    std::size_t first_binding;
    std::size_t binding_count;
    /** The descriptor's \`blend\` (an add equation of these factors); without one the pass writes its output. */
    bool blend_enabled;
    BlendFactors blend;
};

${cpp.table("EffectVariantEntry", "effect_variants", effects.length, `${entries.join("\n")}`)}

} // namespace bbl::upstream
`);
}
