#pragma once

#include <bblite/js_data.hpp>
#include <bblite/js_encoding.hpp>
#include <bblite/js_error.hpp>

#include <cstring>
#include <string>
#include <string_view>
#include <variant>

namespace bbl::js {

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
/** A buffer-source union: the bytes of the member it holds. */
template <typename... Members>
[[nodiscard]] std::string_view buffer_source_bytes(const std::variant<Members...>& source) {
    return std::visit([](const auto& member) { return buffer_source_bytes(member); }, source);
}

/** `TextDecoder.prototype.decode(input)` over UTF-8, without streaming. */
template <typename Source>
[[nodiscard]] std::string text_decode(const TextDecoder& decoder, const Source& source) {
    const auto bytes = buffer_source_bytes(source);
    auto text = decoder->ignore_bom ? decode_utf8(bytes, decoder->fatal)
                                    : decode_utf8_removing_bom(bytes, decoder->fatal);
    if (!text)
        throw NamedError("TypeError", "The encoded data was not valid for encoding utf-8");
    return std::move(*text);
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
