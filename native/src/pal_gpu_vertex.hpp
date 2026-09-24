// The vertex both backends upload and every input they bind: the packed
// `GpuVertex`, its streams, the deformation block, the mesh vertex and
// shared-geometry caches, the thin-instance pool and the morph payloads.
#pragma once
#include "pal_gpu_sprites.hpp"

namespace bbl::pal {

// Where the per-instance streams sit in the shared attribute table both
// backends bind against. The matrix columns take the four lanes after the
// vertex attributes, and the RGBA stream a material with
// `useThinInstanceColors` reads takes the one after them -- the same
// numbers `src/shader-ir.ts` specializes the WGSL to, stated once here so
// the two backends cannot disagree about them.
inline constexpr std::uint32_t instance_matrix_first_location = 16;
inline constexpr std::uint32_t instance_color_location = instance_matrix_first_location + 4;

struct GpuVertex {
    float position[3];
    float normal[3];
    float tangent[4];
    float uv[2];
    float uv2[2];
    float color[4];
#if BBLITE_GPU_DEFORMATION
    float joints[4];
    float weights[4];
    float morph_position_0[3];
    float morph_position_1[3];
    float morph_normal_0[3];
    float morph_normal_1[3];
    float morph_tangent_0[3];
    float morph_tangent_1[3];
#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
    // The pin's own skinned vertex stages take joint indices as integers where
    // the transcribed one takes them as floats. Both are carried while the two
    // paths coexist, and this sits last so no existing attribute offset moves;
    // the float pair goes away with the transcription.
    std::uint32_t joint_indices[4];
#endif
#endif
};
#if BBLITE_GPU_DEFORMATION && (BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON)
static_assert(sizeof(GpuVertex) == 192);
#elif BBLITE_GPU_DEFORMATION
static_assert(sizeof(GpuVertex) == 176);
#else
static_assert(sizeof(GpuVertex) == 72);
#endif

/**
 * Which vertex buffer a declared input comes from.
 *
 * The pin's own thin-instance fragment names two instance-stepped groups
 * beside the vertex one -- `ti-matrix` for the four world columns and
 * `ti-color` for the RGBA lane -- and both the transcribed path and the
 * composed variants bind that same set of slots, so the table lives beside
 * `GpuVertex` rather than inside either path's own guard.
 */
enum class VertexInputStream : std::uint32_t {
    vertex = 0,
    instance_matrix = 1,
    instance_color = 2,
};

/** The buffer slot both backends bind a stream at. */
inline constexpr std::uint32_t vertex_stream_slot(VertexInputStream stream) {
    return static_cast<std::uint32_t>(stream);
}

/**
 * The pin's own name for the buffer group a stream carries.
 *
 * This mapping is the only part of the layout that is ours: the pin declares
 * groups by name (`ti-matrix`, `ti-color`) and assigns no slot at all, so
 * which slot each binds at is the backend's answer and everything else --
 * stride, offset, step rate -- comes from the generated declaration.
 */
inline constexpr std::string_view vertex_stream_group(VertexInputStream stream) {
    switch (stream) {
    case VertexInputStream::instance_matrix:
        return "ti-matrix";
    case VertexInputStream::instance_color:
        return "ti-color";
    case VertexInputStream::vertex:
        break;
    }
    return "";
}

/**
 * One stream's element stride.
 *
 * The vertex stream's is ours -- it is `GpuVertex`. The instance-stepped
 * ones are the pin's, read from `pinned_instance_attributes`, which is
 * lowered from `createThinInstanceFragment`'s own `_arrayStride`
 * declarations. A stride the pin moves therefore moves here, in both
 * backends, without either one restating it.
 */
inline constexpr std::uint64_t vertex_stream_stride([[maybe_unused]] VertexInputStream stream) {
#if BBLITE_GPU_INSTANCING
    if (stream != VertexInputStream::vertex) {
        return upstream::pinned_instance_group_stride(vertex_stream_group(stream));
    }
#endif
    return sizeof(GpuVertex);
}

/** Whether a stream steps per instance rather than per vertex. */
inline constexpr bool vertex_stream_is_instanced(VertexInputStream stream) {
    return stream != VertexInputStream::vertex;
}

#if BBLITE_GPU_INSTANCING
// The join between this backend's slots and the pin's groups. Naming a group
// here is how a slot is chosen; proving the name is the pin's is these three
// lines. A pin that renames a group leaves its stride lookup at zero, and one
// that adds a third leaves the list longer than the two streams this backend
// declares -- either way the build stops rather than binding the wrong buffer
// at the right slot.
static_assert(upstream::pinned_instance_groups.size() == 2);
static_assert(vertex_stream_stride(VertexInputStream::instance_matrix) != 0);
static_assert(vertex_stream_stride(VertexInputStream::instance_color) != 0);
#endif

/** The streams, in slot order, for a backend filling a buffer list. */
inline constexpr std::array<VertexInputStream, 3> vertex_streams{
    VertexInputStream::vertex,
    VertexInputStream::instance_matrix,
    VertexInputStream::instance_color,
};

#if BBLITE_GPU_DEFORMATION
// Vertex deformation uniforms shared by both render backends (moved
// verbatim from pal_sdl_gpu.cpp).
struct DeformationUniforms {
    std::array<std::array<float, 16>, 64> bone_matrices{};
    float morph_weights[4]{};
    float options[4]{};
};

inline DeformationUniforms build_deformation_uniforms(const MeshRecord& mesh) {
    DeformationUniforms result;
    for (std::array<float, 16>& matrix : result.bone_matrices) {
        matrix[0] = 1.0f;
        matrix[5] = 1.0f;
        matrix[10] = 1.0f;
        matrix[15] = 1.0f;
    }
    if (!mesh.gpu_deformation)
        return result;
    // A palette on the pin's own texture is read by the composed skeleton
    // stage, not from this block, so the bone lanes stay the identity:
    // filling them would be dead bytes, and this 64-matrix array could
    // not hold a larger palette anyway. The morph half still travels,
    // since the two transports are independent.
    if (!mesh.pinned_bone_palette) {
        // Sized by the loader from the skin's joint count, which
        // generation refuses above this array's length and the loader
        // refuses again for a BBLITE_ASSET_DIR override -- so the copy
        // cannot overrun and needs no third check here.
        std::copy(mesh.bone_matrices.begin(), mesh.bone_matrices.end(),
                  result.bone_matrices.begin());
    }
    std::copy(mesh.morph_weights.begin(), mesh.morph_weights.end(), result.morph_weights);
    result.options[0] = 1.0f;
    return result;
}
#endif

/**
 * One mesh's vertex buffer: its geometry's local lanes, uploaded once as the
 * pin's own `createMappedBuffer` uploads them. A node's world never enters
 * these bytes -- it reaches the vertex stage through the mesh block
 * (`mesh_block_world`) -- so a transform-only change uploads nothing.
 *
 * The morph lanes carry the geometry's first two targets for the
 * vertex-attribute morph transport.
 */
inline std::vector<GpuVertex> mesh_gpu_vertices(const ModelGeometry& geometry,
                                                [[maybe_unused]] const MeshRecord& mesh) {
    std::vector<GpuVertex> result;
    result.reserve(geometry.vertices.size());
#if BBLITE_GPU_DEFORMATION
    const auto morph_lane = [&](const std::vector<std::vector<Vec3>>& targets, std::size_t target,
                                std::size_t vertex_index) {
        if (targets.size() <= target)
            return std::array<float, 3>{};
        const Vec3& delta = targets[target][vertex_index];
        return std::array<float, 3>{delta.x, delta.y, delta.z};
    };
#endif
    for (std::size_t vertex_index = 0; vertex_index < geometry.vertices.size(); ++vertex_index) {
        const ModelVertex& vertex = geometry.vertices[vertex_index];
        GpuVertex packed{
            {vertex.position.x, vertex.position.y, vertex.position.z},
            {vertex.normal.x, vertex.normal.y, vertex.normal.z},
            {vertex.tangent.x, vertex.tangent.y, vertex.tangent.z, vertex.tangent.w},
            {vertex.uv.x, vertex.uv.y},
            {vertex.uv2.x, vertex.uv2.y},
            {vertex.color.x, vertex.color.y, vertex.color.z, vertex.color.w},
#if BBLITE_GPU_DEFORMATION
            {
                static_cast<float>(vertex.joints[0]),
                static_cast<float>(vertex.joints[1]),
                static_cast<float>(vertex.joints[2]),
                static_cast<float>(vertex.joints[3]),
            },
            {
                // A deformed mesh with no skin weights reads the identity
                // palette entry, so the influence sum is the identity.
                mesh.gpu_deformation &&
                        vertex.weights.x + vertex.weights.y + vertex.weights.z + vertex.weights.w <=
                            0.0f
                    ? 1.0f
                    : vertex.weights.x,
                vertex.weights.y,
                vertex.weights.z,
                vertex.weights.w,
            },
            {},
            {},
            {},
            {},
            {},
            {},
#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
            {
                static_cast<std::uint32_t>(vertex.joints[0]),
                static_cast<std::uint32_t>(vertex.joints[1]),
                static_cast<std::uint32_t>(vertex.joints[2]),
                static_cast<std::uint32_t>(vertex.joints[3]),
            },
#endif
#endif
        };
#if BBLITE_GPU_DEFORMATION
        const auto store = [](float (&lane)[3], const std::array<float, 3>& value) {
            std::copy(value.begin(), value.end(), lane);
        };
        store(packed.morph_position_0, morph_lane(geometry.morph_positions, 0, vertex_index));
        store(packed.morph_position_1, morph_lane(geometry.morph_positions, 1, vertex_index));
        store(packed.morph_normal_0, morph_lane(geometry.morph_normals, 0, vertex_index));
        store(packed.morph_normal_1, morph_lane(geometry.morph_normals, 1, vertex_index));
        store(packed.morph_tangent_0, morph_lane(geometry.morph_tangents, 0, vertex_index));
        store(packed.morph_tangent_1, morph_lane(geometry.morph_tangents, 1, vertex_index));
#endif
        result.push_back(packed);
    }
    return result;
}

/**
 * What identifies one immutable shader-geometry upload in a backend cache.
 *
 * The cache exists so short-lived custom-shader meshes that repeat one
 * geometry -- particles, falling blocks, mob parts -- share a buffer. It
 * used to keep a CPU copy of every cached geometry to compare against,
 * which for a streaming voxel world meant a copy of every chunk mesh held
 * for the whole time the mesh was drawn, hundreds of megabytes that never
 * matched anything. A 64-bit content hash beside the two counts is the
 * identity now; the bytes are kept only for a small geometry, where an
 * exact compare confirms the hash and where sharing actually happens.
 */
struct SharedGeometryIdentity {
    std::size_t vertex_count = 0;
    std::size_t index_count = 0;
    std::uint64_t hash = 0;
};

/** Below this many vertices a cached geometry also keeps its bytes. */
inline constexpr std::size_t shared_geometry_bytes_kept_below = 4096;

inline std::uint64_t fnv1a_append(std::uint64_t hash, const void* data, std::size_t size) {
    const auto* bytes = static_cast<const std::uint8_t*>(data);
    for (std::size_t index = 0; index < size; ++index) {
        hash ^= bytes[index];
        hash *= 1099511628211ull;
    }
    return hash;
}

inline SharedGeometryIdentity shared_geometry_identity(const std::vector<GpuVertex>& vertices,
                                                       const std::vector<std::uint32_t>& indices) {
    std::uint64_t hash = 14695981039346656037ull;
    hash = fnv1a_append(hash, vertices.data(), vertices.size() * sizeof(GpuVertex));
    hash = fnv1a_append(hash, indices.data(), indices.size() * sizeof(std::uint32_t));
    return {vertices.size(), indices.size(), hash};
}

inline bool shared_geometry_keeps_bytes(const std::vector<GpuVertex>& vertices) {
    return vertices.size() < shared_geometry_bytes_kept_below;
}

/** Find an exact immutable shader-geometry upload in a backend cache. */
template <typename SharedGeometry>
inline SharedGeometry*
find_shared_shader_geometry(const std::vector<std::unique_ptr<SharedGeometry>>& cache,
                            const SharedGeometryIdentity& identity,
                            const std::vector<GpuVertex>& vertices,
                            const std::vector<std::uint32_t>& indices) {
    const auto found = std::find_if(
        cache.begin(), cache.end(), [&](const std::unique_ptr<SharedGeometry>& candidate) {
            if (candidate->identity.vertex_count != identity.vertex_count ||
                candidate->identity.index_count != identity.index_count ||
                candidate->identity.hash != identity.hash) {
                return false;
            }
            // A kept copy confirms the hash byte for byte; a geometry too
            // large to keep is matched on the hash alone.
            if (candidate->vertices.empty() && !vertices.empty())
                return true;
            return candidate->indices == indices &&
                   (vertices.empty() || std::memcmp(candidate->vertices.data(), vertices.data(),
                                                    vertices.size() * sizeof(GpuVertex)) == 0);
        });
    return found == cache.end() ? nullptr : found->get();
}

/** Find the backend texture upload owned by one shader material. */
template <typename SharedTextures>
inline SharedTextures*
find_shared_shader_material_textures(const std::vector<std::unique_ptr<SharedTextures>>& cache,
                                     MaterialHandle material) {
    const auto found = std::find_if(cache.begin(), cache.end(),
                                    [&](const std::unique_ptr<SharedTextures>& candidate) {
                                        return candidate->material.value == material.value;
                                    });
    return found == cache.end() ? nullptr : found->get();
}

/**
 * Drops one mesh's reference to a backend-owned shared cache entry. It runs
 * on the noexcept mesh-release paths, so an underflow -- a broken ownership
 * count -- ends the process naming itself instead of throwing.
 */
template <typename Shared>
inline void release_shared_user(Shared*& shared, const char* underflow_message) noexcept {
    if (!shared)
        return;
    if (shared->users == 0) {
        terminate_after("release_shared_user", underflow_message);
    }
    --shared->users;
    shared = nullptr;
}

/** Releases and erases cache entries after their last mesh retires. */
template <typename Cache, typename Release>
inline void prune_unused_shared(Cache& cache, Release release) {
    const auto unused = std::remove_if(cache.begin(), cache.end(), [&](const auto& entry) {
        if (entry->users != 0)
            return false;
        release(*entry);
        return true;
    });
    cache.erase(unused, cache.end());
}

/** Releases all backend objects in a cache during renderer teardown. */
template <typename Cache, typename Release>
inline void release_all_shared(Cache& cache, Release release) {
    for (const auto& entry : cache) {
        release(*entry);
    }
    cache.clear();
}

/**
 * Whether a live pool has outgrown the instance buffers its registration
 * allocated.
 *
 * `addThinInstance` doubles a full pool, so a mesh registered with sixteen
 * rows can be drawing thirty-two of them a frame later. Both backends size
 * both instance buffers -- matrices and the colour lane -- from the same
 * row count at registration, so this is one question rather than two, and
 * it is asked before the version-gated upload that would otherwise write
 * past the end.
 */
inline bool thin_instance_pool_grew(const MeshRecord& record, std::uint32_t allocated_rows) {
    return record.thin_instanced &&
           record.instance_matrices.size() > static_cast<std::size_t>(allocated_rows);
}

inline std::size_t thin_instance_active_count(const MeshRecord& record) {
    return std::min(static_cast<std::size_t>(record.instance_count),
                    record.instance_matrices.size());
}

#if BBLITE_PINNED_MATERIALS
/**
 * Where one of Babylon Lite's own vertex-input names sits in our vertex.
 *
 * All three composed families declare their inputs by the pin's names, and
 * the pin numbers the locations densely per variant — an unskinned stage puts
 * nothing where a skinned one puts `joints`. So a PAL resolves each declared
 * name against the vertex we pack, and the table that answers it is a
 * property of `GpuVertex` rather than of a family or a backend.
 *
 * `lane` is the shape, which each backend maps to its own format enum;
 * `stream` says which buffer it comes from. The pin's own thin-instance
 * fragment names two instance-stepped groups -- `ti-matrix` at stride 64
 * for the four world columns and `ti-color` at stride 16 for the RGBA lane
 * -- so an input is in the vertex, in the matrix stream, or in the colour
 * stream, and those are the slots both backends already bind.
 */
enum class VertexInputLane {
    float2,
    float3,
    float4,
    uint4,
};

struct PinnedVertexInput {
    VertexInputLane lane = VertexInputLane::float3;
    std::uint64_t offset = 0;
    VertexInputStream stream = VertexInputStream::vertex;
    /** False when this vertex carries nothing under that name. */
    bool mapped = false;
};

/**
 * Resolve one declared input onto the vertex's own lanes, which hold the
 * geometry's local values for every family and view.
 */
inline PinnedVertexInput pinned_vertex_input(std::string_view name) {
    const auto at = [](VertexInputLane lane, std::size_t offset) {
        return PinnedVertexInput{
            lane,
            static_cast<std::uint64_t>(offset),
            VertexInputStream::vertex,
            true,
        };
    };
    if (name == "position") {
        return at(VertexInputLane::float3, offsetof(GpuVertex, position));
    }
    if (name == "normal") {
        return at(VertexInputLane::float3, offsetof(GpuVertex, normal));
    }
    if (name == "tangent") {
        return at(VertexInputLane::float4, offsetof(GpuVertex, tangent));
    }
    if (name == "uv") {
        return at(VertexInputLane::float2, offsetof(GpuVertex, uv));
    }
    if (name == "uv2") {
        return at(VertexInputLane::float2, offsetof(GpuVertex, uv2));
    }
    if (name == "color") {
        return at(VertexInputLane::float4, offsetof(GpuVertex, color));
    }
#if BBLITE_GPU_INSTANCING
    // The pin's own thin-instance attributes -- the four `ti-matrix` world
    // columns and the `ti-color` RGBA lane -- resolved from the declaration
    // that states their group and their offset within it, rather than from
    // names and arithmetic written here. Every one of them is a float4.
    if (const upstream::PinnedInstanceAttribute* declared =
            upstream::pinned_instance_attribute(name)) {
        return PinnedVertexInput{
            VertexInputLane::float4,
            declared->offset,
            declared->buffer_group == vertex_stream_group(VertexInputStream::instance_color)
                ? VertexInputStream::instance_color
                : VertexInputStream::instance_matrix,
            true,
        };
    }
#endif
#if BBLITE_GPU_DEFORMATION
    if (name == "weights") {
        return at(VertexInputLane::float4, offsetof(GpuVertex, weights));
    }
#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
    // The pin takes joint indices as integers; the transcribed stage takes
    // them as floats, so the vertex carries both while the two coexist.
    if (name == "joints") {
        return at(VertexInputLane::uint4, offsetof(GpuVertex, joint_indices));
    }
#endif
#endif
    return PinnedVertexInput{};
}
#endif

#if BBLITE_PINNED_MATERIAL_VARIANTS
/** Whether a record draws through the pin's thin-instance arm: stamped by
 *  the scene setter or filled by the glTF EXT_mesh_gpu_instancing pool. */
inline bool pinned_record_instanced(const MeshRecord& record) {
    return record.thin_instanced || !record.instance_matrices.empty();
}

/**
 * Whether that pool also carries per-instance colours.
 *
 * `_computeMeshFeatures` reads `mesh.thinInstances.colors`, so this is what
 * the variant KEY asks and what each backend's binding asks, and the two
 * have to agree: a pipeline declaring the colour stream that no draw binds
 * is a validation failure, and the reverse silently shades white. One
 * predicate rather than five transcriptions of the same expression.
 */
inline bool pinned_record_instance_colored(const MeshRecord& record) {
    return has_instance_colors(record);
}

#endif

#if BBLITE_GPU_INSTANCE_COLORS
// Snapshot a retained caller view at the versioned GPU upload boundary.
inline std::vector<float> instance_colors_for_upload(const MeshRecord& mesh) {
    if (!mesh.instance_color_source)
        return mesh.instance_colors;
    const auto& source = *mesh.instance_color_source;
    std::vector<float> colors(source.size());
    for (std::size_t lane = 0; lane < colors.size(); ++lane)
        colors[lane] = source.load(lane);
    return colors;
}
#endif

#if BBLITE_GPU_MORPH_STORAGE
// Storage-buffer morph payloads shared by both render backends. The deltas
// are the pin's own packing (`upstream::pack_morph_deltas`); the weights
// blob carries a 16-byte header the shader reads before the float array.
// The empty binding still needs the 16-byte header plus one runtime-array
// element. Both WebGPU and Metal validate that 20-byte minimum.
inline constexpr std::array<std::uint32_t, 5> empty_morph_weight_data{};

/**
 * The float array behind the weights blob's 16-byte header: one weight
 * per target, zero past the record's stored values. Split out because a
 * version-gated re-upload may rewrite just this span (the header is
 * constant after creation), and both backends must fill it identically.
 */
inline std::vector<float> morph_weight_values(const ModelGeometry& geometry,
                                              const MeshRecord& mesh_record) {
    const std::size_t target_count = geometry.morph_positions.size();
    std::vector<float> weights(target_count, 0.0f);
    for (std::size_t target = 0; target < target_count; ++target) {
        weights[target] = target < mesh_record.morph_storage_weights.size()
                              ? mesh_record.morph_storage_weights[target]
                              : 0.0f;
    }
    return weights;
}

inline std::vector<std::uint8_t> pack_morph_weights(const ModelGeometry& geometry,
                                                    const MeshRecord& mesh_record) {
    const std::size_t target_count = geometry.morph_positions.size();
    const std::size_t vertex_count = geometry.vertices.size();
    std::vector<std::uint8_t> weights_blob(16 + target_count * sizeof(float), 0);
    const std::uint32_t header[2] = {
        static_cast<std::uint32_t>(target_count),
        static_cast<std::uint32_t>(vertex_count),
    };
    std::memcpy(weights_blob.data(), header, sizeof(header));
    const std::vector<float> weights = morph_weight_values(geometry, mesh_record);
    if (target_count > 0) {
        std::memcpy(weights_blob.data() + 16, weights.data(), target_count * sizeof(float));
    }
    return weights_blob;
}
#endif

} // namespace bbl::pal
