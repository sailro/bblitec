// The lowered streaming-sound family (test/streaming-sounds.test.ts writes
// it) over the real LabSound PAL, rendered offline between its calls: a
// packaged WAVE media element preloaded to its canplaythrough, played,
// re-volumed, paused, resumed, stopped and disposed; a URL list whose first
// candidate is not packaged; an undecodable source rejecting the creation.
// Prints one line per step: the left and right channel peaks once settled.

#include "pal_audio_labsound.cpp"
#include "labsound-fixture.hpp"

#include "../../artifacts/streaming-sound-capture/library.hpp"

#include <bblite/pal_event_loop.hpp>
#include <bblite/pal_packaged_responses.hpp>

#include <array>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

using namespace bbl;

// pal.cpp's clock reports a build's stamp; a fixture has none of its own.
const char* bbl::pal::bblite_build_stamp() { return "streaming-sound-capture-check"; }

namespace {

using labsound_fixture::fixed;
using labsound_fixture::peak;

/** Render `frames` more frames offline; each channel's peak over the last `measured`. */
std::string render(pal::AudioContextHandle context, int frames, int measured) {
    const auto pcm = labsound_fixture::render(context, frames);
    std::string line;
    for (int channel = 0; channel < 2; ++channel) {
        const auto recorded = labsound_fixture::samples(*pcm, channel);
        line += " " + fixed(peak(recorded, recorded.size() - measured, recorded.size()));
    }
    return line;
}

/** A fixture packages its files where they are. */
std::string fixture_path(const std::string& path) { return path; }

js::Promise<js::PromiseVoid> run(std::string wav, std::string broken,
                                 std::vector<std::string>& lines) {
    AudioEngineOptions engine_options{};
    engine_options.audio_context = pal::audio_create_context();
    const auto engine = co_await create_audio_engine_async(engine_options);
    const auto context = engine.context;
    const std::array<pal::PackagedFetchEntry, 2> responses{
        {{"/music/theme.wav", "http://localhost/music/theme.wav", wav},
         {"/music/broken.wav", "http://localhost/music/broken.wav", broken}}};
    pal::register_packaged_responses("http://localhost/", fixture_path, responses);

    // Created once its preloaded element can play through.
    StreamingSoundOptions options{};
    options.loop = true;
    const auto sound =
        co_await create_streaming_sound_async(engine, std::string("/music/theme.wav"), options);
    lines.push_back("preloaded " +
                    std::to_string(static_cast<int>(sound->get_preload_completed_count())) + " " +
                    std::to_string(engine.sources.size()));
    play_streaming_sound(sound);
    // The element's play() settles in a task; let the loop run it.
    co_await js::Promise<js::PromiseVoid>::resolved({});
    lines.push_back("playing " + std::to_string(static_cast<int>(sound->get_state())) +
                    render(context, 4800, 2400));

    RampOptions instant{};
    instant.shape = std::string("none");
    set_streaming_sound_volume(sound, 0.5, instant);
    lines.push_back("volume" + render(context, 4800, 2400));
    pause_streaming_sound(sound);
    lines.push_back("paused " + std::to_string(static_cast<int>(sound->get_state())) +
                    render(context, 4800, 2400));
    resume_streaming_sound(sound);
    lines.push_back("resumed " + std::to_string(static_cast<int>(sound->get_state())) +
                    render(context, 4800, 2400));
    stop_streaming_sound(sound);
    lines.push_back("stopped " + std::to_string(static_cast<int>(sound->get_state())) +
                    render(context, 4800, 2400));
    dispose_streaming_sound(sound);
    lines.push_back("disposed " + std::to_string(engine.sources.size()));

    // A URL list: the element tries its source children in order.
    const auto listed = co_await create_streaming_sound_async(
        engine, js::Array<std::string>{"/music/missing.wav", "/music/theme.wav"},
        StreamingSoundOptions{});
    play_streaming_sound(listed);
    co_await js::Promise<js::PromiseVoid>::resolved({});
    lines.push_back("listed" + render(context, 4800, 2400));
    dispose_streaming_sound(listed);

    // An undecodable source fails its preload, and the creation with it.
    try {
        static_cast<void>(co_await create_streaming_sound_async(
            engine, std::string("/music/broken.wav"), StreamingSoundOptions{}));
        lines.push_back("broken created");
    } catch (...) {
        lines.push_back("broken " + js::error_message(std::current_exception()));
    }
    lines.push_back("left " + std::to_string(engine.sources.size()));
    co_return js::PromiseVoid{};
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 3)
        return 2;
    _putenv_s("BBLITE_AUDIO_CAPTURE", "streaming-sound-capture-unused.wav");
    std::vector<std::string> lines;
    std::string failure;
    {
        const js::RealmScope realm;
        pal::EventLoop loop;
        loop.run([&] {
            static_cast<void>(run(argv[1], argv[2], lines)
                                  .then(js::Callback<void(js::PromiseVoid)>(
                                            [&](js::PromiseVoid) { loop.close(); }),
                                        js::Callback<void(js::Error)>([&](js::Error error) {
                                            failure = js::error_message(error);
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
