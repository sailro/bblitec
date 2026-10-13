#pragma once

/**
 * The Web Audio boundary.
 *
 * The seam is the pin's own, and it is the same shape the rigid-body and
 * navigation seams take. `packages/babylon-lite/src/audio/` is a
 * behavioural port of Babylon.js AudioV2 whose entire platform reach is
 * `AudioContext`, `GainNode`, `PannerNode`, `StereoPannerNode`,
 * `AnalyserNode`, `AudioBufferSourceNode` and `AudioParam` -- plus the
 * `document`/`navigator` hooks in the modules this port refuses by name.
 * Where physics takes `hknp` as a parameter and navigation takes a
 * wrapper module, audio takes the *browser*: `new GainNode(ctx)`,
 * `gain.connect(...)`, `param.setValueCurveAtTime(...)`. So the surface
 * this header mirrors is the Web Audio API, and everything above it --
 * buses, the sound sub-graph, the ramp curves, spatial panner
 * configuration, the sound state machine -- is Babylon behaviour that
 * belongs in generated code.
 *
 * Corpus reach: interactive applications use the Lite engine for lifecycle
 * only -- `createAudioEngineAsync`, `engine.audioContext`,
 * `createSoundSourceAsync`, `unlockAudioEngineAsync` -- and then build
 * their own raw Web Audio graph on the context it hands back. The eighth
 * consumer is `audio-demo.ts`, the audio module's own Tier-4 showcase,
 * and it is the one place `createSoundAsync`/`playSound`, the microphone,
 * the visualizer and the unmute UI are reached at all; upstream marks it
 * manual and non-deterministic, never a gate.
 *
 * That split is why this header is the Web Audio API rather than
 * Babylon's sound API: the surface every shipped consumer actually calls
 * is the browser's.
 *
 * **Every entry point here is one a generated scene can reach.** Buffer
 * creation/playback is a separate reached feature, so applications that do
 * not use sampled audio do not compile its node implementation. The
 * ramp-curve scheduler remains absent and is refused by the compiler.
 *
 * The implementation behind it is LabSound (`pal_audio_labsound.cpp`), a
 * BSD-licensed C++ Web Audio engine forked from WebKit's, whose platform
 * stream sits behind its own `lab::AudioDevice` interface -- so the
 * device is SDL3 like every other platform service here
 * (`pal_audio_sdl_device.hpp`). Nothing generated names LabSound or SDL.
 *
 * **How an audio result is measured.** In a build configured with
 * `BBLITE_AUDIO_CAPTURE=ON`, `BBLITE_AUDIO_CAPTURE=<path.wav>`
 * makes a context render offline instead of opening a device: the
 * scene's graph is identical and nothing runs in real time, and
 * `AudioSession::finish` -- called at the end of its engine's `run_engine`,
 * the one place a run ends -- renders
 * `BBLITE_AUDIO_CAPTURE_SECONDS` (default 1.0) and writes 32-bit float
 * WAV beside a one-line summary of frames, peak and RMS. Two runs of one
 * scene produce byte-identical PCM, which is what makes a comparison
 * against the browser's own `OfflineAudioContext` render a measurement
 * rather than an opinion. This repository does not accept a result it
 * cannot measure.
 *
 * **Two clocks, and they are not the frame clock.** Web Audio schedules
 * against `AudioContext.currentTime`, which advances on the audio
 * thread in 128-frame quanta. A scene schedules ahead of it
 * (`osc.start(ctx.currentTime + 0.05)`); nothing here is stepped by the
 * renderer. A capture context has no thread at all and advances only
 * inside the capture render, which is what makes a native audio result
 * measurable rather than audible.
 */

#include <bblite/features/workers.hpp>

#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>
#include <bblite/js_data.hpp>
#include <bblite/pal_audio_types.hpp>
#include <bblite/js_callback.hpp>
#include <bblite/listener_lease.hpp>

