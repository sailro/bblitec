#pragma once

#include <algorithm>
#include <charconv>
#include <cmath>
#include <stdexcept>
#include <string>
#include <string_view>

namespace bbl::pal {
// RmlUi has no CSS math parser. Resolve viewport/absolute length expressions
// before its ordinary cascade; containing-block and font-relative units need
// a later layout stage and are deliberately rejected here.
class UiLengthMath {
    struct Value {
        double number;
        bool length;
    };
    std::string_view source;
    std::size_t offset = 0;
    double width, height;

    [[noreturn]] void refuse() const {
        throw std::runtime_error(
            "UI CSS math requires finite px/vw/vh/vmin/vmax lengths and scalar arithmetic: " +
            std::string(source));
    }
    void space() {
        while (offset < source.size() && (source[offset] == ' ' || source[offset] == '\t' ||
                                          source[offset] == '\n' || source[offset] == '\r'))
            ++offset;
    }
    bool take(char token) {
        space();
        if (offset == source.size() || source[offset] != token)
            return false;
        ++offset;
        return true;
    }
    static bool letter(char value) { return value >= 'a' && value <= 'z'; }
    Value atom() {
        space();
        if (take('(')) {
            const auto value = sum();
            if (!take(')'))
                refuse();
            return value;
        }
        if (take('+'))
            return atom();
        if (take('-')) {
            auto value = atom();
            value.number = -value.number;
            return value;
        }
        const auto start = offset;
        while (offset < source.size() && letter(source[offset]))
            ++offset;
        if (offset != start) {
            const auto name = source.substr(start, offset - start);
            if (!take('('))
                refuse();
            auto value = sum();
            if (name == "calc") {
                if (!take(')'))
                    refuse();
                return value;
            }
            if (name != "min" && name != "max" && name != "clamp")
                refuse();
            if (name == "clamp") {
                if (!take(','))
                    refuse();
                const auto preferred = sum();
                if (!take(','))
                    refuse();
                const auto maximum = sum();
                if (!take(')') || value.length != preferred.length ||
                    value.length != maximum.length)
                    refuse();
                value.number = std::max(value.number, std::min(preferred.number, maximum.number));
                return value;
            }
            while (take(',')) {
                const auto other = sum();
                if (value.length != other.length)
                    refuse();
                value.number = name == "min" ? std::min(value.number, other.number)
                                             : std::max(value.number, other.number);
            }
            if (!take(')'))
                refuse();
            return value;
        }
        double number = 0;
        const auto parsed =
            std::from_chars(source.data() + offset, source.data() + source.size(), number);
        if (parsed.ec != std::errc{})
            refuse();
        offset = static_cast<std::size_t>(parsed.ptr - source.data());
        const auto unit_start = offset;
        while (offset < source.size() && letter(source[offset]))
            ++offset;
        const auto unit = source.substr(unit_start, offset - unit_start);
        if (unit.empty())
            return {number, false};
        if (unit == "px")
            return {number, true};
        if (unit == "vw")
            return {number * width / 100, true};
        if (unit == "vh")
            return {number * height / 100, true};
        if (unit == "vmin")
            return {number * std::min(width, height) / 100, true};
        if (unit == "vmax")
            return {number * std::max(width, height) / 100, true};
        refuse();
    }
    Value product() {
        auto value = atom();
        for (;;) {
            const bool multiply = take('*');
            if (!multiply && !take('/'))
                return value;
            const auto other = atom();
            if ((multiply && value.length && other.length) ||
                (!multiply && (other.length || other.number == 0)))
                refuse();
            value.number = multiply ? value.number * other.number : value.number / other.number;
            value.length = value.length || other.length;
        }
    }
    Value sum() {
        auto value = product();
        for (;;) {
            const bool add = take('+');
            if (!add && !take('-'))
                return value;
            const auto other = product();
            if (value.length != other.length)
                refuse();
            value.number += add ? other.number : -other.number;
        }
    }

public:
    UiLengthMath(std::string_view expression, double viewport_width, double viewport_height)
        : source(expression), width(viewport_width), height(viewport_height) {}
    std::pair<std::string, std::size_t> resolve() {
        const auto value = atom();
        if (!std::isfinite(value.number))
            refuse();
        return {std::to_string(value.number) + (value.length ? "px" : ""), offset};
    }
};

inline std::string rml_css_length_math(std::string value, double width, double height) {
    char quote = 0;
    for (std::size_t index = 0; index < value.size(); ++index) {
        const char token = value[index];
        if (token == '\\') {
            ++index;
            continue;
        }
        if (quote) {
            if (token == quote)
                quote = 0;
            continue;
        }
        if (token == '\'' || token == '"') {
            quote = token;
            continue;
        }
        const auto tail = std::string_view(value).substr(index);
        if (tail.starts_with("url(")) {
            const auto end = value.find(')', index + 4);
            if (end == std::string::npos)
                break;
            index = end;
            continue;
        }
        if (index &&
            ((value[index - 1] >= 'a' && value[index - 1] <= 'z') || value[index - 1] == '-'))
            continue;
        if (!tail.starts_with("calc(") && !tail.starts_with("min(") && !tail.starts_with("max(") &&
            !tail.starts_with("clamp("))
            continue;
        const auto [replacement, consumed] = UiLengthMath(tail, width, height).resolve();
        value.replace(index, consumed, replacement);
        index += replacement.size() - 1;
    }
    return value;
}
} // namespace bbl::pal
