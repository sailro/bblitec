// The lowered static-sound library (test/static-sounds.test.ts writes it)
// over the real LabSound PAL, rendered offline between its calls: a packaged
// WAVE sound is created, played, ramped down, restored, stopped and
// disposed, and each step's PCM is measured. Prints one line per step.

#include "pal_audio_labsound.cpp"

#include "../../artifacts/static-sound-capture/library.hpp"

#include <bblite/pal_event_loop.hpp>
#include <bblite/pal_packaged_responses.hpp>

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
    auto& record = pal::require_context(context.value);
    auto scratch = std::make_shared<lab::AudioBus>(2, lab::AudioNode::ProcessingSizeInFrames);
    record.destination->offlineRender(scratch.get(), frames);
    const auto pcm = record.recorder->createBusFromRecording(false);
    const auto* samples = pcm->channel(0)->data();
    return std::vector<float>(samples + (pcm->length() - frames), samples + pcm->length());
}

float peak(const std::vector<float>& samples, std::size_t first, std::size_t last) {
    float value = 0.0f;
    for (std::size_t index = first; index < last; ++index)
        value = std::max(value, std::abs(samples[index]));
    return value;
}

std::string fixed(float value) {
    char text[32];
    std::snprintf(text, sizeof text, "%.3f", static_cast<double>(value));
    return text;
}

js::Promise<js::PromiseVoid> run(std::string wav, std::vector<std::string>& lines) {
    // The engine `createAudioEngineAsync` builds: main out and main bus.
    const auto context = pal::audio_create_context();
    const auto out = pal::audio_create_gain(context);
    pal::audio_connect(out, pal::audio_destination(context));
    const auto bus = pal::audio_create_gain(context);
    pal::audio_connect(bus, out);
    AudioEngineHandle engine{context, bus, out};
    pal::register_packaged_responses("http://localhost/", {{"/sounds/tone.wav", wav}});
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
