#pragma once

/**
 * `HTMLAudioElement`. A lowered library asks `canPlayType`, answered from the
 * decoders this build links (`audio:decode-*`). Application playback
 * (`audio:media-element`, `pal_audio_labsound.cpp`) decodes the element's
 * packaged source whole on a native job and plays it on its context's clock:
 * through the node `createMediaElementSource` made, or else to the default
 * output, a context its audio session shares among unrouted elements.
 */

#include <bblite/features/audio_decode_flac.hpp>
#include <bblite/features/audio_decode_mp3.hpp>
#include <bblite/features/audio_decode_mpc.hpp>
#include <bblite/features/audio_decode_ogg.hpp>
#include <bblite/features/audio_decode_opus.hpp>
#include <bblite/features/audio_decode_wav.hpp>
#include <bblite/features/audio_decode_wv.hpp>
#include <bblite/features/has_audio_media_element.hpp>

#include <bblite/js_gc.hpp>
#include <bblite/pal_audio_types.hpp>
#if BBLITE_HAS_AUDIO_MEDIA_ELEMENT
#include <bblite/js_callback.hpp>
#include <bblite/js_promise.hpp>
#include <bblite/pal_audio.hpp>
#endif

#include <algorithm>
#include <cctype>
#include <initializer_list>
#include <memory>
#include <string>
#include <string_view>

namespace bbl::pal {

#if BBLITE_HAS_AUDIO_MEDIA_ELEMENT
/** An element's source, playback state and listeners (`pal_audio_labsound.cpp`). */
struct AudioElementPlayback;
#endif

/** One `HTMLAudioElement`. */
struct AudioElementState {
#if BBLITE_HAS_AUDIO_MEDIA_ELEMENT
    AudioElementState();
    AudioElementState(const AudioElementState&) = delete;
    AudioElementState& operator=(const AudioElementState&) = delete;
    ~AudioElementState();
    std::unique_ptr<AudioElementPlayback> playback;
    void gc_trace(const js::TraceVisitor& visitor) const;
#endif
};
using AudioElement = std::shared_ptr<AudioElementState>;

/** `new Audio()`. */
[[nodiscard]] inline AudioElement audio_create_element() {
    return js::make_gc_shared<AudioElementState>();
}

/** `document.createElement("source")`: a candidate source for an Audio element. */
struct AudioSourceElementState {
    std::string src;
    void gc_trace(const js::TraceVisitor&) const {}
};
using AudioSourceElement = std::shared_ptr<AudioSourceElementState>;
[[nodiscard]] inline AudioSourceElement audio_create_source_element() {
    return js::make_gc_shared<AudioSourceElementState>();
}
/** `source.src = url`, read when the element selects its resource. */
inline void audio_source_element_set_src(const AudioSourceElement& source, std::string src) {
    source->src = std::move(src);
}

#if BBLITE_HAS_AUDIO_MEDIA_ELEMENT
/**
 * `new Audio([url])` in `session`, whose default output it plays to until
 * routed; `url` selects a packaged response (`register_packaged_responses`).
 */
[[nodiscard]] AudioElement audio_create_element(std::shared_ptr<AudioSession>& session);
[[nodiscard]] AudioElement audio_create_element(std::shared_ptr<AudioSession>& session,
                                                std::string url);

/**
 * `play()`: settles in a task once playback starts. Rejects with
 * NotSupportedError for an element with no source or a source that is not
 * packaged or not decodable, and with AbortError when `pause()` or `load()`
 * interrupts it.
 */
[[nodiscard]] js::Promise<js::PromiseVoid> audio_element_play(const AudioElement& element);
void audio_element_pause(const AudioElement& element);
/** `load()`: rejects pending plays, releases the decoded source, rewinds, reloads. */
void audio_element_load(const AudioElement& element);
/** `removeAttribute("src")`: takes effect at the next `load()`. */
void audio_element_remove_source(const AudioElement& element);
/**
 * `appendChild(source)`: without a `src`, the element tries its source
 * children in order, each packaged and decodable or the next; when none is,
 * it waits with no `error` of its own, as browsers do.
 */
void audio_element_append_source(const AudioElement& element, const AudioSourceElement& source);

/** `duration`: NaN until the source is decoded. */
[[nodiscard]] double audio_element_duration(const AudioElement& element);
[[nodiscard]] double audio_element_current_time(const AudioElement& element);
/** `currentTime = seconds`: a seek, clamped to the duration once known. */
void audio_element_set_current_time(const AudioElement& element, double seconds);
[[nodiscard]] bool audio_element_loop(const AudioElement& element);
void audio_element_set_loop(const AudioElement& element, bool loop);
[[nodiscard]] std::string audio_element_preload(const AudioElement& element);
void audio_element_set_preload(const AudioElement& element, std::string preload);
[[nodiscard]] bool audio_element_paused(const AudioElement& element);
[[nodiscard]] bool audio_element_ended(const AudioElement& element);
/**
 * `crossOrigin = value` and `controls = value`: kept, with no effect on
 * playback (a packaged source has no origin, a native element no controls).
 */
void audio_element_set_cross_origin(const AudioElement& element, js::Nullable<std::string> value);
void audio_element_set_controls(const AudioElement& element, bool value);

/**
 * The events an element dispatches to listeners: `canplaythrough` once its
 * source is decoded, `error` when no supported source was found.
 */
enum class AudioElementEvent : std::uint8_t {
    TimeUpdate,
    Ended,
    Play,
    Pause,
    CanPlayThrough,
    Error,
};
/** An addition under an AbortSignal holds its `lease`; false for a listener already added. */
bool audio_element_add_listener(const AudioElement& element, AudioElementEvent type,
                                std::size_t identity, js::Callback<void()> callback, bool capture,
                                bool once, ListenerLeasePtr lease = {});
void audio_element_remove_listener(const AudioElement& element, AudioElementEvent type,
                                   std::size_t identity, bool capture);

/**
 * `context.createMediaElementSource(element)`: the element's output, from now
 * on only into the returned node (playback in progress moves there). A second
 * call throws InvalidStateError.
 */
[[nodiscard]] AudioNodeHandle audio_create_media_element_source(AudioContextHandle context,
                                                                const AudioElement& element);

/** `MediaElementAudioSourceOptions`: the member a lowered library passes. */
struct MediaElementAudioSourceInit {
    AudioElement media_element;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(media_element); }
};

