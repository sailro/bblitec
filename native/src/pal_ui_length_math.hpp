#pragma once

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <numbers>
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

/** The index of the `)` closing the parenthesis at `open`, or the size when it is unclosed. */
inline std::size_t css_function_end(std::string_view value, std::size_t open) {
    std::size_t end = open;
    for (int depth = 0; end < value.size(); ++end) {
        depth += value[end] == '(' ? 1 : value[end] == ')' ? -1 : 0;
        if (depth == 0)
            break;
    }
    return end;
}

inline std::string_view trim_css_token(std::string_view value) {
    const std::size_t first = value.find_first_not_of(" \t\r\n");
    if (first == std::string_view::npos)
        return {};
    const std::size_t last = value.find_last_not_of(" \t\r\n");
    return value.substr(first, last - first + 1);
}

inline bool css_identifier_character(char character) {
    return std::isalnum(static_cast<unsigned char>(character)) || character == '-' ||
           character == '_';
}

/** Whether the CSS function `name` (its parenthesis included) starts at `index`, not within an identifier. */
inline bool css_function_at(std::string_view value, std::size_t index, std::string_view name) {
    return value.substr(index).starts_with(name) &&
           (index == 0 || !css_identifier_character(value[index - 1]));
}

/**
 * Visits each index of a CSS value outside escapes, quoted strings and url() arguments, where a
 * token may start; `visit(index)` may rewrite `value` and returns the index to resume after.
 */
template <typename Visit> void scan_css_value(std::string& value, Visit&& visit) {
    char quote = 0;
    for (std::size_t index = 0; index < value.size(); ++index) {
        const char token = value[index];
        if (token == '\\') {
            ++index;
        } else if (quote) {
            quote = token == quote ? 0 : quote;
        } else if (token == '\'' || token == '"') {
            quote = token;
        } else if (css_function_at(value, index, "url(")) {
            index = css_function_end(value, index + 3);
        } else {
            index = visit(index);
        }
    }
}

} // namespace detail

// Root-relative lengths reproject when the document's computed font changes.
// Containing-block and element-relative units still require a later layout stage.
// Lengths resolve to CSS px (dp, the projected CSS px, included), times to s, angles to deg.
class UiLengthMath {
    enum class Dimension { Number, Length, Time, Angle };
    struct Value {
        double number;
        Dimension dimension;
    };
    std::string_view source;
    std::size_t offset = 0;
    double width, height;
    std::optional<double> root_font_size;
    bool root_relative = false;

