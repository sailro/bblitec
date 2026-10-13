// HTMLAudioElement playback over the real LabSound PAL, rendered offline
// between its calls (test/media-element-audio.test.ts runs it): an unrouted
// element plays to its session's default output and moves into the graph
// when routed; a packaged ramp (sample value = position in seconds) plays,
// pauses, resumes, seeks, ends and loops through createMediaElementSource;
// two constant elements then crossfade through their gains, the
// application's shape. Prints one line per step.

#include "pal_audio_labsound.cpp"

#include <bblite/pal_event_loop.hpp>
#include <bblite/pal_packaged_responses.hpp>

#include <cmath>
#include <cstdlib>
#include <iostream>
#include <map>
#include <string>
#include <vector>

using namespace bbl;

// pal.cpp's clock reports a build's stamp; a fixture has none of its own.
const char* bbl::pal::bblite_build_stamp() { return "media-element-capture-check"; }

namespace {

constexpr int rate = 48000;

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

std::string fixed(double value) {
    char text[32];
    std::snprintf(text, sizeof text, "%.3f", value);
    return text;
}

js::Promise<js::PromiseVoid> sleep(double milliseconds) {
    js::Promise<js::PromiseVoid> promise;
    pal::EventLoop::current().set_timeout([promise] { promise.resolve(js::PromiseVoid{}); },
                                          milliseconds);
    return promise;
}

js::Promise<js::PromiseVoid> run(std::vector<std::string> files, std::vector<std::string>& lines,
                                 std::map<std::string, int>& counted) {
    const auto context = pal::audio_create_context();
    const auto master = pal::audio_create_gain(context);
    pal::audio_connect(master, pal::audio_destination(context));
    pal::register_packaged_responses(
        "http://localhost/",
        {{"/beds/ramp.wav", files[0]}, {"/beds/high.wav", files[1]}, {"/beds/low.wav", files[2]}});
    std::shared_ptr<pal::AudioSession> session;
    std::size_t identity = 100;
    const auto count = [&](const pal::AudioElement& element, const std::string& prefix) {
        for (const auto& [type, name] :
             {std::pair{pal::AudioElementEvent::TimeUpdate, "timeupdate"},
              std::pair{pal::AudioElementEvent::Ended, "ended"},
              std::pair{pal::AudioElementEvent::Play, "play"},
              std::pair{pal::AudioElementEvent::Pause, "pause"}}) {
            const std::string key = prefix + name;
            pal::audio_element_add_listener(
                element, type, ++identity,
                js::Callback<void()>([&counted, key] { ++counted[key]; }), false, false);
        }
    };

    // An unrouted element plays to its session's default output; routing it
    // moves playback, from the same position, into the graph.
    const auto direct = pal::audio_create_element(session, std::string("/beds/high.wav"));
    co_await pal::audio_element_play(direct);
    const auto output = direct->playback->context;
    const auto heard = render(output, rate / 10);
    pal::audio_connect(pal::audio_create_media_element_source(context, direct), master);
    const auto left = render(output, rate / 10);
    const auto moved = render(context, rate / 10);
    lines.push_back("direct " + fixed(heard.back()) + " " + fixed(peak(left, 0, left.size())) +
                    " " + fixed(moved.back()) + " " +
                    fixed(pal::audio_element_current_time(direct)));
    pal::audio_element_pause(direct);
    co_await sleep(0.0);

    // The ramp: routed through its own gain, as the application routes a bed.
    const auto ramp = pal::audio_create_element(session, std::string("/beds/ramp.wav"));
    count(ramp, "ramp.");
    const auto ramp_gain = pal::audio_create_gain(context);
    pal::audio_connect(pal::audio_create_media_element_source(context, ramp), ramp_gain);
    pal::audio_connect(ramp_gain, master);
    lines.push_back("before " + std::string(std::isnan(pal::audio_element_duration(ramp))
                                                ? "nan"
                                                : fixed(pal::audio_element_duration(ramp))));
    co_await pal::audio_element_play(ramp);
    lines.push_back("played " + fixed(pal::audio_element_duration(ramp)));

    const auto playing = render(context, rate / 4);
    lines.push_back("playing " + fixed(playing.back()) + " " +
                    fixed(pal::audio_element_current_time(ramp)));

    pal::audio_element_pause(ramp);
    const auto paused = render(context, rate / 10);
    lines.push_back("paused " + fixed(peak(paused, 0, paused.size())) + " " +
                    fixed(pal::audio_element_current_time(ramp)));

    co_await pal::audio_element_play(ramp);
    const auto resumed = render(context, rate / 20);
    lines.push_back("resumed " + fixed(resumed.front()));

    pal::audio_element_set_current_time(ramp, 0.75);
    const auto seeked = render(context, rate / 20);
    lines.push_back("seeked " + fixed(seeked.front()) + " " +
                    fixed(pal::audio_element_current_time(ramp)));

    // Past the end: silence, then the element's tick runs the ended steps.
    const auto ending = render(context, rate * 3 / 10);
    co_await sleep(300.0);
    lines.push_back("ended " + fixed(peak(ending, rate / 4, ending.size())) + " " +
                    std::to_string(pal::audio_element_paused(ramp)) +
                    std::to_string(pal::audio_element_ended(ramp)) + " " +
                    fixed(pal::audio_element_current_time(ramp)));

    // Looping: play() after the end restarts at zero and wraps at the end.
    pal::audio_element_set_loop(ramp, true);
    co_await pal::audio_element_play(ramp);
    const auto looped = render(context, rate * 6 / 5);
    co_await sleep(300.0);
    lines.push_back("looped " + fixed(looped.back()) + " " +
                    fixed(pal::audio_element_current_time(ramp)) + " " +
                    std::to_string(pal::audio_element_ended(ramp)));
    pal::audio_element_pause(ramp);
    co_await sleep(0.0);

    // A crossfade between two elements through their gains.
    const auto high = pal::audio_create_element(session, std::string("/beds/high.wav"));
    const auto low = pal::audio_create_element(session, std::string("/beds/low.wav"));
    const auto high_gain = pal::audio_create_gain(context);
    const auto low_gain = pal::audio_create_gain(context);
    pal::audio_connect(pal::audio_create_media_element_source(context, high), high_gain);
    pal::audio_connect(pal::audio_create_media_element_source(context, low), low_gain);
    pal::audio_connect(high_gain, master);
    pal::audio_connect(low_gain, master);
    co_await pal::audio_element_play(high);
    const auto alone = render(context, rate / 10);
    const pal::AudioParamHandle fade_out{high_gain, pal::AudioParamName::Gain};
    const pal::AudioParamHandle fade_in{low_gain, pal::AudioParamName::Gain};
    pal::audio_param_set_value(fade_in, 0.0f);
    co_await pal::audio_element_play(low);
    const double now = pal::audio_current_time(context);
    pal::audio_param_set_value_at_time(fade_out, 1.0f, now);
    pal::audio_param_linear_ramp(fade_out, 0.0f, now + 0.2);
    pal::audio_param_set_value_at_time(fade_in, 0.0f, now);
    pal::audio_param_linear_ramp(fade_in, 1.0f, now + 0.2);
    const auto fading = render(context, rate / 5);
    const auto after = render(context, rate / 10);
    lines.push_back("crossfade " + fixed(alone.back()) + " " + fixed(fading.front()) + " " +
                    fixed(fading[fading.size() / 2]) + " " + fixed(after.back()));

    // Releasing the outgoing element: pause, drop the source, load.
    pal::audio_element_pause(high);
    pal::audio_element_remove_source(high);
    pal::audio_element_load(high);
    const auto released = render(context, rate / 10);
    lines.push_back("released " + fixed(released.back()) + " " +
                    std::string(std::isnan(pal::audio_element_duration(high)) ? "nan" : "known") +
                    " " + std::to_string(pal::audio_element_paused(high)));
    pal::audio_element_pause(low);
    co_await sleep(0.0);
    co_return js::PromiseVoid{};
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 4)
        return 2;
    _putenv_s("BBLITE_AUDIO_CAPTURE", "media-element-capture-unused.wav");
    std::vector<std::string> lines;
    std::map<std::string, int> counted;
    std::string failure;
    {
        const js::RealmScope realm;
        pal::EventLoop loop;
        loop.run([&] {
            static_cast<void>(run({argv[1], argv[2], argv[3]}, lines, counted)
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
    std::cout << "events";
    for (const auto& [name, value] : counted)
        std::cout << " " << name << "=" << value;
    std::cout << "\n";
    if (!failure.empty()) {
        std::cout << "failed " << failure << "\n";
        return 1;
    }
    return 0;
}
