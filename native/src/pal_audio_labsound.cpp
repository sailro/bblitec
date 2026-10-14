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

#include <bblite/features/has_audio_biquad_filter.hpp>
#include <bblite/features/has_audio_buffer_source.hpp>
#include <bblite/features/has_audio_decode_file.hpp>
#include <bblite/features/has_audio_media_element.hpp>
#include <bblite/features/has_audio_media_stream.hpp>
#include <bblite/features/has_audio_oscillator.hpp>
#include <bblite/features/has_audio_panner.hpp>
#include <bblite/features/has_audio_stereo_panner.hpp>
#include <bblite/features/has_audio_analyser.hpp>
#include <bblite/features/workers.hpp>

#include <bblite/js_error.hpp>
#include <bblite/pal_audio.hpp>
#include <bblite/teardown.hpp>

#include <bblite/pal.hpp>
#if BBLITE_WORKERS
#include <bblite/pal_event_loop.hpp>
#endif
#if BBLITE_HAS_AUDIO_MEDIA_ELEMENT
#if !BBLITE_WORKERS || !BBLITE_HAS_AUDIO_BUFFER_SOURCE || !BBLITE_HAS_AUDIO_DECODE_FILE
#error "audio:media-element needs an application realm, buffer sources and decoding."
#endif
#include <bblite/pal_audio_element.hpp>
#include <bblite/pal_native_workers.hpp>
#include <bblite/pal_packaged_responses.hpp>
#endif

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
#if BBLITE_HAS_AUDIO_PANNER
#include "LabSound/core/AudioListener.h"
#include "LabSound/core/PannerNode.h"
#endif
#if BBLITE_HAS_AUDIO_STEREO_PANNER
#include "LabSound/core/StereoPannerNode.h"
#endif
#if BBLITE_HAS_AUDIO_ANALYSER
#include "LabSound/core/AnalyserNode.h"
#endif
#if BBLITE_HAS_AUDIO_MEDIA_STREAM
#include <bblite/pal_media_stream.hpp>
#include "LabSound/core/AudioNodeInput.h"
#include <mutex>
#endif
#if BBLITE_AUDIO_CAPTURE
#include "LabSound/extended/RecorderNode.h"
#endif
#if BBLITE_HAS_AUDIO_DECODE_FILE
#include "pal_audio_decode.hpp"
#endif

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <limits>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace bbl::pal {

struct AudioContextState {
    enum class Status { Running, Suspended, Closed };
    Status status = Status::Running;
    double sample_rate = 48000.0;
    double closed_time = 0.0;
#if BBLITE_WORKERS
    bool polling_events = false;
#endif
};

struct AudioSourceState {
    bool started = false;
    bool completed = false;
#if BBLITE_WORKERS
    std::weak_ptr<EventLoop::Inbox> inbox;
    std::uint64_t completion = 0;
    bool event_pull = false;
    void post_completion() {
        const auto id = std::exchange(completion, 0);
        if (id)
            if (auto target = inbox.lock())
                target->post(std::make_unique<CompletionEvent>(id));
    }
#endif
};

struct AudioNodeRecord {
    std::shared_ptr<lab::AudioNode> node;
    std::shared_ptr<AudioSourceState> source;
#if BBLITE_WORKERS
    std::array<PlatformEventListeners<void()>, 2> ended;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(ended); }
#endif
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    bool source_loop = false;
    double source_loop_start = 0.0;
    double source_loop_end = 0.0;
    AudioBufferHandle buffer{};
#endif
#if BBLITE_HAS_AUDIO_MEDIA_STREAM
    /** A MediaStreamAudioDestinationNode's `stream`. */
    MediaStreamHandle stream;
#endif
};

#if BBLITE_HAS_AUDIO_MEDIA_STREAM
/**
 * The stereo samples a stream destination renders, read by the stream sources
 * of any context (each its own audio thread, or offline renders in turn). A
 * reader starts at the position it was created at and keeps at most the last
 * `capacity` frames behind.
 */
class MediaStreamAudioTap {
public:
    static constexpr std::size_t capacity = std::size_t{1} << 16;
    explicit MediaStreamAudioTap(double sample_rate)
        : sample_rate_(sample_rate), samples_(2 * capacity) {}
    [[nodiscard]] double sample_rate() const noexcept { return sample_rate_; }
    [[nodiscard]] std::uint64_t position() const {
        std::lock_guard lock(mutex_);
        return written_;
    }
    /** Appends `frames` stereo frames; null channels write silence. */
    void write(const float* left, const float* right, int frames) {
        std::lock_guard lock(mutex_);
        for (int frame = 0; frame < frames; ++frame) {
            const auto slot = static_cast<std::size_t>(
                                  (written_ + static_cast<std::uint64_t>(frame)) % capacity) *
                              2;
            samples_[slot] = left ? left[frame] : 0.0f;
            samples_[slot + 1] = right ? right[frame] : 0.0f;
        }
        written_ += static_cast<std::uint64_t>(frames);
    }
    /** Copies up to `frames` frames after `cursor` and advances it; returns how many. */
    int read(std::uint64_t& cursor, float* left, float* right, int frames) {
        std::lock_guard lock(mutex_);
        if (written_ - cursor > capacity)
            cursor = written_ - capacity;
        const auto count = static_cast<int>(
            std::min<std::uint64_t>(static_cast<std::uint64_t>(frames), written_ - cursor));
        for (int frame = 0; frame < count; ++frame) {
            const auto slot =
                static_cast<std::size_t>((cursor + static_cast<std::uint64_t>(frame)) % capacity) *
                2;
            left[frame] = samples_[slot];
            right[frame] = samples_[slot + 1];
        }
        cursor += static_cast<std::uint64_t>(count);
        return count;
    }

private:
    const double sample_rate_;
    mutable std::mutex mutex_;
    std::vector<float> samples_;
    std::uint64_t written_ = 0;
};
#endif

#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
struct AudioBufferRecord {
    std::uint32_t handle = 0;
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
    /** Every node an edge reaches: the union of the two lists below. */
    std::vector<lab::AudioNode*> outputs;
    /** Nodes whose input this node feeds, and nodes one of whose parameters it drives. */
    std::vector<lab::AudioNode*> node_edges;
    std::vector<lab::AudioNode*> param_edges;
    double retire_after = -1.0;
    bool reached = false;
    /** A stream destination: the context pulls it every quantum. */
    bool automatic_pull = false;
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
        for (const auto& [identity, entry] : graph) {
            (void)identity;
            if (entry.automatic_pull)
                context->removeAutomaticPullNode(entry.node);
        }
#if BBLITE_WORKERS
        for (const auto& [identity, entry] : graph) {
            (void)identity;
            if (entry.source && entry.source->event_pull)
                context->removeAutomaticPullNode(entry.node);
        }
        if (context) {
            lab::ContextRenderLock render(context.get(), "bblite audio event teardown");
            context->handlePreRenderTasks(render);
        }
#endif
        nodes.for_each_live([](AudioNodeRecord& record) { record.node.reset(); });
    }

    std::shared_ptr<lab::AudioContext> context;
    std::shared_ptr<AudioContextState> state = std::make_shared<AudioContextState>();
    std::shared_ptr<lab::AudioDestinationNode> destination;
    std::shared_ptr<detail::AudioDeviceSdl3> device;
    /**
     * A capture context records through the pin's own answer to the same
     * question -- a recorder tapping the destination's input -- because
     * `offlineRender` reuses one quantum-sized bus rather than
     * accumulating.
     */
#if BBLITE_AUDIO_CAPTURE
    std::shared_ptr<lab::RecorderNode> recorder;
#endif
    /** The stream a new context requests; `channels`/`sample_rate` are what it got. */
    static constexpr int requested_channels = 2;
    static constexpr double requested_sample_rate = 48000.0;
    int channels = requested_channels;
    /**
     * Not derivable from `context->sampleRate()`: that reads the
     * destination's `SamplingInfo`, which is zero on an offline context
     * until a render has run.
     */
    double sample_rate = requested_sample_rate;
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
    context.graph.emplace(value->node.get(),
                          AudioGraphNode{value->node, value, value->source, {}, {}, {}, -1.0});
}

/** Longest declared tail on the reachable graph. Feedback and unbounded
 * tails stay alive until disconnect/close. Kahn's walk avoids recursive
 * traversal of user-created chains. */
double graph_tail(ContextRecord& context, lab::AudioNode* source, lab::ContextRenderLock& lock) {
    struct Path {
        std::size_t inputs = 0;
        double elapsed = 0.0;
    };
    std::unordered_map<lab::AudioNode*, Path> paths;
    std::vector<lab::AudioNode*> pending{source};
    paths.emplace(source, Path{});
    for (std::size_t index = 0; index < pending.size(); ++index) {
        for (auto* output : context.graph.at(pending[index]).outputs) {
            auto [found, inserted] = paths.try_emplace(output);
            ++found->second.inputs;
            if (inserted)
                pending.push_back(output);
        }
    }
    pending.clear();
    for (const auto& [node, path] : paths)
        if (!path.inputs)
            pending.push_back(node);
    double maximum = 0.0;
    for (std::size_t index = 0; index < pending.size(); ++index) {
        auto* node = pending[index];
        const double tail = node->tailTime(lock) + node->latencyTime(lock);
        if (!std::isfinite(tail) || tail < 0.0)
            return std::numeric_limits<double>::infinity();
        const double elapsed = paths.at(node).elapsed + tail;
        maximum = std::max(maximum, elapsed);
        for (auto* output : context.graph.at(node).outputs) {
            auto& path = paths.at(output);
            path.elapsed = std::max(path.elapsed, elapsed);
            if (--path.inputs == 0)
                pending.push_back(output);
        }
    }
    return pending.size() == paths.size() ? maximum : std::numeric_limits<double>::infinity();
}

/**
 * Drop `node`'s rendered edges. A disconnect does so for JavaScript too; the
 * collector's retirement of a finished source or an unreachable node does
 * not: the edges stay connected as JavaScript sees them, so a later
 * `disconnect(destination)` still finds its edge.
 */
void detach_outputs(AudioGraphNode& node, lab::ContextGraphLock& lock, bool disconnect = true) {
    for (int index = 0; index < node.node->numberOfOutputs(); ++index) {
        lab::AudioNodeOutput::disconnectAll(lock, node.node->output(index));
    }
    node.outputs.clear();
    if (disconnect) {
        node.node_edges.clear();
        node.param_edges.clear();
    }
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
#if BBLITE_WORKERS
        if (entry.source && entry.source->completed && entry.source->event_pull) {
            context.context->removeAutomaticPullNode(entry.node);
            entry.source->event_pull = false;
        }
#endif
        if (entry.source && entry.source->completed && !entry.outputs.empty()) {
            if (entry.retire_after < 0.0)
                entry.retire_after = now + graph_tail(context, identity, render);
            if (now >= entry.retire_after)
                pending.push_back(identity);
            else
                context.has_draining_tails = true;
        }
    }
    {
        lab::ContextGraphLock graph(context.context.get(), "bblite completed audio sources");
        for (auto* identity : pending)
            detach_outputs(context.graph.at(identity), graph, false);
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
            if (!entry.reached)
                detach_outputs(entry, graph, false);
        }
    }
    for (auto& [identity, entry] : context.graph)
        if (!entry.reached && entry.automatic_pull)
            context.context->removeAutomaticPullNode(entry.node);
    context.context->handlePostRenderTasks(render);
    std::erase_if(context.graph, [](const auto& item) { return !item.second.reached; });
    pending.clear();
}

