#include "pal_audio_handles.hpp"

#include <cassert>
#include <iostream>

int main() {
    using namespace bbl::pal::audio_handles;
    for (const std::uint32_t context : {1u, max_component}) {
        for (const std::uint32_t index : {0u, max_component}) {
            const auto handle = pack(context, index);
            assert(context_of(handle) == context);
            assert(index_of(handle) == index);
        }
    }
    const auto rejects = [](std::uint32_t context, std::uint32_t index) {
        try {
            static_cast<void>(pack(context, index));
        } catch (const std::runtime_error&) {
            return true;
        }
        return false;
    };
    assert(rejects(1u, max_component + 1u));
    assert(rejects(max_component + 1u, 0u));
    assert(rejects(0u, 0u));
    std::cout << "audio-handles-check: ok\n";
}
