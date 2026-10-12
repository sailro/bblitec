#pragma once
#include <bblite/runtime.hpp>

namespace bbl::pal {

/** Native interleaved storage for the source's separate attribute buffers. */
template <class Positions, class Normals, class Uvs, class Uv2s, class Tangents, class Colors>
inline std::vector<ModelVertex>
pack_mesh_vertices(const Positions& positions, const Normals& normals, const Uvs& uvs,
                   const Uv2s& uvs2, const Tangents& tangents, const Colors& colors) {
    std::vector<ModelVertex> vertices(positions.size() / 3);
    for (std::size_t index = 0; index < vertices.size(); ++index) {
        auto& vertex = vertices[index];
        vertex.position = {positions[index * 3], positions[index * 3 + 1],
                           positions[index * 3 + 2]};
        if (normals.size() >= index * 3 + 3)
            vertex.normal = {normals[index * 3], normals[index * 3 + 1], normals[index * 3 + 2]};
        if (uvs.size() >= index * 2 + 2)
            vertex.uv = {uvs[index * 2], uvs[index * 2 + 1]};
        if (uvs2.size() >= index * 2 + 2)
            vertex.uv2 = {uvs2[index * 2], uvs2[index * 2 + 1]};
        if (tangents.size() >= index * 4 + 4)
            vertex.tangent = {tangents[index * 4], tangents[index * 4 + 1], tangents[index * 4 + 2],
                              tangents[index * 4 + 3]};
        if (colors.size() >= index * 4 + 4)
            vertex.color = {colors[index * 4], colors[index * 4 + 1], colors[index * 4 + 2],
                            colors[index * 4 + 3]};
    }
    return vertices;
}

} // namespace bbl::pal
