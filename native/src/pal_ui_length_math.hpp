#pragma once

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>

namespace bbl::pal {
namespace detail {

/**
 * The unsigned CSS decimal at `offset`: digits with an optional fraction, and
 * an exponent only when digits follow it (`2em` is 2, then `em`). `offset`
 * moves past it; empty when no digit starts it or it is out of double range.
 * Converted by strtod, correctly rounded on every target (Android's libc++
 * provides no floating-point std::from_chars).
 */
inline std::optional<double> css_decimal(std::string_view source, std::size_t& offset) {
    const auto digit = [&](std::size_t at) {
        return at < source.size() && source[at] >= '0' && source[at] <= '9';
    };
    const auto start = offset;
    auto end = offset;
    std::size_t digits = 0;
    for (; digit(end); ++end)
        ++digits;
    if (end < source.size() && source[end] == '.')
        for (++end; digit(end); ++end)
            ++digits;
    if (digits == 0)
        return std::nullopt;
    if (end < source.size() && (source[end] == 'e' || source[end] == 'E')) {
        auto exponent = end + 1;
        if (exponent < source.size() && (source[exponent] == '+' || source[exponent] == '-'))
            ++exponent;
        if (digit(exponent)) {
            while (digit(exponent))
                ++exponent;
            end = exponent;
        }
    }
    const std::string text(source.substr(start, end - start));
    char* parsed_end = nullptr;
    errno = 0;
    const double number = std::strtod(text.c_str(), &parsed_end);
    // Overflow, or underflow to zero, is out of range (a subnormal is not).
    if (parsed_end != text.c_str() + text.size() || !std::isfinite(number) ||
        (number == 0 && errno == ERANGE))
        return std::nullopt;
    offset = end;
    return number;
}

} // namespace detail

// Root-relative lengths reproject when the document's computed font changes.
// Containing-block and element-relative units still require a later layout stage.
class UiLengthMath {
    struct Value {
        double number;
        bool length;
    };
    std::string_view source;
    std::size_t offset = 0;
    double width, height;
    std::optional<double> root_font_size;
    bool root_relative = false;

    [[noreturn]] void refuse() const {
        throw std::runtime_error(
            "UI CSS math requires finite px/rem/vw/vh/vmin/vmax lengths and scalar arithmetic: " +
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
        const auto parsed = detail::css_decimal(source, offset);
        if (!parsed)
            refuse();
        const double number = *parsed;
        const auto unit_start = offset;
        while (offset < source.size() && letter(source[offset]))
            ++offset;
        const auto unit = source.substr(unit_start, offset - unit_start);
        if (unit.empty())
            return {number, false};
        if (unit == "px")
            return {number, true};
        if (unit == "rem") {
            if (!root_font_size || !std::isfinite(*root_font_size) || *root_font_size <= 0)
                throw std::runtime_error("Root-relative CSS math requires the computed root font size.");
            root_relative = true;
            return {number * *root_font_size, true};
        }
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
    UiLengthMath(std::string_view expression, double viewport_width, double viewport_height,
                 std::optional<double> root_font = std::nullopt)
        : source(expression), width(viewport_width), height(viewport_height), root_font_size(root_font) {}
    bool uses_root_font() const { return root_relative; }
    std::pair<std::string, std::size_t> resolve() {
        const auto value = atom();
        if (!std::isfinite(value.number))
            refuse();
        return {std::to_string(value.number) + (value.length ? "px" : ""), offset};
    }
};

inline std::string rml_css_length_math(std::string value, double width, double height,
                                      std::optional<double> root_font = std::nullopt,
                                      std::string_view property_name = {}) {
    char quote = 0;
    std::string property(property_name);
    std::size_t declaration_start = 0;
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
        if (token == ';' || token == '{' || token == '}') {
            declaration_start = index + 1;
            property = property_name;
        } else if (token == ':') {
            property = value.substr(declaration_start, index - declaration_start);
            const auto first = property.find_first_not_of(" \t\r\n");
            const auto last = property.find_last_not_of(" \t\r\n");
            property = first == std::string::npos ? "" : property.substr(first, last - first + 1);
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
        UiLengthMath math(tail, width, height, root_font);
        const auto [replacement, consumed] = math.resolve();
        if (math.uses_root_font() &&
            (property == "font" || property == "font-size" || property.starts_with("--")))
            throw std::runtime_error("Root-relative CSS math in font sizing or custom properties is not represented.");
        value.replace(index, consumed, replacement);
        index += replacement.size() - 1;
    }
    return value;
}
} // namespace bbl::pal
