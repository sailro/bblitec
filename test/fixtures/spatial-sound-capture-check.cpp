// The lowered spatial static-sound library (test/spatial-sounds.test.ts
// writes it) over the real LabSound PAL, rendered offline between its calls:
// a constant-level WAVE sound is made spatial with the linear distance model
// (full within 6, silent from 42), then moved around a listener. Prints one
// line per placement: the left and right channel peaks once settled.

#include "pal_audio_labsound.cpp"

#include "../../artifacts/spatial-sound-capture/library.hpp"

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
const char* bbl::pal::bblite_build_stamp() { return "spatial-sound-capture-check"; }

namespace {

/** Render `frames` more frames offline; the peak of each channel over the last `measured`. */
std::string render(pal::AudioContextHandle context, int frames, int measured) {
    auto& record = pal::require_context(context.value);
    auto scratch = std::make_shared<lab::AudioBus>(2, lab::AudioNode::ProcessingSizeInFrames);
    record.destination->offlineRender(scratch.get(), frames);
    const auto pcm = record.recorder->createBusFromRecording(false);
    std::string line;
    for (int channel = 0; channel < 2; ++channel) {
        const auto* samples = pcm->channel(channel)->data();
        float peak = 0.0f;
        for (int index = pcm->length() - measured; index < pcm->length(); ++index)
            peak = std::max(peak, std::abs(samples[index]));
        char text[32];
        std::snprintf(text, sizeof text, " %.3f", static_cast<double>(peak));
        line += text;
    }
    return line;
}

/** A fixture packages its files where they are. */
std::string fixture_path(const std::string& path) { return path; }

js::Promise<js::PromiseVoid> run(std::string wav, std::vector<std::string>& lines) {
    // The pin's own engine, on a context the call site opened.
    AudioEngineOptions engine_options{};
    engine_options.audio_context = pal::audio_create_context();
    const auto engine = co_await create_audio_engine_async(engine_options);
    const auto context = engine.context;
    const std::array<pal::PackagedFetchEntry, 1> responses{
        {{"/sounds/tone.wav", "http://localhost/sounds/tone.wav", wav}}};
    pal::register_packaged_responses("http://localhost/", fixture_path, responses);
    StaticSoundOptions options{};
    options.loop = true;
    const auto sound =
        co_await create_sound_async(engine, std::string("/sounds/tone.wav"), options);

    // The application's options: linear roll-off from 6 to 42.
    SpatialSoundOptions spatial{};
    spatial.distance_model = std::string("linear");
    spatial.min_distance = 6.0;
    spatial.max_distance = 42.0;
    enable_spatial(sound, spatial);
    play_sound(sound);

    // Each placement: the listener, then the source, then 0.4 s of sound, measured
    // over its last 0.1 s -- once the panner's gains have settled (they approach a
    // new placement with a 50 ms time constant).
    const auto place = [&](const char* name, Vec3d listener, Vec3d source) {
        set_spatial_listener_position(engine, listener);
        set_spatial_position(sound, source);
        lines.push_back(name + render(context, 19200, 4800));
    };
    place("right", {0, 0, 0}, {3, 0, 0});
    place("left", {0, 0, 0}, {-3, 0, 0});
    place("front", {0, 0, 0}, {0, 0, -3});
    // Halfway through the roll-off: half the gain.
    place("half", {0, 0, 0}, {0, 0, -24});
    place("beyond", {0, 0, 0}, {0, 0, -50});
    // Relative to the listener: the source on the listener's right again.
    place("moved", {20, 0, 0}, {23, 0, 0});

    dispose_sound(sound);
    co_return js::PromiseVoid{};
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 2)
        return 2;
    _putenv_s("BBLITE_AUDIO_CAPTURE", "spatial-sound-capture-unused.wav");
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
