#pragma once

#include "pal_ui_filter.hpp"
#include <unordered_map>

namespace bbl::pal {

/** RmlUi caches generated decorations as CPU-owned textures. Replay only the
 * captured layer, using the same ordered filter plan as the GPU consumers. */
struct UiSnapshotSurface {
    using Pixel = std::array<float, 4>;
    int left = 0, top = 0;
    std::uint32_t width = 0, height = 0;
    std::uint32_t samples = 1;
    std::vector<Pixel> pixels;

    UiSnapshotSurface() = default;
    UiSnapshotSurface(int x, int y, std::uint32_t w, std::uint32_t h,
                      std::uint32_t sample_count = 1)
        : left(x), top(y), width(w), height(h), samples(sample_count),
          pixels(static_cast<std::size_t>(w) * h * sample_count) {}

    Pixel read(int x, int y) const {
        x -= left;
        y -= top;
        if (x < 0 || y < 0 || x >= static_cast<int>(width) || y >= static_cast<int>(height))
            return {};
        Pixel result{};
        const auto first = (static_cast<std::size_t>(y) * width + x) * samples;
        for (std::size_t sample = 0; sample < samples; ++sample)
            for (std::size_t channel = 0; channel < 4; ++channel)
                result[channel] += pixels[first + sample][channel] / samples;
        return result;
    }

    template <class Read>
    static Pixel sample(std::uint32_t w, std::uint32_t h, float u, float v, bool nearest,
                        Read&& read) {
        const float x = u * w - .5f, y = v * h - .5f;
        const int x0 = static_cast<int>(std::floor(x)), y0 = static_cast<int>(std::floor(y));
        const auto clamped = [&](int px, int py) {
            return read(std::clamp(px, 0, static_cast<int>(w) - 1),
                        std::clamp(py, 0, static_cast<int>(h) - 1));
        };
        if (nearest)
            return clamped(static_cast<int>(std::floor(x + .5f)),
                           static_cast<int>(std::floor(y + .5f)));
        const auto a = clamped(x0, y0), b = clamped(x0 + 1, y0), c = clamped(x0, y0 + 1),
                   d = clamped(x0 + 1, y0 + 1);
        const float fx = x - x0, fy = y - y0;
        Pixel result{};
        for (std::size_t i = 0; i < 4; ++i)
            result[i] =
                (a[i] * (1 - fx) + b[i] * fx) * (1 - fy) + (c[i] * (1 - fx) + d[i] * fx) * fy;
        return result;
    }

    Pixel sample(float u, float v) const {
        if (!width || !height || u < 0 || u > 1 || v < 0 || v > 1)
            return {};
        return sample(width, height, u, v, false,
                      [&](int x, int y) { return read(left + x, top + y); });
    }

