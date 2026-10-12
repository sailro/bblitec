#pragma once
#include <bblite/mesh_cpu_streams.hpp>
#include <bblite/mesh_vertex_packing.hpp>
#include <bblite/pal_mesh_attributes.hpp>

namespace bbl::pal {

struct MeshIndexBuffer {
    ModelGeometry* geometry;
};

inline const js::U32Array& mesh_index_scratch(const ModelGeometry& geometry) {
    const auto& scratch = geometry.index_scratch;
    if (!scratch)
        throw std::runtime_error("Mesh index scratch storage is absent.");
    return *scratch;
}

inline void write_mesh_geometry_bytes(MeshAttributeBuffer buffer, double destination_offset,
                                      const js::F32Array& values, double source_offset,
                                      double byte_length) {
    if (destination_offset < 0 || destination_offset > buffer.size() || byte_length < 0 ||
        byte_length > buffer.size() - destination_offset || source_offset < 0 ||
        source_offset > values.byte_length() || byte_length > values.byte_length() - source_offset)
        throw std::runtime_error("Mesh attribute upload exceeds represented buffer storage.");
    write_mesh_attribute_bytes(buffer, destination_offset, values, source_offset, byte_length);
}

inline void write_mesh_geometry_bytes(MeshIndexBuffer buffer, double destination_offset,
                                      const js::U32Array& values, double source_offset,
                                      double byte_length) {
    auto& uploaded = buffer.geometry->render_indices_override;
    if (!uploaded)
        uploaded = buffer.geometry->indices;
    const auto destination = static_cast<std::size_t>(destination_offset) / sizeof(std::uint32_t);
    const auto source = static_cast<std::size_t>(source_offset) / sizeof(std::uint32_t);
    const auto count = static_cast<std::size_t>(byte_length) / sizeof(std::uint32_t);
    if (destination > uploaded->size() || count > uploaded->size() - destination ||
        source > values.size() || count > values.size() - source)
        throw std::runtime_error("Mesh index upload exceeds represented buffer storage.");
    for (std::size_t index = 0; index < count; ++index)
        (*uploaded)[destination + index] = values.load(source + index);
    ++buffer.geometry->index_version;
}

/** Retained CPU objects and physical GPU mirrors have independent storage. */
inline void retain_mesh_geometry_snapshot(Engine& engine, MeshHandle mesh,
                                          std::shared_ptr<MeshCpuStreams> retained,
                                          const std::optional<std::array<double, 3>>& minimum,
                                          const std::optional<std::array<double, 3>>& maximum) {
    auto& record = handle_at(engine.meshes, mesh);
    auto& geometry = engine.geometries.at(record.geometry);
    if (!geometry.render_vertices_override)
        geometry.render_vertices_override = geometry.vertices;
    if (!geometry.render_indices_override)
        geometry.render_indices_override = geometry.indices;
    record.cpu_streams = std::move(retained);
    const MeshCpuStreamsView streams(record, &geometry);
    geometry.vertices = pack_mesh_vertices(streams.positions, streams.normals, streams.uvs,
                                           streams.uvs2, streams.tangents, streams.colors);
    geometry.indices = streams.indices.copy_raw();
    record.has_bounds = minimum.has_value() && maximum.has_value();
    record.has_bounds_min_override = false;
    record.has_bounds_max_override = false;
    if (minimum)
        geometry.bounds_min = {static_cast<float>((*minimum)[0]), static_cast<float>((*minimum)[1]),
                               static_cast<float>((*minimum)[2])};
    if (maximum)
        geometry.bounds_max = {static_cast<float>((*maximum)[0]), static_cast<float>((*maximum)[1]),
                               static_cast<float>((*maximum)[2])};
}
} // namespace bbl::pal
