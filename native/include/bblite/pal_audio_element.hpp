#pragma once

/**
 * `HTMLAudioElement`, as far as the native platform holds one. A lowered
 * library reaches it only to ask `canPlayType`, answered from the decoders
 * this build links (`audio:decode-*`); element playback extends this record
 * rather than replacing it.
 */

#include <bblite/features/audio_decode_flac.hpp>
#include <bblite/features/audio_decode_mp3.hpp>
#include <bblite/features/audio_decode_mpc.hpp>
#include <bblite/features/audio_decode_ogg.hpp>
#include <bblite/features/audio_decode_opus.hpp>
#include <bblite/features/audio_decode_wav.hpp>
#include <bblite/features/audio_decode_wv.hpp>

#include <algorithm>
#include <cctype>
#include <initializer_list>
#include <memory>
#include <string>
#include <string_view>

namespace bbl::pal {

/** One `HTMLAudioElement`. */
struct AudioElementState {};
using AudioElement = std::shared_ptr<AudioElementState>;

/** `new Audio()`. */
[[nodiscard]] inline AudioElement audio_create_element() {
    return std::make_shared<AudioElementState>();
}

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
