#pragma once

#include <bblite/js_data.hpp>

#include <array>
#include <cstddef>
#include <cstring>
#include <random>
#include <type_traits>

namespace bbl::js {

namespace crypto_detail {
/** `getRandomValues` refuses more than 65536 bytes with a QuotaExceededError. */
inline void require_entropy_quota(std::size_t bytes) {
    if (bytes > 65536)
        throw NamedError("QuotaExceededError",
                         "The ArrayBufferView's byte length exceeds the number of bytes of entropy "
                         "available via this API (65536)");
}

/** Random bytes from the host's entropy source. */
inline void fill_entropy(unsigned char* bytes, std::size_t count) {
    thread_local std::random_device source;
    for (std::size_t index = 0; index < count; ++index)
        bytes[index] = static_cast<unsigned char>(source());
}
} // namespace crypto_detail

/** `crypto.getRandomValues` on a Uint8Array: every byte set to random bits. */
inline void fill_random_values(U8Array& values) {
    crypto_detail::require_entropy_quota(values.size());
    crypto_detail::fill_entropy(values.data(), values.size());
}

/** `crypto.getRandomValues` on another integer typed array: every element set to random bits. */
template <typename T> inline void fill_random_values(TypedArray<T>& values) {
    static_assert(!std::is_floating_point_v<T>, "getRandomValues fills integer typed arrays.");
    crypto_detail::require_entropy_quota(values.byte_length());
    for (std::size_t index = 0; index < values.size(); ++index) {
        std::array<unsigned char, sizeof(T)> bytes;
        crypto_detail::fill_entropy(bytes.data(), bytes.size());
        T value;
        std::memcpy(&value, bytes.data(), sizeof(T));
        values.store(index, value);
    }
}

} // namespace bbl::js
