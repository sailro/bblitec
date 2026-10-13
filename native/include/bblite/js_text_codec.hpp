#pragma once

#include <bblite/js_data.hpp>
#include <bblite/js_encoding.hpp>
#include <bblite/js_error.hpp>

#include <cstring>
#include <string>
#include <string_view>
#include <utility>
#include <variant>

namespace bbl::js {

/**
 * A UTF-8 TextDecoder: its options and the stream state `decode(input, { stream: true })`
 * carries to the next call: an incomplete trailing sequence and whether the BOM was seen.
 */
struct TextDecoderOptions {
    bool fatal = false;
    bool ignore_bom = false;
    std::string pending;
    bool bom_seen = false;
    bool streaming = false;
};
using TextDecoder = Ref<TextDecoderOptions>;
struct TextEncoderTag {};
using TextEncoder = Ref<TextEncoderTag>;

[[nodiscard]] inline TextDecoder make_text_decoder(bool fatal, bool ignore_bom) {
    TextDecoderOptions options;
    options.fatal = fatal;
    options.ignore_bom = ignore_bom;
    return make_ref<TextDecoderOptions>(std::move(options));
}
[[nodiscard]] inline TextEncoder make_text_encoder() { return make_ref<TextEncoderTag>(); }

/** The bytes an ArrayBuffer or one of its views (typed array, DataView) covers. */
[[nodiscard]] inline std::string_view buffer_source_bytes(const ArrayBuffer& buffer) {
    return {reinterpret_cast<const char*>(buffer.data()), buffer.byte_length()};
}
template <typename View>
    requires requires(const View& view) {
        view.buffer();
        view.byte_offset();
        view.byte_length();
    }
[[nodiscard]] std::string_view buffer_source_bytes(const View& view) {
    // The view, not this temporary handle, owns the bytes it covers.
    const ArrayBuffer buffer = view.buffer();
    return {reinterpret_cast<const char*>(buffer.data()) + view.byte_offset(), view.byte_length()};
}
/** A buffer-source union: the bytes of the member it holds. */
template <typename... Members>
[[nodiscard]] std::string_view buffer_source_bytes(const std::variant<Members...>& source) {
    return std::visit([](const auto& member) { return buffer_source_bytes(member); }, source);
}

namespace text_codec_detail {
/**
 * The length of a trailing UTF-8 sequence that is still a valid prefix (the Encoding
 * Standard's UTF-8 decoder bounds, including the restricted second bytes), which a streaming
 * decode keeps for the next call; zero when the tail is complete or already an error.
 */
[[nodiscard]] inline std::size_t incomplete_utf8_suffix(std::string_view bytes) {
    for (std::size_t back = 1; back <= 3 && back <= bytes.size(); ++back) {
        const auto lead = static_cast<unsigned char>(bytes[bytes.size() - back]);
        if ((lead & 0xC0u) == 0x80u)
            continue;
        const std::size_t needed = lead >= 0xC2u && lead <= 0xDFu   ? 2
                                   : lead >= 0xE0u && lead <= 0xEFu ? 3
                                   : lead >= 0xF0u && lead <= 0xF4u ? 4
                                                                    : 0;
        if (needed <= back)
            return 0;
        if (back >= 2) {
            const auto second = static_cast<unsigned char>(bytes[bytes.size() - back + 1]);
            const unsigned char low = lead == 0xE0u ? 0xA0u : lead == 0xF0u ? 0x90u : 0x80u;
            const unsigned char high = lead == 0xEDu ? 0x9Fu : lead == 0xF4u ? 0x8Fu : 0xBFu;
            if (second < low || second > high)
                return 0;
        }
        return back;
    }
    return 0;
}

inline void reset_stream(TextDecoderOptions& state) {
    state.pending.clear();
    state.bom_seen = false;
    state.streaming = false;
}

/** The Encoding Standard's `decode(input, { stream })` over a UTF-8 decoder. */
[[nodiscard]] inline std::string decode(TextDecoderOptions& state, std::string_view input,
                                        bool stream) {
    if (!state.streaming) {
        state.pending.clear();
        state.bom_seen = false;
    }
    state.streaming = stream;
    std::string bytes = std::move(state.pending);
    state.pending.clear();
    bytes.append(input);
    std::string_view complete(bytes);
    if (stream) {
        const auto kept = incomplete_utf8_suffix(complete);
        state.pending = std::string(complete.substr(complete.size() - kept));
        complete.remove_suffix(kept);
    }
    auto text = decode_utf8(complete, state.fatal);
    if (!text) {
        reset_stream(state);
        throw NamedError("TypeError", "The encoded data was not valid for encoding utf-8");
    }
    // The first decoded code point decides the BOM once per stream.
    if (!state.ignore_bom && !state.bom_seen && !text->empty()) {
        state.bom_seen = true;
        constexpr std::string_view byte_order_mark{"\xEF\xBB\xBF", 3};
        if (std::string_view(*text).starts_with(byte_order_mark))
            text->erase(0, byte_order_mark.size());
    }
    if (!stream)
        reset_stream(state);
    return std::move(*text);
}
} // namespace text_codec_detail

/** `TextDecoder.prototype.decode(input, { stream })` over UTF-8. */
template <typename Source>
[[nodiscard]] std::string text_decode(const TextDecoder& decoder, const Source& source,
                                      bool stream = false) {
    return text_codec_detail::decode(*decoder, buffer_source_bytes(source), stream);
}

/** `decoder.decode()`: flushes a stream's incomplete sequence and ends it. */
[[nodiscard]] inline std::string text_decode(const TextDecoder& decoder) {
    return text_codec_detail::decode(*decoder, {}, false);
}

/** `TextEncoder.prototype.encode(input)`: the UTF-8 bytes of its USVString. */
[[nodiscard]] inline U8Array text_encode(const TextEncoder&, const std::string& text) {
    const std::string scalar = usv_string(text);
    U8Array result(scalar.size());
    if (!scalar.empty())
        std::memcpy(result.data(), scalar.data(), scalar.size());
    return result;
}

} // namespace bbl::js
