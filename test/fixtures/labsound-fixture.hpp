// Offline renders and probes over the real LabSound PAL for the audio
// fixtures; include after pal_audio_labsound.cpp. A fixture that does not
// link pal.cpp defines LABSOUND_FIXTURE_ENVIRONMENT first: the PAL then
// reads the process environment (BBLITE_AUDIO_CAPTURE and the like).
#pragma once
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef LABSOUND_FIXTURE_ENVIRONMENT
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
#endif

namespace labsound_fixture {

#if BBLITE_AUDIO_CAPTURE
/**
 * Renders `frames` more frames offline; the capture recording holds every frame
 * rendered so far.
 */
inline std::unique_ptr<lab::AudioBus> render(bbl::pal::AudioContextHandle context, int frames) {
    auto& record = bbl::pal::require_context(context.value);
    auto scratch = std::make_shared<lab::AudioBus>(2, lab::AudioNode::ProcessingSizeInFrames);
    record.destination->offlineRender(scratch.get(), frames);
    return record.recorder->createBusFromRecording(false);
}
#endif

/** A recorded channel's samples. */
inline std::span<const float> samples(const lab::AudioBus& bus, int channel = 0) {
    return {bus.channel(channel)->data(), static_cast<std::size_t>(bus.length())};
}

/** The largest magnitude among `samples[first, last)`. */
inline float peak(std::span<const float> samples, std::size_t first, std::size_t last) {
    float value = 0.0f;
    for (std::size_t index = first; index < last; ++index)
        value = std::max(value, std::abs(samples[index]));
    return value;
}

/** `value` with three decimals, as the fixtures print measurements. */
inline std::string fixed(double value) {
    char text[32];
    std::snprintf(text, sizeof text, "%.3f", value);
    return text;
}

/** A one-channel buffer source holding `value` in every one of `frames`, not started. */
inline bbl::pal::AudioNodeHandle constant_source(bbl::pal::AudioContextHandle context, float value,
                                                 std::uint32_t frames) {
    const auto source = bbl::pal::audio_create_buffer_source(context);
    const auto buffer = bbl::pal::audio_create_buffer(context, 1, frames, 48000.0);
    auto channel = bbl::pal::audio_buffer_channel(buffer, 0);
    for (std::size_t index = 0; index < channel.size(); ++index)
        channel[index] = value;
    bbl::pal::audio_set_buffer(source, buffer);
    return source;
}

/** The DOMException name (or Error name) a call throws, empty when it returns. */
template <class Call> std::string thrown(Call call) {
    try {
        call();
    } catch (const bbl::js::NamedError& error) {
        return error.name;
    } catch (const std::runtime_error&) {
        return "runtime_error";
    }
    return {};
}

} // namespace labsound_fixture
