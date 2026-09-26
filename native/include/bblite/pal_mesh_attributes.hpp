#pragma once
#include <bblite/runtime.hpp>

namespace bbl::pal {
enum class MeshAttribute { Position, Uv };

/** A tightly packed source attribute mapped onto native interleaved vertices. */
struct MeshAttributeBuffer {
    ModelGeometry* geometry;
    MeshAttribute attribute;
    [[nodiscard]] std::size_t components() const { return attribute == MeshAttribute::Position ? 3u : 2u; }
    [[nodiscard]] double size() const { return static_cast<double>(geometry->vertices.size() * components() * sizeof(float)); }
    explicit operator bool() const { return true; }
};

inline void write_mesh_attribute_bytes(MeshAttributeBuffer buffer, double destination_offset,
                                       const std::vector<float>& values, double source_offset,
                                       double byte_length) {
    const auto width = buffer.components();
    const auto destination = static_cast<std::size_t>(destination_offset) / (width * sizeof(float));
    const auto source = static_cast<std::size_t>(source_offset) / sizeof(float);
    const auto count = static_cast<std::size_t>(byte_length) / (width * sizeof(float));
    auto& rendered = buffer.geometry->render_vertices_override;
    if (!rendered) rendered = buffer.geometry->vertices;
    for (std::size_t index = 0; index < count; ++index) {
        auto& vertex = (*rendered)[destination + index];
        const auto offset = source + index * width;
        if (buffer.attribute == MeshAttribute::Position)
            vertex.position = {values[offset], values[offset + 1], values[offset + 2]};
        else
            vertex.uv = {values[offset], values[offset + 1]};
    }
    ++buffer.geometry->attribute_version;
}
} // namespace bbl::pal