void invalidate_source_tails(ContextRecord& context, lab::AudioNode* changed) {
    if (!context.has_draining_tails)
        return;
    std::unordered_multimap<lab::AudioNode*, lab::AudioNode*> inputs;
    for (const auto& [identity, entry] : context.graph) {
        for (auto* output : entry.outputs)
            inputs.emplace(output, identity);
    }
    std::unordered_set<lab::AudioNode*> reached{changed};
    std::vector<lab::AudioNode*> pending{changed};
    for (std::size_t index = 0; index < pending.size(); ++index) {
        auto* identity = pending[index];
        auto& entry = context.graph.at(identity);
        if (entry.source && entry.source->completed)
            entry.retire_after = -1.0;
        const auto [first, last] = inputs.equal_range(identity);
        for (auto input = first; input != last; ++input) {
            if (reached.insert(input->second).second)
                pending.push_back(input->second);
        }
    }
}

/** Add `target` to `edges` once; whether it was added. */
bool add_edge(std::vector<lab::AudioNode*>& edges, lab::AudioNode* target) {
    if (std::find(edges.begin(), edges.end(), target) != edges.end())
        return false;
    edges.push_back(target);
    return true;
}

template <typename Connect>
void connect_audio_graph(ContextRecord& context, const AudioNodeHandle& source,
                         const AudioNodeHandle& destination, bool to_parameter, Connect connect) {
    auto& entry = context.graph.at(source.ownership->node.get());
    auto* target = destination.ownership->node.get();
    auto& kind = to_parameter ? entry.param_edges : entry.node_edges;
    const bool inserted = add_edge(entry.outputs, target);
    const bool kind_inserted = add_edge(kind, target);
    try {
        connect();
    } catch (...) {
        if (inserted)
            entry.outputs.pop_back();
        if (kind_inserted)
            kind.pop_back();
        throw;
    }
    if (inserted)
        invalidate_source_tails(context, source.ownership->node.get());
}

/** A node handle is `(context << 16) | index`, so one lookup finds both. */
using audio_handles::context_of;
using audio_handles::index_of;
using audio_handles::pack;

std::unordered_map<std::uint32_t, ContextRecord>& contexts() {
    static std::unordered_map<std::uint32_t, ContextRecord> map;
    return map;
}

#if BBLITE_WORKERS
/** LabSound's automatic event dispatch is disabled. A bounded realm timer
 * also pumps completion for applications with no rendering frame. */
void poll_audio_events(std::uint32_t id) {
    const auto found = contexts().find(id);
    if (found == contexts().end())
        return;
    auto& context = found->second;
    if (context.state->polling_events)
        return;
    const bool pending =
        std::any_of(context.graph.begin(), context.graph.end(), [](const auto& entry) {
            return entry.second.source && entry.second.source->completion != 0;
        });
    if (!pending)
        return;
    context.state->polling_events = true;
    EventLoop::current().set_timeout(
        [id] {
            const auto active = contexts().find(id);
            if (active == contexts().end())
                return;
            active->second.state->polling_events = false;
            collect_audio_graph(active->second);
            poll_audio_events(id);
        },
        8.0);
}

void retain_audio_completion(const AudioNodeHandle& node) {
    const auto& record = node.ownership;
    const auto& state = record->source;
    if (!state || !state->started || state->completed || state->completion ||
        (record->ended[0].empty() && record->ended[1].empty()))
        return;
    auto& loop = EventLoop::current();
    if (const auto previous = state->inbox.lock(); previous && previous != loop.inbox())
        throw std::logic_error("An audio listener belongs to another realm.");
    auto& audio = contexts().at(context_of(node.value));
    const auto context = audio.state;
    auto handler = js::make_closure(
        std::tuple{node, context}, [](auto& captures, std::unique_ptr<ExternalEvent>) {
            const auto& source = std::get<0>(captures);
            if (std::get<1>(captures)->status == AudioContextState::Status::Closed)
                return;
            auto& owner = EventLoop::current();
            // Listener snapshots and removals use the shared DOM registry rules.
            // Delivery is a queued task, outside all audio graph locks/iteration.
            for (auto& listeners : source.ownership->ended)
                dispatch_platform_event(owner, listeners);
        });
    state->inbox = loop.inbox();
    state->completion =
        loop.register_completion(std::move(handler), [state] { state->completion = 0; });
    // Scheduled sources must advance even without an output connection.
    // LabSound's render quantum already avoids processing a node twice.
    audio.context->addAutomaticPullNode(record->node);
    state->event_pull = true;
    poll_audio_events(context_of(node.value));
}

#endif

/**
 * `BBLITE_AUDIO_CAPTURE`. Audio produces no pixels, so the parity
 * harness has nothing to screenshot -- but an offline render is a byte
 * string. With the variable set, every context the scene creates renders
 * offline, so the graph is identical and nothing runs in real time.
 */
#if BBLITE_AUDIO_CAPTURE
struct CaptureRequest {
    std::string path;
    double seconds = 1.0;
    bool wanted() const { return !path.empty(); }
};

const CaptureRequest& capture_request() {
    static const CaptureRequest request = [] {
        CaptureRequest value;
        value.path = environment_variable("BBLITE_AUDIO_CAPTURE");
        const std::string seconds = environment_variable("BBLITE_AUDIO_CAPTURE_SECONDS");
        if (!seconds.empty()) {
            value.seconds = std::strtod(seconds.c_str(), nullptr);
            if (!(value.seconds > 0.0))
                value.seconds = 1.0;
        }
        return value;
    }();
    return request;
}

#endif

std::uint32_t next_context_id() {
    static std::uint32_t next = 1;
    audio_handles::require_context_id(next);
    return next++;
}

ContextRecord& require_context(std::uint32_t id) {
    auto found = contexts().find(id);
    if (found == contexts().end()) {
        throw std::runtime_error("Invalid audio context handle " + std::to_string(id) + ".");
    }
    return found->second;
}

#if BBLITE_WORKERS
bool release_unobserved_audio_completion(const AudioNodeHandle& node) {
    auto& record = *node.ownership;
    if (!record.ended[0].empty() || !record.ended[1].empty() || !record.source->completion)
        return false;
    EventLoop::current().cancel_completion(record.source->completion);
    require_context(context_of(node.value)).context->removeAutomaticPullNode(record.node);
    record.source->event_pull = false;
    return true;
}
#endif

/** The node an already-resolved context holds at a handle's index. */
std::shared_ptr<lab::AudioNode> require_node(ContextRecord& record, AudioNodeHandle node) {
    const std::uint32_t index = index_of(node.value);
    if (!record.nodes.contains(index, node.ownership) || !node.ownership->node) {
        throw std::runtime_error("Invalid audio node handle.");
    }
    return node.ownership->node;
}

std::shared_ptr<lab::AudioNode> require_node(AudioNodeHandle node) {
    return require_node(require_context(context_of(node.value)), node);
}

#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
std::shared_ptr<AudioBufferRecord> require_buffer(AudioBufferHandle buffer) {
    // Buffer data outlives its creating context. Validate its owned record,
    // which retains the packed identity even after the context registry dies.
    if (!buffer.value || !buffer.ownership || buffer.ownership->handle != buffer.value) {
        throw std::runtime_error("Invalid audio buffer handle.");
    }
    return buffer.ownership;
}

AudioBufferHandle allocate_audio_buffer(AudioContextHandle context, std::uint32_t channels,
                                        std::uint32_t frames, double sample_rate) {
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
        buffer->bus.setChannelMemory(static_cast<int>(channel), buffer->channels[channel].data(),
                                     static_cast<int>(frames));
    }
    auto entry = context_record.buffers.insert(std::move(buffer));
    entry.ownership->handle = pack(context.value, entry.index);
    return AudioBufferHandle{entry.ownership->handle, std::move(entry.ownership)};
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
constexpr const char* spelling(AudioParamName name) {
    switch (name) {
    case AudioParamName::Gain:
        return "gain";
    case AudioParamName::Frequency:
        return "frequency";
    case AudioParamName::Detune:
        return "detune";
    case AudioParamName::Q:
        return "Q";
    case AudioParamName::Pan:
        return "pan";
    case AudioParamName::PlaybackRate:
        return "playbackRate";
    case AudioParamName::PositionX:
        return "positionX";
    case AudioParamName::PositionY:
        return "positionY";
    case AudioParamName::PositionZ:
        return "positionZ";
    case AudioParamName::OrientationX:
        return "orientationX";
    case AudioParamName::OrientationY:
        return "orientationY";
    case AudioParamName::OrientationZ:
        return "orientationZ";
    default:
        return nullptr;
    }
}

#if BBLITE_HAS_AUDIO_PANNER
/** The context listener's parameter a `Listener*` name selects, or none. */
std::shared_ptr<lab::AudioParam> listener_param(lab::AudioListener& listener, AudioParamName name) {
    switch (name) {
    case AudioParamName::ListenerPositionX:
        return listener.positionX();
    case AudioParamName::ListenerPositionY:
        return listener.positionY();
    case AudioParamName::ListenerPositionZ:
        return listener.positionZ();
    case AudioParamName::ListenerForwardX:
        return listener.forwardX();
    case AudioParamName::ListenerForwardY:
        return listener.forwardY();
    case AudioParamName::ListenerForwardZ:
        return listener.forwardZ();
    case AudioParamName::ListenerUpX:
        return listener.upX();
    case AudioParamName::ListenerUpY:
        return listener.upY();
    case AudioParamName::ListenerUpZ:
        return listener.upZ();
    default:
        return nullptr;
    }
}
#endif

std::shared_ptr<lab::AudioParam> require_param(AudioParamHandle handle) {
#if BBLITE_HAS_AUDIO_PANNER
    if (handle.name >= AudioParamName::ListenerPositionX) {
        require_node(handle.node);
        auto param = listener_param(
            *require_context(context_of(handle.node.value)).context->listener(), handle.name);
        if (!param)
            throw std::runtime_error("The audio listener has no such parameter.");
        return param;
    }
#endif
    if (!spelling(handle.name))
        throw std::runtime_error("Audio node has no such parameter.");
    auto param = require_node(handle.node)->param(spelling(handle.name));
    if (!param) {
        throw std::runtime_error("Audio node has no such parameter.");
    }
    return param;
}

#if BBLITE_HAS_AUDIO_OSCILLATOR
lab::OscillatorType to_lab(OscillatorWave wave) {
    switch (wave) {
    case OscillatorWave::Sine:
        return lab::OscillatorType::SINE;
    case OscillatorWave::Square:
        return lab::OscillatorType::SQUARE;
    case OscillatorWave::Sawtooth:
        return lab::OscillatorType::SAWTOOTH;
    case OscillatorWave::Triangle:
        return lab::OscillatorType::TRIANGLE;
    }
    throw std::runtime_error("Unhandled oscillator wave.");
}
#endif

#if BBLITE_HAS_AUDIO_BIQUAD_FILTER
lab::FilterType to_lab(BiquadFilterKind kind) {
    switch (kind) {
    case BiquadFilterKind::Lowpass:
        return lab::FilterType::LOWPASS;
    case BiquadFilterKind::Highpass:
        return lab::FilterType::HIGHPASS;
    case BiquadFilterKind::Bandpass:
        return lab::FilterType::BANDPASS;
    case BiquadFilterKind::Lowshelf:
        return lab::FilterType::LOWSHELF;
    case BiquadFilterKind::Highshelf:
        return lab::FilterType::HIGHSHELF;
    case BiquadFilterKind::Peaking:
        return lab::FilterType::PEAKING;
    case BiquadFilterKind::Notch:
        return lab::FilterType::NOTCH;
    case BiquadFilterKind::Allpass:
        return lab::FilterType::ALLPASS;
    }
    throw std::runtime_error("Unhandled biquad filter kind.");
}
#endif

/** Registers a constructed node in its context's handles and graph. */
AudioNodeHandle insert_node(AudioContextHandle context, ContextRecord& record,
                            std::shared_ptr<AudioNodeRecord> value) {
    auto entry = record.nodes.insert(std::move(value));
    AudioNodeHandle handle{pack(context.value, entry.index), std::move(entry.ownership)};
    register_graph_node(record, handle);
    return handle;
}

