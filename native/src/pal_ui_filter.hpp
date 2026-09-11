#pragma once

#include <bblite/pal_ui.hpp>
#include "pal_ui_backdrop.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <map>
#include <stdexcept>
#include <string_view>

namespace bbl::pal {

/** CSS color matrices operate on straight sRGB; alpha is preserved separately. */
inline UiFilter color_ui_filter(std::string_view name, float value) {
    if (!std::isfinite(value)) throw std::runtime_error("Non-finite retained UI filter value.");
    UiFilter result{};
    result.kind = UiFilterKind::Color;
    auto& m = result.matrix;
    m = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    if (name != "hue-rotate" && value < 0) throw std::runtime_error("Negative retained UI filter value.");
    if (name == "brightness") {
        m[0] = m[5] = m[10] = value;
    } else if (name == "contrast") {
        m[0] = m[5] = m[10] = value;
        result.offset = {0.5f - 0.5f * value, 0.5f - 0.5f * value, 0.5f - 0.5f * value, 0};
    } else if (name == "opacity") {
        m[15] = std::min(value, 1.0f);
    } else if (name == "invert") {
        value = std::min(value, 1.0f);
        m[0] = m[5] = m[10] = 1 - 2 * value;
        result.offset = {value, value, value, 0};
    } else if (name == "grayscale" || name == "sepia") {
        value = std::min(value, 1.0f);
        const std::array<float, 9> mixing = name == "grayscale"
            ? std::array<float, 9>{.2126f, .7152f, .0722f, .2126f, .7152f, .0722f, .2126f, .7152f, .0722f}
            : std::array<float, 9>{.393f, .769f, .189f, .349f, .686f, .168f, .272f, .534f, .131f};
        for (std::size_t row = 0; row < 3; ++row) for (std::size_t column = 0; column < 3; ++column)
            m[row * 4 + column] = mixing[row * 3 + column] * value + (row == column ? 1 - value : 0);
    } else if (name == "saturate") {
        const std::array<float, 3> luminance{.213f, .715f, .072f};
        for (std::size_t row = 0; row < 3; ++row) for (std::size_t column = 0; column < 3; ++column)
            m[row * 4 + column] = luminance[column] * (1 - value) + (row == column ? value : 0);
    } else if (name == "hue-rotate") {
        const float c = std::cos(value), s = std::sin(value);
        m = {.213f + .787f*c - .213f*s, .715f - .715f*c - .715f*s, .072f - .072f*c + .928f*s, 0,
             .213f - .213f*c + .143f*s, .715f + .285f*c + .140f*s, .072f - .072f*c - .283f*s, 0,
             .213f - .213f*c - .787f*s, .715f - .715f*c + .715f*s, .072f + .928f*c + .072f*s, 0,
             0, 0, 0, 1};
    } else throw std::runtime_error("Unsupported retained UI color filter.");
    return result;
}

enum class UiFilterSurface : std::size_t { Snapshot, First, Second, Third, BlurFirst, BlurSecond, Count };
struct UiFilterUniforms {
    std::array<float, 16> rows{};
    std::array<float, 4> offset{}, parameters{}, color{};
    std::array<float, 20> weights{};
};
static_assert(sizeof(UiFilterUniforms) == 192);
struct UiFilterDraw {
    UiFilterSurface output, input, secondary;
    std::uint32_t width = 0, height = 0;
    UiFilterUniforms uniforms{};
};
struct UiFilterPlan {
    std::vector<UiFilterDraw> draws;
    UiFilterSurface result = UiFilterSurface::Snapshot;
};

/** Full-size ping-pong targets and blur pairs retained by working extent. */
template<class Texture>
struct UiFilterTargets {
    struct BlurPair { std::array<Texture, 2> textures; bool used = false; };
    std::array<Texture, 4> full;
    std::map<std::pair<std::uint32_t, std::uint32_t>, BlurPair> blur;
    std::array<Texture*, 2> current_blur{};