    template <class Shade>
    void draw(const UiRenderFrame& frame, std::uint32_t first, std::uint32_t count, int clip_left,
              int clip_top, std::uint32_t clip_width, std::uint32_t clip_height, Shade&& shade) {
        for (std::size_t index = first; index + 2 < static_cast<std::size_t>(first) + count;
             index += 3) {
            std::array vertices{frame.vertices.at(frame.indices.at(index)),
                                frame.vertices.at(frame.indices.at(index + 1)),
                                frame.vertices.at(frame.indices.at(index + 2))};
            const auto point = [](const UiRenderVertex& vertex) -> UiClipPoint {
                return {vertex.x, vertex.y};
            };
            float area = ui_clip_side(point(vertices[0]), point(vertices[1]), point(vertices[2]));
            if (std::abs(area) < 1e-6f)
                continue;
            if (area < 0) {
                std::swap(vertices[1], vertices[2]);
                area = -area;
            }
            const auto& a = vertices[0];
            const auto& b = vertices[1];
            const auto& c = vertices[2];
            const int x0 = std::max(
                {left, clip_left, static_cast<int>(std::floor(std::min({a.x, b.x, c.x})))});
            const int y0 =
                std::max({top, clip_top, static_cast<int>(std::floor(std::min({a.y, b.y, c.y})))});
            const int x1 =
                std::min({left + static_cast<int>(width), clip_left + static_cast<int>(clip_width),
                          static_cast<int>(std::ceil(std::max({a.x, b.x, c.x})))});
            const int y1 =
                std::min({top + static_cast<int>(height), clip_top + static_cast<int>(clip_height),
                          static_cast<int>(std::ceil(std::max({a.y, b.y, c.y})))});
            const auto inside = [](float edge, const UiRenderVertex& from,
                                   const UiRenderVertex& to) {
                return edge > 0 ||
                       (edge == 0 && (to.y < from.y || (to.y == from.y && to.x > from.x)));
            };
            // Four coverage samples retain rounded edges without double-blending
            // shared triangle edges. Filters resolve them before sampling.
            constexpr std::array<UiClipPoint, 4> positions{
                {{.375f, .125f}, {.875f, .375f}, {.125f, .625f}, {.625f, .875f}}};
            for (int y = y0; y < y1; ++y)
                for (int x = x0; x < x1; ++x)
                    for (std::uint32_t sample = 0; sample < samples; ++sample) {
                        const auto offset =
                            samples == 1 ? UiClipPoint{.5f, .5f} : positions[sample];
                        const UiClipPoint p{x + offset[0], y + offset[1]};
                        const float wa = ui_clip_side(point(b), point(c), p),
                                    wb = ui_clip_side(point(c), point(a), p),
                                    wc = ui_clip_side(point(a), point(b), p);
                        if (!inside(wa, b, c) || !inside(wb, c, a) || !inside(wc, a, b))
                            continue;
                        const auto value = [&](auto field) {
                            return (wa * (a.*field) + wb * (b.*field) + wc * (c.*field)) / area;
                        };
                        auto source = shade(value(&UiRenderVertex::u), value(&UiRenderVertex::v));
                        const Pixel color{
                            value(&UiRenderVertex::red), value(&UiRenderVertex::green),
                            value(&UiRenderVertex::blue), value(&UiRenderVertex::alpha)};
                        for (std::size_t channel = 0; channel < 4; ++channel)
                            source[channel] *= color[channel] / 255.f;
                        auto& destination =
                            pixels[(static_cast<std::size_t>(y - top) * width + x - left) *
                                       samples +
                                   sample];
                        for (std::size_t channel = 0; channel < 4; ++channel)
                            destination[channel] =
                                source[channel] + destination[channel] * (1 - source[3]);
                    }
        }
    }
};

inline UiSnapshotSurface filter_ui_snapshot(const UiSnapshotSurface& source,
                                            const UiLayerComposite& composite) {
    std::array<UiSnapshotSurface, static_cast<std::size_t>(UiFilterSurface::Count)> surfaces;
    auto& snapshot = surfaces[0];
    snapshot = {0, 0, composite.width, composite.height};
    for (std::uint32_t y = 0; y < snapshot.height; ++y)
        for (std::uint32_t x = 0; x < snapshot.width; ++x)
            snapshot.pixels[static_cast<std::size_t>(y) * snapshot.width + x] =
                source.read(composite.left + x, composite.top + y);
    const auto plan = ui_filter_plan(composite);
    for (const auto& pass : plan.draws) {
        const auto& input = surfaces[static_cast<std::size_t>(pass.input)];
        const auto& secondary = surfaces[static_cast<std::size_t>(pass.secondary)];
        UiSnapshotSurface output(0, 0, pass.width, pass.height);
        const auto& uniforms = pass.uniforms;
        const int mode = static_cast<int>(uniforms.parameters[0]);
        for (std::uint32_t y = 0; y < output.height; ++y)
            for (std::uint32_t x = 0; x < output.width; ++x) {
                const float u = (x + .5f) / output.width, v = (y + .5f) / output.height;
                auto color = input.sample(u, v);
                if (mode == 1) {
                    auto straight = color;
                    for (std::size_t channel = 0; channel < 3; ++channel)
                        straight[channel] /= std::max(color[3], .0000001f);
                    for (std::size_t row = 0; row < 4; ++row) {
                        float value = uniforms.offset[row];
                        for (std::size_t column = 0; column < 4; ++column)
                            value += uniforms.rows[row * 4 + column] * straight[column];
                        color[row] = std::clamp(value, 0.f, 1.f);
                    }
                    for (std::size_t channel = 0; channel < 3; ++channel)
                        color[channel] *= color[3];
                } else if (mode == 2 || mode == 3) {
                    color = {};
                    const int radius = static_cast<int>(uniforms.parameters[1]);
                    for (int tap = -radius; tap <= radius; ++tap) {
                        const auto sample =
                            input.sample(u + (mode == 2 ? float(tap) / input.width : 0),
                                         v + (mode == 3 ? float(tap) / input.height : 0));
                        for (std::size_t channel = 0; channel < 4; ++channel)
                            color[channel] += sample[channel] * uniforms.weights[std::abs(tap)];
                    }
                } else if (mode == 4) {
                    const float alpha = input.sample(u - uniforms.parameters[2] / input.width,
                                                     v - uniforms.parameters[3] / input.height)[3];
                    for (std::size_t channel = 0; channel < 4; ++channel)
                        color[channel] = uniforms.color[channel] * alpha;
                } else if (mode == 5) {
                    const auto shadow = secondary.sample(u, v);
                    const float alpha = color[3];
                    for (std::size_t channel = 0; channel < 4; ++channel)
                        color[channel] += shadow[channel] * (1 - alpha);
                }
                output.pixels[static_cast<std::size_t>(y) * output.width + x] = color;
            }
        surfaces[static_cast<std::size_t>(pass.output)] = std::move(output);
    }
    return std::move(surfaces[static_cast<std::size_t>(plan.result)]);
}

struct UiFrameCheckpoint {
    std::size_t vertices, indices, textures, draws, backdrops, composites, operations;
    std::uint32_t layer_count;
    explicit UiFrameCheckpoint(const UiRenderFrame& frame)
        : vertices(frame.vertices.size()), indices(frame.indices.size()),
          textures(frame.textures.size()), draws(frame.draws.size()),
          backdrops(frame.backdrops.size()), composites(frame.composites.size()),
          operations(frame.operations.size()), layer_count(frame.layer_count) {}
    void restore(UiRenderFrame& frame) const {
        frame.layer_count = layer_count;
        frame.vertices.resize(vertices);
        frame.indices.resize(indices);
        frame.textures.resize(textures);
        frame.draws.resize(draws);
        frame.backdrops.resize(backdrops);
        frame.composites.resize(composites);
        frame.operations.resize(operations);
    }
};

inline std::vector<std::uint8_t> snapshot_ui_layer(const UiRenderFrame& frame,
                                                   const UiFrameCheckpoint& start,
                                                   std::uint32_t layer, int left, int top,
                                                   std::uint32_t width, std::uint32_t height) {
    std::unordered_map<std::uint32_t, UiSnapshotSurface> layers;
    const auto texture = [&](std::uint64_t id) -> const UiRenderTexture* {
        if (!id)
            return nullptr;
        const auto found = std::find_if(frame.textures.begin(), frame.textures.end(),
                                        [&](const auto& entry) { return entry.id == id; });
        if (found == frame.textures.end() || !found->rgba || !found->width || !found->height ||
            found->rgba->size() != static_cast<std::size_t>(found->width) * found->height * 4)
            throw std::runtime_error("Saved retained UI layers require an owned RGBA texture.");
        return &*found;
    };
    for_each_ui_segment(
        frame,
        [&](std::size_t first, std::size_t end, std::uint32_t target) {
            for (std::size_t index = std::max(first, start.draws); index < end; ++index) {
                const auto& draw = frame.draws[index];
                const auto* image = texture(draw.texture_id);
                layers.at(target).draw(
                    frame, draw.first_index, draw.index_count, draw.scissor_x, draw.scissor_y,
                    draw.scissor_width, draw.scissor_height,
                    [&](float u, float v) -> UiSnapshotSurface::Pixel {
                        if (!image)
                            return {1, 1, 1, 1};
                        return UiSnapshotSurface::sample(
                            image->width, image->height, u, v, draw.nearest_sampling,
                            [&](int x, int y) {
                                UiSnapshotSurface::Pixel result{};
                                const auto offset =
                                    (static_cast<std::size_t>(y) * image->width + x) * 4;
                                for (std::size_t channel = 0; channel < 4; ++channel)
                                    result[channel] = image->rgba->at(offset + channel) / 255.f;
                                return result;
                            });
                    });
            }
        },
        [&](const UiRenderOperation& operation) {
            if (&operation < frame.operations.data() + start.operations)
                return;
            if (operation.kind == UiRenderOperation::Kind::ResetLayer)
                layers.insert_or_assign(operation.index,
                                        UiSnapshotSurface(left, top, width, height, 4));
            else if (operation.kind == UiRenderOperation::Kind::Composite) {
                const auto& composite = frame.composites.at(operation.index);
                const auto filtered = filter_ui_snapshot(layers.at(composite.source), composite);
                layers.at(composite.destination)
                    .draw(frame, composite.first_index, composite.index_count, composite.left,
                          composite.top, composite.width, composite.height,
                          [&](float u, float v) { return filtered.sample(u, v); });
            } else
                throw std::runtime_error(
                    "Saved retained UI layers cannot sample an external backdrop.");
        });
    std::vector<std::uint8_t> result(static_cast<std::size_t>(width) * height * 4);
    const auto& surface = layers.at(layer);
    for (std::uint32_t y = 0; y < height; ++y)
        for (std::uint32_t x = 0; x < width; ++x) {
            const auto pixel = surface.read(left + x, top + y);
            for (std::size_t channel = 0; channel < 4; ++channel)
                result[(static_cast<std::size_t>(y) * width + x) * 4 + channel] =
                    static_cast<std::uint8_t>(
                        std::clamp(std::lround(pixel[channel] * 255), 0l, 255l));
        }
    return result;
}

} // namespace bbl::pal
