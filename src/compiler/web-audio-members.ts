/**
 * The Web Audio and media members both lowerings serve, each fact once: a
 * member's name, the PAL entry point or enumerator that implements it, and
 * whether a program may write it. The pinned libraries' records
 * (`webAudioRecords` in `src/lowering/web-platform-schema.ts`) and the
 * application surface (`properties.ts` reads, `audio-surface.ts` writes and
 * calls, `media-streams.ts`) are both built from these tables, each spelling
 * its own arguments: pinned bodies hand over doubles, application code
 * compiles each operand to its native type.
 */

/** `node.<name>`: each automatable parameter's `AudioParamName` enumerator. */
export const AUDIO_PARAM_NAMES = [
    ["gain", "Gain"],
    ["frequency", "Frequency"],
    ["detune", "Detune"],
    ["Q", "Q"],
    ["pan", "Pan"],
    ["playbackRate", "PlaybackRate"],
    ["positionX", "PositionX"],
    ["positionY", "PositionY"],
    ["positionZ", "PositionZ"],
    ["orientationX", "OrientationX"],
    ["orientationY", "OrientationY"],
    ["orientationZ", "OrientationZ"],
] as const;

/** A panner's numeric attributes, each its `PannerProperty` enumerator. */
export const PANNER_PROPERTIES = [
    ["refDistance", "RefDistance"],
    ["maxDistance", "MaxDistance"],
    ["rolloffFactor", "RolloffFactor"],
    ["coneInnerAngle", "ConeInnerAngle"],
    ["coneOuterAngle", "ConeOuterAngle"],
    ["coneOuterGain", "ConeOuterGain"],
] as const;

/** A panner's string models, each its `PannerModel` enumerator. */
export const PANNER_MODELS = [
    ["panningModel", "Panning"],
    ["distanceModel", "Distance"],
] as const;

/** An analyser's numeric attributes: its `AnalyserProperty` enumerator, and whether it is writable. */
export const ANALYSER_PROPERTIES = [
    ["fftSize", "FftSize", true],
    ["frequencyBinCount", "FrequencyBinCount", false],
    ["minDecibels", "MinDecibels", true],
    ["maxDecibels", "MaxDecibels", true],
    ["smoothingTimeConstant", "SmoothingTimeConstant", true],
] as const;

/** An analyser's readouts: the element type each writes and its `AnalyserData` enumerator. */
export const ANALYSER_READOUTS = [
    ["getByteFrequencyData", "u8array", "Frequency"],
    ["getFloatFrequencyData", "f32array", "Frequency"],
    ["getByteTimeDomainData", "u8array", "TimeDomain"],
    ["getFloatTimeDomainData", "f32array", "TimeDomain"],
] as const;

/** A buffer source's loop flag and points: `audio_<native>` reads, `audio_set_<native>` writes. */
export const SOURCE_LOOP_MEMBERS = [
    ["loop", "boolean", "loop"],
    ["loopStart", "number", "loop_start"],
    ["loopEnd", "number", "loop_end"],
] as const;

/** `AudioBuffer` reads, each its `AudioBufferProperty` enumerator. */
export const AUDIO_BUFFER_PROPERTIES = [
    ["duration", "Duration"],
    ["length", "Length"],
    ["sampleRate", "SampleRate"],
    ["numberOfChannels", "NumberOfChannels"],
] as const;

/** `param.<method>(value, time)`: each schedule's PAL entry point. */
export const AUDIO_PARAM_SCHEDULES = [
    ["setValueAtTime", "audio_param_set_value_at_time"],
    ["linearRampToValueAtTime", "audio_param_linear_ramp"],
    ["exponentialRampToValueAtTime", "audio_param_exponential_ramp"],
] as const;

/** The context's listener parameters, each `AudioParamName::Listener<Name>`. */
export const AUDIO_LISTENER_PARAMS = [
    "positionX",
    "positionY",
    "positionZ",
    "forwardX",
    "forwardY",
    "forwardZ",
    "upX",
    "upY",
    "upZ",
] as const;

