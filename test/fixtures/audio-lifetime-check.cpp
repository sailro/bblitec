#include "pal_audio_labsound.cpp"
#include "pal_window.hpp"

#include <cassert>
#include <iostream>

namespace bbl::pal {
std::string environment_variable(const char* name) {
    char* value = nullptr;
    std::size_t length = 0;
    _dupenv_s(&value, &length, name);
    const std::string result = value ? value : "";
    std::free(value);
    return result;
}
}

using namespace bbl::pal;

static std::unique_ptr<lab::AudioBus> render(AudioContextHandle handle, int frames) {
    auto& record = require_context(handle.value);
    auto scratch = std::make_shared<lab::AudioBus>(2, lab::AudioNode::ProcessingSizeInFrames);
    record.destination->offlineRender(scratch.get(), frames);
    return record.recorder->createBusFromRecording(false);
}

static void check_session_isolation() {
    // Finishing one engine preserves another's contexts and SDL audio device.
    _putenv_s("BBLITE_AUDIO_CAPTURE", "");
    const SDL_InitFlags external_audio = SDL_WasInit(SDL_INIT_AUDIO);
    std::shared_ptr<AudioSession> first_session;
    std::shared_ptr<AudioSession> second_session;
    const auto first_context = audio_create_context(first_session);
    const auto second_context = audio_create_context(second_session);
    std::weak_ptr<detail::AudioDeviceSdl3> first_device =
        require_context(first_context.value).device;
    std::weak_ptr<detail::AudioDeviceSdl3> second_device =
        require_context(second_context.value).device;
    {
        SdlWindowRun run;
        assert(initialize_run_sdl(SDL_INIT_EVENTS));
        first_session->finish();
    }
    assert(!contexts().contains(first_context.value));
    assert(first_device.expired());
    assert(audio_destination(second_context).ownership);
    assert(require_context(second_context.value).device->isRunning());
    assert(SDL_WasInit(SDL_INIT_AUDIO));
    second_session.reset();
    assert(!contexts().contains(second_context.value));
    assert(second_device.expired());
    assert(SDL_WasInit(SDL_INIT_AUDIO) == external_audio);
}