namespace bbl::pal {

#if BBLITE_WORKERS
/**
 * Scheduled-source callbacks run through their owning realm's event queue. An
 * addition under an AbortSignal holds its `lease` (`bbl::js::add_event_listener`);
 * false for a listener already added.
 */
bool audio_add_ended_listener(AudioNodeHandle node, std::size_t identity,
                              js::Callback<void()> callback, bool capture = false,
                              bool once = false, ListenerLeasePtr lease = {});
void audio_remove_ended_listener(AudioNodeHandle node, std::size_t identity, bool capture = false);
void audio_set_ended_handler(AudioNodeHandle node, js::Callback<void()> callback);
#endif

namespace detail {
class AudioDeviceSdl3;
}
/** A real-time context's open playback device (`audio_open_device`); native data only. */
using AudioPlaybackDevice = detail::AudioDeviceSdl3;

struct DecodedAudio;

/** Context ownership follows the generated engine, including failed startup. */
class AudioSession {
public:
    AudioSession() = default;
    AudioSession(const AudioSession&) = delete;
    AudioSession& operator=(const AudioSession&) = delete;
    ~AudioSession();
    void finish() noexcept;

private:
    std::vector<AudioContextHandle> contexts_;
    /** The default output unrouted media elements share, once one plays. */
    AudioContextHandle media_output_{};
    /** A silent input keeping that output's capture recorder fed once elements leave it. */
    AudioNodeHandle media_output_feed_{};
    /**
     * Packaged sources decoded for media elements, by file and sample rate: the
     * elements playing one share its decode, which lives while one holds it.
     */
    std::map<std::pair<std::string, double>, std::weak_ptr<const DecodedAudio>> decoded_;
    /** Unrouted elements playing to the default output: its device runs while one does. */
    std::size_t media_playing_ = 0;
    friend struct AudioSessionMedia;
    friend AudioContextHandle audio_create_context(std::shared_ptr<AudioSession>& session,
                                                   std::shared_ptr<AudioPlaybackDevice> device);
    friend AudioContextHandle audio_media_output(std::shared_ptr<AudioSession>& session);
};

/** The session's media element output context, created on first use. */
AudioContextHandle audio_media_output(std::shared_ptr<AudioSession>& session);

/** `OscillatorNode.type`. */
enum class OscillatorWave : std::uint8_t {
    Sine,
    Square,
    Sawtooth,
    Triangle,
};

/** `BiquadFilterNode.type`. */
enum class BiquadFilterKind : std::uint8_t {
    Lowpass,
    Highpass,
    Bandpass,
    Lowshelf,
    Highshelf,
    Peaking,
    Notch,
    Allpass,
};

// -- context lifecycle ---------------------------------------------------

/**
 * The supported no-options `new AudioContext()` uses the device's rate
 * and channel count. Browser constructor options, including a requested
 * sample rate, are outside this entry point. Opening fails by throwing,
 * exactly as this project's GPU backends throw rather than degrading.
 *
 * When the capture capability was compiled, `BBLITE_AUDIO_CAPTURE` builds a
 * capture context instead:
 * the same graph with no device and no thread.
 */
AudioContextHandle audio_create_context();
AudioContextHandle audio_create_context(std::shared_ptr<AudioSession>& session);

/**
 * The steps of `audio_create_context`. `audio_begin_context` runs on the realm:
 * it sets LabSound's log level and says whether the context renders offline
 * (refusing a capture request a build cannot honor); otherwise, on SDL's main
 * thread, it initializes SDL's audio subsystem for the run, and elsewhere it
 * refuses unless that thread has initialized or announced it.
 * `audio_open_device` opens the playback device, none for capture, on any
 * thread, once an announced initialization finishes; the context around it is
 * created and joins `session` on the realm.
 */
bool audio_begin_context();
std::shared_ptr<AudioPlaybackDevice> audio_open_device(bool capture);
AudioContextHandle audio_create_context(std::shared_ptr<AudioSession>& session,
                                        std::shared_ptr<AudioPlaybackDevice> device);

/**
 * SDL initializes its audio subsystem on its main thread, once for the run,
 * never on a worker; devices never quit it (SDL_Quit at exit does). A host
 * whose realm runs on another thread calls both on SDL's main thread:
 * `audio_announce_subsystem` before starting that realm, and
 * `audio_initialize_subsystem` while it starts, before waiting on it; the
 * realm's device opens wait for the initialization. Neither does anything
 * while `BBLITE_AUDIO_CAPTURE` renders contexts offline.
 */
void audio_announce_subsystem();
void audio_initialize_subsystem();

/** Idempotent session teardown; asynchronous close checks lifecycle separately. */
void audio_close_context(AudioContextHandle context);

/** `ctx.currentTime`. */
double audio_current_time(AudioContextHandle context);

/** `ctx.sampleRate`. */
double audio_sample_rate(AudioContextHandle context);

/** `AudioContext.state`, including closed aliases retained after device teardown. */
std::string audio_state(AudioContextHandle context);

/** `ctx.resume()`. Inert on a capture context, as the pin's unlock is. */
void audio_resume(AudioContextHandle context);

/** Pause rendering and its clock while retaining the graph. */
void audio_suspend(AudioContextHandle context);

/** `ctx.destination`. */
AudioNodeHandle audio_destination(AudioContextHandle context);

// -- node construction ---------------------------------------------------

AudioNodeHandle audio_create_gain(AudioContextHandle context);
AudioNodeHandle audio_create_oscillator(AudioContextHandle context);
AudioNodeHandle audio_create_biquad_filter(AudioContextHandle context);
AudioNodeHandle audio_create_stereo_panner(AudioContextHandle context);
/**
 * `ctx.createMediaStreamDestination()`: a sink the context renders every
 * quantum into its `stream`'s one audio track (`bblite/pal_media_stream.hpp`).
 */
AudioNodeHandle audio_create_media_stream_destination(AudioContextHandle context);
std::shared_ptr<MediaStream> audio_destination_stream(AudioNodeHandle node);
/**
 * `ctx.createMediaStreamSource(stream)`: the stream's first audio track by id,
 * the destination audio it carries from any context at the same sample rate.
 * InvalidStateError without an audio track.
 */
AudioNodeHandle audio_create_media_stream_source(AudioContextHandle context,
                                                 const std::shared_ptr<MediaStream>& stream);

/**
 * `ctx.createPanner()` / `new PannerNode(ctx)`, with Web Audio's defaults:
 * equal-power panning, the inverse distance model, refDistance 1,
 * maxDistance 10000, rolloffFactor 1, a full cone.
 */
AudioNodeHandle audio_create_panner(AudioContextHandle context);

/** A PannerNode's numeric attributes. */
enum class PannerProperty : std::uint8_t {
    RefDistance,
    MaxDistance,
    RolloffFactor,
    ConeInnerAngle,
    ConeOuterAngle,
    ConeOuterGain,
};
double audio_panner_property(AudioNodeHandle panner, PannerProperty property);
/** A write the attribute rejects throws as Web Audio does (RangeError, InvalidStateError). */
void audio_set_panner_property(AudioNodeHandle panner, PannerProperty property, double value);

/** `panner.panningModel` and `panner.distanceModel`, as Web Audio spells them. */
enum class PannerModel : std::uint8_t { Panning, Distance };
std::string audio_panner_model(AudioNodeHandle panner, PannerModel which);
/**
 * A value outside the enumeration is ignored, as WebIDL ignores it; `"HRTF"`
 * throws, since this build packages no HRTF database.
 */
void audio_set_panner_model(AudioNodeHandle panner, PannerModel which, const std::string& value);

/** `ctx.listener.<name>`: a listener parameter (the `Listener*` names). */
AudioParamHandle audio_listener_param(AudioContextHandle context, AudioParamName name);

/** `ctx.createBuffer(channels, frames, sampleRate)`. */
AudioBufferHandle audio_create_buffer(AudioContextHandle context, std::uint32_t channels,
                                      std::uint32_t frames, double sample_rate);

/** Decode encoded bytes at the context's sample rate. */
AudioBufferHandle audio_decode_buffer(AudioContextHandle context,
                                      const bbl::js::ArrayBuffer& encoded);

/**
 * The two halves of `audio_decode_buffer`: `audio_decode_samples` decodes and
 * resamples a copy of the encoded bytes on any thread (null when they are not
 * decodable); `audio_buffer_from_decoded` makes the context's buffer on the
 * realm, an empty handle when it cannot.
 */
struct DecodedAudio;
std::shared_ptr<const DecodedAudio> audio_decode_samples(const std::vector<std::uint8_t>& bytes,
                                                         double sample_rate);
AudioBufferHandle audio_buffer_from_decoded(AudioContextHandle context,
                                            const std::shared_ptr<const DecodedAudio>& decoded);

/** `buffer.getChannelData(channel)`: a mutable view into retained PCM. */
bbl::js::F32Array audio_buffer_channel(AudioBufferHandle buffer, std::uint32_t channel);

enum class AudioBufferProperty { Duration, Length, SampleRate, NumberOfChannels };
double audio_buffer_property(AudioBufferHandle buffer, AudioBufferProperty property);
enum class AudioBufferCopy { FromChannel, ToChannel };
void audio_buffer_copy(AudioBufferHandle buffer, bbl::js::F32Array samples, std::uint32_t channel,
                       std::uint32_t offset, AudioBufferCopy direction);
bbl::js::Nullable<AudioBufferHandle> audio_source_buffer(AudioNodeHandle source);

/** `ctx.createBufferSource()`. */
AudioNodeHandle audio_create_buffer_source(AudioContextHandle context);

/** `AudioBufferSourceOptions`: the members a lowered library passes. */
struct AudioBufferSourceInit {
    bbl::js::Nullable<AudioBufferHandle> buffer;
};

/** `new AudioBufferSourceNode(ctx, { buffer })`. */
AudioNodeHandle audio_create_buffer_source(AudioContextHandle context,
                                           const AudioBufferSourceInit& options);

/** `source.buffer = buffer`. */
void audio_set_buffer(AudioNodeHandle source, AudioBufferHandle buffer);

/** `source.loop = enabled`. */
void audio_set_loop(AudioNodeHandle source, bool enabled);

/** `source.loop`, `source.loopStart`, `source.loopEnd`, and their writes. */
bool audio_loop(AudioNodeHandle source);
double audio_loop_start(AudioNodeHandle source);
double audio_loop_end(AudioNodeHandle source);
void audio_set_loop_start(AudioNodeHandle source, double seconds);
void audio_set_loop_end(AudioNodeHandle source, double seconds);

// -- graph ---------------------------------------------------------------

/**
 * `source.connect(destination)`. The edge is visible to the graph at the
 * next render quantum, which is the moment the browser makes it visible
 * too -- the backend's own deferral is not a contract a caller has to
 * know about, so there is no flush entry point.
 */
void audio_connect(AudioNodeHandle source, AudioNodeHandle destination);

/** `source.connect(destinationParam)` -- an audio-rate modulation edge. */
void audio_connect_param(AudioNodeHandle source, AudioParamHandle destination);

/** `node.disconnect()` -- every outgoing edge. */
void audio_disconnect(AudioNodeHandle node);

/**
 * `node.disconnect(destination[, output[, input]])` -- the edges into
 * `destination`'s input (never its parameters). An index the nodes do not
 * have is an IndexSizeError; no such edge is an InvalidAccessError.
 */
void audio_disconnect(AudioNodeHandle node, AudioNodeHandle destination,
                      bbl::js::Nullable<double> output = std::nullopt,
                      bbl::js::Nullable<double> input = std::nullopt);

/** `source.start(when)`, in context time. */
void audio_node_start(AudioNodeHandle node, double when);

/** `source.start(when, offset)`, with the offset in buffer seconds. */
void audio_node_start(AudioNodeHandle node, double when, double offset);

/** `source.start(when, offset, duration)`, all values in seconds. */
void audio_node_start(AudioNodeHandle node, double when, double offset, double duration);

/** `source.start(when, offset, duration)` where `duration` may be `undefined`. */
void audio_node_start(AudioNodeHandle node, double when, double offset,
                      bbl::js::Nullable<double> duration);

/** `source.stop(when)`, in context time. */
void audio_node_stop(AudioNodeHandle node, double when);

// -- node properties -----------------------------------------------------

/** `node.<name>`. Pure: the same node and name give the same parameter. */
AudioParamHandle audio_node_param(AudioNodeHandle node, AudioParamName name);

/** `oscillator.type = ...`. */
void audio_set_oscillator_wave(AudioNodeHandle node, OscillatorWave wave);

/** `filter.type = ...`. */
void audio_set_filter_kind(AudioNodeHandle node, BiquadFilterKind kind);

// -- parameter automation ------------------------------------------------

/** `param.value`. */
float audio_param_value(AudioParamHandle param);

/** `param.value = v`. */
void audio_param_set_value(AudioParamHandle param, float value);

/** `param.setValueAtTime(v, t)`. */
void audio_param_set_value_at_time(AudioParamHandle param, float value, double time);

/** `param.linearRampToValueAtTime(v, t)`. */
void audio_param_linear_ramp(AudioParamHandle param, float value, double time);

/** `param.exponentialRampToValueAtTime(v, t)`. */
void audio_param_exponential_ramp(AudioParamHandle param, float value, double time);

/** `param.cancelScheduledValues(t)`. */
void audio_param_cancel_scheduled_values(AudioParamHandle param, double time);

/**
 * `param.setValueCurveAtTime(values, startTime, duration)`: the values are
 * copied at the call. Fewer than two values is an InvalidStateError; a
 * negative start or a non-positive duration a RangeError.
 */
void audio_param_set_value_curve(AudioParamHandle param, const bbl::js::F32Array& values,
                                 double start, double duration);

/** Reclaim discarded graphs at a control-thread frame boundary. */
void audio_collect_finished();

} // namespace bbl::pal