/** `AudioParamName::Listener<Name>` for a listener parameter. */
export function listenerParamName(
    name: (typeof AUDIO_LISTENER_PARAMS)[number],
): string {
    return `Listener${name[0]!.toUpperCase()}${name.slice(1)}`;
}

/**
 * `HTMLAudioElement` media state: `audio_element_<native>` reads, and
 * `audio_element_set_<native>` writes for the writable ones.
 */
export const AUDIO_ELEMENT_PROPERTIES = [
    ["duration", "number", "duration", false],
    ["currentTime", "number", "current_time", true],
    ["loop", "boolean", "loop", true],
    ["paused", "boolean", "paused", false],
    ["ended", "boolean", "ended", false],
    ["preload", "string", "preload", true],
] as const;

/** `HTMLAudioElement` event types and their `AudioElementEvent`. */
export const AUDIO_ELEMENT_EVENTS: Readonly<Record<string, string>> = {
    timeupdate: "TimeUpdate",
    ended: "Ended",
    play: "Play",
    pause: "Pause",
    canplaythrough: "CanPlayThrough",
    error: "Error",
};

/** `MediaStream` reads: `media_stream_<native>`; a changing one is impure. */
export const MEDIA_STREAM_PROPERTIES = [
    ["id", "string", "id", false],
    ["active", "boolean", "active", true],
] as const;

/**
 * `MediaStreamTrack` reads: `media_stream_track_<native>`; a changing one is
 * impure, and `enabled` is written through `media_stream_track_set_enabled`.
 */
export const MEDIA_STREAM_TRACK_PROPERTIES = [
    ["kind", "string", "kind", false],
    ["id", "string", "id", false],
    ["label", "string", "label", false],
    ["readyState", "string", "ready_state", true],
    ["enabled", "boolean", "enabled", true],
] as const;

/** A stream's track lists: `media_stream_tracks(stream, kind)`, "" for every track. */
export const MEDIA_STREAM_TRACK_LISTS = [
    ["getTracks", ""],
    ["getAudioTracks", "audio"],
    ["getVideoTracks", "video"],
] as const;

/** `ctx.create<Node>()`: each factory's PAL entry point and the feature its node needs. */
export const AUDIO_NODE_FACTORIES = [
    ["createGain", "audio_create_gain", undefined],
    ["createOscillator", "audio_create_oscillator", "audio:oscillator"],
    ["createBiquadFilter", "audio_create_biquad_filter", "audio:biquad-filter"],
    ["createStereoPanner", "audio_create_stereo_panner", "audio:stereo-panner"],
    ["createPanner", "audio_create_panner", "audio:panner"],
    ["createBufferSource", "audio_create_buffer_source", "audio:buffer-source"],
] as const;

/** `oscillator.type`: each Web Audio spelling's `OscillatorWave` enumerator. */
export const OSCILLATOR_WAVES = [
    ["sine", "Sine"],
    ["square", "Square"],
    ["sawtooth", "Sawtooth"],
    ["triangle", "Triangle"],
] as const;

/** `filter.type`: each Web Audio spelling's `BiquadFilterKind` enumerator. */
export const BIQUAD_FILTER_KINDS = [
    ["lowpass", "Lowpass"],
    ["highpass", "Highpass"],
    ["bandpass", "Bandpass"],
    ["lowshelf", "Lowshelf"],
    ["highshelf", "Highshelf"],
    ["peaking", "Peaking"],
    ["notch", "Notch"],
    ["allpass", "Allpass"],
] as const;

/** `context.resume()`, `suspend()`, `close()`: each transition's `AudioContextAction`. */
export const AUDIO_CONTEXT_TRANSITIONS = [
    ["resume", "Resume"],
    ["suspend", "Suspend"],
    ["close", "Close"],
] as const;
