#define main generated_main
#include "../../artifacts/media-query/program.hpp"
#undef main
#include <cassert>

namespace {
bool reduced = false;
double ratio = 1;
bool read_motion() { return reduced; }
double read_ratio() { return ratio; }
std::vector<std::shared_ptr<bbl::pal::MediaQueryList>> queries;
}

namespace bbl::pal {
std::shared_ptr<MediaQueryList> create_media_query(std::string query) {
    auto media = js::make_gc_shared<MediaQueryList>(std::move(query), read_ratio, read_motion);
    queries.push_back(media);
    return media;
}
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    std::exception_ptr failure;
    loop.on_error([&](std::exception_ptr error) { failure = error; loop.close(); });
    loop.run([&] {
        initialize(realm);
        reduced = true;
        for (const auto& query : queries) { query->deliver(); query->deliver(); }
    });
    queries.clear();
    if (failure) std::rethrow_exception(failure);
    return 0;
}
}

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
    for (const auto* query : {"(width: 600px)", "(prefers-reduced-motion: sometimes)", "(resolution: 2dpi)", "screen and (resolution: 2dppx)"}) {
        bool refused = false;
        try { const MediaQueryList unsupported(query, read_ratio, read_motion); }
        catch (const std::invalid_argument&) { refused = true; }
        assert(refused);
    }
    reduced = false;
    ratio = 1;
    assert(generated_main() == 0);
}
