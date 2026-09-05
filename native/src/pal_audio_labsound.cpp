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
#include "pal_audio_handles.hpp"
#include "pal_runtime_trace.hpp"

#include "LabSound/core/AudioContext.h"
#include "LabSound/extended/Logging.h"
#include "LabSound/core/AudioDevice.h"
#include "LabSound/core/AudioParam.h"
#include "LabSound/core/AudioNodeOutput.h"
#include "LabSound/extended/AudioContextLock.h"
#include "LabSound/core/AudioScheduledSourceNode.h"
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
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace bbl::pal {

struct AudioSourceState {
    bool started = false;
    bool completed = false;
};

struct AudioNodeRecord {
    std::shared_ptr<lab::AudioNode> node;
    std::shared_ptr<AudioSourceState> source;
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    bool source_loop = false;
#endif
};

#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
struct AudioBufferRecord {
    std::vector<bbl::js::F32Array> channels;
    lab::AudioBus bus;
    AudioBufferRecord(std::uint32_t channel_count, std::uint32_t frames)
        : bus(static_cast<int>(channel_count), static_cast<int>(frames), false) {}
};
#endif

namespace {

struct AudioGraphNode {
    std::shared_ptr<lab::AudioNode> node;
    std::weak_ptr<AudioNodeRecord> javascript;
    std::shared_ptr<AudioSourceState> source;
    std::vector<lab::AudioNode*> outputs;
    double retire_after = -1.0;
    bool reached = false;
};

struct ContextRecord {
    ContextRecord() = default;
    ContextRecord(ContextRecord&&) = default;
    ContextRecord& operator=(ContextRecord&&) = delete;
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
        if (device) {
            device->stop();
            // The stopped callback no longer needs its destination. LabSound's
            // destination also owns the device, so release this reverse edge
            // while the record and context still retain the destination.
            device->setDestinationNode({});
        }
        nodes.for_each_live([](AudioNodeRecord& record) { record.node.reset(); });
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
    audio_handles::Registry<AudioNodeRecord> nodes;
    AudioNodeHandle destination_handle;
    std::unordered_map<lab::AudioNode*, AudioGraphNode> graph;
    // Reuse one buffer for completed sources, then the reachability walk.
    std::vector<lab::AudioNode*> collection_work;
    bool has_draining_tails = false;
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    audio_handles::Registry<AudioBufferRecord> buffers;
#endif
};

void register_graph_node(ContextRecord& context, const AudioNodeHandle& handle) {
    const auto& value = handle.ownership;
    context.graph.emplace(value->node.get(), AudioGraphNode{
        value->node, value, value->source, {}, -1.0});
}

/** Longest declared tail on the reachable graph. Feedback and unbounded
 * tails stay alive until disconnect/close. Kahn's walk avoids recursive
 * traversal of user-created chains. */
double graph_tail(ContextRecord& context, lab::AudioNode* source, lab::ContextRenderLock& lock) {
    struct Path { std::size_t inputs = 0; double elapsed = 0.0; };
    std::unordered_map<lab::AudioNode*, Path> paths;
    std::vector<lab::AudioNode*> pending{source};
    paths.emplace(source, Path{});
    for (std::size_t index = 0; index < pending.size(); ++index) {
        for (auto* output : context.graph.at(pending[index]).outputs) {
            auto [found, inserted] = paths.try_emplace(output);
            ++found->second.inputs;
            if (inserted) pending.push_back(output);
        }
    }
    pending.clear();
    for (const auto& [node, path] : paths) if (!path.inputs) pending.push_back(node);
    double maximum = 0.0;
    for (std::size_t index = 0; index < pending.size(); ++index) {
        auto* node = pending[index];
        const double tail = node->tailTime(lock) + node->latencyTime(lock);
        if (!std::isfinite(tail) || tail < 0.0) return std::numeric_limits<double>::infinity();
        const double elapsed = paths.at(node).elapsed + tail;
        maximum = std::max(maximum, elapsed);
        for (auto* output : context.graph.at(node).outputs) {
            auto& path = paths.at(output);
            path.elapsed = std::max(path.elapsed, elapsed);
            if (--path.inputs == 0) pending.push_back(output);
        }
    }
    return pending.size() == paths.size() ? maximum : std::numeric_limits<double>::infinity();
}

void detach_outputs(AudioGraphNode& node, lab::ContextGraphLock& lock) {
    for (int index = 0; index < node.node->numberOfOutputs(); ++index) {
        lab::AudioNodeOutput::disconnectAll(lock, node.node->output(index));
    }
    node.outputs.clear();
}

void collect_audio_graph(ContextRecord& context) {
    // Web Audio completion belongs to the control thread. LabSound's update
    // worker can stop between graph changes, so it is not the event pump.
    context.context->dispatchEvents();
    lab::ContextRenderLock render(context.context.get(), "bblite audio collection");
    context.context->handlePreRenderTasks(render);
    const double now = context.context->currentTime();
    auto& pending = context.collection_work;
    pending.clear();
    pending.reserve(context.graph.size());
    context.has_draining_tails = false;
    for (auto& [identity, entry] : context.graph) {
        entry.reached = false;
        if (entry.source && entry.source->completed && !entry.outputs.empty()) {
            if (entry.retire_after < 0.0) entry.retire_after = now + graph_tail(context, identity, render);
            if (now >= entry.retire_after) pending.push_back(identity);
            else context.has_draining_tails = true;
        }
    }
    {
        lab::ContextGraphLock graph(context.context.get(), "bblite completed audio sources");
        for (auto* identity : pending) detach_outputs(context.graph.at(identity), graph);
    }
    pending.clear();
    for (auto& [identity, entry] : context.graph) {
        const bool active = entry.source && entry.source->started && !entry.outputs.empty() &&
            (entry.retire_after < 0.0 || now < entry.retire_after);
        if (!entry.javascript.expired() || active) {
            entry.reached = true;
            pending.push_back(identity);
        }
    }
    for (std::size_t index = 0; index < pending.size(); ++index) {
        for (auto* output : context.graph.at(pending[index]).outputs) {
            auto& entry = context.graph.at(output);
            if (!entry.reached) {
                entry.reached = true;
                pending.push_back(output);
            }
        }
    }
    {
        lab::ContextGraphLock graph(context.context.get(), "bblite discarded audio graph");
        for (auto& [identity, entry] : context.graph) {
            if (!entry.reached) detach_outputs(entry, graph);
        }
    }
    context.context->handlePostRenderTasks(render);
    std::erase_if(context.graph, [](const auto& item) { return !item.second.reached; });
    pending.clear();
}

void invalidate_source_tails(ContextRecord& context, lab::AudioNode* changed) {
    if (!context.has_draining_tails) return;
    std::unordered_multimap<lab::AudioNode*, lab::AudioNode*> inputs;
    for (const auto& [identity, entry] : context.graph) {
        for (auto* output : entry.outputs) inputs.emplace(output, identity);
    }
    std::unordered_set<lab::AudioNode*> reached{changed};
    std::vector<lab::AudioNode*> pending{changed};
    for (std::size_t index = 0; index < pending.size(); ++index) {
        auto* identity = pending[index];
        auto& entry = context.graph.at(identity);
        if (entry.source && entry.source->completed) entry.retire_after = -1.0;
        const auto [first, last] = inputs.equal_range(identity);
        for (auto input = first; input != last; ++input) {
            if (reached.insert(input->second).second) pending.push_back(input->second);
        }
    }
}

template <typename Connect>
void connect_audio_graph(ContextRecord& context, const AudioNodeHandle& source,
                         const AudioNodeHandle& destination, Connect connect) {
    auto& outputs = context.graph.at(source.ownership->node.get()).outputs;
    auto* target = destination.ownership->node.get();
    const bool inserted = std::find(outputs.begin(), outputs.end(), target) == outputs.end();
    if (inserted) outputs.push_back(target);
    try { connect(); }
    catch (...) {
        if (inserted) outputs.pop_back();
        throw;
    }
    if (inserted) invalidate_source_tails(context, source.ownership->node.get());
}

/** A node handle is `(context << 16) | index`, so one lookup finds both. */
using audio_handles::pack;
using audio_handles::context_of;
using audio_handles::index_of;

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

#endif

std::uint32_t next_context_id()
{
    static std::uint32_t next = 1;
    audio_handles::require_context_id(next);
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
std::shared_ptr<lab::AudioNode> require_node(
    ContextRecord& record, AudioNodeHandle node)
{
    const std::uint32_t index = index_of(node.value);
    if (!record.nodes.contains(index, node.ownership) || !node.ownership->node) {
        throw std::runtime_error("Invalid audio node handle.");
    }
    return node.ownership->node;
}

std::shared_ptr<lab::AudioNode> require_node(AudioNodeHandle node)
{
    return require_node(require_context(context_of(node.value)), node);
}

#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
std::shared_ptr<AudioBufferRecord> require_buffer(AudioBufferHandle buffer)
{
    ContextRecord& record = require_context(context_of(buffer.value));
    const std::uint32_t index = index_of(buffer.value);
    if (!record.buffers.contains(index, buffer.ownership)) {
        throw std::runtime_error("Invalid audio buffer handle.");
    }
    return buffer.ownership;
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
    auto buffer = std::make_shared<AudioBufferRecord>(channels, frames);
    buffer->channels.reserve(channels);
    for (std::uint32_t channel = 0; channel < channels; ++channel) {
        buffer->channels.emplace_back(frames, 0.0f);
    }
    buffer->bus.setSampleRate(static_cast<float>(sample_rate));
    for (std::uint32_t channel = 0; channel < channels; ++channel) {
        buffer->bus.setChannelMemory(
            static_cast<int>(channel),
            buffer->channels[channel].data(),
            static_cast<int>(frames));
    }
    auto entry = context_record.buffers.insert(std::move(buffer));
    return AudioBufferHandle{pack(context.value, entry.index), std::move(entry.ownership)};
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
    auto value = std::make_shared<AudioNodeRecord>();
    value->node = std::make_shared<Node>(*record.context);
    if constexpr (std::is_base_of_v<lab::AudioScheduledSourceNode, Node>) {
        value->source = std::make_shared<AudioSourceState>();
        // The PAL pumps events on the control thread. Weak ownership keeps
        // queued completion notifications from retaining the source.
        std::weak_ptr<AudioSourceState> completion = value->source;
        std::static_pointer_cast<Node>(value->node)->setOnEnded([completion] {
            if (auto state = completion.lock()) state->completed = true;
        });
    }
    auto entry = record.nodes.insert(std::move(value));
    AudioNodeHandle handle{pack(context.value, entry.index), std::move(entry.ownership)};
    register_graph_node(record, handle);
    return handle;
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

    record.context = std::make_shared<lab::AudioContext>(capture, false);

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
    auto destination_node =
        capture ? std::static_pointer_cast<lab::AudioNode>(record.recorder)
                : std::static_pointer_cast<lab::AudioNode>(record.destination);
#else
    auto destination_node = std::static_pointer_cast<lab::AudioNode>(record.destination);
#endif
    auto destination_record = std::make_shared<AudioNodeRecord>();
    destination_record->node = std::move(destination_node);
    auto destination_entry = record.nodes.insert(std::move(destination_record));
    record.destination_handle = {pack(id, destination_entry.index), std::move(destination_entry.ownership)};
    register_graph_node(record, record.destination_handle);
    contexts().emplace(id, std::move(record));
    return AudioContextHandle{id};
}

void audio_close_context(AudioContextHandle context)
{
    contexts().erase(context.value);
}

AudioContextHandle audio_create_context(std::shared_ptr<AudioSession>& session) {
    if (!session) session = std::make_shared<AudioSession>();
    const auto context = audio_create_context();
    try {
        session->contexts_.push_back(context);
    } catch (...) {
        audio_close_context(context);
        throw;
    }
    return context;
}

AudioSession::~AudioSession() {
    for (const auto context : contexts_) audio_close_context(context);
}

void audio_collect_finished() {
    for (auto& [id, context] : contexts()) {
        (void)id;
        collect_audio_graph(context);
    }
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
    return require_context(context.value).destination_handle;
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
        auto buffer = require_buffer(handle);
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

bbl::js::F32Array audio_buffer_channel(
    AudioBufferHandle buffer,
    std::uint32_t channel)
{
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    auto record = require_buffer(buffer);
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
    // Alias the bus to the buffer owner: LabSound can keep playing after JS
    // releases its AudioBuffer handle, without dangling channel memory.
    sampled->setBus(std::shared_ptr<lab::AudioBus>(buffer_record, &buffer_record->bus));
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
    if (!std::dynamic_pointer_cast<lab::SampledAudioNode>(
            require_node(record, source))) {
        throw std::runtime_error("Audio node is not a buffer source.");
    }
    source.ownership->source_loop = enabled;
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
    const auto source_node = require_node(record, source);
    const auto destination_node = require_node(record, destination);
    connect_audio_graph(record, source, destination, [&] {
        record.context->connect(destination_node, source_node, 0, 0);
    });
}

void audio_connect_param(AudioNodeHandle source, AudioParamHandle destination)
{
    if (context_of(source.value) != context_of(destination.node.value)) {
        throw std::runtime_error(
            "Audio nodes and parameters from different contexts cannot be connected.");
    }
    ContextRecord& record = require_context(context_of(source.value));
    const auto source_node = require_node(record, source);
    const auto param = require_param(destination);
    connect_audio_graph(record, source, destination.node, [&] {
        record.context->connectParam(param, source_node, 0);
    });
}

void audio_disconnect(AudioNodeHandle node)
{
    ContextRecord& record = require_context(context_of(node.value));
    const auto source = require_node(record, node);
    {
        lab::ContextRenderLock render(record.context.get(), "bblite audio disconnect");
        record.context->handlePreRenderTasks(render);
        {
            lab::ContextGraphLock graph(record.context.get(), "bblite audio disconnect");
            detach_outputs(record.graph.at(source.get()), graph);
        }
        record.context->handlePostRenderTasks(render);
    }
    invalidate_source_tails(record, source.get());
    collect_audio_graph(record);
}

static void audio_node_start_impl(
    AudioNodeHandle node,
    double when,
    double offset,
    double duration,
    int argument_count)
{
#if BBLITE_HAS_AUDIO_OSCILLATOR || BBLITE_HAS_AUDIO_BUFFER_SOURCE
    auto& context = require_context(context_of(node.value));
    lab::ContextRenderLock render(context.context.get(), "bblite audio start");
    const auto source = require_node(context, node);
    if (!node.ownership->source) throw std::runtime_error("Audio node is not a scheduled source.");
    if (node.ownership->source->started) throw std::runtime_error("An AudioScheduledSourceNode can only be started once.");
#if !BBLITE_HAS_AUDIO_BUFFER_SOURCE
    (void)offset;
    (void)duration;
#endif
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    // LabSound deliberately gives SampledAudioNode an absolute-time start
    // overload which is not virtual. Calling through AudioScheduledSourceNode
    // starts only the base scheduler and never enqueues the sample, producing
    // a perfectly connected but silent buffer source. Preserve Web Audio's
    // common `start(when)` surface by dispatching this concrete node first.
    if (auto sampled = std::dynamic_pointer_cast<lab::SampledAudioNode>(source)) {
        const bool loop = node.ownership->source_loop;
        if (argument_count == 1) {
            sampled->start(static_cast<float>(when), loop ? -1 : 0);
        } else if (argument_count == 2) {
            sampled->start(
                static_cast<float>(when),
                static_cast<float>(offset),
                loop ? -1 : 0);
        } else {
            sampled->start(
                static_cast<float>(when),
                static_cast<float>(offset),
                static_cast<float>(duration),
                0);
        }
        node.ownership->source->started = true;
        if (runtime_trace_enabled()) {
            std::fprintf(
                stderr,
                "[bblite trace] audio source=%u start=%.6f offset=%.6f duration=%.6f\n",
                node.value, when, offset, duration);
        }
        return;
    }
#endif
    if (argument_count > 1) {
        throw std::runtime_error(
            "Audio source offset and duration require a sampled source.");
    }
    auto scheduled =
        std::dynamic_pointer_cast<lab::AudioScheduledSourceNode>(source);
    if (!scheduled) {
        throw std::runtime_error("Audio node is not a scheduled source.");
    }
    scheduled->start(static_cast<float>(when));
    node.ownership->source->started = true;
    if (runtime_trace_enabled()) {
        std::fprintf(
            stderr,
            "[bblite trace] audio source=%u start=%.6f\n",
            node.value, when);
    }
#else
    (void)node;
    (void)when;
    (void)offset;
    (void)duration;
    (void)argument_count;
    throw std::runtime_error("Scheduled audio sources were not compiled.");
#endif
}

void audio_node_start(AudioNodeHandle node, double when)
{
    audio_node_start_impl(node, when, 0.0, 0.0, 1);
}

void audio_node_start(AudioNodeHandle node, double when, double offset)
{
    audio_node_start_impl(node, when, offset, 0.0, 2);
}

void audio_node_start(
    AudioNodeHandle node,
    double when,
    double offset,
    double duration)
{
    audio_node_start_impl(node, when, offset, duration, 3);
}

void audio_node_stop(AudioNodeHandle node, double when)
{
#if BBLITE_HAS_AUDIO_OSCILLATOR || BBLITE_HAS_AUDIO_BUFFER_SOURCE
    auto& context = require_context(context_of(node.value));
    lab::ContextRenderLock render(context.context.get(), "bblite audio stop");
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

namespace {
void render_audio_capture([[maybe_unused]] std::uint32_t id) noexcept
{
#if BBLITE_HAS_AUDIO_CAPTURE
    try {
        const CaptureRequest& request = capture_request();
        if (!request.wanted()) return;
        auto found = contexts().find(id);
        if (found == contexts().end() || !found->second.recorder) return;
        ContextRecord& record = found->second;
        const int frames = static_cast<int>(record.sample_rate * request.seconds);
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
        std::fprintf(stderr, "[bblite audio] capture failed: %s\n", error.what());
    }
#endif
}
} // namespace

void AudioSession::finish() noexcept {
    for (const auto context : contexts_) {
        render_audio_capture(context.value);
        audio_close_context(context);
    }
    contexts_.clear();
}

} // namespace bbl::pal
