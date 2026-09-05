#pragma once

#include "pal_ui_emoji.hpp"
#include <RmlUi/Core/StringUtilities.h>
#include <string>
#include <string_view>
#include <utility>

namespace bbl::pal {

// RmlUi's default font engine does not shape variation selectors. Select the
// color face for Unicode's emoji defaults or explicit VS16, and leave ordinary
// text symbols to the text-font fallback. Attribute bytes are never rewritten.
inline bool ui_text_needs_emoji_normalization(std::string_view text) {
    const char* end = text.data() + text.size();
    for (const char* cursor = text.data(); cursor != end;) {
        if (static_cast<unsigned char>(*cursor) < 0x80) {
            ++cursor;
            continue;
        }
        const auto point = Rml::StringUtilities::ToCharacter(cursor, end);
        if (point == Rml::Character(0xFE0E) || point == Rml::Character(0xFE0F) ||
            ui_default_emoji_presentation(static_cast<char32_t>(point))) return true;
        cursor = Rml::StringUtilities::SeekForwardUTF8(cursor + 1, end);
    }
    return false;
}

inline std::string ui_normalize_emoji_presentation(std::string markup) {
    std::string result;
    const std::string_view source(markup);
    std::size_t copied_until = 0;
    bool modified = false;
    bool in_tag = false;
    char quote = 0;
    for (std::size_t offset = 0; offset < markup.size();) {
        const char current = markup[offset];
        if (current == '<' && !in_tag) in_tag = true;
        if (in_tag) {
            if (quote) {
                if (current == quote) quote = 0;
            } else if (current == '\'' || current == '"') {
                quote = current;
            } else if (current == '>') {
                in_tag = false;
            }
            ++offset;
            continue;
        }
        // ASCII cannot have default emoji presentation. Only inspect it
        // further when the following bytes could be a variation selector.
        if (static_cast<unsigned char>(current) < 0x80 &&
            (offset + 1 == markup.size() ||
             static_cast<unsigned char>(markup[offset + 1]) != 0xEF)) {
            ++offset;
            continue;
        }
        const char* begin = markup.data() + offset;
        const char* end = markup.data() + markup.size();
        const auto point = Rml::StringUtilities::ToCharacter(begin, end);
        const std::size_t next = static_cast<std::size_t>(
            Rml::StringUtilities::SeekForwardUTF8(begin + 1, end) - markup.data());
        const bool text_selector = source.substr(next, 3) == "\xEF\xB8\x8E";
        const bool emoji_selector = source.substr(next, 3) == "\xEF\xB8\x8F";
        const bool emoji = emoji_selector ||
            (!text_selector && ui_default_emoji_presentation(static_cast<char32_t>(point)));
        if (emoji || text_selector) {
            constexpr std::string_view open = "<span style=\"font-family:bbl-emoji;line-height:0;\">";
            constexpr std::string_view close = "</span>";
            if (!modified) {
                result.reserve(markup.size() + open.size() + close.size());
                modified = true;
            }
            result.append(source.substr(copied_until, offset - copied_until));
            if (emoji) result += open;
            result.append(source.substr(offset, next - offset));
            if (emoji) result += close;
            copied_until = next + (text_selector || emoji_selector ? 3 : 0);
        }
        offset = next + (text_selector || emoji_selector ? 3 : 0);
    }
    if (!modified) return markup;
    result.append(source.substr(copied_until));
    return result;
}

} // namespace bbl::pal
