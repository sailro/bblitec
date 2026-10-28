#pragma once

// The browser's `MeshoptDecoder` (`meshopt_decoder.js`: meshoptimizer's decoder built to
// WebAssembly) as meshoptimizer's own C++ decoder at the pinned script's version
// (`pal_meshopt.cpp`), linked only where a program reaches it (platform:meshopt).

#include <bblite/js_data.hpp>
#include <bblite/js_promise.hpp>

#include <cstdint>
#include <string>

namespace bbl::pal {

/** The decoder object the pin holds once its script has loaded. */
class MeshoptDecoder {
public:
    /** `decoder.ready`: the native decoder is ready once linked. */
    [[nodiscard]] js::Promise<js::PromiseVoid> ready() const;

    /**
     * `decoder.decodeGltfBuffer(target, count, size, source, mode, filter)`: `mode` names the
     * codec ("ATTRIBUTES", "TRIANGLES" or "INDICES") and `filter` the decode filter
     * ("OCTAHEDRAL", "QUATERNION" or "EXPONENTIAL"; any other applies none), as the script's
     * tables do. A malformed stream throws `Malformed buffer data: <code>` after the target
     * receives what was decoded.
     */
    void decode_gltf_buffer(const js::TypedArray<std::uint8_t>& target, double count, double size,
                            const js::TypedArray<std::uint8_t>& source, const std::string& mode,
                            const js::Nullable<std::string>& filter) const;
};

/** The script's load: the native decoder is linked, so it settles at once. */
[[nodiscard]] js::Promise<MeshoptDecoder> load_meshopt_decoder();

} // namespace bbl::pal
