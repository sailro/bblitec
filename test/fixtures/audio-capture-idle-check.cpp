// A capture recorder that is never fed, and one whose inputs all disconnect
// between renders, over the real LabSound PAL. Both used to read or write
// freed memory: a recorder that recorded nothing read a channel it never made,
// and an output whose consumer reallocated its bus between quanta wrote the
// sample rate through the stale in-place bus.

#include "pal_audio_labsound.cpp"

#include <cstdlib>
#include <iostream>
#include <string>

namespace bbl::pal {
std::string environment_variable(const char* name) {
    char* value = nullptr;
    std::size_t length = 0;
    _dupenv_s(&value, &length, name);
    const std::string result = value ? value : "";
    std::free(value);
    return result;
}
} // namespace bbl::pal

using namespace bbl::pal;

namespace {

void render(AudioContextHandle handle, int frames) {
    auto& record = require_context(handle.value);
    auto scratch = std::make_shared<lab::AudioBus>(2, lab::AudioNode::ProcessingSizeInFrames);
    record.destination->offlineRender(scratch.get(), frames);
}

/** A one-channel buffer source holding `value` in every one of `frames`. */
AudioNodeHandle constant_source(AudioContextHandle context, float value, std::uint32_t frames) {
    const auto source = audio_create_buffer_source(context);
    const auto buffer = audio_create_buffer(context, 1, frames, 48000.0);
    auto channel = audio_buffer_channel(buffer, 0);
    for (std::size_t index = 0; index < channel.size(); ++index)
        channel[index] = value;
    audio_set_buffer(source, buffer);
    return source;
}

/** An idle context: its recorder renders and is written at the session's finish. */
void check_idle_context() {
    auto session = std::make_shared<AudioSession>();
    static_cast<void>(audio_create_context(session));
    session->finish();
}

/** Mono and stereo producers connected, rendered, then all disconnected, repeatedly. */
void check_disconnected_inputs() {
    auto session = std::make_shared<AudioSession>();
    const auto context = audio_create_context(session);
    for (int round = 0; round < 8; ++round) {
        const auto source = constant_source(context, 0.5f, 48000);
        const auto mono = audio_create_gain(context);
        const auto stereo = audio_create_stereo_panner(context);
        audio_connect(source, mono);
        audio_connect(mono, stereo);
        audio_connect(stereo, audio_destination(context));
        audio_connect(mono, audio_destination(context));
        audio_node_start(source, 0.0);
        render(context, 1024);
        audio_disconnect(stereo);
        audio_disconnect(mono);
        render(context, 1024);
    }
    session->finish();
}

} // namespace

int main() {
    _putenv_s("BBLITE_AUDIO_CAPTURE", "audio-capture-idle-unused.wav");
    _putenv_s("BBLITE_AUDIO_CAPTURE_SECONDS", "0.1");
    check_idle_context();
    check_disconnected_inputs();
    std::cout << "audio-capture-idle-check: ok\n";
    return 0;
}