    void begin() { for (auto& [extent, pair] : blur) { static_cast<void>(extent); pair.used = false; } }
    Texture& get(UiFilterSurface surface) {
        const auto index = static_cast<std::size_t>(surface);
        return index < full.size() ? full[index] : *current_blur.at(index - full.size());
    }
    Texture& output(const UiFilterDraw& draw) {
        const auto index = static_cast<std::size_t>(draw.output);
        if (index < full.size()) return full[index];
        auto& pair = blur[{draw.width, draw.height}];
        pair.used = true;
        auto* texture = &pair.textures.at(index - full.size());
        current_blur.at(index - full.size()) = texture;
        return *texture;
    }
    template<class Release> void finish(Release&& release) {
        for (auto it = blur.begin(); it != blur.end();) {
            if (it->second.used) { ++it; continue; }
            for (auto& texture : it->second.textures) release(texture);
            it = blur.erase(it);
        }
    }
    template<class Release> void release(Release&& destroy) {
        for (auto& texture : full) destroy(texture);
        for (auto& [extent, pair] : blur) { static_cast<void>(extent); for (auto& texture : pair.textures) destroy(texture); }
        blur.clear(); current_blur = {};
    }
};

/** Source-order passes, with explicit non-aliasing intermediates for chained shadows. */
inline UiFilterPlan ui_filter_plan(const UiLayerComposite& composite) {
    using Surface = UiFilterSurface;
    UiFilterPlan plan;
    auto current = Surface::Snapshot;
    const auto free_surface = [](Surface a, Surface b = Surface::Snapshot) {
        for (const auto candidate : {Surface::First, Surface::Second, Surface::Third})
            if (candidate != a && candidate != b) return candidate;
        throw std::runtime_error("No retained UI filter intermediate.");
    };
    const auto add = [&](Surface output, Surface input, UiFilterUniforms uniforms,
                         Surface secondary = Surface::Snapshot, std::uint32_t width = 0, std::uint32_t height = 0) {
        plan.draws.push_back({output, input, secondary,
            width ? width : composite.width, height ? height : composite.height, uniforms});
    };
    const auto blur = [&](Surface input, Surface output, float sigma) {
        if (sigma < .1f) { if (input != output) add(output, input, {}); return; }
        const auto kernel = make_ui_blur_kernel(sigma);
        const auto width = std::max(1u, static_cast<std::uint32_t>(std::ceil(composite.width / kernel.reduction)));
        const auto height = std::max(1u, static_cast<std::uint32_t>(std::ceil(composite.height / kernel.reduction)));
        add(Surface::BlurFirst, input, {}, Surface::Snapshot, width, height);
        UiFilterUniforms uniforms;
        for (std::size_t i = 0; i < kernel.taps.size(); ++i) uniforms.weights[i] = kernel.taps[i] / 255.0f;
        uniforms.parameters[0] = 2;
        uniforms.parameters[1] = static_cast<float>(kernel.radius);
        add(Surface::BlurSecond, Surface::BlurFirst, uniforms, Surface::Snapshot, width, height);
        uniforms.parameters[0] = 3;
        add(Surface::BlurFirst, Surface::BlurSecond, uniforms, Surface::Snapshot, width, height);
        add(output, Surface::BlurFirst, {});
    };
    for (const auto& filter : composite.filters) {
        const auto output = free_surface(current);
        if (filter.kind == UiFilterKind::Color) {
            UiFilterUniforms uniforms;
            uniforms.rows = filter.matrix; uniforms.offset = filter.offset; uniforms.parameters[0] = 1;
            add(output, current, uniforms);
            current = output;
        } else if (filter.kind == UiFilterKind::Blur) {
            blur(current, output, filter.sigma);
            current = output;
        } else {
            UiFilterUniforms uniforms;
            uniforms.parameters = {4, 0, filter.offset_x, filter.offset_y}; uniforms.color = filter.color;
            add(output, current, uniforms);
            blur(output, output, filter.sigma);
            const auto combined = free_surface(current, output);
            uniforms = {}; uniforms.parameters[0] = 5;
            add(combined, current, uniforms, output);
            current = combined;
        }
    }
    plan.result = current;
    return plan;
}

/** Split only at effects and target changes, so every consumer submits the same order. */
template<class Draw, class Operation>
void for_each_ui_segment(const UiRenderFrame& frame, Draw&& draw, Operation&& operation) {
    std::size_t cursor = 0;
    const auto flush = [&](std::size_t end) {
        if (end < cursor || end > frame.draws.size()) throw std::runtime_error("Invalid retained UI operation order.");
        while (cursor < end) {
            const auto first = cursor;
            const auto layer = frame.draws[cursor].layer;
            while (cursor < end && frame.draws[cursor].layer == layer) ++cursor;
            draw(first, cursor, layer);
        }
    };
    for (const auto& entry : frame.operations) {
        flush(entry.before_draw);
        operation(entry);
    }
    flush(frame.draws.size());
}

} // namespace bbl::pal
