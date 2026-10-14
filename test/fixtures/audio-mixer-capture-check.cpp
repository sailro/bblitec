// The lowered audio library's mixer surface (test/audio-mixer.test.ts writes
// it) over the real LabSound PAL, rendered offline between its calls: a
// looped constant-level WAVE sound routed through two nested buses, each
// bus's volume set and ramped, then a bus disposed. Prints one line per
// step: the left and right channel peaks once settled.

#include "pal_audio_labsound.cpp"
#include "labsound-fixture.hpp"

#include "../../artifacts/audio-mixer-capture/library.hpp"

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
const char* bbl::pal::bblite_build_stamp() { return "audio-mixer-capture-check"; }

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

js::Promise<js::PromiseVoid> run(std::string wav, std::vector<std::string>& lines) {
    AudioEngineOptions engine_options{};
    engine_options.audio_context = pal::audio_create_context();
    const auto engine = co_await create_audio_engine_async(engine_options);
    const auto context = engine.context;
    const std::array<pal::PackagedFetchEntry, 1> responses{
        {{"/sounds/tone.wav", "http://localhost/sounds/tone.wav", wav}}};
    pal::register_packaged_responses("http://localhost/", fixture_path, responses);

    // music (0.5) <- effects (0.5) <- the sound: a quarter of its level.
    AudioBusOptions music_options{};
    music_options.volume = 0.5;
    const auto music = co_await create_audio_bus_async(engine, "music", music_options);
    AudioBusOptions effects_options{};
    effects_options.volume = 0.5;
    effects_options.out_bus = music;
    const auto effects = co_await create_audio_bus_async(engine, "effects", effects_options);
    lines.push_back("buses " + std::to_string(engine.buses.size()) + " " + music->name + " " +
                    effects->name);

    StaticSoundOptions options{};
    options.loop = true;
    options.out_bus = effects;
    const auto sound =
        co_await create_sound_async(engine, std::string("/sounds/tone.wav"), options);
    play_sound(sound);
    lines.push_back("nested" + render(context, 4800, 2400));

    RampOptions instant{};
    instant.shape = std::string("none");
    set_bus_volume(music, 1.0, instant);
    lines.push_back("music" + render(context, 4800, 2400));

    // Down to silence over 0.1 s on the inner bus.
    RampOptions fade{};
    fade.duration = 0.1;
    set_bus_volume(effects, 0.0, fade);
    lines.push_back("faded" + render(context, 9600, 2400));
    set_bus_volume(effects, 1.0, instant);
    lines.push_back("restored" + render(context, 4800, 2400));

    // The inner bus's sub-graph disconnects: nothing reaches the output.
    dispose_audio_bus(effects);
    lines.push_back("disposed " + std::to_string(engine.buses.size()) +
                    render(context, 4800, 2400));
    dispose_sound(sound);
    dispose_audio_bus(music);
    co_return js::PromiseVoid{};
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 2)
        return 2;
    _putenv_s("BBLITE_AUDIO_CAPTURE", "audio-mixer-capture-unused.wav");
    std::vector<std::string> lines;
    std::string failure;
    {
        const js::RealmScope realm;
        pal::EventLoop loop;
        loop.run([&] {
            static_cast<void>(run(argv[1], lines)
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
