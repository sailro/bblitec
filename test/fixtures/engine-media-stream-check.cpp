// The lowered engine media-stream tap (test/spatial-sounds.test.ts writes the
// library) over the real LabSound PAL: a looped constant-level sound plays
// through an engine whose master output is at half, the tap's stream feeds a
// second context, and both renders are measured. Prints one line per step.

#include "pal_audio_labsound.cpp"
#include "labsound-fixture.hpp"

#include "../../artifacts/engine-media-stream-capture/library.hpp"

#include <bblite/pal_event_loop.hpp>
#include <bblite/pal_packaged_responses.hpp>

#include <cmath>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

using namespace bbl;

// pal.cpp's clock reports a build's stamp; a fixture has none of its own.
const char* bbl::pal::bblite_build_stamp() { return "engine-media-stream-check"; }

namespace {

/** Render `frames` more frames offline; the peak of channel 0 over their second half. */
std::string render(pal::AudioContextHandle context, int frames) {
    const auto recorded = labsound_fixture::samples(*labsound_fixture::render(context, frames));
    return labsound_fixture::fixed(
        labsound_fixture::peak(recorded, recorded.size() - frames / 2, recorded.size()));
}

js::Promise<js::PromiseVoid> run(std::string wav, std::vector<std::string>& lines) {
    // The engine `createAudioEngineAsync` builds, its master output at half.
    const auto context = pal::audio_create_context();
    const auto out = pal::audio_create_gain(context);
    pal::audio_connect(out, pal::audio_destination(context));
    const auto bus = pal::audio_create_gain(context);
    pal::audio_connect(bus, out);
    pal::audio_param_set_value(pal::audio_node_param(out, pal::AudioParamName::Gain), 0.5f);
    AudioEngineHandle engine{context, bus, out};

    const auto tap = create_audio_engine_media_stream(engine);
    lines.push_back("tracks " +
                    std::to_string(pal::media_stream_tracks(tap->stream, "audio").size()) +
                    " disposers " + std::to_string(engine.disposers.size()));

    pal::register_packaged_responses("http://localhost/", {{"/sounds/tone.wav", wav}});
    StaticSoundOptions options{};
    options.loop = true;
    const auto sound =
        co_await create_sound_async(engine, std::string("/sounds/tone.wav"), options);
    play_sound(sound);

    // A second context reads the tap's stream, after the engine's own render.
    const auto mixer = pal::audio_create_context();
    const auto input = pal::audio_create_media_stream_source(mixer, tap->stream);
    pal::audio_connect(input, pal::audio_destination(mixer));
    lines.push_back("engine " + render(context, 4800));
    lines.push_back("stream " + render(mixer, 4800));

    dispose_audio_engine_media_stream(tap);
    const auto track = pal::media_stream_tracks(tap->stream, "audio")[0];
    lines.push_back("disposed " + std::to_string(engine.disposers.size()) + " " +
                    pal::media_stream_track_ready_state(track));
    dispose_sound(sound);
    co_return js::PromiseVoid{};
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 2)
        return 2;
    _putenv_s("BBLITE_AUDIO_CAPTURE", "engine-media-stream-unused.wav");
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
