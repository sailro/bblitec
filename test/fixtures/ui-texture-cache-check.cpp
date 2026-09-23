#include "pal_ui_texture_cache.hpp"
#include <cassert>
#include <iostream>

using namespace bbl::pal;

int main() {
    using Pixels = const std::vector<std::uint8_t>;
    std::unordered_map<std::uint64_t, UiCachedTexture<int>> cache;
    std::vector<int> released;
    const auto prune = [&] {
        return prune_ui_texture_cache(cache, [&](int resource) { released.push_back(resource); });
    };
    auto source = std::make_shared<Pixels>(16, std::uint8_t{255});
    auto frame = source;
    cache.emplace(1, UiCachedTexture<int>{101, frame});
    assert(source.use_count() == 2); // The GPU cache must not retain CPU pixels.

    frame.reset(); // A glyph can leave the visible frame while its font still owns it.
    assert(prune() == 0 && cache.contains(1));
    frame = source;
    assert(cache.at(1).resource == 101); // Reappearing pixels reuse their original GPU resource.
    source.reset();                      // A recorded frame can outlive ReleaseTexture.
    assert(prune() == 0 && cache.contains(1));
    frame.reset();
    assert(prune() == 1 && cache.empty());
    assert((released == std::vector<int>{101}));
    assert(prune() == 0); // A later empty frame must not release twice.

    auto first = std::make_shared<Pixels>(16, std::uint8_t{255});
    auto second = std::make_shared<Pixels>(16, std::uint8_t{255});
    cache.emplace(2, UiCachedTexture<int>{102, first});
    cache.emplace(3, UiCachedTexture<int>{103, second});
    first.reset(); // Equal pixel contents do not merge independent source lifetimes.
    assert(prune() == 1 && !cache.contains(2) && cache.contains(3));
    second.reset();
    assert(prune() == 1 && cache.empty());
    assert((released == std::vector<int>{101, 102, 103}));
    std::cout << "ui-texture-cache-check: ok\n";
}
