// The pinned `loadAudioArrayBuffer` (audio-fetch.ts), lowered by
// test/static-sound-library.test.ts, over the web platform seam as
// native/src/pal_web_platform.cpp defines it: a packaged URL reads its file,
// an unpackaged one goes to HTTP and a failed status rejects with the pin's
// message. Each line printed is one observation the test compares.

#include "../../artifacts/static-sound-fetch-check/library.hpp"

#include <bblite/pal_event_loop.hpp>
#include <bblite/pal_packaged_responses.hpp>

#include <cassert>
#include <iostream>
#include <string>
#include <vector>

using namespace bbl;

// pal.cpp's clock reports a build's stamp; a fixture has none of its own.
const char* bbl::pal::bblite_build_stamp() { return "static-sound-fetch-check"; }

namespace {

js::Promise<js::PromiseVoid> run(std::string base, std::string packaged,
                                 std::vector<std::string>& lines) {
    pal::register_packaged_responses("http://localhost/app/",
                                     {{"http://localhost/app/sounds/a%23b.wav", packaged}});
    // A relative request resolves against the deployment base; `#` is the
    // pin's own escape (`cleanAudioUrl`).
    const auto bytes = co_await load_audio_array_buffer("sounds/a#b.wav");
    lines.push_back("packaged " + std::to_string(bytes.byte_length()) + " " +
                    std::to_string(static_cast<int>(bytes.data()[0])));
    try {
        static_cast<void>(co_await load_audio_array_buffer(base + "/missing.wav"));
        lines.push_back("missing resolved");
    } catch (...) {
        lines.push_back("missing " + js::error_message(std::current_exception()));
    }
    co_return js::PromiseVoid{};
}

} // namespace

int main(int argc, char** argv) {
    assert(argc == 3);
    std::vector<std::string> lines;
    std::string failure;
    {
        const js::RealmScope realm;
        pal::EventLoop loop;
        loop.run([&] {
            static_cast<void>(run(argv[1], argv[2], lines)
                                  .then(js::Callback<void(js::PromiseVoid)>(
                                            [&](js::PromiseVoid) { loop.close(); }),
                                        js::Callback<void(js::Error)>([&](js::Error) {
                                            failure = "rejected";
                                            loop.close();
                                        })));
        });
    }
    for (const auto& line : lines)
        std::cout << line << "\n";
    if (!failure.empty()) {
        std::cout << "failed " << failure << "\n";
        return 1;
    }
    return 0;
}