template <typename Node> AudioNodeHandle create_node(AudioContextHandle context) {
    ContextRecord& record = require_context(context.value);
    auto value = js::make_gc_shared<AudioNodeRecord>();
    value->node = std::make_shared<Node>(*record.context);
    if constexpr (std::is_base_of_v<lab::AudioScheduledSourceNode, Node>) {
        value->source = std::make_shared<AudioSourceState>();
        // The PAL pumps events on the control thread. Weak ownership keeps
        // queued completion notifications from retaining the source.
        std::weak_ptr<AudioSourceState> completion = value->source;
        std::static_pointer_cast<Node>(value->node)->setOnEnded([completion] {
            if (auto state = completion.lock()) {
                state->completed = true;
#if BBLITE_WORKERS
                state->post_completion();
#endif
            }
        });
    }
    return insert_node(context, record, std::move(value));
}

#if BBLITE_HAS_AUDIO_MEDIA_STREAM
/** A stereo node descriptor with one output. */
const lab::AudioNodeDescriptor& stereo_node_descriptor() {
    static const lab::AudioNodeDescriptor descriptor{nullptr, nullptr, 2};
    return descriptor;
}

/**
 * MediaStreamAudioDestinationNode: a sink that renders its stereo input into
 * its stream's tap every quantum, connected or not, while the context pulls it.
 */
class StreamDestinationNode final : public lab::AudioNode {
public:
    StreamDestinationNode(lab::AudioContext& context, std::shared_ptr<MediaStreamAudioTap> tap)
        : lab::AudioNode(context, stereo_node_descriptor()), tap_(std::move(tap)) {
        _self->m_channelCount = 2;
        _self->m_channelCountMode = lab::ChannelCountMode::Explicit;
        _self->m_channelInterpretation = lab::ChannelInterpretation::Speakers;
        addInput(std::make_unique<lab::AudioNodeInput>(this));
        initialize();
    }
    ~StreamDestinationNode() override { uninitialize(); }
    const char* name() const override { return "MediaStreamAudioDestination"; }
    void process(lab::ContextRenderLock& render, int frames) override {
        auto* input = this->input(0)->bus(render);
        const int channels = input && this->input(0)->isConnected() ? input->numberOfChannels() : 0;
        // Speaker up-mix: mono feeds both channels.
        if (channels > 0)
            tap_->write(input->channel(0)->data(), input->channel(channels > 1 ? 1 : 0)->data(),
                        frames);
        else
            tap_->write(nullptr, nullptr, frames);
        output(0)->bus(render)->zero();
    }
    void reset(lab::ContextRenderLock&) override {}

private:
    double tailTime(lab::ContextRenderLock&) const override { return 0; }
    double latencyTime(lab::ContextRenderLock&) const override { return 0; }
    std::shared_ptr<MediaStreamAudioTap> tap_;
};

/**
 * MediaStreamAudioSourceNode: its track's destination audio from where the
 * track's tap stood when the node was created; silence while the track is
 * disabled or ended, or until audio arrives.
 */
class StreamSourceNode final : public lab::AudioNode {
public:
    StreamSourceNode(lab::AudioContext& context, MediaStreamTrackHandle track)
        : lab::AudioNode(context, stereo_node_descriptor()), track_(std::move(track)),
          cursor_(track_->audio->position()) {
        _self->m_channelCountMode = lab::ChannelCountMode::Explicit;
        initialize();
    }
    ~StreamSourceNode() override { uninitialize(); }
    const char* name() const override { return "MediaStreamAudioSource"; }
    void process(lab::ContextRenderLock& render, int frames) override {
        auto* bus = output(0)->bus(render);
        float* left = bus->channel(0)->mutableData();
        float* right = bus->channel(1)->mutableData();
        int copied = track_->audio->read(cursor_, left, right, frames);
        if (!track_->state->live.load() || !track_->state->enabled.load())
            copied = 0;
        std::fill(left + copied, left + frames, 0.0f);
        std::fill(right + copied, right + frames, 0.0f);
    }
    void reset(lab::ContextRenderLock&) override {}

private:
    double tailTime(lab::ContextRenderLock&) const override { return 0; }
    double latencyTime(lab::ContextRenderLock&) const override { return 0; }
    MediaStreamTrackHandle track_;
    std::uint64_t cursor_;
};
#endif

/** Peak and RMS in one walk over the captured bus. */
#if BBLITE_AUDIO_CAPTURE
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
bool write_float_wav(const std::string& path, const lab::AudioBus& bus, double sample_rate) {
    const int channels = bus.numberOfChannels();
    const int frames = bus.length();
    if (channels <= 0 || frames <= 0)
        return false;

    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    if (!file)
        return false;

    const std::uint32_t data_bytes =
        static_cast<std::uint32_t>(frames) * static_cast<std::uint32_t>(channels) * 4u;
    const std::uint32_t rate = static_cast<std::uint32_t>(sample_rate);
    const auto u32 = [&file](std::uint32_t v) { file.write(reinterpret_cast<const char*>(&v), 4); };
    const auto u16 = [&file](std::uint16_t v) { file.write(reinterpret_cast<const char*>(&v), 2); };

    file.write("RIFF", 4);
    u32(36u + data_bytes);
    file.write("WAVE", 4);
    file.write("fmt ", 4);
    u32(16u);
    u16(3); // IEEE float
    u16(static_cast<std::uint16_t>(channels));
    u32(rate);
    u32(rate * static_cast<std::uint32_t>(channels) * 4u); // byte rate
    u16(static_cast<std::uint16_t>(channels * 4));         // block align
    u16(32);                                               // bits per sample
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

CaptureStats measure(const lab::AudioBus& bus) {
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
    if (count > 0.0)
        stats.rms = std::sqrt(sum / count);
    return stats;
}
#endif

} // namespace

namespace {
/** The stream a new context asks for: the record's own rate and width. */
lab::AudioStreamConfig requested_output() {
    lab::AudioStreamConfig out_config;
    out_config.device_index = 0;
    out_config.desired_channels = static_cast<std::uint32_t>(ContextRecord::requested_channels);
    out_config.desired_samplerate = static_cast<float>(ContextRecord::requested_sample_rate);
    return out_config;
}

/** Whether `BBLITE_AUDIO_CAPTURE` asks for offline rendering, which opens no device. */
bool audio_capture_requested() {
#if BBLITE_AUDIO_CAPTURE
    return capture_request().wanted();
#else
    return !environment_variable("BBLITE_AUDIO_CAPTURE").empty();
#endif
}
} // namespace

void audio_announce_subsystem() {
    if (!audio_capture_requested())
        detail::SdlAudioSubsystem::instance().announce();
}

void audio_initialize_subsystem() {
    if (!audio_capture_requested())
        detail::SdlAudioSubsystem::instance().initialize();
}

bool audio_begin_context() {
    require_runtime_execution("audio device creation");
    // LabSound ships rxi's logger at TRACE, which floods stderr from the
    // graph-update thread and the device it opens. Warnings and errors still
    // surface; the lower levels are opt-in diagnostics.
    const std::string log_level = environment_variable("BBLITE_AUDIO_LOG");
    log_set_level(log_level == "trace"   ? LOGLEVEL_TRACE
                  : log_level == "debug" ? LOGLEVEL_DEBUG
                  : log_level == "info"  ? LOGLEVEL_INFO
                  : log_level == "error" ? LOGLEVEL_ERROR
                                         : LOGLEVEL_WARN);
    if (audio_capture_requested()) {
#if BBLITE_AUDIO_CAPTURE
        return true;
#else
        throw std::runtime_error("Audio capture was not compiled. Configure with "
                                 "BBLITE_AUDIO_CAPTURE=ON.");
#endif
    }
    detail::SdlAudioSubsystem::instance().prepare();
    return false;
}

std::shared_ptr<AudioPlaybackDevice> audio_open_device(bool capture) {
    if (capture)
        return nullptr;
    std::shared_ptr<AudioPlaybackDevice> device;
    if (detail::SdlAudioSubsystem::instance().available())
        device =
            std::make_shared<AudioPlaybackDevice>(lab::AudioStreamConfig{}, requested_output());
    if (!device || !device->opened()) {
        throw std::runtime_error("Audio: SDL could not open a playback device. bblitec has no "
                                 "silent fallback -- an unavailable device is the answer.");
    }
    return device;
}

