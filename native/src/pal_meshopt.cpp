#include <bblite/pal_meshopt.hpp>

#include <bblite/js_error.hpp>

#include <cstddef>
#include <cstring>
#include <string>
#include <vector>

#include <meshoptimizer.h>

namespace bbl::pal {
namespace {

using Codec = int (*)(void*, std::size_t, std::size_t, const unsigned char*, std::size_t);
using Filter = void (*)(void*, std::size_t, std::size_t);

/** The script's `decoders` table: a mode's codec, or none. */
Codec codec_of(const std::string& mode) {
    if (mode == "ATTRIBUTES")
        return meshopt_decodeVertexBuffer;
    if (mode == "TRIANGLES")
        return meshopt_decodeIndexBuffer;
    if (mode == "INDICES")
        return meshopt_decodeIndexSequence;
    return nullptr;
}

/** The script's `filters` table: a name it lists, or no filter (`NONE` and any other name). */
Filter filter_of(const js::Nullable<std::string>& filter) {
    if (!filter)
        return nullptr;
    if (*filter == "OCTAHEDRAL")
        return meshopt_decodeFilterOct;
    if (*filter == "QUATERNION")
        return meshopt_decodeFilterQuat;
    if (*filter == "EXPONENTIAL")
        return meshopt_decodeFilterExp;
    return nullptr;
}

} // namespace

js::Promise<js::PromiseVoid> MeshoptDecoder::ready() const {
    return js::Promise<js::PromiseVoid>::resolved({});
}

// The script's `decode`: the codec writes a scratch sized for the count rounded up to four,
// the filter runs over that rounded count, the target receives `count * size` bytes, and a
// failed codec throws only after the copy.
void MeshoptDecoder::decode_gltf_buffer(const js::TypedArray<std::uint8_t>& target, double count,
                                        double size, const js::TypedArray<std::uint8_t>& source,
                                        const std::string& mode,
                                        const js::Nullable<std::string>& filter) const {
    const Codec codec = codec_of(mode);
    if (!codec)
        throw js::NamedError("TypeError", "fun is not a function");
    const auto elements = static_cast<std::size_t>(count);
    const auto stride = static_cast<std::size_t>(size);
    const std::size_t rounded = (elements + 3) & ~std::size_t{3};
    std::vector<unsigned char> scratch(rounded * stride);
    const auto encoded = js::typed_array_bytes(source);
    const int result = codec(scratch.data(), elements, stride, encoded.data(), encoded.size());
    if (const Filter apply = filter_of(filter); result == 0 && apply)
        apply(scratch.data(), rounded, stride);
    const auto destination = js::typed_array_bytes(target);
    if (elements * stride > destination.size())
        throw js::NamedError("RangeError", "offset is out of bounds");
    if (elements * stride != 0)
        std::memcpy(destination.data(), scratch.data(), elements * stride);
    if (result != 0)
        throw js::NamedError("Error", "Malformed buffer data: " + std::to_string(result));
}

js::Promise<MeshoptDecoder> load_meshopt_decoder() {
    return js::Promise<MeshoptDecoder>::resolved(MeshoptDecoder{});
}

} // namespace bbl::pal
