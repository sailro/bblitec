// The lowered audio library's mixer surface (test/audio-mixer.test.ts writes
// it) over the real LabSound PAL, rendered offline between its calls: a
// looped constant-level WAVE sound routed through two nested buses, each
// bus's volume set and ramped, then a bus disposed; sound buffers decoded
// from URL lists and played; an analyser's readouts of a sine; caller-built
// nodes as sound sources; a last sound panned across the stereo field
// (LabSound up-mixes a later mono input to the left channel only once a
// stereo source has left the main bus, so mono measurements come first).
// Prints one line per step: the left and right channel peaks once settled.

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

js::Promise<js::PromiseVoid> run(std::string wav, std::string broken, std::string sine_wav,
                                 std::vector<std::string>& lines) {
    AudioEngineOptions engine_options{};
    engine_options.audio_context = pal::audio_create_context();
    const auto engine = co_await create_audio_engine_async(engine_options);
    const auto context = engine.context;
    const std::array<pal::PackagedFetchEntry, 3> responses{
        {{"/sounds/tone.wav", "http://localhost/sounds/tone.wav", wav},
         {"/sounds/broken.wav", "http://localhost/sounds/broken.wav", broken},
         {"/sounds/sine.wav", "http://localhost/sounds/sine.wav", sine_wav}}};
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
    lines.push_back("remaining " + std::to_string(engine.buses.size()));
    lines.push_back("disposed" + render(context, 4800, 2400));
    dispose_sound(sound);
    dispose_audio_bus(music);

    // A sound buffer from a URL list: the codec check skips an extension no
    // linked decoder reads, and the first decodable URL wins.
    const auto buffer = co_await create_sound_buffer_async(
        engine, js::Array<std::string>{"/sounds/tone.xyz", "/sounds/tone.wav"},
        SoundBufferOptions{});
    lines.push_back("buffer " + fixed(buffer->get_duration()) + " " +
                    std::to_string(static_cast<int>(buffer->get_sample_rate())) + " " +
                    std::to_string(static_cast<int>(buffer->get_channel_count())) + " " +
                    std::to_string(static_cast<int>(buffer->get_length())));
    // Without the check, an undecodable file marks its format invalid and
    // the next URL is tried.
    SoundBufferOptions unchecked{};
    unchecked.skip_codec_check = true;
    const auto recovered = co_await create_sound_buffer_async(
        engine, js::Array<std::string>{"/sounds/broken.wav", "/sounds/tone.wav"}, unchecked);
    lines.push_back("recovered " + fixed(recovered->get_duration()) + " " +
                    std::to_string(engine.invalid_formats.has("wav")));
    // A sound over the buffer plays it; a sound passed its own buffer shares it.
    StaticSoundOptions buffered_options{};
    buffered_options.loop = true;
    const auto buffered = co_await create_sound_async(engine, buffer, buffered_options);
    play_sound(buffered);
    lines.push_back("buffered" + render(context, 4800, 2400));
    lines.push_back("shared " + std::to_string(static_cast<int>(buffered->get_buffer() == buffer)));
    dispose_sound(buffered);

    // An analyser on a 1500 Hz sine: bin 64 of a 2048-point FFT at 48 kHz.
    StaticSoundOptions sine_options{};
    sine_options.loop = true;
    const auto sine =
        co_await create_sound_async(engine, std::string("/sounds/sine.wav"), sine_options);
    enable_analyzer(sine);
    const auto analyser = std::static_pointer_cast<AnalyzerSubNode>(sine->graph->analyzer)->node;
    const auto attributes = [&] {
        std::string line;
        for (const auto property :
             {pal::AnalyserProperty::MinDecibels, pal::AnalyserProperty::MaxDecibels,
              pal::AnalyserProperty::SmoothingTimeConstant, pal::AnalyserProperty::FftSize,
              pal::AnalyserProperty::FrequencyBinCount})
            line += " " + fixed(pal::audio_analyser_property(analyser, property));
        return line;
    };
    lines.push_back("analyser" + attributes());
    play_sound(sine);
    static_cast<void>(render(context, 9600, 2400));
    js::TypedArray<std::uint8_t> bins(1024);
    get_byte_frequency_data(sine, bins);
    std::size_t loudest = 0;
    for (std::size_t index = 1; index < bins.size(); ++index)
        if (bins.load(index) > bins.load(loudest))
            loudest = index;
    js::F32Array decibels(1024);
    get_float_frequency_data(sine, decibels);
    std::size_t strongest = 0;
    for (std::size_t index = 1; index < decibels.size(); ++index)
        if (decibels.load(index) > decibels.load(strongest))
            strongest = index;
    lines.push_back("spectrum " + std::to_string(loudest) + " " + std::to_string(strongest));
    js::F32Array waveform(2048);
    get_float_time_domain_data(sine, waveform);
    float top = 0.0f;
    for (std::size_t index = 0; index < waveform.size(); ++index)
        top = std::max(top, std::abs(waveform.load(index)));
    js::TypedArray<std::uint8_t> levels(2048);
    get_byte_time_domain_data(sine, levels);
    std::uint8_t lowest = 255;
    std::uint8_t highest = 0;
    for (std::size_t index = 0; index < levels.size(); ++index) {
        lowest = std::min(lowest, levels.load(index));
        highest = std::max(highest, levels.load(index));
    }
    lines.push_back("waveform " + fixed(top) + " " + std::to_string(lowest) + " " +
                    std::to_string(highest));
    // Reconfigured: a smaller FFT keeps the smoothing; the range is written whole.
    AudioAnalyzerOptions reconfigured{};
    reconfigured.fft_size = 1024.0;
    reconfigured.min_decibels = -90.0;
    reconfigured.max_decibels = -10.0;
    reconfigured.smoothing = 0.5;
    enable_analyzer(sine, reconfigured);
    lines.push_back("reconfigured" + attributes());
    lines.push_back("refused " + labsound_fixture::thrown([&] {
                        pal::audio_set_analyser_property(analyser, pal::AnalyserProperty::FftSize,
                                                         1000.0);
                    }));
    dispose_sound(sine);

    // A caller-built node as a sound source: its options' volume and name,
    // re-volumed, then disposed.
    RampOptions immediate{};
    immediate.shape = std::string("none");
    const auto constant = labsound_fixture::constant_source(context, 0.5f, 48000 * 4);
    pal::audio_node_start(constant, 0.0);
    SoundSourceOptions source_options{};
    source_options.volume = 0.5;
    source_options.name = std::string("input");
    const auto source = co_await create_sound_source_async(engine, constant, source_options);
    lines.push_back("source " + source->name + " " + std::to_string(engine.sources.size()) +
                    render(context, 4800, 2400));
    set_sound_source_volume(source, 1.0, immediate);
    lines.push_back("source-volume" + render(context, 4800, 2400));
    dispose_sound_source(source);
    lines.push_back("source-disposed " + std::to_string(engine.sources.size()) +
                    render(context, 4800, 2400));
    // Without the default bus, a source is silent until routed.
    const auto unrouted_node = labsound_fixture::constant_source(context, 0.5f, 48000 * 4);
    pal::audio_node_start(unrouted_node, 0.0);
    SoundSourceOptions unrouted_options{};
    unrouted_options.out_bus_auto_default = false;
    const auto unrouted =
        co_await create_sound_source_async(engine, unrouted_node, unrouted_options);
    lines.push_back("unrouted" + render(context, 4800, 2400));
    dispose_sound_source(unrouted);
    // A stream source's disposal stops its stream's tracks.
    const auto stream =
        pal::audio_destination_stream(pal::audio_create_media_stream_destination(context));
    const auto streamed = co_await create_sound_source_async(
        engine, pal::audio_create_media_stream_source(context, stream), SoundSourceOptions{});
    const auto track = pal::media_stream_tracks(stream, "")[0];
    lines.push_back("stream " + pal::media_stream_track_ready_state(track));
    dispose_sound_source(streamed);
    lines.push_back("stream-disposed " + pal::media_stream_track_ready_state(track));

    // A sound on the main bus, panned: equal-power stereo panning of mono,
    // measured once LabSound's de-zippered pan settles.
    StaticSoundOptions panned_options{};
    panned_options.loop = true;
    const auto panned =
        co_await create_sound_async(engine, std::string("/sounds/tone.wav"), panned_options);
    StereoSoundOptions stereo{};
    stereo.pan = 1.0;
    enable_stereo(panned, stereo);
    play_sound(panned);
    lines.push_back("pan-right" + render(context, 19200, 4800));
    set_stereo_pan(panned, -1.0, instant);
    lines.push_back("pan-left" + render(context, 19200, 4800));
    set_stereo_pan(panned, 0.0, instant);
    lines.push_back("pan-centre" + render(context, 19200, 4800));
    dispose_sound(panned);

    co_return js::PromiseVoid{};
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 4)
        return 2;
    _putenv_s("BBLITE_AUDIO_CAPTURE", "audio-mixer-capture-unused.wav");
    std::vector<std::string> lines;
    std::string failure;
    {
        const js::RealmScope realm;
        pal::EventLoop loop;
        loop.run([&] {
            static_cast<void>(run(argv[1], argv[2], argv[3], lines)
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
