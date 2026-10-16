#pragma once

#include <bblite/runtime.hpp>
#include <bblite/pal_offscreen.hpp>
#include <bblite/js_data.hpp>

namespace bbl {

struct StorageBufferOptions {
    std::optional<std::string> label;
    std::optional<bool> writable;
    std::optional<bool> vertex;
    std::optional<bool> index;
    std::optional<bool> indirect;
};

struct StorageBufferSource {
    double byte_length{};
    bool numeric{};
    std::span<const std::uint8_t> bytes;
};

inline StorageBufferSource storage_buffer_source(double size) { return {size, true, {}}; }
inline StorageBufferSource storage_buffer_source(const js::ArrayBufferView& data) {
    const auto bytes = storage_buffer_bytes(data);
    return {static_cast<double>(bytes.size()), false, bytes};
}
inline StorageBufferSource storage_buffer_source(const js::DataView& data) {
    return storage_buffer_source(js::ArrayBufferView(data));
}
template <class Data> StorageBufferSource storage_buffer_source(const Data& data) {
    const auto bytes = storage_buffer_bytes(data);
    return {static_cast<double>(bytes.size()), false, bytes};
}
template <class... Data>
StorageBufferSource storage_buffer_source(const std::variant<Data...>& data) {
    return std::visit([](const auto& value) { return storage_buffer_source(value); }, data);
}

StorageBufferHandle create_gpu_storage_buffer(std::shared_ptr<Engine>, StorageBufferSource,
                                              StorageBufferOptions);

} // namespace bbl
