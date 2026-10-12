#pragma once
#include <bblite/runtime.hpp>

namespace bbl::pal {
enum class MeshAttribute { Position, Normal, Uv, Uv2, Tangent, Color };

/** A tightly packed source attribute mapped onto native interleaved vertices. */
struct MeshAttributeBuffer {
    ModelGeometry* geometry;
    MeshAttribute attribute;
    [[nodiscard]] std::size_t components() const {
        switch (attribute) {
        case MeshAttribute::Position:
        case MeshAttribute::Normal:
            return 3u;
        case MeshAttribute::Uv:
        case MeshAttribute::Uv2:
            return 2u;
        case MeshAttribute::Tangent:
        case MeshAttribute::Color:
            return 4u;
        }
        throw std::runtime_error("Unknown mesh attribute.");
    }
    [[nodiscard]] double size() const {
        const auto& capacities = geometry->attribute_capacities;
        switch (attribute) {
        case MeshAttribute::Position:
            return capacities.position;
        case MeshAttribute::Normal:
            return capacities.normal;
        case MeshAttribute::Uv:
            return capacities.uv;
        case MeshAttribute::Uv2:
            return capacities.uv2;
        case MeshAttribute::Tangent:
            return capacities.tangent;
        case MeshAttribute::Color:
            return capacities.color;
        }
        throw std::runtime_error("Unknown mesh attribute.");
    }
    explicit operator bool() const {
        // Imported layouts have no represented per-attribute buffer owners:
        // reach the pinned ownership refusal instead of treating them as absent.
        if (!geometry->owned_packed_geometry)
            return true;
        switch (attribute) {
        case MeshAttribute::Position:
        case MeshAttribute::Normal:
        case MeshAttribute::Uv:
            return true;
        case MeshAttribute::Uv2:
        case MeshAttribute::Tangent:
        case MeshAttribute::Color:
            return size() != 0;
        }
        throw std::runtime_error("Unknown mesh attribute.");
    }
};

inline void write_mesh_attribute_bytes(MeshAttributeBuffer buffer, double destination_offset,
                                       const js::F32Array& values, double source_offset,
                                       double byte_length) {
    const auto width = buffer.components();
    const auto destination = static_cast<std::size_t>(destination_offset) / (width * sizeof(float));
    const auto source = static_cast<std::size_t>(source_offset) / sizeof(float);
    const auto count = static_cast<std::size_t>(byte_length) / (width * sizeof(float));
    const auto extent = buffer.geometry->render_vertices_override
                            ? buffer.geometry->render_vertices_override->size()
                            : buffer.geometry->vertices.size();
    const auto& indices = buffer.geometry->render_indices_override
                              ? *buffer.geometry->render_indices_override
                              : buffer.geometry->indices;
    if (destination + count > extent && std::ranges::any_of(indices, [&](std::uint32_t index) {
            return index >= extent && index >= destination && index - destination < count;
        }))
        throw std::runtime_error(
            "Mesh attribute uploads to indexed vertices outside the position stream are not represented.");
    auto& rendered = buffer.geometry->render_vertices_override;
    if (!rendered)
        rendered = buffer.geometry->vertices;
    for (std::size_t index = 0; index < count; ++index) {
        if (destination + index >= rendered->size())
            break;
        auto& vertex = (*rendered)[destination + index];
        const auto offset = source + index * width;
        switch (buffer.attribute) {
        case MeshAttribute::Position:
            vertex.position = {values.load(offset), values.load(offset + 1),
                               values.load(offset + 2)};
            break;
        case MeshAttribute::Normal:
            vertex.normal = {values.load(offset), values.load(offset + 1), values.load(offset + 2)};
            break;
        case MeshAttribute::Uv:
            vertex.uv = {values.load(offset), values.load(offset + 1)};
            break;
        case MeshAttribute::Uv2:
            vertex.uv2 = {values.load(offset), values.load(offset + 1)};
            break;
        case MeshAttribute::Tangent:
            vertex.tangent = {values.load(offset), values.load(offset + 1), values.load(offset + 2),
                              values.load(offset + 3)};
            break;
        case MeshAttribute::Color:
            vertex.color = {values.load(offset), values.load(offset + 1), values.load(offset + 2),
                            values.load(offset + 3)};
            break;
        }
    }
    ++buffer.geometry->attribute_version;
}
} // namespace bbl::pal
