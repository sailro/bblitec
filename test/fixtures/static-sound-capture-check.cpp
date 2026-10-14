// The lowered audio library (test/static-sounds.test.ts writes it) over the
// real LabSound PAL, rendered offline between its calls: the pin's engine is
// created, a packaged WAVE sound is created, played, ramped down and
// restored, the master volume ramped down and restored, and the sound
// stopped and disposed; each step's PCM is measured. Prints one line per
// step.

#include "pal_audio_labsound.cpp"
#include "labsound-fixture.hpp"

#include "../../artifacts/static-sound-capture/library.hpp"

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
const char* bbl::pal::bblite_build_stamp() { return "static-sound-capture-check"; }

namespace {

/** Render `frames` more frames offline; the last `frames` samples of channel 0. */
std::vector<float> render(pal::AudioContextHandle context, int frames) {
    const auto pcm = labsound_fixture::render(context, frames);
    const auto recorded = labsound_fixture::samples(*pcm);
    return {recorded.end() - frames, recorded.end()};
}

using labsound_fixture::fixed;
using labsound_fixture::peak;

/** A fixture packages its files where they are. */
std::string fixture_path(const std::string& path) { return path; }

js::Promise<js::PromiseVoid> run(std::string wav, std::vector<std::string>& lines) {
    // The pin's own engine, on a context the call site opened.
    AudioEngineOptions engine_options{};
    engine_options.audio_context = pal::audio_create_context();
    const auto engine = co_await create_audio_engine_async(engine_options);
    const auto context = engine.context;
    lines.push_back("engine " + fixed(static_cast<float>(get_master_volume(engine))) + " " +
                    fixed(static_cast<float>(engine.ramp_duration)));
    const std::array<pal::PackagedFetchEntry, 1> responses{
        {{"/sounds/tone.wav", "http://localhost/sounds/tone.wav", wav}}};
    pal::register_packaged_responses("http://localhost/", fixture_path, responses);
    StaticSoundOptions options{};
    options.volume = 1.0;
    const auto sound =
        co_await create_sound_async(engine, std::string("/sounds/tone.wav"), options);
    lines.push_back("created " + std::to_string(engine.sources.size()));

    play_sound(sound);
    const auto playing = render(context, 4800);
    lines.push_back("playing " + fixed(peak(playing, 2400, 4800)));

    // Down to silence over 0.1 s (4800 frames): a linear ramp.
    RampOptions ramp{};
    ramp.duration = 0.1;
    set_sound_volume(sound, 0.0, ramp);
    const auto ramping = render(context, 4800);
    lines.push_back("ramp " + fixed(peak(ramping, 0, 240)) + " " +
                    fixed(peak(ramping, 2280, 2520)) + " " + fixed(peak(ramping, 4680, 4800)));

    RampOptions instant{};
    instant.shape = std::string("none");
    set_sound_volume(sound, 1.0, instant);
    const auto restored = render(context, 2400);
    lines.push_back("restored " + fixed(peak(restored, 1200, 2400)));

    // The master volume down to silence over 0.1 s: the main output's ramp.
    RampOptions fade{};
    fade.duration = 0.1;
    set_master_volume(engine, 0.0, fade);
    const auto fading = render(context, 4800);
    lines.push_back("master " + fixed(peak(fading, 0, 240)) + " " +
                    fixed(peak(fading, 2280, 2520)) + " " + fixed(peak(fading, 4680, 4800)) + " " +
                    fixed(static_cast<float>(get_master_volume(engine))));
    set_master_volume(engine, 1.0, instant);
    const auto unmuted = render(context, 2400);
    lines.push_back("unmuted " + fixed(peak(unmuted, 1200, 2400)));

    stop_sound(sound);
    const auto stopped = render(context, 4800);
    lines.push_back("stopped " + fixed(peak(stopped, 2400, 4800)));

    dispose_sound(sound);
    lines.push_back("disposed " + std::to_string(engine.sources.size()));
    co_return js::PromiseVoid{};
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 2)
        return 2;
    _putenv_s("BBLITE_AUDIO_CAPTURE", "static-sound-capture-unused.wav");
    std::vector<std::string> lines;
    std::string failure;
    {
        const js::RealmScope realm;
        pal::EventLoop loop;
        loop.run([&] {
            static_cast<void>(run(argv[1], lines)
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
