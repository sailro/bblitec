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
 * Corpus reach: **no `sceneNNN` scene uses audio at all.** The reach is
 * upstream's seven game demos (tetris, quake, doom,
 * minecraft, platformer, racer, sandblox), which use the Lite engine for
 * lifecycle ONLY -- `createAudioEngineAsync`, `engine.audioContext`,
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
 * **Every entry point here is one a generated scene can reach.** The
 * buffer family (`createBuffer`, `getChannelData`, a source's `buffer`)
 * and the ramp-curve scheduler are deliberately absent: the compiler
 * refuses their call sites by name, so declaring them would put dead
 * surface in a contract header. [TODO](../../../TODO.md) names what each
 * needs.
 *
 * The implementation behind it is LabSound (`pal_audio_labsound.cpp`), a
 * BSD-licensed C++ Web Audio engine forked from WebKit's, whose platform
 * stream sits behind its own `lab::AudioDevice` interface -- so the
 * device is SDL3 like every other platform service here
 * (`pal_audio_sdl_device.hpp`). Nothing generated names LabSound or SDL.
 *
 * **How an audio result is measured.** `BBLITE_AUDIO_CAPTURE=<path.wav>`
 * makes a context render offline instead of opening a device: the
 * scene's graph is identical and nothing runs in real time, and
 * `audio_render_pending_captures` -- called at the end of `run_engine`,
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

#include <cstdint>

namespace bbl::pal {

/** One audio context: a real-time SDL3 device, or a capture render. */
struct AudioContextHandle {
    std::uint32_t value = 0;
};

/** One node in a context's graph. */
struct AudioNodeHandle {
    std::uint32_t value = 0;
};

/**
 * The automatable parameters the reached slice names, as the enumerator
 * a generated caller passes rather than the string Web Audio spells --
 * the contract `pinned_depth_compare` and `pinned_blend_table` already
 * hold for their own enumerations.
 */
enum class AudioParamName : std::uint8_t {
    Gain,
    Frequency,
    Detune,
    Q,
    Pan,
};

/**
 * One automatable scalar on a node (`gain`, `frequency`, ...).
 *
 * It is a *value*, not an id into a table, because Web Audio's contract
 * is identity: `osc.frequency` returns the same `AudioParam` object on
 * every read, and the pinned ramp component depends on that -- it
 * retains the object and keeps `_rampEndTime` state on it. A handle
 * minted per call would make two reads of one parameter two parameters.
 */
struct AudioParamHandle {
    AudioNodeHandle node;
    AudioParamName name = AudioParamName::Gain;
};

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
 * `new AudioContext()`. The rate and channel count are the device's --
 * Web Audio's constructor takes neither, and which they are is a
 * platform answer rather than a Babylon one. Opening fails by throwing,
 * exactly as this project's GPU backends throw rather than degrading.
 *
 * Under `BBLITE_AUDIO_CAPTURE` this builds a capture context instead:
 * the same graph with no device and no thread.
 */
AudioContextHandle audio_create_context();

/** `ctx.close()` plus the device teardown a real-time context owns. */
void audio_close_context(AudioContextHandle context);

/** `ctx.currentTime`. */
double audio_current_time(AudioContextHandle context);

/** `ctx.sampleRate`. */
double audio_sample_rate(AudioContextHandle context);

/** `ctx.resume()`. Inert on a capture context, as the pin's unlock is. */
void audio_resume(AudioContextHandle context);

/** `ctx.destination`. */
AudioNodeHandle audio_destination(AudioContextHandle context);

// -- node construction ---------------------------------------------------

AudioNodeHandle audio_create_gain(AudioContextHandle context);
AudioNodeHandle audio_create_oscillator(AudioContextHandle context);
AudioNodeHandle audio_create_biquad_filter(AudioContextHandle context);
AudioNodeHandle audio_create_stereo_panner(AudioContextHandle context);

// -- graph ---------------------------------------------------------------

/**
 * `source.connect(destination)`. The edge is visible to the graph at the
 * next render quantum, which is the moment the browser makes it visible
 * too -- the backend's own deferral is not a contract a caller has to
 * know about, so there is no flush entry point.
 */
void audio_connect(AudioNodeHandle source, AudioNodeHandle destination);

/** `node.disconnect()` -- every outgoing edge. */
void audio_disconnect(AudioNodeHandle node);

/** `source.start(when)`, in context time. */
void audio_node_start(AudioNodeHandle node, double when);

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

// -- capture -------------------------------------------------------------

/**
 * Render and write every context `BBLITE_AUDIO_CAPTURE` asked for.
 *
 * Called once from `pal::run_engine`, which is the one place a run ends
 * -- the same seam `CaptureGate` takes a screenshot at, rather than an
 * `atexit` hook running after teardown has begun. A build that compiled
 * no audio has nothing to render, which is what the stub says.
 */
#if defined(BBLITE_HAS_AUDIO) && BBLITE_HAS_AUDIO
void audio_render_pending_captures();
#else
inline void audio_render_pending_captures() {}
#endif

} // namespace bbl::pal