namespace {
/** A null `device` is a capture context, which renders offline; a device is always open. */
AudioContextHandle create_context(const std::shared_ptr<AudioPlaybackDevice>& device) {
    [[maybe_unused]] const bool capture = !device;
    const std::uint32_t id = next_context_id();
    ContextRecord record;
    record.context = std::make_shared<lab::AudioContext>(capture, false);

#if BBLITE_AUDIO_CAPTURE
    if (capture) {
        const lab::AudioStreamConfig in_config{};
        const lab::AudioStreamConfig out_config = requested_output();
        record.destination = std::make_shared<lab::AudioDestinationNode>(
            *record.context, std::make_shared<lab::AudioDevice_Null>(in_config, out_config));
        record.context->setDestinationNode(record.destination);
        record.recorder = std::make_shared<lab::RecorderNode>(*record.context, out_config);
        record.context->connect(record.destination, record.recorder, 0, 0);
        record.recorder->startRecording();
    } else
#endif
    {
        // The device may have opened at a different rate or width than
        // asked for; the graph runs at what it got.
        record.sample_rate = device->getOutputConfig().desired_samplerate;
        record.channels = static_cast<int>(device->getOutputConfig().desired_channels);
        record.destination = std::make_shared<lab::AudioDestinationNode>(*record.context, device);
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
#if BBLITE_AUDIO_CAPTURE
    auto destination_node = capture ? std::static_pointer_cast<lab::AudioNode>(record.recorder)
                                    : std::static_pointer_cast<lab::AudioNode>(record.destination);
#else
    auto destination_node = std::static_pointer_cast<lab::AudioNode>(record.destination);
#endif
    auto destination_record = std::make_shared<AudioNodeRecord>();
    destination_record->node = std::move(destination_node);
    auto destination_entry = record.nodes.insert(std::move(destination_record));
    record.destination_handle = {pack(id, destination_entry.index),
                                 std::move(destination_entry.ownership)};
    register_graph_node(record, record.destination_handle);
    record.state->sample_rate = record.sample_rate;
    AudioContextHandle handle{id, record.state};
    contexts().emplace(id, std::move(record));
    return handle;
}
} // namespace

AudioContextHandle audio_create_context() {
    return create_context(audio_open_device(audio_begin_context()));
}

void audio_close_context(AudioContextHandle context) {
    const auto found = contexts().find(context.value);
    if (found == contexts().end())
        return;
    auto& record = found->second;
    if (record.device)
        record.device->stop();
    record.state->closed_time = record.context->currentTime();
    record.state->status = AudioContextState::Status::Closed;
#if BBLITE_WORKERS
    for (auto& [identity, entry] : record.graph) {
        (void)identity;
        if (entry.source)
            entry.source->post_completion();
    }
#endif
    contexts().erase(found);
}

AudioContextHandle audio_create_context(std::shared_ptr<AudioSession>& session) {
    return audio_create_context(session, audio_open_device(audio_begin_context()));
}

AudioContextHandle audio_create_context(std::shared_ptr<AudioSession>& session,
                                        std::shared_ptr<AudioPlaybackDevice> device) {
    if (!session)
        session = std::make_shared<AudioSession>();
    const auto context = create_context(device);
    try {
        session->contexts_.push_back(context);
    } catch (...) {
        audio_close_context(context);
        throw;
    }
    return context;
}

AudioSession::~AudioSession() {
    run_teardown("AudioSession teardown", [this] {
        for (const auto& context : contexts_)
            audio_close_context(context);
    });
}

void audio_collect_finished() {
    for (auto& [id, context] : contexts()) {
        (void)id;
        collect_audio_graph(context);
    }
}

#if BBLITE_WORKERS
bool audio_add_ended_listener(AudioNodeHandle node, std::size_t identity,
                              js::Callback<void()> callback, bool capture, bool once,
                              ListenerLeasePtr lease) {
    require_node(node);
    if (!node.ownership->source)
        throw std::runtime_error("Audio node is not a scheduled source.");
    const bool added = node.ownership->ended[capture ? 0 : 1].add(identity, std::move(callback),
                                                                  once, std::move(lease));
    retain_audio_completion(node);
    return added;
}

void audio_remove_ended_listener(AudioNodeHandle node, std::size_t identity, bool capture) {
    require_node(node);
    if (!node.ownership->source)
        throw std::runtime_error("Audio node is not a scheduled source.");
    node.ownership->ended[capture ? 0 : 1].remove(identity);
    release_unobserved_audio_completion(node);
}

void audio_set_ended_handler(AudioNodeHandle node, js::Callback<void()> callback) {
    require_node(node);
    if (!node.ownership->source)
        throw std::runtime_error("Audio node is not a scheduled source.");
    node.ownership->ended[1].set_handler(std::move(callback));
    if (!release_unobserved_audio_completion(node)) {
        retain_audio_completion(node);
    }
}
#endif

double audio_current_time(AudioContextHandle context) {
    require_runtime_execution("an audio clock read");
    if (context.state && context.state->status == AudioContextState::Status::Closed)
        return context.state->closed_time;
    return require_context(context.value).context->currentTime();
}

double audio_sample_rate(AudioContextHandle context) {
    if (context.state)
        return context.state->sample_rate;
    return require_context(context.value).sample_rate;
}

std::string audio_state(AudioContextHandle context) {
    const auto& state = context.state ? *context.state : *require_context(context.value).state;
    switch (state.status) {
    case AudioContextState::Status::Running:
        return "running";
    case AudioContextState::Status::Suspended:
        return "suspended";
    case AudioContextState::Status::Closed:
        return "closed";
    }
    throw std::logic_error("Invalid audio context state.");
}

void audio_resume(AudioContextHandle context) {
    ContextRecord& record = require_context(context.value);
    if (record.device)
        record.device->start();
    record.state->status = AudioContextState::Status::Running;
}

void audio_suspend(AudioContextHandle context) {
    ContextRecord& record = require_context(context.value);
    if (record.device)
        record.device->stop();
    record.state->status = AudioContextState::Status::Suspended;
}

AudioNodeHandle audio_destination(AudioContextHandle context) {
    return require_context(context.value).destination_handle;
}

AudioNodeHandle audio_create_gain(AudioContextHandle context) {
    return create_node<lab::GainNode>(context);
}

AudioNodeHandle audio_create_media_stream_destination(AudioContextHandle context) {
#if BBLITE_HAS_AUDIO_MEDIA_STREAM
    ContextRecord& record = require_context(context.value);
    const auto tap = std::make_shared<MediaStreamAudioTap>(record.sample_rate);
    auto value = js::make_gc_shared<AudioNodeRecord>();
    value->node = std::make_shared<StreamDestinationNode>(*record.context, tap);
    js::Array<MediaStreamTrackHandle> tracks;
    tracks.push_back(create_media_stream_track("audio", tap));
    value->stream = create_media_stream(tracks);
    const auto node = value->node;
    auto handle = insert_node(context, record, std::move(value));
    record.context->addAutomaticPullNode(node);
    record.graph.at(node.get()).automatic_pull = true;
    return handle;
#else
    (void)context;
    throw std::runtime_error("Media stream audio support was not compiled.");
#endif
}

std::shared_ptr<MediaStream> audio_destination_stream(AudioNodeHandle node) {
#if BBLITE_HAS_AUDIO_MEDIA_STREAM
    require_node(node);
    if (!node.ownership->stream)
        throw std::runtime_error("Audio node is not a MediaStreamAudioDestinationNode.");
    return node.ownership->stream;
#else
    (void)node;
    throw std::runtime_error("Media stream audio support was not compiled.");
#endif
}

AudioNodeHandle audio_create_media_stream_source(AudioContextHandle context,
                                                 const std::shared_ptr<MediaStream>& stream) {
#if BBLITE_HAS_AUDIO_MEDIA_STREAM
    ContextRecord& record = require_context(context.value);
    if (!stream)
        throw js::NamedError("TypeError", "createMediaStreamSource requires a MediaStream.");
    // The audio track whose id sorts first.
    MediaStreamTrackHandle selected;
    for (const auto& track : stream->tracks)
        if (track->kind == "audio" && (!selected || track->id < selected->id))
            selected = track;
    if (!selected)
        throw js::make_dom_exception("The MediaStream has no audio track.", "InvalidStateError");
    if (selected->audio->sample_rate() != record.sample_rate)
        throw js::make_dom_exception(
            "The MediaStream audio sample rate differs from the AudioContext sample rate.",
            "NotSupportedError");
    auto value = js::make_gc_shared<AudioNodeRecord>();
    value->node = std::make_shared<StreamSourceNode>(*record.context, selected);
    // A stream source keeps producing while connected, like a started source.
    value->source = std::make_shared<AudioSourceState>();
    value->source->started = true;
    return insert_node(context, record, std::move(value));
#else
    (void)context;
    (void)stream;
    throw std::runtime_error("Media stream audio support was not compiled.");
#endif
}

AudioNodeHandle audio_create_oscillator(AudioContextHandle context) {
#if BBLITE_HAS_AUDIO_OSCILLATOR
    return create_node<lab::OscillatorNode>(context);
#else
    (void)context;
    throw std::runtime_error("Oscillator support was not compiled.");
#endif
}

AudioNodeHandle audio_create_biquad_filter(AudioContextHandle context) {
#if BBLITE_HAS_AUDIO_BIQUAD_FILTER
    return create_node<lab::BiquadFilterNode>(context);
#else
    (void)context;
    throw std::runtime_error("Biquad filter support was not compiled.");
#endif
}

AudioNodeHandle audio_create_stereo_panner(AudioContextHandle context) {
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

#if BBLITE_HAS_AUDIO_ANALYSER
namespace {
std::shared_ptr<lab::AnalyserNode> require_analyser(AudioNodeHandle node) {
    auto analyser = std::dynamic_pointer_cast<lab::AnalyserNode>(require_node(node));
    if (!analyser)
        throw std::runtime_error("Audio node is not an analyser.");
    return analyser;
}

/**
 * The decibel range, written through LabSound's settings: its maxDecibels
 * setting hands the analyser the minDecibels setting's value, and a setting
 * notifies only on change. So the minimum setting carries the maximum first,
 * a changed maximum setting copies it, then the minimum is set.
 */
void set_decibel_range(lab::AnalyserNode& analyser, double minimum, double maximum) {
    const auto top = static_cast<float>(maximum);
    analyser.setMinDecibels(top);
    analyser.setMaxDecibels(top + 1.0f);
    analyser.setMaxDecibels(top);
    analyser.setMinDecibels(static_cast<float>(minimum));
}
} // namespace
#else
namespace {
[[noreturn]] void analysers_absent() {
    throw std::runtime_error("Analyser support was not compiled.");
}
} // namespace
#endif

AudioNodeHandle audio_create_analyser(AudioContextHandle context) {
#if BBLITE_HAS_AUDIO_ANALYSER
    ContextRecord& record = require_context(context.value);
    auto value = js::make_gc_shared<AudioNodeRecord>();
    // LabSound's own default size is 1024; its decibel range and smoothing
    // defaults are Web Audio's.
    value->node = std::make_shared<lab::AnalyserNode>(*record.context, 2048);
    const auto node = value->node;
    auto handle = insert_node(context, record, std::move(value));
    record.context->addAutomaticPullNode(node);
    record.graph.at(node.get()).automatic_pull = true;
    return handle;
#else
    (void)context;
    analysers_absent();
#endif
}

double audio_analyser_property(AudioNodeHandle node, AnalyserProperty property) {
#if BBLITE_HAS_AUDIO_ANALYSER
    const auto analyser = require_analyser(node);
    switch (property) {
    case AnalyserProperty::FftSize:
        return static_cast<double>(analyser->fftSize());
    case AnalyserProperty::FrequencyBinCount:
        return static_cast<double>(analyser->frequencyBinCount());
    case AnalyserProperty::MinDecibels:
        return analyser->minDecibels();
    case AnalyserProperty::MaxDecibels:
        return analyser->maxDecibels();
    case AnalyserProperty::SmoothingTimeConstant:
        return analyser->smoothingTimeConstant();
    }
    throw std::logic_error("Unknown analyser property.");
#else
    (void)node;
    (void)property;
    analysers_absent();
#endif
}

void audio_set_analyser_property(AudioNodeHandle node, AnalyserProperty property, double value) {
#if BBLITE_HAS_AUDIO_ANALYSER
    const auto analyser = require_analyser(node);
    if (!std::isfinite(value))
        throw js::NamedError("TypeError", "An analyser attribute takes a finite number.");
    const auto out_of_range = [](const char* message) {
        return js::make_dom_exception(message, "IndexSizeError");
    };
    switch (property) {
    case AnalyserProperty::FftSize: {
        const double size = std::trunc(value);
        const auto whole = static_cast<std::uint32_t>(std::clamp(size, 0.0, 65536.0));
        if (size < 32.0 || size > 32768.0 || (whole & (whole - 1)) != 0)
            throw out_of_range("fftSize must be a power of two from 32 to 32768.");
        // A new size rebuilds LabSound's analyser under the render lock (the
        // audio thread writes into it); the rebuild keeps the decibel range
        // but not the smoothing.
        const double smoothing = analyser->smoothingTimeConstant();
        ContextRecord& record = require_context(context_of(node.value));
        lab::ContextRenderLock render(record.context.get(), "bblite analyser size");
        analyser->setFftSize(render, static_cast<int>(whole));
        analyser->setSmoothingTimeConstant(smoothing);
        return;
    }
    case AnalyserProperty::FrequencyBinCount:
        throw std::logic_error("frequencyBinCount is read-only.");
    case AnalyserProperty::MinDecibels:
        if (value >= analyser->maxDecibels())
            throw out_of_range("minDecibels must be less than maxDecibels.");
        set_decibel_range(*analyser, value, analyser->maxDecibels());
        return;
    case AnalyserProperty::MaxDecibels:
        if (value <= analyser->minDecibels())
            throw out_of_range("maxDecibels must be greater than minDecibels.");
        set_decibel_range(*analyser, analyser->minDecibels(), value);
        return;
    case AnalyserProperty::SmoothingTimeConstant:
        if (value < 0.0 || value > 1.0)
            throw out_of_range("smoothingTimeConstant must lie in [0, 1].");
        analyser->setSmoothingTimeConstant(value);
        return;
    }
#else
    (void)node;
    (void)property;
    (void)value;
    analysers_absent();
#endif
}

void audio_analyser_byte_data(AudioNodeHandle node, AnalyserData data,
                              js::TypedArray<std::uint8_t> out) {
#if BBLITE_HAS_AUDIO_ANALYSER
    const auto analyser = require_analyser(node);
    const std::size_t held =
        data == AnalyserData::Frequency ? analyser->frequencyBinCount() : analyser->fftSize();
    std::vector<std::uint8_t> values(std::min(out.size(), held));
    if (data == AnalyserData::Frequency)
        analyser->getByteFrequencyData(values);
    else
        analyser->getByteTimeDomainData(values);
    for (std::size_t index = 0; index < values.size(); ++index)
        out.store(index, values[index]);
#else
    (void)node;
    (void)data;
    (void)out;
    analysers_absent();
#endif
}

void audio_analyser_float_data(AudioNodeHandle node, AnalyserData data, js::F32Array out) {
#if BBLITE_HAS_AUDIO_ANALYSER
    const auto analyser = require_analyser(node);
    const std::size_t held =
        data == AnalyserData::Frequency ? analyser->frequencyBinCount() : analyser->fftSize();
    std::vector<float> values(std::min(out.size(), held));
    if (data == AnalyserData::Frequency)
        analyser->getFloatFrequencyData(values);
    else
        analyser->getFloatTimeDomainData(values);
    for (std::size_t index = 0; index < values.size(); ++index)
        out.store(index, values[index]);
#else
    (void)node;
    (void)data;
    (void)out;
    analysers_absent();
#endif
}

#if BBLITE_HAS_AUDIO_PANNER
namespace {
std::shared_ptr<lab::PannerNode> require_panner(AudioNodeHandle node) {
    auto panner = std::dynamic_pointer_cast<lab::PannerNode>(require_node(node));
    if (!panner)
        throw std::runtime_error("Audio node is not a panner.");
    return panner;
}
} // namespace
#else
namespace {
[[noreturn]] void panners_absent() { throw std::runtime_error("Panner support was not compiled."); }
} // namespace
#endif

AudioNodeHandle audio_create_panner(AudioContextHandle context) {
#if BBLITE_HAS_AUDIO_PANNER
    const AudioNodeHandle node = create_node<lab::PannerNode>(context);
    const auto panner = require_panner(node);
    panner->setPanningModel(lab::PanningModel::EQUALPOWER);
    panner->setDistanceModel(lab::PannerNode::INVERSE_DISTANCE);
    panner->setRefDistance(1.0f);
    panner->setMaxDistance(10000.0f);
    panner->setRolloffFactor(1.0f);
    panner->setConeInnerAngle(360.0f);
    panner->setConeOuterAngle(360.0f);
    panner->setConeOuterGain(0.0f);
    return node;
#else
    (void)context;
    panners_absent();
#endif
}

double audio_panner_property(AudioNodeHandle node, PannerProperty property) {
#if BBLITE_HAS_AUDIO_PANNER
    const auto panner = require_panner(node);
    switch (property) {
    case PannerProperty::RefDistance:
        return panner->refDistance();
    case PannerProperty::MaxDistance:
        return panner->maxDistance();
    case PannerProperty::RolloffFactor:
        return panner->rolloffFactor();
    case PannerProperty::ConeInnerAngle:
        return panner->coneInnerAngle();
    case PannerProperty::ConeOuterAngle:
        return panner->coneOuterAngle();
    case PannerProperty::ConeOuterGain:
        return panner->coneOuterGain();
    }
    throw std::logic_error("Unknown panner property.");
#else
    (void)node;
    (void)property;
    panners_absent();
#endif
}

void audio_set_panner_property(AudioNodeHandle node, PannerProperty property, double value) {
#if BBLITE_HAS_AUDIO_PANNER
    const auto panner = require_panner(node);
    if (!std::isfinite(value))
        throw js::NamedError("TypeError", "A panner attribute takes a finite number.");
    const auto at_least = [&](double minimum, bool inclusive, const char* name) {
        if (inclusive ? value < minimum : value <= minimum)
            throw js::NamedError("RangeError", std::string(name) + " is out of range.");
    };
    const auto single = static_cast<float>(value);
    switch (property) {
    case PannerProperty::RefDistance:
        at_least(0.0, true, "refDistance");
        panner->setRefDistance(single);
        return;
    case PannerProperty::MaxDistance:
        at_least(0.0, false, "maxDistance");
        panner->setMaxDistance(single);
        return;
    case PannerProperty::RolloffFactor:
        at_least(0.0, true, "rolloffFactor");
        panner->setRolloffFactor(single);
        return;
    case PannerProperty::ConeInnerAngle:
        panner->setConeInnerAngle(single);
        return;
    case PannerProperty::ConeOuterAngle:
        panner->setConeOuterAngle(single);
        return;
    case PannerProperty::ConeOuterGain:
        if (value < 0.0 || value > 1.0)
            throw js::make_dom_exception("coneOuterGain must lie in [0, 1].", "InvalidStateError");
        panner->setConeOuterGain(single);
        return;
    }
#else
    (void)node;
    (void)property;
    (void)value;
    panners_absent();
#endif
}

std::string audio_panner_model(AudioNodeHandle node, PannerModel which) {
#if BBLITE_HAS_AUDIO_PANNER
    const auto panner = require_panner(node);
    if (which == PannerModel::Panning)
        return panner->panningModel() == lab::PanningModel::HRTF ? "HRTF" : "equalpower";
    switch (panner->distanceModel()) {
    case lab::PannerNode::LINEAR_DISTANCE:
        return "linear";
    case lab::PannerNode::EXPONENTIAL_DISTANCE:
        return "exponential";
    default:
        return "inverse";
    }
#else
    (void)node;
    (void)which;
    panners_absent();
#endif
}

void audio_set_panner_model(AudioNodeHandle node, PannerModel which, const std::string& value) {
#if BBLITE_HAS_AUDIO_PANNER
    const auto panner = require_panner(node);
    if (which == PannerModel::Panning) {
        if (value == "equalpower")
            panner->setPanningModel(lab::PanningModel::EQUALPOWER);
        else if (value == "HRTF")
            throw js::make_dom_exception(
                "HRTF panning needs an HRTF database, which this build does not package.",
                "NotSupportedError");
        return;
    }
    if (value == "linear")
        panner->setDistanceModel(lab::PannerNode::LINEAR_DISTANCE);
    else if (value == "inverse")
        panner->setDistanceModel(lab::PannerNode::INVERSE_DISTANCE);
    else if (value == "exponential")
        panner->setDistanceModel(lab::PannerNode::EXPONENTIAL_DISTANCE);
#else
    (void)node;
    (void)which;
    (void)value;
    panners_absent();
#endif
}

AudioParamHandle audio_listener_param(AudioContextHandle context, AudioParamName name) {
    // Pure, like `audio_node_param`: one listener, one object per name.
    return AudioParamHandle{audio_destination(context), name};
}

AudioBufferHandle audio_create_buffer(AudioContextHandle context, std::uint32_t channels,
                                      std::uint32_t frames, double sample_rate) {
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    const AudioBufferHandle handle = allocate_audio_buffer(context, channels, frames, sample_rate);
    if (runtime_trace_enabled()) {
        std::fprintf(stderr, "[bblite trace] audio buffer=%u channels=%u frames=%u rate=%.0f\n",
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

struct DecodedAudio {
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE && BBLITE_HAS_AUDIO_DECODE_FILE
    std::unique_ptr<lab::AudioBus> bus;
#endif
};

std::shared_ptr<const DecodedAudio>
audio_decode_samples([[maybe_unused]] const std::vector<std::uint8_t>& bytes,
                     [[maybe_unused]] double sample_rate) {
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE && BBLITE_HAS_AUDIO_DECODE_FILE
    try {
        const auto extension = audio_container_extension(bytes);
        if (extension.empty())
            return nullptr;
        const auto source = decode_audio_bus(bytes, extension);
        auto decoded = std::make_shared<DecodedAudio>();
        if (source)
            decoded->bus = lab::AudioBus::createBySampleRateConverting(
                source.get(), false, static_cast<float>(sample_rate));
        if (!decoded->bus || decoded->bus->numberOfChannels() <= 0 || decoded->bus->length() <= 0)
            return nullptr;
        return decoded;
    } catch (...) {
        return nullptr;
    }
#else
    return nullptr;
#endif
}

AudioBufferHandle
audio_buffer_from_decoded([[maybe_unused]] AudioContextHandle context,
                          [[maybe_unused]] const std::shared_ptr<const DecodedAudio>& decoded) {
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE && BBLITE_HAS_AUDIO_DECODE_FILE
    if (!decoded)
        return {};
    try {
        const lab::AudioBus& bus = *decoded->bus;
        const auto channel_count = static_cast<std::uint32_t>(bus.numberOfChannels());
        const auto frame_count = static_cast<std::uint32_t>(bus.length());
        const AudioBufferHandle handle = allocate_audio_buffer(
            context, channel_count, frame_count, require_context(context.value).sample_rate);
        auto buffer = require_buffer(handle);
        for (std::uint32_t channel = 0; channel < channel_count; ++channel) {
            const float* samples = bus.channel(static_cast<int>(channel))->data();
            std::copy_n(samples, frame_count, buffer->channels[channel].begin());
        }
        return handle;
    } catch (...) {
        // Decode failure uses the optional-buffer sentinel.
        return {};
    }
#else
    return {};
#endif
}

AudioBufferHandle audio_decode_buffer(AudioContextHandle context,
                                      const bbl::js::ArrayBuffer& encoded) {
    try {
        const std::vector<std::uint8_t> bytes(encoded.data(),
                                              encoded.data() + encoded.byte_length());
        return audio_buffer_from_decoded(
            context, audio_decode_samples(bytes, require_context(context.value).sample_rate));
    } catch (...) {
        // Decode failure uses the optional-buffer sentinel.
        return {};
    }
}

bbl::js::F32Array audio_buffer_channel(AudioBufferHandle buffer, std::uint32_t channel) {
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

AudioNodeHandle audio_create_buffer_source(AudioContextHandle context) {
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    return create_node<lab::SampledAudioNode>(context);
#else
    (void)context;
    throw std::runtime_error("Audio buffer source support was not compiled.");
#endif
}

AudioNodeHandle audio_create_buffer_source(AudioContextHandle context,
                                           const AudioBufferSourceInit& options) {
    auto source = audio_create_buffer_source(context);
    if (options.buffer)
        audio_set_buffer(source, *options.buffer);
    return source;
}

double audio_buffer_property(AudioBufferHandle buffer, AudioBufferProperty property) {
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    const auto record = require_buffer(buffer);
    switch (property) {
    case AudioBufferProperty::Duration:
        return static_cast<double>(record->bus.length()) / record->bus.sampleRate();
    case AudioBufferProperty::Length:
        return static_cast<double>(record->bus.length());
    case AudioBufferProperty::SampleRate:
        return record->bus.sampleRate();
    case AudioBufferProperty::NumberOfChannels:
        return static_cast<double>(record->channels.size());
    }
    throw std::logic_error("Unknown AudioBuffer property.");
#else
    (void)buffer;
    (void)property;
    throw std::runtime_error("Audio buffer source support was not compiled.");
#endif
}

void audio_buffer_copy(AudioBufferHandle buffer, bbl::js::F32Array samples, std::uint32_t channel,
                       std::uint32_t offset, AudioBufferCopy direction) {
    auto channel_data = audio_buffer_channel(buffer, channel);
    if (offset >= channel_data.size())
        return;
    const auto count = std::min(samples.size(), channel_data.size() - offset);
    // A source view can overlap its destination. Snapshot only the copied
    // samples and use typed-array loads/stores for ArrayBuffer-backed views.
    auto source = direction == AudioBufferCopy::ToChannel
                      ? samples.copy_range(0, count)
                      : channel_data.copy_range(offset, offset + count);
    auto destination = direction == AudioBufferCopy::ToChannel ? channel_data : samples;
    const auto start = direction == AudioBufferCopy::ToChannel ? offset : 0u;
    for (std::size_t index = 0; index < count; ++index)
        destination.store(start + index, source.load(index));
}

namespace {
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
AudioNodeRecord& require_buffer_source(AudioNodeHandle source) {
    ContextRecord& record = require_context(context_of(source.value));
    if (!std::dynamic_pointer_cast<lab::SampledAudioNode>(require_node(record, source)))
        throw std::runtime_error("Audio node is not a buffer source.");
    return *source.ownership;
}
#else
[[noreturn]] void buffer_sources_absent() {
    throw std::runtime_error("Audio buffer source support was not compiled.");
}
#endif
} // namespace

bbl::js::Nullable<AudioBufferHandle> audio_source_buffer(AudioNodeHandle source) {
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    const auto& buffer = require_buffer_source(source).buffer;
    if (!buffer.value)
        return std::nullopt;
    return buffer;
#else
    (void)source;
    buffer_sources_absent();
#endif
}

void audio_set_buffer(AudioNodeHandle source, AudioBufferHandle buffer) {
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    auto& context = require_context(context_of(source.value));
    lab::ContextRenderLock render(context.context.get(), "bblite audio buffer assignment");
    const auto sampled =
        std::static_pointer_cast<lab::SampledAudioNode>(require_buffer_source(source).node);
    const auto& buffer_record = require_buffer(buffer);
    // Alias the bus to the buffer owner: LabSound can keep playing after JS
    // releases its AudioBuffer handle, without dangling channel memory.
    sampled->setBus(std::shared_ptr<lab::AudioBus>(buffer_record, &buffer_record->bus));
    // Configure channels before the first pull can select an in-place bus.
    // LabSound applies its queued buffer inside process(), after that selection.
    sampled->output(0)->setNumberOfChannels(render, buffer_record->bus.numberOfChannels());
    sampled->output(0)->updateRenderingState(render);
    source.ownership->buffer = buffer;
    if (runtime_trace_enabled()) {
        float peak = 0.0f;
        for (const auto& channel : buffer_record->channels) {
            for (const float sample : channel) {
                peak = std::max(peak, std::fabs(sample));
            }
        }
        std::fprintf(stderr, "[bblite trace] audio source=%u set-buffer=%u peak=%.6f\n",
                     source.value, buffer.value, peak);
    }
#else
    (void)source;
    (void)buffer;
    buffer_sources_absent();
#endif
}

bool audio_loop(AudioNodeHandle source) {
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    return require_buffer_source(source).source_loop;
#else
    (void)source;
    buffer_sources_absent();
#endif
}

double audio_loop_start(AudioNodeHandle source) {
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    return require_buffer_source(source).source_loop_start;
#else
    (void)source;
    buffer_sources_absent();
#endif
}

double audio_loop_end(AudioNodeHandle source) {
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    return require_buffer_source(source).source_loop_end;
#else
    (void)source;
    buffer_sources_absent();
#endif
}

void audio_set_loop_start(AudioNodeHandle source, double seconds) {
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    if (!std::isfinite(seconds))
        throw js::NamedError("TypeError", "loopStart must be a finite number.");
    require_buffer_source(source).source_loop_start = seconds;
#else
    (void)source;
    (void)seconds;
    buffer_sources_absent();
#endif
}

void audio_set_loop_end(AudioNodeHandle source, double seconds) {
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    if (!std::isfinite(seconds))
        throw js::NamedError("TypeError", "loopEnd must be a finite number.");
    require_buffer_source(source).source_loop_end = seconds;
#else
    (void)source;
    (void)seconds;
    buffer_sources_absent();
#endif
}

void audio_set_loop(AudioNodeHandle source, bool enabled) {
#if BBLITE_HAS_AUDIO_BUFFER_SOURCE
    require_buffer_source(source).source_loop = enabled;
#else
    (void)source;
    (void)enabled;
    buffer_sources_absent();
#endif
}

void audio_connect(AudioNodeHandle source, AudioNodeHandle destination) {
    if (context_of(source.value) != context_of(destination.value)) {
        throw std::runtime_error("Audio nodes from different contexts cannot be connected.");
    }
    // One context lookup, two indexes: the single-argument `require_node`
    // would resolve the context twice for one edge.
    ContextRecord& record = require_context(context_of(source.value));
    const auto source_node = require_node(record, source);
    const auto destination_node = require_node(record, destination);
    connect_audio_graph(record, source, destination, false,
                        [&] { record.context->connect(destination_node, source_node, 0, 0); });
}

void audio_connect_param(AudioNodeHandle source, AudioParamHandle destination) {
    if (context_of(source.value) != context_of(destination.node.value)) {
        throw std::runtime_error(
            "Audio nodes and parameters from different contexts cannot be connected.");
    }
    ContextRecord& record = require_context(context_of(source.value));
    const auto source_node = require_node(record, source);
    const auto param = require_param(destination);
    connect_audio_graph(record, source, destination.node, true,
                        [&] { record.context->connectParam(param, source_node, 0); });
}

void audio_disconnect(AudioNodeHandle node) {
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

void audio_disconnect(AudioNodeHandle node, AudioNodeHandle destination,
                      bbl::js::Nullable<double> output, bbl::js::Nullable<double> input) {
    if (context_of(node.value) != context_of(destination.value))
        throw js::make_dom_exception("The destination belongs to another AudioContext.",
                                     "InvalidAccessError");
    ContextRecord& record = require_context(context_of(node.value));
    const auto source = require_node(record, node);
    const auto target = require_node(record, destination);
    // WebIDL `unsigned long`, then the node's own output and input counts.
    const auto index = [](const bbl::js::Nullable<double>& value) {
        return value ? static_cast<double>(js::to_uint32(*value)) : 0.0;
    };
    if (output && index(output) >= static_cast<double>(source->numberOfOutputs()))
        throw js::make_dom_exception("The output index is out of range.", "IndexSizeError");
    if (input && index(input) >= static_cast<double>(target->numberOfInputs()))
        throw js::make_dom_exception("The input index is out of range.", "IndexSizeError");
    auto& entry = record.graph.at(source.get());
    const auto edge = std::find(entry.node_edges.begin(), entry.node_edges.end(), target.get());
    if (edge == entry.node_edges.end())
        throw js::make_dom_exception("The node is not connected to that destination.",
                                     "InvalidAccessError");
    // Every reached node has one output and one input, so the edge is the indexed one.
    record.context->disconnect(target, source, static_cast<int>(index(input)),
                               static_cast<int>(index(output)));
    entry.node_edges.erase(edge);
    if (std::find(entry.param_edges.begin(), entry.param_edges.end(), target.get()) ==
        entry.param_edges.end())
        std::erase(entry.outputs, target.get());
    invalidate_source_tails(record, source.get());
    collect_audio_graph(record);
}

static void audio_node_start_impl(AudioNodeHandle node, double when, double offset, double duration,
                                  int argument_count) {
#if BBLITE_HAS_AUDIO_OSCILLATOR || BBLITE_HAS_AUDIO_BUFFER_SOURCE
    auto& context = require_context(context_of(node.value));
    lab::ContextRenderLock render(context.context.get(), "bblite audio start");
    const auto source = require_node(context, node);
    if (!node.ownership->source)
        throw std::runtime_error("Audio node is not a scheduled source.");
    if (node.ownership->source->started)
        throw std::runtime_error("An AudioScheduledSourceNode can only be started once.");
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
        if (loop) {
            // Web Audio's actual loop is the whole buffer unless the points
            // select a region inside it; LabSound loops whole grains only.
            const double start = node.ownership->source_loop_start;
            const double end = node.ownership->source_loop_end;
            const double length =
                node.ownership->buffer.value
                    ? audio_buffer_property(node.ownership->buffer, AudioBufferProperty::Duration)
                    : 0.0;
            if (start >= 0.0 && end > 0.0 && start < end && (start > 0.0 || end < length))
                throw std::runtime_error(
                    "A looping AudioBufferSourceNode with a loopStart/loopEnd region inside its "
                    "buffer is not supported natively.");
            if (argument_count > 2)
                throw std::runtime_error(
                    "A looping AudioBufferSourceNode started with a duration is not supported "
                    "natively.");
        }
        if (argument_count == 1) {
            sampled->start(static_cast<float>(when), loop ? -1 : 0);
        } else if (argument_count == 2) {
            sampled->start(static_cast<float>(when), static_cast<float>(offset), loop ? -1 : 0);
        } else {
            sampled->start(static_cast<float>(when), static_cast<float>(offset),
                           static_cast<float>(duration), 0);
        }
        node.ownership->source->started = true;
#if BBLITE_WORKERS
        retain_audio_completion(node);
#endif
        if (runtime_trace_enabled()) {
            std::fprintf(stderr,
                         "[bblite trace] audio source=%u start=%.6f offset=%.6f duration=%.6f\n",
                         node.value, when, offset, duration);
        }
        return;
    }
#endif
    if (argument_count > 1) {
        throw std::runtime_error("Audio source offset and duration require a sampled source.");
    }
    auto scheduled = std::dynamic_pointer_cast<lab::AudioScheduledSourceNode>(source);
    if (!scheduled) {
        throw std::runtime_error("Audio node is not a scheduled source.");
    }
    scheduled->start(static_cast<float>(when));
    node.ownership->source->started = true;
#if BBLITE_WORKERS
    retain_audio_completion(node);
#endif
    if (runtime_trace_enabled()) {
        std::fprintf(stderr, "[bblite trace] audio source=%u start=%.6f\n", node.value, when);
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

void audio_node_start(AudioNodeHandle node, double when) {
    audio_node_start_impl(node, when, 0.0, 0.0, 1);
}

void audio_node_start(AudioNodeHandle node, double when, double offset) {
    audio_node_start_impl(node, when, offset, 0.0, 2);
}

void audio_node_start(AudioNodeHandle node, double when, double offset, double duration) {
    audio_node_start_impl(node, when, offset, duration, 3);
}

void audio_node_start(AudioNodeHandle node, double when, double offset,
                      bbl::js::Nullable<double> duration) {
    if (duration)
        audio_node_start_impl(node, when, offset, *duration, 3);
    else
        audio_node_start_impl(node, when, offset, 0.0, 2);
}

void audio_node_stop(AudioNodeHandle node, double when) {
#if BBLITE_HAS_AUDIO_OSCILLATOR || BBLITE_HAS_AUDIO_BUFFER_SOURCE
    auto& context = require_context(context_of(node.value));
    lab::ContextRenderLock render(context.context.get(), "bblite audio stop");
    auto scheduled = std::dynamic_pointer_cast<lab::AudioScheduledSourceNode>(require_node(node));
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

AudioParamHandle audio_node_param(AudioNodeHandle node, AudioParamName name) {
    // Pure by contract: `osc.frequency` is one object in Web Audio, so two
    // reads must produce one handle. Validity is checked where the
    // parameter is used.
    return AudioParamHandle{node, name};
}

void audio_set_oscillator_wave(AudioNodeHandle node, OscillatorWave wave) {
#if BBLITE_HAS_AUDIO_OSCILLATOR
    auto osc = std::dynamic_pointer_cast<lab::OscillatorNode>(require_node(node));
    if (!osc)
        throw std::runtime_error("Audio node is not an oscillator.");
    osc->setType(to_lab(wave));
#else
    (void)node;
    (void)wave;
    throw std::runtime_error("Oscillator support was not compiled.");
#endif
}

void audio_set_filter_kind(AudioNodeHandle node, BiquadFilterKind kind) {
#if BBLITE_HAS_AUDIO_BIQUAD_FILTER
    auto filter = std::dynamic_pointer_cast<lab::BiquadFilterNode>(require_node(node));
    if (!filter)
        throw std::runtime_error("Audio node is not a biquad filter.");
    filter->setType(to_lab(kind));
#else
    (void)node;
    (void)kind;
    throw std::runtime_error("Biquad filter support was not compiled.");
#endif
}

float audio_param_value(AudioParamHandle param) { return require_param(param)->value(); }

void audio_param_set_value(AudioParamHandle param, float value) {
    require_param(param)->setValue(value);
}

void audio_param_set_value_at_time(AudioParamHandle param, float value, double time) {
    require_param(param)->setValueAtTime(value, static_cast<float>(time));
}

void audio_param_linear_ramp(AudioParamHandle param, float value, double time) {
    require_param(param)->linearRampToValueAtTime(value, static_cast<float>(time));
}

void audio_param_exponential_ramp(AudioParamHandle param, float value, double time) {
    require_param(param)->exponentialRampToValueAtTime(value, static_cast<float>(time));
}

void audio_param_cancel_scheduled_values(AudioParamHandle param, double time) {
    require_param(param)->cancelScheduledValues(static_cast<float>(time));
}

void audio_param_set_value_curve(AudioParamHandle param, const bbl::js::F32Array& values,
                                 double start, double duration) {
    if (!std::isfinite(start) || !std::isfinite(duration))
        throw js::NamedError("TypeError", "setValueCurveAtTime takes finite times.");
    if (start < 0.0)
        throw js::NamedError("RangeError", "setValueCurveAtTime's startTime is negative.");
    if (duration <= 0.0)
        throw js::NamedError("RangeError", "setValueCurveAtTime's duration is not positive.");
    if (values.size() < 2)
        throw js::make_dom_exception("setValueCurveAtTime needs at least two values.",
                                     "InvalidStateError");
    // Web Audio interpolates linearly between the curve's values, which
    // LabSound's own curve event does not (it holds each value for its
    // share of the duration): the same timeline as linear ramps between
    // consecutive values, from the first value at `start`.
    const auto target = require_param(param);
    const std::size_t count = values.size();
    target->setValueAtTime(values.load(0), static_cast<float>(start));
    for (std::size_t index = 1; index < count; ++index)
        target->linearRampToValueAtTime(
            values.load(index), static_cast<float>(start + duration * static_cast<double>(index) /
                                                               static_cast<double>(count - 1)));
}

#if BBLITE_HAS_AUDIO_MEDIA_ELEMENT
/**
 * An `HTMLAudioElement`'s media state. The packaged source is decoded whole,
 * at its routing context's rate, by a native job, and plays through the
 * `MediaElementAudioSourceNode` (a sampled node with no scheduled-source
 * state) as one segment from `segment_offset` at context time
 * `segment_start`; the element's clock is that context's clock.
 */
struct AudioElementPlayback {
    /** The URL `new Audio(url)` set; absent after `removeAttribute("src")`. */
    std::optional<std::string> source;
    std::string preload = "auto";
    bool loop = false;
    bool paused = true;
    /** The source failed to load since the last `load()`. */
    bool failed = false;
    bool loading = false;
    /** A decode a later `load()` superseded is discarded. */
    std::uint64_t generation = 0;
    /** The official playback position while no segment plays. */
    double position = 0.0;
    double duration = std::numeric_limits<double>::quiet_NaN();
    std::shared_ptr<const DecodedAudio> decoded;
    /** The session whose default output an unrouted element plays to. */
    std::shared_ptr<AudioSession> session;
    AudioContextHandle context{};
    /** The session's default output this element keeps running while it plays there. */
    AudioContextHandle held_output{};
    std::optional<AudioNodeHandle> output;
    /** `createMediaElementSource` made `output`; otherwise it feeds the default output. */
    bool routed = false;
    bool playing = false;
    bool segment_loops = false;
    double segment_start = 0.0;
    double segment_offset = 0.0;
    EventLoop::TimerId timer = 0;
    std::vector<js::Promise<js::PromiseVoid>> pending_plays;
    /** Capture and non-capture listeners per `AudioElementEvent`. */
    std::array<std::array<PlatformEventListeners<void()>, 2>, 4> listeners;
};

AudioElementState::AudioElementState() : playback(std::make_unique<AudioElementPlayback>()) {}

/**
 * A session's media element state: the decodes its elements share
 * (`AudioSession::decoded_`), and the default output's device, which runs
 * only while an unrouted element plays (`AudioSession::media_playing_`).
 */
struct AudioSessionMedia {
    using Key = std::pair<std::string, double>;
    static std::shared_ptr<const DecodedAudio> find(AudioSession& session, const Key& key) {
        const auto found = session.decoded_.find(key);
        return found == session.decoded_.end() ? nullptr : found->second.lock();
    }
    /** Record `decoded`, dropping the entries no element holds any more. */
    static void keep(AudioSession& session, Key key,
                     const std::shared_ptr<const DecodedAudio>& decoded) {
        std::erase_if(session.decoded_, [](const auto& entry) { return entry.second.expired(); });
        session.decoded_.insert_or_assign(std::move(key), decoded);
    }
    /** An element starts playing: on the default output, it keeps that output's device running. */
    static void hold_output(AudioElementPlayback& playback) {
        if (playback.held_output.value || !playback.session)
            return;
        auto& session = *playback.session;
        if (playback.context.value != session.media_output_.value)
            return;
        playback.held_output = session.media_output_;
        if (session.media_playing_++ == 0 && audio_state(session.media_output_) != "closed")
            audio_resume(session.media_output_);
    }
    /** The element stops playing there; the last one to stop suspends the output's device. */
    static void release_output(AudioElementPlayback& playback) {
        const auto held = std::exchange(playback.held_output, AudioContextHandle{});
        if (!held.value || !playback.session)
            return;
        auto& session = *playback.session;
        // A hold on an output since closed and replaced counts for nothing.
        if (held.value != session.media_output_.value || session.media_playing_ == 0)
            return;
        if (--session.media_playing_ == 0 && audio_state(held) != "closed")
            audio_suspend(held);
    }
    /** A new default output starts suspended, with nothing playing to it. */
    static void reset_output(AudioSession& session, AudioContextHandle output) {
        session.media_output_ = output;
        session.media_playing_ = 0;
        audio_suspend(output);
    }
};

namespace {

/** Browsers fire `timeupdate` every 15 to 250 ms while playing; Chromium every 250 ms. */
constexpr double media_time_update_ms = 250.0;

AudioElementPlayback& playback_of(const AudioElement& element) {
    if (!element || !element->playback)
        throw std::runtime_error("Invalid HTMLAudioElement handle.");
    return *element->playback;
}

std::shared_ptr<lab::SampledAudioNode> element_node(const AudioElementPlayback& playback) {
    if (!playback.output || !playback.output->ownership)
        return nullptr;
    return std::static_pointer_cast<lab::SampledAudioNode>(playback.output->ownership->node);
}

/** The position the scheduled segment has reached, before looping or clamping. */
double raw_position(const AudioElementPlayback& playback) {
    if (!playback.playing)
        return playback.position;
    return playback.segment_offset +
           (audio_current_time(playback.context) - playback.segment_start);
}

double current_position(const AudioElementPlayback& playback) {
    const double raw = raw_position(playback);
    if (!playback.playing)
        return raw;
    return playback.segment_loops ? std::fmod(raw, playback.duration)
                                  : std::min(raw, playback.duration);
}

void dispatch_element_event(AudioElementPlayback& playback, AudioElementEvent type) {
    auto& owner = EventLoop::current();
    for (auto& listeners : playback.listeners[static_cast<std::size_t>(type)])
        dispatch_platform_event(owner, listeners);
}

/** One media element task firing `types` in order. */
void queue_element_events(const AudioElement& element, std::vector<AudioElementEvent> types) {
    EventLoop::current().post([element, types = std::move(types)] {
        for (const auto type : types)
            dispatch_element_event(*element->playback, type);
    });
}

void reject_plays(std::vector<js::Promise<js::PromiseVoid>> plays, const char* message,
                  const char* name) {
    for (const auto& play : plays)
        play.reject(js::dom_exception_error(message, name));
}

std::shared_ptr<lab::AudioBus> decoded_bus(const AudioElementPlayback& playback) {
    return {playback.decoded, playback.decoded->bus.get()};
}

/** Drop the node's segments. Clearing also drops a source bus the node has not
 * taken yet, so the decoded source is queued again behind it. */
void clear_segments(const AudioElementPlayback& playback) {
    const auto node = element_node(playback);
    if (!node)
        return;
    node->clearSchedules();
    if (playback.decoded)
        node->setBus(decoded_bus(playback));
}

void stop_segment(AudioElementPlayback& playback) {
    if (!playback.playing)
        return;
    playback.position = current_position(playback);
    playback.playing = false;
    AudioSessionMedia::release_output(playback);
    if (playback.timer)
        EventLoop::current().clear_timer(std::exchange(playback.timer, 0));
    clear_segments(playback);
}

void tick_element(const AudioElement& element);

/** The next tick: the `timeupdate` cadence, or the end of a segment that does not loop. */
void arm_element_timer(const AudioElement& element) {
    auto& playback = *element->playback;
    double delay = media_time_update_ms;
    if (!playback.segment_loops)
        delay = std::clamp(std::ceil((playback.duration - raw_position(playback)) * 1000.0), 1.0,
                           media_time_update_ms);
    playback.timer = EventLoop::current().set_timeout([element] { tick_element(element); }, delay);
}

/** Schedule the decoded source from the official position; a loop restarts at zero. */
void start_segment(const AudioElement& element) {
    auto& playback = *element->playback;
    const auto node = element_node(playback);
    if (!node || audio_state(playback.context) == "closed")
        return;
    const double offset = std::clamp(playback.position, 0.0, playback.duration);
    if (offset < playback.duration)
        node->schedule(0.0f, static_cast<float>(offset), 0);
    if (playback.loop)
        node->schedule(static_cast<float>(playback.duration - offset), 0.0f, -1);
    AudioSessionMedia::hold_output(playback);
    playback.playing = true;
    playback.segment_loops = playback.loop;
    playback.segment_start = audio_current_time(playback.context);
    playback.segment_offset = offset;
    arm_element_timer(element);
}

/** `timeupdate` while playing; at the end of a segment that does not loop, the ended steps. */
void tick_element(const AudioElement& element) {
    auto& playback = *element->playback;
    playback.timer = 0;
    if (!playback.playing)
        return;
    if (playback.segment_loops || raw_position(playback) < playback.duration) {
        arm_element_timer(element);
        dispatch_element_event(playback, AudioElementEvent::TimeUpdate);
        return;
    }
    stop_segment(playback);
    dispatch_element_event(playback, AudioElementEvent::TimeUpdate);
    if (!playback.paused) {
        playback.paused = true;
        auto plays = std::exchange(playback.pending_plays, {});
        dispatch_element_event(playback, AudioElementEvent::Pause);
        reject_plays(std::move(plays), "The play() request was interrupted by the end of playback.",
                     "AbortError");
    }
    dispatch_element_event(playback, AudioElementEvent::Ended);
}

void resolve_plays(AudioElementPlayback& playback) {
    for (const auto& play : std::exchange(playback.pending_plays, {}))
        play.resolve(js::PromiseVoid{});
}

void fail_element_source(AudioElementPlayback& playback) {
    playback.loading = false;
    playback.failed = true;
    reject_plays(std::exchange(playback.pending_plays, {}),
                 "Failed to load because no supported source was found.", "NotSupportedError");
}

/** The output node plays the decoded source, its channels configured before a pull. */
void bind_decoded_source(const AudioElementPlayback& playback) {
    const auto node = element_node(playback);
    auto& context = require_context(context_of(playback.output->value));
    lab::ContextRenderLock render(context.context.get(), "bblite media element source");
    node->setBus(decoded_bus(playback));
    node->output(0)->setNumberOfChannels(render, playback.decoded->bus->numberOfChannels());
    node->output(0)->updateRenderingState(render);
}

/** A sampled node in `context` for the element's output, held by the element. */
AudioNodeHandle create_element_output(AudioContextHandle context) {
    ContextRecord& record = require_context(context.value);
    auto value = js::make_gc_shared<AudioNodeRecord>();
    value->node = std::make_shared<lab::SampledAudioNode>(*record.context);
    return insert_node(context, record, std::move(value));
}

void finish_element_load(const AudioElement& element, std::uint64_t generation,
                         std::shared_ptr<const DecodedAudio> decoded) {
    auto& playback = *element->playback;
    if (generation != playback.generation)
        return;
    const auto node = element_node(playback);
    if (!decoded || !node || audio_state(playback.context) == "closed") {
        fail_element_source(playback);
        return;
    }
    playback.loading = false;
    playback.decoded = std::move(decoded);
    playback.duration =
        static_cast<double>(playback.decoded->bus->length()) / audio_sample_rate(playback.context);
    bind_decoded_source(playback);
    // A position set before the source loaded is its default start position.
    playback.position = std::clamp(playback.position, 0.0, playback.duration);
    if (!playback.paused) {
        start_segment(element);
        resolve_plays(playback);
    }
}

/**
 * Read and decode the packaged source on a native job, settling on the realm;
 * a source another element of the session holds decoded settles with that.
 */
void begin_element_load(const AudioElement& element) {
    auto& playback = *element->playback;
    playback.loading = true;
    const auto generation = playback.generation;
    auto packaged = packaged_response(*playback.source);
    if (!packaged) {
        EventLoop::current().post([element, generation] {
            if (generation == element->playback->generation)
                fail_element_source(*element->playback);
        });
        return;
    }
    using Decoded = std::shared_ptr<const DecodedAudio>;
    AudioSessionMedia::Key key{std::move(packaged->path), audio_sample_rate(playback.context)};
    if (auto shared = AudioSessionMedia::find(*playback.session, key)) {
        EventLoop::current().post([element, generation, shared = std::move(shared)] {
            finish_element_load(element, generation, shared);
        });
        return;
    }
    std::weak_ptr<AudioElementState> target = element;
    std::weak_ptr<AudioSession> session = playback.session;
    // The work's own copy, taken before the call moves `key` into the completion.
    auto work = [path = key.first, rate = key.second] {
        return audio_decode_samples(read_binary_file(path), rate);
    };
    start_native_job(std::move(work), [target, session, generation,
                                       key = std::move(key)](NativeWork<Decoded>& job) mutable {
        Decoded decoded;
        try {
            decoded = job.get();
        } catch (const WorkerTerminated&) {
            throw;
        } catch (...) {
            // An unreadable file fails the source like an undecodable one.
        }
        if (const auto owner = session.lock(); owner && decoded)
            AudioSessionMedia::keep(*owner, std::move(key), decoded);
        if (const auto owner = target.lock())
            finish_element_load(owner, generation, std::move(decoded));
    });
}

/** The resource selection an element with a source and an output runs when it may load. */
void select_element_resource(const AudioElement& element, bool playing) {
    auto& playback = *element->playback;
    if (playback.source && playback.output && !playback.decoded && !playback.loading &&
        !playback.failed && (playing || audio_element_detail::lowered(playback.preload) != "none"))
        begin_element_load(element);
}

} // namespace

AudioElementState::~AudioElementState() {
    if (!playback)
        return;
    if (playback->playing)
        if (const auto node = element_node(*playback))
            node->clearSchedules();
    try {
        AudioSessionMedia::release_output(*playback);
    } catch (...) {
        // A device that cannot stop while the session tears down stops with it.
    }
}

void AudioElementState::gc_trace(const js::TraceVisitor& visitor) const {
    if (!playback)
        return;
    visitor(playback->pending_plays);
    visitor(playback->listeners);
    visitor(playback->output);
}

AudioElement audio_create_element(std::shared_ptr<AudioSession>& session) {
    if (!session)
        session = std::make_shared<AudioSession>();
    auto element = audio_create_element();
    element->playback->session = session;
    return element;
}

AudioElement audio_create_element(std::shared_ptr<AudioSession>& session, std::string url) {
    auto element = audio_create_element(session);
    element->playback->source = std::move(url);
    return element;
}

AudioContextHandle audio_media_output(std::shared_ptr<AudioSession>& session) {
    if (!session)
        session = std::make_shared<AudioSession>();
    if (session->media_output_.value && audio_state(session->media_output_) != "closed")
        return session->media_output_;
    const auto output = audio_create_context(session);
    AudioSessionMedia::reset_output(*session, output);
#if BBLITE_AUDIO_CAPTURE
    // A capture recorder renders only while something feeds it, and routed
    // elements leave this output.
    if (require_context(output.value).recorder) {
        session->media_output_feed_ = audio_create_gain(output);
        audio_connect(session->media_output_feed_, audio_destination(output));
    }
#endif
    return output;
}

js::Promise<js::PromiseVoid> audio_element_play(const AudioElement& element) {
    auto& playback = playback_of(element);
    if (!playback.source || playback.failed)
        return js::Promise<js::PromiseVoid>::rejected(
            js::dom_exception_error("The element has no supported sources.", "NotSupportedError"));
    if (!playback.output) {
        try {
            const auto context = audio_media_output(playback.session);
            const auto output = create_element_output(context);
            audio_connect(output, audio_destination(context));
            playback.context = context;
            playback.output = output;
        } catch (const WorkerTerminated&) {
            throw;
        } catch (...) {
            return js::Promise<js::PromiseVoid>::rejected(std::current_exception());
        }
    }
    js::Promise<js::PromiseVoid> promise;
    playback.pending_plays.push_back(promise);
    select_element_resource(element, true);
    // Playback that ended restarts from the beginning.
    if (playback.decoded && !playback.playing && !playback.loop &&
        playback.position >= playback.duration)
        playback.position = 0.0;
    if (playback.paused) {
        playback.paused = false;
        queue_element_events(element, {AudioElementEvent::Play});
        if (playback.decoded)
            start_segment(element);
    }
    if (playback.decoded)
        EventLoop::current().post([plays = std::exchange(playback.pending_plays, {})] {
            for (const auto& play : plays)
                play.resolve(js::PromiseVoid{});
        });
    return promise;
}

void audio_element_pause(const AudioElement& element) {
    auto& playback = playback_of(element);
    select_element_resource(element, false);
    if (playback.paused)
        return;
    playback.paused = true;
    stop_segment(playback);
    auto plays = std::exchange(playback.pending_plays, {});
    EventLoop::current().post([element, plays = std::move(plays)]() mutable {
        dispatch_element_event(*element->playback, AudioElementEvent::TimeUpdate);
        dispatch_element_event(*element->playback, AudioElementEvent::Pause);
        reject_plays(std::move(plays), "The play() request was interrupted by a call to pause().",
                     "AbortError");
    });
}

void audio_element_load(const AudioElement& element) {
    auto& playback = playback_of(element);
    ++playback.generation;
    playback.loading = false;
    stop_segment(playback);
    const bool moved = playback.position != 0.0;
    playback.decoded.reset();
    // The node releases the decoded source once it takes a silent frame in
    // its place (LabSound cannot render a source-less node it once fed).
    if (const auto node = element_node(playback))
        node->setBus(std::make_shared<lab::AudioBus>(1, 1));
    playback.duration = std::numeric_limits<double>::quiet_NaN();
    playback.failed = false;
    playback.paused = true;
    playback.position = 0.0;
    if (moved)
        queue_element_events(element, {AudioElementEvent::TimeUpdate});
    reject_plays(std::exchange(playback.pending_plays, {}),
                 "The play() request was interrupted by a new load request.", "AbortError");
    select_element_resource(element, false);
}

void audio_element_remove_source(const AudioElement& element) {
    playback_of(element).source.reset();
}

double audio_element_duration(const AudioElement& element) { return playback_of(element).duration; }

double audio_element_current_time(const AudioElement& element) {
    return current_position(playback_of(element));
}

void audio_element_set_current_time(const AudioElement& element, double seconds) {
    if (!std::isfinite(seconds))
        throw js::NamedError("TypeError", "The provided double value is non-finite.");
    auto& playback = playback_of(element);
    const bool playing = playback.playing;
    stop_segment(playback);
    playback.position =
        playback.decoded ? std::clamp(seconds, 0.0, playback.duration) : std::max(seconds, 0.0);
    if (!playback.decoded)
        return;
    if (playing)
        start_segment(element);
    queue_element_events(element, {AudioElementEvent::TimeUpdate});
}

bool audio_element_loop(const AudioElement& element) { return playback_of(element).loop; }

void audio_element_set_loop(const AudioElement& element, bool loop) {
    auto& playback = playback_of(element);
    if (playback.loop == loop)
        return;
    playback.loop = loop;
    if (playback.playing) {
        stop_segment(playback);
        start_segment(element);
    }
}

std::string audio_element_preload(const AudioElement& element) {
    // The enumerated attribute as Chromium reflects it: "" is Automatic, an
    // invalid value Metadata.
    std::string value = audio_element_detail::lowered(playback_of(element).preload);
    if (value == "none" || value == "metadata")
        return value;
    return value.empty() || value == "auto" ? "auto" : "metadata";
}

void audio_element_set_preload(const AudioElement& element, std::string preload) {
    playback_of(element).preload = std::move(preload);
    select_element_resource(element, false);
}

bool audio_element_paused(const AudioElement& element) { return playback_of(element).paused; }

bool audio_element_ended(const AudioElement& element) {
    const auto& playback = playback_of(element);
    return playback.decoded && !playback.loop && current_position(playback) >= playback.duration;
}

bool audio_element_add_listener(const AudioElement& element, AudioElementEvent type,
                                std::size_t identity, js::Callback<void()> callback, bool capture,
                                bool once, ListenerLeasePtr lease) {
    return playback_of(element).listeners[static_cast<std::size_t>(type)][capture ? 0 : 1].add(
        identity, std::move(callback), once, std::move(lease));
}

void audio_element_remove_listener(const AudioElement& element, AudioElementEvent type,
                                   std::size_t identity, bool capture) {
    playback_of(element).listeners[static_cast<std::size_t>(type)][capture ? 0 : 1].remove(
        identity);
}

AudioNodeHandle audio_create_media_element_source(AudioContextHandle context,
                                                  const AudioElement& element) {
    auto& playback = playback_of(element);
    if (playback.routed)
        throw js::make_dom_exception("HTMLMediaElement already connected previously to a different "
                                     "MediaElementSourceNode.",
                                     "InvalidStateError");
    const auto handle = create_element_output(context);
    const bool playing = playback.playing;
    bool rebind = false;
    if (playback.output) {
        // Leave the default output, keeping the position.
        stop_segment(playback);
        audio_disconnect(*playback.output);
        // A source decoded (or decoding) at another rate decodes again.
        rebind =
            playback.decoded && audio_sample_rate(playback.context) == audio_sample_rate(context);
        if (!rebind) {
            ++playback.generation;
            playback.loading = false;
            playback.decoded.reset();
        }
    }
    playback.output = handle;
    playback.context = context;
    playback.routed = true;
    if (rebind) {
        bind_decoded_source(playback);
        if (playing)
            start_segment(element);
    }
    select_element_resource(element, !playback.paused);
    return handle;
}
#endif

namespace {
void render_audio_capture([[maybe_unused]] std::uint32_t id) noexcept {
#if BBLITE_AUDIO_CAPTURE
    try {
        const CaptureRequest& request = capture_request();
        if (!request.wanted())
            return;
        auto found = contexts().find(id);
        if (found == contexts().end() || !found->second.recorder)
            return;
        ContextRecord& record = found->second;
        const int frames = static_cast<int>(record.sample_rate * request.seconds);
        record.context->synchronizeConnections();
        auto scratch = std::make_shared<lab::AudioBus>(record.channels,
                                                       lab::AudioNode::ProcessingSizeInFrames);
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
        const CaptureStats stats = captured ? measure(*captured) : CaptureStats{};
        const bool written =
            captured && write_float_wav(request.path, *captured, record.sample_rate);

        std::fprintf(stderr,
                     "[bblite audio] captured %d frames at %.0f Hz, peak %.6f, "
                     "rms %.6f -> %s%s\n",
                     stats.frames, record.sample_rate, static_cast<double>(stats.peak), stats.rms,
                     request.path.c_str(), written ? "" : " (WRITE FAILED)");
    } catch (const std::exception& error) {
        std::fprintf(stderr, "[bblite audio] capture failed: %s\n", error.what());
    }
#endif
}
} // namespace

void AudioSession::finish() noexcept {
    run_teardown("AudioSession finish", [this] {
        for (const auto& context : contexts_) {
            render_audio_capture(context.value);
            audio_close_context(context);
        }
        contexts_.clear();
    });
}

} // namespace bbl::pal