    [[noreturn]] void refuse() const {
        throw std::runtime_error(
            "UI CSS math requires finite px/rem/viewport lengths, s/ms times, deg/rad/turn angles and "
            "scalar arithmetic: " +
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
                if (!take(')') || value.dimension != preferred.dimension ||
                    value.dimension != maximum.dimension)
                    refuse();
                value.number = std::max(value.number, std::min(preferred.number, maximum.number));
                return value;
            }
            while (take(',')) {
                const auto other = sum();
                if (value.dimension != other.dimension)
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
            return {number, Dimension::Number};
        if (unit == "px" || unit == "dp")
            return {number, Dimension::Length};
        if (unit == "rem") {
            if (!root_font_size || !std::isfinite(*root_font_size) || *root_font_size <= 0)
                throw std::runtime_error(
                    "Root-relative CSS math requires the computed root font size.");
            root_relative = true;
            return {number * *root_font_size, Dimension::Length};
        }
        // Without browser toolbars the small, large and dynamic viewports are the viewport.
        const auto viewport = [&](std::string_view base) {
            return unit == base || unit == std::string("s") + std::string(base) ||
                   unit == std::string("l") + std::string(base) ||
                   unit == std::string("d") + std::string(base);
        };
        if (viewport("vw"))
            return {number * width / 100, Dimension::Length};
        if (viewport("vh"))
            return {number * height / 100, Dimension::Length};
        if (viewport("vmin"))
            return {number * std::min(width, height) / 100, Dimension::Length};
        if (viewport("vmax"))
            return {number * std::max(width, height) / 100, Dimension::Length};
        if (unit == "s" || unit == "ms")
            return {unit == "s" ? number : number / 1000, Dimension::Time};
        if (unit == "deg" || unit == "rad" || unit == "turn" || unit == "grad")
            return {unit == "deg"    ? number
                    : unit == "rad"  ? number * 180 / std::numbers::pi
                    : unit == "turn" ? number * 360
                                     : number * 0.9,
                    Dimension::Angle};
        refuse();
    }
    Value product() {
        auto value = atom();
        for (;;) {
            const bool multiply = take('*');
            if (!multiply && !take('/'))
                return value;
            const auto other = atom();
            if ((multiply && value.dimension != Dimension::Number &&
                 other.dimension != Dimension::Number) ||
                (!multiply && (other.dimension != Dimension::Number || other.number == 0)))
                refuse();
            value.number = multiply ? value.number * other.number : value.number / other.number;
            if (value.dimension == Dimension::Number)
                value.dimension = other.dimension;
        }
    }
    Value sum() {
        auto value = product();
        for (;;) {
            const bool add = take('+');
            if (!add && !take('-'))
                return value;
            const auto other = product();
            if (value.dimension != other.dimension)
                refuse();
            value.number += add ? other.number : -other.number;
        }
    }

public:
    UiLengthMath(std::string_view expression, double viewport_width, double viewport_height,
                 std::optional<double> root_font = std::nullopt)
        : source(expression), width(viewport_width), height(viewport_height),
          root_font_size(root_font) {}
    bool uses_root_font() const { return root_relative; }
    std::pair<std::string, std::size_t> resolve() {
        const auto value = atom();
        if (!std::isfinite(value.number))
            refuse();
        const char* unit = value.dimension == Dimension::Length  ? "px"
                           : value.dimension == Dimension::Time  ? "s"
                           : value.dimension == Dimension::Angle ? "deg"
                                                                 : "";
        return {std::to_string(value.number) + unit, offset};
    }
};

inline std::string rml_css_length_math(std::string value, double width, double height,
                                       std::optional<double> root_font = std::nullopt,
                                       std::string_view property_name = {}) {
    std::string property(property_name);
    std::size_t declaration_start = 0;
    detail::scan_css_value(value, [&](std::size_t index) {
        const char token = value[index];
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
        if (!detail::css_function_at(value, index, "calc(") &&
            !detail::css_function_at(value, index, "min(") &&
            !detail::css_function_at(value, index, "max(") &&
            !detail::css_function_at(value, index, "clamp("))
            return index;
        const std::size_t end = detail::css_function_end(value, value.find('(', index));
        // Math over var() resolves once the style engine substitutes the variables; clip-path math keeps its
        // percentages for the shape to resolve against its reference box.
        if (property == "clip-path" ||
            std::string_view(value).substr(index, end - index).find("var(") != std::string::npos)
            return end;
        UiLengthMath math(tail, width, height, root_font);
        const auto [replacement, consumed] = math.resolve();
        if (math.uses_root_font() &&
            (property == "font" || property == "font-size" || property.starts_with("--")))
            throw std::runtime_error(
                "Root-relative CSS math in font sizing or custom properties is not represented.");
        value.replace(index, consumed, replacement);
        return index + replacement.size() - 1;
    });
    return value;
}

/** The window's safe-area insets in CSS px: the edges the display obscures (a notch, rounded corners). */
struct UiSafeAreaInsets {
    double top = 0, right = 0, bottom = 0, left = 0;
    bool operator==(const UiSafeAreaInsets&) const = default;
};

/**
 * Substitutes CSS `env()`: a `safe-area-inset-*` variable is the window's
 * inset, read at run time; another name takes its fallback, and refuses
 * without one.
 */
inline std::string rml_css_environment(std::string value, const UiSafeAreaInsets& insets) {
    detail::scan_css_value(value, [&](std::size_t index) {
        if (!detail::css_function_at(value, index, "env("))
            return index;
        const std::size_t end = detail::css_function_end(value, index + 3);
        if (end == value.size())
            throw std::runtime_error("UI CSS env() is unclosed: " + value);
        const auto arguments = std::string_view(value).substr(index + 4, end - index - 4);
        const auto comma = arguments.find(',');
        const auto name = detail::trim_css_token(arguments.substr(0, comma));
        const double* inset = name == "safe-area-inset-top"      ? &insets.top
                              : name == "safe-area-inset-right"  ? &insets.right
                              : name == "safe-area-inset-bottom" ? &insets.bottom
                              : name == "safe-area-inset-left"   ? &insets.left
                                                                 : nullptr;
        if (!inset && comma == std::string_view::npos)
            throw std::runtime_error(
                "UI CSS env() names a variable the native host does not define: " + value);
        const std::string replacement =
            inset ? std::to_string(*inset) + "px"
                  : rml_css_environment(
                        std::string(detail::trim_css_token(arguments.substr(comma + 1))), insets);
        value.replace(index, end + 1 - index, replacement);
        return index + replacement.size() - 1;
    });
    return value;
}
} // namespace bbl::pal
