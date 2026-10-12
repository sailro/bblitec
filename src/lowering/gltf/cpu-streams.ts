/** Rehydrate recorded source arrays without deriving ownership from GPU geometry. */
export function gltfCpuStreamsCpp(): string {
    return `struct GltfCpuStreamCache {
    std::unordered_map<std::size_t, js::ArrayBuffer> buffers;
    std::unordered_map<std::size_t, js::F32Array> floats;
    std::unordered_map<std::size_t, js::U32Array> indices;

    template<class Array>
    Array read(std::unordered_map<std::size_t, Array>& arrays, std::size_t index,
               std::uint32_t component_type, const ts::ArrayBuffer& binary,
               const upstream::ParsedGlbContainer& container,
               const std::vector<BufferViewInfo>& views, const std::vector<AccessorInfo>& accessors) {
        if (const auto found = arrays.find(index); found != arrays.end()) return found->second;
        const auto& accessor = accessors.at(index);
        const auto& view = views.at(accessor.buffer_view);
        if (accessor.type != "SCALAR" || accessor.component_type != component_type ||
            accessor.normalized || view.stride || accessor.offset > view.length ||
            accessor.count > (view.length - accessor.offset) / 4 || accessor.offset % 4)
            throw std::runtime_error("Invalid glTF CPU array storage.");
        auto found = buffers.find(accessor.buffer_view);
        if (found == buffers.end()) {
            if (container.bin_offset > binary.byte_length() || container.bin_length > binary.byte_length() - container.bin_offset ||
                view.offset > container.bin_length || view.length > container.bin_length - view.offset)
                throw std::runtime_error("glTF CPU backing buffer exceeds its binary storage.");
            const auto* start = binary.data() + container.bin_offset + view.offset;
            found = buffers.emplace(accessor.buffer_view, js::ArrayBuffer(std::vector<std::uint8_t>(start, start + view.length))).first;
        }
        return arrays.emplace(index, Array(found->second, static_cast<double>(accessor.offset), static_cast<double>(accessor.count))).first->second;
    }
};

std::shared_ptr<MeshCpuStreams> read_gltf_cpu_streams(const JsonObject& cpu, GltfCpuStreamCache& cache,
    const ts::ArrayBuffer& binary, const upstream::ParsedGlbContainer& container,
    const std::vector<BufferViewInfo>& views, const std::vector<AccessorInfo>& accessors) {
    auto result = std::make_shared<MeshCpuStreams>();
${["positions", "normals", "uvs", "uvs2", "tangents", "colors"]
    .map(
        (field) => `    if (const auto* value = optional(cpu, "${field}"))
        result->${field} = cache.read(cache.floats, unsigned_value(*value), 5126, binary, container, views, accessors);`,
    )
    .join("\n")}
    if (const auto* value = optional(cpu, "indices"))
        result->indices = cache.read(cache.indices, unsigned_value(*value), 5125, binary, container, views, accessors);
    return result;
}
`;
}
