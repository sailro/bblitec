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
    Registry<int> registry;
    auto retained = registry.insert(std::make_shared<int>(17));
    std::uint32_t reusable = 0;
    std::weak_ptr<int> discarded;
    for (int iteration = 0; iteration < 100000; ++iteration) {
        auto transient = registry.insert(std::make_shared<int>(iteration));
        if (iteration == 0) reusable = transient.index;
        assert(transient.index == reusable);
        assert(registry.contains(retained.index, retained.ownership));
        assert(registry.contains(transient.index, transient.ownership));
        assert(!registry.contains(transient.index, retained.ownership));
        assert(!registry.contains(retained.index, {}));
        discarded = transient.ownership;
    }
    assert(discarded.expired());
    assert(*retained.ownership == 17);
    assert(registry.capacity() == 2);
    registry.for_each_live([](int& value) { value += 1; });
    assert(*retained.ownership == 18);
    // The allocation can outlive its lookup table without a callback into
    // destroyed registry storage, and its last release is still valid.
    auto surviving = [] {
        Registry<int> local;
        return local.insert(std::make_shared<int>(4));
    }();
    assert(*surviving.ownership == 4);
    std::cout << "audio-handles-check: ok\n";
}
