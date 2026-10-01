#pragma once

#include <bblite/js_data.hpp>
#include <bblite/js_encoding.hpp>
#include <bblite/js_error.hpp>

#include <string>
#include <string_view>

namespace bbl::js {

/** Web IDL USVString conversion: each unpaired UTF-16 surrogate becomes U+FFFD. */
[[nodiscard]] inline std::string usv_string(const std::string& text) {
    auto units = string_code_units(text);
    for (std::size_t i = 0; i < units.size(); ++i) {
        if (units[i] >= 0xd800u && units[i] <= 0xdbffu && i + 1 < units.size() &&
            units[i + 1] >= 0xdc00u && units[i + 1] <= 0xdfffu) {
            ++i;
            continue;
        }
        if (units[i] >= 0xd800u && units[i] <= 0xdfffu)
            units[i] = 0xfffdu;
    }
    return string_from_code_units(units);
}

/** Whether `bytes` is well-formed UTF-8, by the bounds `decode_utf8` applies. */
[[nodiscard]] inline bool utf8_well_formed(std::string_view bytes) {
    for (std::size_t i = 0; i < bytes.size();) {
        const auto byte = static_cast<unsigned char>(bytes[i++]);
        if (byte < 0x80u)
            continue;
        unsigned needed = 0;
        unsigned lower = 0x80u, upper = 0xbfu;
        if (byte >= 0xc2u && byte <= 0xdfu)
            needed = 1;
        else if (byte >= 0xe0u && byte <= 0xefu) {
            needed = 2;
            lower = byte == 0xe0u ? 0xa0u : lower;
            upper = byte == 0xedu ? 0x9fu : upper;
        } else if (byte >= 0xf0u && byte <= 0xf4u) {
            needed = 3;
            lower = byte == 0xf0u ? 0x90u : lower;
            upper = byte == 0xf4u ? 0x8fu : upper;
        } else
            return false;
        for (; needed; --needed, lower = 0x80u, upper = 0xbfu) {
            if (i == bytes.size())
                return false;
            const auto next = static_cast<unsigned char>(bytes[i++]);
            if (next < lower || next > upper)
                return false;
        }
    }
    return true;
}

/** A UTF-8 TextDecoder's options; decoding without `stream` keeps no state. */
struct TextDecoderOptions {
    bool fatal = false;
    bool ignore_bom = false;
};
using TextDecoder = Ref<TextDecoderOptions>;
struct TextEncoderTag {};
using TextEncoder = Ref<TextEncoderTag>;

[[nodiscard]] inline TextDecoder make_text_decoder(bool fatal, bool ignore_bom) {
    return make_ref<TextDecoderOptions>(TextDecoderOptions{fatal, ignore_bom});
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

/** `TextDecoder.prototype.decode(input)` over UTF-8, without streaming. */
template <typename Source>
[[nodiscard]] std::string text_decode(const TextDecoder& decoder, const Source& source) {
    std::string_view bytes = buffer_source_bytes(source);
    if (!decoder->ignore_bom && bytes.starts_with("\xef\xbb\xbf"))
        bytes.remove_prefix(3);
    if (decoder->fatal && !utf8_well_formed(bytes))
        throw NamedError("TypeError", "The encoded data was not valid for encoding utf-8");
    return decode_utf8(bytes);
}

/** `TextEncoder.prototype.encode(input)`: the UTF-8 bytes of its USVString. */
[[nodiscard]] inline U8Array text_encode(const TextEncoder&, const std::string& text) {
    const std::string scalar = usv_string(text);
    return U8Array(ArrayBuffer(std::vector<std::uint8_t>(scalar.begin(), scalar.end())));
}

} // namespace bbl::js