/** `new MediaElementAudioSourceNode(context, { mediaElement })`. */
[[nodiscard]] inline AudioNodeHandle
audio_create_media_element_source(AudioContextHandle context,
                                  const MediaElementAudioSourceInit& options) {
    return audio_create_media_element_source(context, options.media_element);
}
#endif

namespace audio_element_detail {

[[nodiscard]] inline std::string lowered(std::string_view text) {
    std::string result(text);
    std::transform(result.begin(), result.end(), result.begin(),
                   [](unsigned char unit) { return static_cast<char>(std::tolower(unit)); });
    return result;
}

[[nodiscard]] inline std::string_view trimmed(std::string_view text) {
    while (!text.empty() && (text.front() == ' ' || text.front() == '\t'))
        text.remove_prefix(1);
    while (!text.empty() && (text.back() == ' ' || text.back() == '\t'))
        text.remove_suffix(1);
    return text;
}

/** Whether every codec a `codecs` parameter lists is one of `accepted`. */
[[nodiscard]] inline bool codecs_within(std::string_view codecs,
                                        std::initializer_list<std::string_view> accepted) {
    if (codecs.size() >= 2 && codecs.front() == '"' && codecs.back() == '"')
        codecs = codecs.substr(1, codecs.size() - 2);
    while (!codecs.empty()) {
        const auto comma = codecs.find(',');
        const auto codec = trimmed(codecs.substr(0, comma));
        if (std::find(accepted.begin(), accepted.end(), codec) == accepted.end())
            return false;
        if (comma == std::string_view::npos)
            break;
        codecs.remove_prefix(comma + 1);
    }
    return true;
}

} // namespace audio_element_detail

/**
 * `audio.canPlayType(type)`: `"maybe"` for a container (and listed codecs) a
 * linked decoder reads, `""` otherwise; parameters other than `codecs` are
 * ignored, as browsers ignore them.
 */
[[nodiscard]] inline std::string audio_can_play_type(const AudioElement& element,
                                                     std::string_view type) {
    static_cast<void>(element);
    using audio_element_detail::codecs_within;
    const std::string text = audio_element_detail::lowered(type);
    const std::string_view view(text);
    const auto semicolon = view.find(';');
    const auto essence = audio_element_detail::trimmed(view.substr(0, semicolon));
    std::string_view codecs;
    for (auto rest = semicolon == std::string_view::npos ? std::string_view{}
                                                         : view.substr(semicolon + 1);
         !rest.empty();) {
        const auto next = rest.find(';');
        const auto parameter = audio_element_detail::trimmed(rest.substr(0, next));
        if (parameter.starts_with("codecs="))
            codecs = parameter.substr(7);
        if (next == std::string_view::npos)
            break;
        rest.remove_prefix(next + 1);
    }
    const auto supports = [&](std::initializer_list<std::string_view> essences,
                              std::initializer_list<std::string_view> accepted) {
        return std::find(essences.begin(), essences.end(), essence) != essences.end() &&
               codecs_within(codecs, accepted);
    };
    bool playable = false;
#if BBLITE_AUDIO_DECODE_WAV
    playable = playable || supports({"audio/wav", "audio/wave", "audio/x-wav"}, {"1"});
#endif
#if BBLITE_AUDIO_DECODE_FLAC
    playable = playable || supports({"audio/flac", "audio/x-flac"}, {"flac"});
#endif
#if BBLITE_AUDIO_DECODE_MP3
    playable = playable || supports({"audio/mpeg", "audio/mp3"}, {"mp3"});
#endif
#if BBLITE_AUDIO_DECODE_OGG
    playable = playable || supports({"audio/ogg"}, {"vorbis"});
#endif
#if BBLITE_AUDIO_DECODE_OPUS
    playable = playable || supports({"audio/ogg", "audio/opus"}, {"opus"});
#endif
#if BBLITE_AUDIO_DECODE_WV
    playable = playable || supports({"audio/wavpack", "audio/x-wavpack"}, {});
#endif
#if BBLITE_AUDIO_DECODE_MPC
    playable = playable || supports({"audio/musepack", "audio/x-musepack"}, {});
#endif
    static_cast<void>(supports);
    return playable ? "maybe" : "";
}

} // namespace bbl::pal
