/**
 * The Web Audio surface, over LabSound.
 *
 * LabSound is a BSD-licensed C++ engine forked from WebKit's own
 * WebAudio implementation, so the nodes, the parameter timeline and the
 * panner math this file exposes are the same algorithms the browser
 * reference runs -- the relationship navigation has with recastnavigation
 * rather than the one physics has with Bullet. The platform stream sits
 * behind LabSound's `lab::AudioDevice`, which is public, so SDL3 slots in
 * without a fork (`pal_audio_sdl_device.hpp`).
 *
 * Nothing here knows anything about Babylon: handles in, handles out.
 * Buses, the sound sub-graph, ramp shapes, the sound state machine and
 * spatial attachment are Babylon behaviour and belong in generated code
 * lowered from the pinned TypeScript modules under `src/audio/`.
 */

#include <bblite/pal_audio.hpp>

#include <bblite/pal.hpp>

#include "pal_audio_sdl_device.hpp"
#include "pal_runtime_trace.hpp"

#include "LabSound/core/AudioContext.h"
#include "LabSound/extended/Logging.h"
#include "LabSound/core/AudioDevice.h"
#include "LabSound/core/AudioParam.h"
#include "LabSound/core/GainNode.h"
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
#include "LabSound/core/AudioBus.h"
#include "LabSound/core/SampledAudioNode.h"
#endif
#if BBLITE_HAS_AUDIO_BIQUAD_FILTER
#include "LabSound/core/BiquadFilterNode.h"
#endif
#if BBLITE_HAS_AUDIO_OSCILLATOR
#include "LabSound/core/OscillatorNode.h"
#endif
#if BBLITE_HAS_AUDIO_STEREO_PANNER
#include "LabSound/core/StereoPannerNode.h"
#endif
#if BBLITE_HAS_AUDIO_CAPTURE
#include "LabSound/extended/RecorderNode.h"
#endif
#if BBLITE_HAS_AUDIO_DECODE_FILE
#include "LabSound/extended/AudioFileReader.h"
#endif

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace bbl::pal {
namespace {

#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
struct AudioBufferRecord {
    std::vector<bbl::js::F32Array> channels;
    std::shared_ptr<lab::AudioBus> bus;
};
#endif

struct ContextRecord {
    ContextRecord() = default;
    ContextRecord(ContextRecord&&) = default;
    ContextRecord& operator=(ContextRecord&&) = default;
    /**
     * Pause the device before the graph it pulls dies. A returned pause is
     * a join -- SDL takes the device lock the audio thread holds while it
     * runs the stream callback -- so no callback is rendering when the
     * members below free the nodes and buffers. Member order alone would
     * free them first and pause last (`context`, whose own uninitialize
     * pauses, is destroyed last): a use-after-free on the audio thread,
     * seen as the application gates' intermittent teardown crash.
     */
    ~ContextRecord() {
        if (device) device->stop();
    }

    std::shared_ptr<lab::AudioContext> context;
    std::shared_ptr<lab::AudioDestinationNode> destination;
    std::shared_ptr<detail::AudioDeviceSdl3> device;
    /**
     * A capture context records through the pin's own answer to the same
     * question -- a recorder tapping the destination's input -- because
     * `offlineRender` reuses one quantum-sized bus rather than
     * accumulating.
     */
#if BBLITE_HAS_AUDIO_CAPTURE
    std::shared_ptr<lab::RecorderNode> recorder;
#endif
    int channels = 2;
    /**
     * Not derivable from `context->sampleRate()`: that reads the
     * destination's `SamplingInfo`, which is zero on an offline context
     * until a render has run.
     */
    double sample_rate = 48000.0;
    /** Index 0 is the node `ctx.destination` names; see `audio_create_context`. */
    std::vector<std::shared_ptr<lab::AudioNode>> nodes;
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    /** Web Audio's per-buffer-source loop flag, parallel to `nodes`. */
    std::vector<bool> source_loops;
#endif
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    std::vector<std::shared_ptr<AudioBufferRecord>> buffers;
#endif
};

/** A node handle is `(context << 16) | index`, so one lookup finds both. */
constexpr std::uint32_t pack(std::uint32_t context, std::uint32_t index)
{
    return (context << 16) | (index & 0xffffu);
}
constexpr std::uint32_t context_of(std::uint32_t packed) { return packed >> 16; }
constexpr std::uint32_t index_of(std::uint32_t packed) { return packed & 0xffffu; }

std::unordered_map<std::uint32_t, ContextRecord>& contexts()
{
    static std::unordered_map<std::uint32_t, ContextRecord> map;
    return map;
}

/**
 * `BBLITE_AUDIO_CAPTURE`. Audio produces no pixels, so the parity
 * harness has nothing to screenshot -- but an offline render is a byte
 * string. With the variable set, every context the scene creates renders
 * offline, so the graph is identical and nothing runs in real time.
 */
#if BBLITE_HAS_AUDIO_CAPTURE
struct CaptureRequest {
    std::string path;
    double seconds = 1.0;
    bool wanted() const { return !path.empty(); }
};

const CaptureRequest& capture_request()
{
    static const CaptureRequest request = [] {
        CaptureRequest value;
        value.path = environment_variable("BBLITE_AUDIO_CAPTURE");
        const std::string seconds =
            environment_variable("BBLITE_AUDIO_CAPTURE_SECONDS");
        if (!seconds.empty()) {
            value.seconds = std::strtod(seconds.c_str(), nullptr);
            if (!(value.seconds > 0.0)) value.seconds = 1.0;
        }
        return value;
    }();
    return request;
}

/** Contexts the capture run has to render, in creation order. */
std::vector<std::uint32_t>& capture_contexts()
{
    static std::vector<std::uint32_t> ids;
    return ids;
}
#endif

std::uint32_t next_context_id()
{
    static std::uint32_t next = 1;
    return next++;
}

ContextRecord& require_context(std::uint32_t id)
{
    auto found = contexts().find(id);
    if (found == contexts().end()) {
        throw std::runtime_error(
            "Invalid audio context handle " + std::to_string(id) + ".");
    }
    return found->second;
}

/** The node an already-resolved context holds at a handle's index. */
const std::shared_ptr<lab::AudioNode>& require_node(
    ContextRecord& record, AudioNodeHandle node)
{
    const std::uint32_t index = index_of(node.value);
    if (index >= record.nodes.size() || !record.nodes[index]) {
        throw std::runtime_error("Invalid audio node handle.");
    }
    return record.nodes[index];
}

const std::shared_ptr<lab::AudioNode>& require_node(AudioNodeHandle node)
{
    return require_node(require_context(context_of(node.value)), node);
}

#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
std::shared_ptr<AudioBufferRecord>& require_buffer(AudioBufferHandle buffer)
{
    ContextRecord& record = require_context(context_of(buffer.value));
    const std::uint32_t index = index_of(buffer.value);
    if (index >= record.buffers.size() || !record.buffers[index]) {
        throw std::runtime_error("Invalid audio buffer handle.");
    }
    return record.buffers[index];
}

AudioBufferHandle allocate_audio_buffer(
    AudioContextHandle context,
    std::uint32_t channels,
    std::uint32_t frames,
    double sample_rate)
{
    if (channels == 0 || frames == 0 || !(sample_rate > 0.0)) {
        throw std::runtime_error("Invalid AudioBuffer dimensions or sample rate.");
    }
    ContextRecord& context_record = require_context(context.value);
    if (context_record.buffers.size() >= 0xffffu) {
        throw std::runtime_error("Too many audio buffers in one context.");
    }
    auto buffer = std::make_shared<AudioBufferRecord>();
    buffer->channels.reserve(channels);
    for (std::uint32_t channel = 0; channel < channels; ++channel) {
        buffer->channels.emplace_back(frames, 0.0f);
    }
    buffer->bus = std::make_shared<lab::AudioBus>(
        static_cast<int>(channels), static_cast<int>(frames), false);
    buffer->bus->setSampleRate(static_cast<float>(sample_rate));
    for (std::uint32_t channel = 0; channel < channels; ++channel) {
        buffer->bus->setChannelMemory(
            static_cast<int>(channel),
            buffer->channels[channel].data(),
            static_cast<int>(frames));
    }
    context_record.buffers.push_back(std::move(buffer));
    return AudioBufferHandle{pack(
        context.value,
        static_cast<std::uint32_t>(context_record.buffers.size() - 1))};
}
#endif

/**
 * LabSound registers every parameter under the Web Audio spelling
 * (`GainNode.cpp`'s `"gain"`, `BiquadFilterNode.cpp`'s
 * `"frequency"`/`"Q"`/`"gain"`/`"detune"`, and so on), and
 * `AudioNode::param(const char*)` is the generic lookup over that
 * registration -- so the name IS the lookup. A per-node cast ladder
 * would be a hand-maintained copy of a table the library already owns,
 * and would go stale against it: written that way, this file had already
 * lost `BiquadFilterNode`'s own `gain`.
 */
constexpr const char* spelling(AudioParamName name)
{
    switch (name) {
        case AudioParamName::Gain: return "gain";
        case AudioParamName::Frequency: return "frequency";
        case AudioParamName::Detune: return "detune";
        case AudioParamName::Q: return "Q";
        case AudioParamName::Pan: return "pan";
        case AudioParamName::PlaybackRate: return "playbackRate";
    }
    return nullptr;
}

std::shared_ptr<lab::AudioParam> require_param(AudioParamHandle handle)
{
    auto param = require_node(handle.node)->param(spelling(handle.name));
    if (!param) {
        throw std::runtime_error("Audio node has no such parameter.");
    }
    return param;
}

#if BBLITE_HAS_AUDIO_OSCILLATOR
lab::OscillatorType to_lab(OscillatorWave wave)
{
    switch (wave) {
        case OscillatorWave::Sine: return lab::OscillatorType::SINE;
        case OscillatorWave::Square: return lab::OscillatorType::SQUARE;
        case OscillatorWave::Sawtooth: return lab::OscillatorType::SAWTOOTH;
        case OscillatorWave::Triangle: return lab::OscillatorType::TRIANGLE;
    }
    throw std::runtime_error("Unhandled oscillator wave.");
}
#endif

#if BBLITE_HAS_AUDIO_BIQUAD_FILTER
lab::FilterType to_lab(BiquadFilterKind kind)
{
    switch (kind) {
        case BiquadFilterKind::Lowpass: return lab::FilterType::LOWPASS;
        case BiquadFilterKind::Highpass: return lab::FilterType::HIGHPASS;
        case BiquadFilterKind::Bandpass: return lab::FilterType::BANDPASS;
        case BiquadFilterKind::Lowshelf: return lab::FilterType::LOWSHELF;
        case BiquadFilterKind::Highshelf: return lab::FilterType::HIGHSHELF;
        case BiquadFilterKind::Peaking: return lab::FilterType::PEAKING;
        case BiquadFilterKind::Notch: return lab::FilterType::NOTCH;
        case BiquadFilterKind::Allpass: return lab::FilterType::ALLPASS;
    }
    throw std::runtime_error("Unhandled biquad filter kind.");
}
#endif

template <typename Node>
AudioNodeHandle create_node(AudioContextHandle context)
{
    ContextRecord& record = require_context(context.value);
    record.nodes.push_back(std::make_shared<Node>(*record.context));
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    record.source_loops.push_back(false);
#endif
    return AudioNodeHandle{
        pack(context.value, static_cast<std::uint32_t>(record.nodes.size() - 1))};
}

/** Peak and RMS in one walk over the captured bus. */
#if BBLITE_HAS_AUDIO_CAPTURE
struct CaptureStats {
    int frames = 0;
    float peak = 0.0f;
    double rms = 0.0;
};

/**
 * 32-bit float WAV. Forty-four bytes of header and an interleave; the
 * project writes its own because the captured bus is the authority on
 * the samples and nothing else here can write one from a bus.
 */
bool write_float_wav(const std::string& path, const lab::AudioBus& bus,
                     double sample_rate)
{
    const int channels = bus.numberOfChannels();
    const int frames = bus.length();
    if (channels <= 0 || frames <= 0) return false;

    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    if (!file) return false;

    const std::uint32_t data_bytes =
        static_cast<std::uint32_t>(frames) *
        static_cast<std::uint32_t>(channels) * 4u;
    const std::uint32_t rate = static_cast<std::uint32_t>(sample_rate);
    const auto u32 = [&file](std::uint32_t v) {
        file.write(reinterpret_cast<const char*>(&v), 4);
    };
    const auto u16 = [&file](std::uint16_t v) {
        file.write(reinterpret_cast<const char*>(&v), 2);
    };

    file.write("RIFF", 4);
    u32(36u + data_bytes);
    file.write("WAVE", 4);
    file.write("fmt ", 4);
    u32(16u);
    u16(3);  // IEEE float
    u16(static_cast<std::uint16_t>(channels));
    u32(rate);
    u32(rate * static_cast<std::uint32_t>(channels) * 4u);  // byte rate
    u16(static_cast<std::uint16_t>(channels * 4));           // block align
    u16(32);                                                 // bits per sample
    file.write("data", 4);
    u32(data_bytes);

    // The bus is de-interleaved; a WAV frame is interleaved.
    for (int frame = 0; frame < frames; ++frame) {
        for (int channel = 0; channel < channels; ++channel) {
            const float sample = bus.channel(channel)->data()[frame];
            file.write(reinterpret_cast<const char*>(&sample), 4);
        }
    }
    return static_cast<bool>(file);
}

CaptureStats measure(const lab::AudioBus& bus)
{
    CaptureStats stats;
    stats.frames = bus.length();
    const int channels = bus.numberOfChannels();
    double sum = 0.0;
    for (int channel = 0; channel < channels; ++channel) {
        const float* data = bus.channel(channel)->data();
        for (int i = 0; i < stats.frames; ++i) {
            const float sample = data[i];
            stats.peak = std::max(stats.peak, std::fabs(sample));
            sum += static_cast<double>(sample) * sample;
        }
    }
    const double count = static_cast<double>(stats.frames) * channels;
    if (count > 0.0) stats.rms = std::sqrt(sum / count);
    return stats;
}
#endif

} // namespace

AudioContextHandle audio_create_context()
{
#if BBLITE_HAS_AUDIO_CAPTURE
    const bool capture = capture_request().wanted();
#else
    constexpr bool capture = false;
    if (!environment_variable("BBLITE_AUDIO_CAPTURE").empty()) {
        throw std::runtime_error(
            "Audio capture was not compiled. Configure with "
            "BBLITE_AUDIO_CAPTURE=ON.");
    }
#endif
    const std::uint32_t id = next_context_id();

    // LabSound ships rxi's logger at TRACE, which floods stderr from the
    // graph-update thread. Warnings and errors still surface; the lower
    // levels are opt-in diagnostics.
    const std::string log_level = environment_variable("BBLITE_AUDIO_LOG");
    log_set_level(
        log_level == "trace"       ? LOGLEVEL_TRACE
            : log_level == "debug" ? LOGLEVEL_DEBUG
            : log_level == "info"  ? LOGLEVEL_INFO
            : log_level == "error" ? LOGLEVEL_ERROR
                                   : LOGLEVEL_WARN);

    ContextRecord record;

    lab::AudioStreamConfig out_config;
    out_config.device_index = 0;
    out_config.desired_channels = static_cast<std::uint32_t>(record.channels);
    out_config.desired_samplerate = static_cast<float>(record.sample_rate);
    const lab::AudioStreamConfig in_config{};

    record.context = std::make_shared<lab::AudioContext>(capture, !capture);

#if BBLITE_HAS_AUDIO_CAPTURE
    if (capture) {
        record.destination = std::make_shared<lab::AudioDestinationNode>(
            *record.context,
            std::make_shared<lab::AudioDevice_Null>(in_config, out_config));
        record.context->setDestinationNode(record.destination);
        record.recorder =
            std::make_shared<lab::RecorderNode>(*record.context, out_config);
        record.context->connect(record.destination, record.recorder, 0, 0);
        record.recorder->startRecording();
        capture_contexts().push_back(id);
    } else
#endif
    {
        auto device = std::make_shared<detail::AudioDeviceSdl3>(in_config, out_config);
        if (!device->opened()) {
            throw std::runtime_error(
                "Audio: SDL could not open a playback device. bblitec has no "
                "silent fallback -- an unavailable device is the answer.");
        }
        // The device may have opened at a different rate or width than
        // asked for; the graph runs at what it got.
        record.sample_rate = device->getOutputConfig().desired_samplerate;
        record.channels = static_cast<int>(device->getOutputConfig().desired_channels);
        record.destination =
            std::make_shared<lab::AudioDestinationNode>(*record.context, device);
        device->setDestinationNode(record.destination);
        record.context->setDestinationNode(record.destination);
        record.device = device;
        device->start();
    }

    // Index 0 is the node a scene's `ctx.destination` names. Real-time,
    // that is the destination itself. Under capture it is the recorder
    // that feeds it -- `offlineRender` reuses one quantum-sized bus
    // rather than accumulating, so the capture has to sit in the graph,
    // and a recorder with nothing connected is pulled with a null input
    // bus.
#if BBLITE_HAS_AUDIO_CAPTURE
    record.nodes.push_back(
        capture ? std::static_pointer_cast<lab::AudioNode>(record.recorder)
                : std::static_pointer_cast<lab::AudioNode>(record.destination));
#else
    record.nodes.push_back(
        std::static_pointer_cast<lab::AudioNode>(record.destination));
#endif
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    record.source_loops.push_back(false);
#endif
    contexts().emplace(id, std::move(record));
    return AudioContextHandle{id};
}

void audio_close_context(AudioContextHandle context)
{
    auto found = contexts().find(context.value);
    if (found == contexts().end()) return;
    ContextRecord& record = found->second;
    if (record.device) record.device->stop();
#if BBLITE_HAS_AUDIO_CAPTURE
    if (record.recorder) record.recorder->stopRecording();
#endif
    if (record.context && record.destination) {
        record.context->disconnect(record.destination);
    }
    contexts().erase(found);
}

void audio_close_all_contexts()
{
    // Each record pauses its device before its graph dies (see
    // ~ContextRecord), and ~AudioContext joins LabSound's graph-update
    // thread -- so after this, no audio thread outlives the run into
    // static destruction, where the objects it touches are torn down in
    // an order nothing controls.
    contexts().clear();
}

double audio_current_time(AudioContextHandle context)
{
    return require_context(context.value).context->currentTime();
}

double audio_sample_rate(AudioContextHandle context)
{
    return require_context(context.value).sample_rate;
}

std::string audio_state(AudioContextHandle context)
{
    require_context(context.value);
    // Creation opens and starts the native device atomically. A failed open
    // throws, so every live handle has reached Web Audio's running state.
    return "running";
}

void audio_resume(AudioContextHandle context)
{
    ContextRecord& record = require_context(context.value);
    if (record.device) record.device->start();
}

AudioNodeHandle audio_destination(AudioContextHandle context)
{
    require_context(context.value);
    return AudioNodeHandle{pack(context.value, 0)};
}

AudioNodeHandle audio_create_gain(AudioContextHandle context)
{
    return create_node<lab::GainNode>(context);
}

AudioNodeHandle audio_create_oscillator(AudioContextHandle context)
{
#if BBLITE_HAS_AUDIO_OSCILLATOR
    return create_node<lab::OscillatorNode>(context);
#else
    (void)context;
    throw std::runtime_error("Oscillator support was not compiled.");
#endif
}

AudioNodeHandle audio_create_biquad_filter(AudioContextHandle context)
{
#if BBLITE_HAS_AUDIO_BIQUAD_FILTER
    return create_node<lab::BiquadFilterNode>(context);
#else
    (void)context;
    throw std::runtime_error("Biquad filter support was not compiled.");
#endif
}

AudioNodeHandle audio_create_stereo_panner(AudioContextHandle context)
{
#if BBLITE_HAS_AUDIO_STEREO_PANNER
    const AudioNodeHandle node = create_node<lab::StereoPannerNode>(context);
    // LabSound declares `pan` with default 0.5 over 0..1 while Web Audio
    // specifies 0.0 over -1..1; only the DESCRIPTOR differs -- the DSP
    // clamps to [-1, 1] and treats 0 as centre, and `AudioParam::setValue`
    // does not enforce the range. So an unset panner would sit right of
    // centre where the browser puts it in the middle. Translating that is
    // this layer's job, exactly as the enum mappings above are.
    require_param(AudioParamHandle{node, AudioParamName::Pan})->setValue(0.0f);
    return node;
#else
    (void)context;
    throw std::runtime_error("Stereo panner support was not compiled.");
#endif
}

AudioBufferHandle audio_create_buffer(
    AudioContextHandle context,
    std::uint32_t channels,
    std::uint32_t frames,
    double sample_rate)
{
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    const AudioBufferHandle handle = allocate_audio_buffer(
        context, channels, frames, sample_rate);
    if (runtime_trace_enabled()) {
        std::fprintf(
            stderr,
            "[bblite trace] audio buffer=%u channels=%u frames=%u rate=%.0f\n",
            handle.value, channels, frames, sample_rate);
    }
    return handle;
#else
    (void)context;
    (void)channels;
    (void)frames;
    (void)sample_rate;
    throw std::runtime_error("Audio buffer source support was not compiled.");
#endif
}

AudioBufferHandle audio_decode_file(
    AudioContextHandle context,
    const std::string& path)
{
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE && BBLITE_HAS_AUDIO_DECODE_FILE
    try {
        ContextRecord& context_record = require_context(context.value);
        const std::shared_ptr<lab::AudioBus> decoded = lab::MakeBusFromFile(
            path, false, static_cast<float>(context_record.sample_rate));
        if (!decoded || decoded->numberOfChannels() <= 0 || decoded->length() <= 0) {
            return {};
        }
        const auto channel_count = static_cast<std::uint32_t>(
            decoded->numberOfChannels());
        const auto frame_count = static_cast<std::uint32_t>(decoded->length());
        const AudioBufferHandle handle = allocate_audio_buffer(
            context, channel_count, frame_count, context_record.sample_rate);
        auto& buffer = require_buffer(handle);
        for (std::uint32_t channel = 0; channel < channel_count; ++channel) {
            const float* samples = decoded->channel(channel)->data();
            std::copy_n(
                samples,
                frame_count,
                buffer->channels[channel].begin());
        }
        return handle;
    } catch (...) {
        // Racer's source helper catches fetch/decode failures and returns null.
        return {};
    }
#else
    (void)context;
    (void)path;
    return {};
#endif
}

bbl::js::F32Array& audio_buffer_channel(
    AudioBufferHandle buffer,
    std::uint32_t channel)
{
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    auto& record = require_buffer(buffer);
    if (channel >= record->channels.size()) {
        throw std::runtime_error("AudioBuffer channel index is out of range.");
    }
    return record->channels[channel];
#else
    (void)buffer;
    (void)channel;
    throw std::runtime_error("Audio buffer source support was not compiled.");
#endif
}

AudioNodeHandle audio_create_buffer_source(AudioContextHandle context)
{
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    return create_node<lab::SampledAudioNode>(context);
#else
    (void)context;
    throw std::runtime_error("Audio buffer source support was not compiled.");
#endif
}

void audio_set_buffer(AudioNodeHandle source, AudioBufferHandle buffer)
{
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    if (context_of(source.value) != context_of(buffer.value)) {
        throw std::runtime_error(
            "An AudioBufferSourceNode and its buffer must share a context.");
    }
    auto sampled =
        std::dynamic_pointer_cast<lab::SampledAudioNode>(require_node(source));
    if (!sampled) {
        throw std::runtime_error("Audio node is not a buffer source.");
    }
    const auto& buffer_record = require_buffer(buffer);
    sampled->setBus(buffer_record->bus);
    if (runtime_trace_enabled()) {
        float peak = 0.0f;
        for (const auto& channel : buffer_record->channels) {
            for (const float sample : channel) {
                peak = std::max(peak, std::fabs(sample));
            }
        }
        std::fprintf(
            stderr,
            "[bblite trace] audio source=%u set-buffer=%u peak=%.6f\n",
            source.value, buffer.value, peak);
    }
#else
    (void)source;
    (void)buffer;
    throw std::runtime_error("Audio buffer source support was not compiled.");
#endif
}

void audio_set_loop(AudioNodeHandle source, bool enabled)
{
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    ContextRecord& record = require_context(context_of(source.value));
    const std::uint32_t index = index_of(source.value);
    if (
        index >= record.source_loops.size() ||
        !std::dynamic_pointer_cast<lab::SampledAudioNode>(
            require_node(record, source))) {
        throw std::runtime_error("Audio node is not a buffer source.");
    }
    record.source_loops[index] = enabled;
#else
    (void)source;
    (void)enabled;
    throw std::runtime_error("Audio buffer source support was not compiled.");
#endif
}

void audio_connect(AudioNodeHandle source, AudioNodeHandle destination)
{
    if (context_of(source.value) != context_of(destination.value)) {
        throw std::runtime_error(
            "Audio nodes from different contexts cannot be connected.");
    }
    // One context lookup, two indexes: the single-argument `require_node`
    // would resolve the context twice for one edge.
    ContextRecord& record = require_context(context_of(source.value));
    record.context->connect(
        require_node(record, destination), require_node(record, source), 0, 0);
}

void audio_disconnect(AudioNodeHandle node)
{
    ContextRecord& record = require_context(context_of(node.value));
    record.context->disconnect(require_node(record, node));
}

void audio_node_start(AudioNodeHandle node, double when)
{
#if BBLITE_HAS_AUDIO_OSCILLATOR || BBLITE_HAS_AUDIO_BUFFER_SOURCE
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    // LabSound deliberately gives SampledAudioNode an absolute-time start
    // overload which is not virtual. Calling through AudioScheduledSourceNode
    // starts only the base scheduler and never enqueues the sample, producing
    // a perfectly connected but silent buffer source. Preserve Web Audio's
    // common `start(when)` surface by dispatching this concrete node first.
    if (auto sampled = std::dynamic_pointer_cast<lab::SampledAudioNode>(
            require_node(node))) {
        const ContextRecord& record =
            require_context(context_of(node.value));
        const std::uint32_t index = index_of(node.value);
        const bool loop =
            index < record.source_loops.size() &&
            record.source_loops[index];
        sampled->start(static_cast<float>(when), loop ? -1 : 0);
        if (runtime_trace_enabled()) {
            std::fprintf(
                stderr,
                "[bblite trace] audio source=%u start=%.6f\n",
                node.value, when);
        }
        return;
    }
#endif
    auto scheduled =
        std::dynamic_pointer_cast<lab::AudioScheduledSourceNode>(require_node(node));
    if (!scheduled) {
        throw std::runtime_error("Audio node is not a scheduled source.");
    }
    scheduled->start(static_cast<float>(when));
    if (runtime_trace_enabled()) {
        std::fprintf(
            stderr,
            "[bblite trace] audio source=%u start=%.6f\n",
            node.value, when);
    }
#else
    (void)node;
    (void)when;
    throw std::runtime_error("Scheduled audio sources were not compiled.");
#endif
}

void audio_node_stop(AudioNodeHandle node, double when)
{
#if BBLITE_HAS_AUDIO_OSCILLATOR || BBLITE_HAS_AUDIO_BUFFER_SOURCE
    auto scheduled =
        std::dynamic_pointer_cast<lab::AudioScheduledSourceNode>(require_node(node));
    if (!scheduled) {
        throw std::runtime_error("Audio node is not a scheduled source.");
    }
    scheduled->stop(static_cast<float>(when));
#else
    (void)node;
    (void)when;
    throw std::runtime_error("Scheduled audio sources were not compiled.");
#endif
}

AudioParamHandle audio_node_param(AudioNodeHandle node, AudioParamName name)
{
    // Pure by contract: `osc.frequency` is one object in Web Audio, so two
    // reads must produce one handle. Validity is checked where the
    // parameter is used.
    return AudioParamHandle{node, name};
}

void audio_set_oscillator_wave(AudioNodeHandle node, OscillatorWave wave)
{
#if BBLITE_HAS_AUDIO_OSCILLATOR
    auto osc = std::dynamic_pointer_cast<lab::OscillatorNode>(require_node(node));
    if (!osc) throw std::runtime_error("Audio node is not an oscillator.");
    osc->setType(to_lab(wave));
#else
    (void)node;
    (void)wave;
    throw std::runtime_error("Oscillator support was not compiled.");
#endif
}

void audio_set_filter_kind(AudioNodeHandle node, BiquadFilterKind kind)
{
#if BBLITE_HAS_AUDIO_BIQUAD_FILTER
    auto filter = std::dynamic_pointer_cast<lab::BiquadFilterNode>(require_node(node));
    if (!filter) throw std::runtime_error("Audio node is not a biquad filter.");
    filter->setType(to_lab(kind));
#else
    (void)node;
    (void)kind;
    throw std::runtime_error("Biquad filter support was not compiled.");
#endif
}

float audio_param_value(AudioParamHandle param)
{
    return require_param(param)->value();
}

void audio_param_set_value(AudioParamHandle param, float value)
{
    require_param(param)->setValue(value);
}

void audio_param_set_value_at_time(AudioParamHandle param, float value, double time)
{
    require_param(param)->setValueAtTime(value, static_cast<float>(time));
}

void audio_param_linear_ramp(AudioParamHandle param, float value, double time)
{
    require_param(param)->linearRampToValueAtTime(value, static_cast<float>(time));
}

void audio_param_exponential_ramp(AudioParamHandle param, float value, double time)
{
    require_param(param)->exponentialRampToValueAtTime(value, static_cast<float>(time));
}

void audio_param_cancel_scheduled_values(AudioParamHandle param, double time)
{
    require_param(param)->cancelScheduledValues(static_cast<float>(time));
}

void audio_render_pending_captures()
{
#if BBLITE_HAS_AUDIO_CAPTURE
    const CaptureRequest& request = capture_request();
    if (!request.wanted()) return;

    for (const std::uint32_t id : capture_contexts()) {
        auto found = contexts().find(id);
        if (found == contexts().end()) continue;
        ContextRecord& record = found->second;
        const int frames = static_cast<int>(record.sample_rate * request.seconds);
        try {
            record.context->synchronizeConnections();
            auto scratch = std::make_shared<lab::AudioBus>(
                record.channels, lab::AudioNode::ProcessingSizeInFrames);
            record.destination->offlineRender(scratch.get(), frames);
            record.recorder->stopRecording();

            // One source of truth for the file and the numbers: the
            // captured bus. LabSound's own `writeRecordingToWav` cannot
            // serve both -- it swaps `m_data` out as it encodes, so a
            // measurement after it reads nothing, and it writes the
            // channel count the recorder OBSERVED (one, for a mono graph)
            // where `createBusFromRecording` returns the count the
            // recorder was configured with. Writing the bus keeps the
            // WAV and the reported peak/RMS the same bytes by
            // construction, which is the only reason the numbers mean
            // anything.
            const std::unique_ptr<lab::AudioBus> captured =
                record.recorder->createBusFromRecording(false);
            const CaptureStats stats =
                captured ? measure(*captured) : CaptureStats{};
            const bool written =
                captured && write_float_wav(request.path, *captured,
                                            record.sample_rate);

            std::fprintf(
                stderr,
                "[bblite audio] captured %d frames at %.0f Hz, peak %.6f, "
                "rms %.6f -> %s%s\n",
                stats.frames, record.sample_rate,
                static_cast<double>(stats.peak), stats.rms,
                request.path.c_str(), written ? "" : " (WRITE FAILED)");
        } catch (const std::exception& error) {
            std::fprintf(stderr, "[bblite audio] capture failed: %s\n",
                         error.what());
        }
    }
    capture_contexts().clear();
#endif
}

} // namespace bbl::pal
