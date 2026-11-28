#define main generated_main
#include "../../artifacts/media-query/program.hpp"
#undef main
#include <cassert>

namespace {
bool reduced = false;
double ratio = 1;
bool read_motion() { return reduced; }
double read_ratio() { return ratio; }
bbl::InputCapabilities device_capabilities{bbl::PointerPrecision::Fine, true};
bbl::InputCapabilities read_input() { return device_capabilities; }
bbl::UiClientRect viewport{0, 0, 800, 600};
bbl::UiClientRect read_viewport() { return viewport; }
std::vector<std::shared_ptr<bbl::pal::MediaQueryList>> queries;
} // namespace

namespace bbl::pal {
Engine& window_document_engine() {
    static Engine document;
    return document;
}
std::shared_ptr<MediaQueryList> create_media_query(std::string query) {
    auto media = js::make_gc_shared<MediaQueryList>(std::move(query), read_ratio, read_motion,
                                                    read_input, read_viewport);
    queries.push_back(media);
    return media;
}
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    std::exception_ptr failure;
    loop.on_error([&](std::exception_ptr error) {
        failure = error;
        loop.close();
    });
    loop.run([&] {
        initialize(realm);
        reduced = true;
        for (const auto& query : queries) {
            query->deliver();
            query->deliver();
        }
    });
    queries.clear();
    if (failure)
        std::rethrow_exception(failure);
    return 0;
}
} // namespace bbl::pal

int main() {
    using bbl::pal::MediaQueryList;
    MediaQueryList reduce(" (PREFERS-REDUCED-MOTION : REDUCE) ", read_ratio, read_motion);
    MediaQueryList inverse("(prefers-reduced-motion:no-preference)", read_ratio, read_motion);
    MediaQueryList boolean("(prefers-reduced-motion)", read_ratio, read_motion);
    MediaQueryList density("(RESOLUTION:1.5DPPX)", read_ratio, read_motion);
    assert(!reduce.matches() && inverse.matches() && !boolean.matches() && !density.matches());
    reduced = true;
    ratio = 1.5;
    assert(reduce.matches() && !inverse.matches() && boolean.matches() && density.matches());
    assert(reduce.media() == "(prefers-reduced-motion: reduce)");
    assert(boolean.media() == "(prefers-reduced-motion)");
    assert(density.media() == "(resolution: 1.5dppx)");
    for (const auto* query : {"(resolution:.5dppx)", "(resolution:1.dppx)", "(resolution:1e0dppx)",
                              "(resolution:1.5e+1dppx)"}) {
        const MediaQueryList decimal(query, read_ratio, read_motion);
        assert(!decimal.media().empty());
    }
    MediaQueryList touch(" (HOVER: NONE) and (pointer: COARSE) ", read_ratio, read_motion,
                         read_input);
    MediaQueryList mouse("(pointer: fine) and (hover: hover)", read_ratio, read_motion, read_input);
    assert(!touch.matches() && mouse.matches());
    assert(touch.media() == "(hover: none) and (pointer: coarse)");
    device_capabilities = {bbl::PointerPrecision::Coarse, false};
    assert(touch.matches() && !mouse.matches());
    device_capabilities = {bbl::PointerPrecision::None, false};
    assert(!touch.matches() && !mouse.matches());
    // The device features join as a sheet's @media joins them, bare forms included.
    MediaQueryList combined("(prefers-reduced-motion) and (HOVER)", read_ratio, read_motion,
                            read_input);
    assert(combined.media() == "(prefers-reduced-motion) and (hover)");
    assert(!combined.matches());
    device_capabilities = {bbl::PointerPrecision::Fine, true};
    assert(combined.matches() == reduced);
    // Viewport bounds are inclusive CSS pixels of the window's viewport.
    MediaQueryList narrow("(MAX-WIDTH:760PX)", read_ratio, read_motion, read_input, read_viewport);
    MediaQueryList box("(min-width: 600px) and (max-height: 600px) and (min-height: .5px)",
                       read_ratio, read_motion, read_input, read_viewport);
    assert(narrow.media() == "(max-width: 760px)");
    assert(box.media() == "(min-width: 600px) and (max-height: 600px) and (min-height: 0.5px)");
    assert(!narrow.matches() && box.matches());
    viewport = {0, 0, 760, 601};
    assert(narrow.matches() && !box.matches());
    viewport = {0, 0, 800, 600};
    bool needs_viewport = false;
    try {
        const MediaQueryList unread("(max-width: 760px)", read_ratio, read_motion, read_input);
    } catch (const std::invalid_argument&) {
        needs_viewport = true;
    }
    assert(needs_viewport);
    for (const auto* query : {"(width: 600px)",
                              "(max-width: 760)",
                              "(max-width: 1em)",
                              "(max-width: -1px)",
                              "(max-width: 1px) and (max-width: 2px)",
                              "(prefers-reduced-motion: sometimes)",
                              "(resolution: 2dpi)",
                              "screen and (resolution: 2dppx)",
                              "(hover: coarse)",
                              "(pointer: hover)",
                              "(pointer: fine) or (hover: none)",
                              "(pointer)",
                              "(hover: hover) and (hover: none)",
                              "(resolution: 1dppx) and (hover)",
                              "(hover)and (pointer: fine)",
                              "(hover) and(pointer: fine)",
                              "(hover) and",
                              "(hover:)",
                              "(hover)\xc2\xa0",
                              "(resolution:1e309dppx)",
                              "(resolution:1e-999dppx)",
                              "(resolution:0x1dppx)",
                              "(resolution:-1dppx)",
                              "(resolution:+1dppx)",
                              "(resolution:1 dppx)"}) {
        bool refused = false;
        try {
            const MediaQueryList unsupported(query, read_ratio, read_motion, read_input,
                                             read_viewport);
        } catch (const std::invalid_argument&) {
            refused = true;
        }
        assert(refused);
    }
    reduced = false;
    ratio = 1;
    device_capabilities = {bbl::PointerPrecision::Fine, true};
    assert(generated_main() == 0);
}