int main() {
    if (!environment_variable("BBLITE_TEST_REALTIME").empty()) {
        assert(!SDL_WasInit(SDL_INIT_AUDIO));
        check_session_isolation();
        // A separately held SDL initialization survives both device owners;
        // releasing it then shuts audio down, proving neither device leaked a ref.
        assert(SDL_InitSubSystem(SDL_INIT_AUDIO));
        check_session_isolation();
        assert(SDL_WasInit(SDL_INIT_AUDIO));
        SDL_QuitSubSystem(SDL_INIT_AUDIO);
        assert(!SDL_WasInit(SDL_INIT_AUDIO));
        _putenv_s("BBLITE_AUDIO_CAPTURE", "");
        const auto context = audio_create_context();
        const auto destination = audio_destination(context);
        std::weak_ptr<lab::AudioNode> last;
        for (int iteration = 0; iteration < 100; ++iteration) {
            const double when = audio_current_time(context);
            {
                const auto source = audio_create_oscillator(context);
                const auto gain = audio_create_gain(context);
                last = require_node(source);
                audio_connect(source, gain);
                audio_connect(gain, destination);
                audio_node_start(source, when);
                audio_node_stop(source, when + 0.003);
            }
            SDL_Delay(3);
        }
        for (int attempt = 0; attempt < 100 && !last.expired(); ++attempt) {
            SDL_Delay(10);
            audio_collect_finished();
        }
        if (!last.expired()) {
            auto& record = require_context(context.value);
            lab::ContextRenderLock lock(record.context.get(), "fixture retirement diagnosis");
            std::cerr << "time=" << record.context->currentTime() << " graph=" << record.graph.size() << '\n';
            for (const auto& [identity, entry] : record.graph) {
                if (!entry.source) continue;
                auto source = std::dynamic_pointer_cast<lab::AudioScheduledSourceNode>(entry.node);
                std::cerr << identity << " completed=" << entry.source->completed
                          << " started=" << entry.source->started << " state=" << static_cast<int>(source->playbackState()) << '\n';
            }
        }
        assert(last.expired());
        assert(require_context(context.value).graph.size() == 1);
        audio_close_context(context);
        assert(!SDL_WasInit(SDL_INIT_AUDIO));
        std::cout << "audio-lifetime-check: ok (realtime)\n";
        return 0;
    }
    _putenv_s("BBLITE_AUDIO_CAPTURE", "fixture-unused.wav");
    const auto context = audio_create_context();
    const auto other = audio_create_context();
    const auto destination = audio_destination(context);
    const auto retained = audio_create_oscillator(context);
    audio_node_start(retained, 0.0);
    audio_node_stop(retained, 0.001);
    bool repeated_start_rejected = false;
    try { audio_node_start(retained, 0.0); }
    catch (const std::runtime_error&) { repeated_start_rejected = true; }
    assert(repeated_start_rejected);

    std::weak_ptr<lab::AudioNode> discarded_source;
    std::weak_ptr<lab::AudioNode> discarded_gain;
    std::weak_ptr<AudioBufferRecord> discarded_buffer;
    for (int iteration = 0; iteration < 1000; ++iteration) {
        const double when = audio_current_time(context);
        {
            const auto source = audio_create_buffer_source(context);
            const auto gain = audio_create_gain(context);
            const auto buffer = audio_create_buffer(context, 1, 64, 48000.0);
            auto channel = audio_buffer_channel(buffer, 0);
            std::fill(channel.begin(), channel.end(), 0.25f);
            discarded_source = require_node(source);
            discarded_gain = require_node(gain);
            discarded_buffer = buffer.ownership;
            audio_set_buffer(source, buffer);
            audio_connect(source, gain);
            audio_connect(gain, destination);
            audio_node_start(source, when);
        }
        collect_audio_graph(require_context(context.value));
        assert(!discarded_source.expired());
        assert(!discarded_buffer.expired());
        auto pcm = render(context, 256);
        assert(pcm && measure(*pcm).peak > 0.1f);
        collect_audio_graph(require_context(context.value));
        assert(discarded_source.expired());
        assert(discarded_gain.expired());
        assert(discarded_buffer.expired());
        assert(require_context(context.value).graph.size() == 2);
        assert(require_node(retained));
        assert(audio_destination(other).ownership);
    }
    assert(require_context(context.value).nodes.capacity() <= 4);
    assert(require_context(context.value).buffers.capacity() == 1);

    // Keep a completed source connected while both downstream filters drain.
    std::weak_ptr<lab::AudioNode> first_filter;
    std::weak_ptr<lab::AudioNode> second_filter;
    {
        const auto source = audio_create_buffer_source(context);
        const auto first = audio_create_biquad_filter(context);
        const auto second = audio_create_biquad_filter(context);
        const auto buffer = audio_create_buffer(context, 1, 64, 48000.0);
        audio_buffer_channel(buffer, 0)[0] = 1.0f;
        first_filter = require_node(first);
        second_filter = require_node(second);
        discarded_source = require_node(source);
        audio_set_buffer(source, buffer);
        audio_connect(source, first);
        audio_connect(first, second);
        audio_connect(second, destination);
        audio_node_start(source, audio_current_time(context));
    }
    render(context, 256);
    audio_collect_finished();
    assert(!discarded_source.expired() && !first_filter.expired() && !second_filter.expired());
    const auto tail = render(context, 12000);
    assert(tail && measure(*tail).peak > 0.0f);
    audio_collect_finished();
    assert(!first_filter.expired() && !second_filter.expired());
    render(context, 14464);
    audio_collect_finished();
    assert(discarded_source.expired() && first_filter.expired() && second_filter.expired());

    // AudioParam connections retain their destination just like audio edges.
    {
        const auto driver = audio_create_oscillator(context);
        {
            const auto gain = audio_create_gain(context);
            discarded_gain = require_node(gain);
            audio_connect_param(driver, audio_node_param(gain, AudioParamName::Gain));
            audio_connect(gain, destination);
        }
        audio_collect_finished();
        assert(!discarded_gain.expired());
        audio_disconnect(driver);
        assert(discarded_gain.expired());
    }
    audio_collect_finished();

    // Feedback is retained conservatively rather than assigned a guessed tail.
    {
        const auto source = audio_create_oscillator(context);
        const auto first = audio_create_gain(context);
        const auto second = audio_create_gain(context);
        audio_connect(source, first);
        audio_connect(first, second);
        audio_connect(second, first);
        auto& record = require_context(context.value);
        {
            lab::ContextRenderLock lock(record.context.get(), "fixture feedback tail");
            assert(std::isinf(graph_tail(record, require_node(first).get(), lock)));
        }
        // Simulate a delivered completion for the graph-lifetime check;
        // actual source completion is exercised by both playback loops.
        source.ownership->source->started = true;
        source.ownership->source->completed = true;
        audio_collect_finished();
        assert(std::isinf(record.graph.at(require_node(source).get()).retire_after));
        audio_disconnect(second);
        assert(record.graph.at(require_node(source).get()).outputs.empty());
        assert(std::isfinite(record.graph.at(require_node(source).get()).retire_after));
        audio_disconnect(first);
    }
    audio_collect_finished();

    // A channel view independently owns its PCM even after its buffer dies.
    auto view = [&] {
        auto buffer = audio_create_buffer(context, 1, 8, 48000.0);
        auto channel = audio_buffer_channel(buffer, 0);
        channel[0] = 0.75f;
        return channel;
    }();
    assert(view[0] == 0.75f);

    audio_close_context(context);
    bool closed_rejected = false;
    try { static_cast<void>(require_node(retained)); }
    catch (const std::runtime_error&) { closed_rejected = true; }
    assert(closed_rejected);
    assert(audio_destination(other).ownership);
    audio_close_context(other);
    std::cout << "audio-lifetime-check: ok\n";
}
