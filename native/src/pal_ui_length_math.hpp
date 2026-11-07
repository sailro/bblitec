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
#include <utility>
#include <vector>

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

/**
 * A bare viewport extreme starting a token at `offset` (`160vmax`, `-2svmin`): its length and
 * its value in CSS pixels. RmlUi has no vmin/vmax, so they resolve here as math terms do.
 */
inline std::optional<std::pair<std::size_t, double>>
css_viewport_extreme(std::string_view source, std::size_t offset, double width, double height) {
    const auto word = [](char character) {
        return std::isalnum(static_cast<unsigned char>(character)) || character == '.' ||
               character == '-' || character == '+' || character == '_' || character == '#';
    };
    if (offset && word(source[offset - 1]))
        return std::nullopt;
    std::size_t at = offset;
    double sign = 1;
    if (at < source.size() && (source[at] == '-' || source[at] == '+')) {
        sign = source[at] == '-' ? -1 : 1;
        ++at;
    }
    auto end = at;
    const auto number = css_decimal(source, end);
    if (!number)
        return std::nullopt;
    auto unit_end = end;
    while (unit_end < source.size() && std::isalpha(static_cast<unsigned char>(source[unit_end])))
        ++unit_end;
    std::string unit(source.substr(end, unit_end - end));
    for (char& character : unit)
        character = static_cast<char>(std::tolower(static_cast<unsigned char>(character)));
    // Without browser toolbars the small, large and dynamic viewports are the viewport.
    if (unit.size() == 5 && (unit[0] == 's' || unit[0] == 'l' || unit[0] == 'd'))
        unit.erase(0, 1);
    if (unit != "vmin" && unit != "vmax")
        return std::nullopt;
    const double extreme = unit == "vmin" ? std::min(width, height) : std::max(width, height);
    return std::pair{unit_end - offset, sign * *number * extreme / 100};
}

/**
 * The properties whose percentages RmlUi resolves at layout from a computed length-percentage, where
 * CSS math over a percentage folds to `bbl-calc(...)` (RmlUi patch css-percentage-math).
 */
inline bool css_layout_percentage_property(std::string_view property) {
    static constexpr std::string_view properties[] = {
        "width",        "height",     "min-width",   "max-width",     "min-height",
        "max-height",   "margin",     "margin-top",  "margin-right",  "margin-bottom",
        "margin-left",  "padding",    "padding-top", "padding-right", "padding-bottom",
        "padding-left", "top",        "right",       "bottom",        "left",
        "flex",         "flex-basis", "gap",         "row-gap",       "column-gap"};
    return std::find(std::begin(properties), std::end(properties), property) !=
           std::end(properties);
}

/** RmlUi decorator text: the decorator itself, or the background image the PAL paints as one. */
inline bool css_decorator_property(std::string_view property) {
    return property == "decorator" || property == "bbl-background-image";
}

/** Text a later projection reads: a custom property, or a background longhand the PAL paints. */
inline bool css_carried_property(std::string_view property) {
    return property.starts_with("--") || property.starts_with("bbl-background-");
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
    const std::size_t first = value.find_first_not_of(" \t\r\n\f");
    if (first == std::string_view::npos)
        return {};
    const std::size_t last = value.find_last_not_of(" \t\r\n\f");
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
// A percentage of the layout's base stays a term the layout resolves (`percentages`), with lengths added and
// min()/max()/clamp() bounds of the same form, written as RmlUi's canonical `bbl-calc(...)`; element-relative
// units still require a later layout stage.
// Lengths resolve to CSS px (dp, the projected CSS px, included), times to s, angles to deg.
class UiLengthMath {
    enum class Dimension { Number, Length, Time, Angle };
    // A length of px and a percentage of the layout's base.
    struct Linear {
        double number = 0;
        double percent = 0;
    };
    struct Value {
        double number;
        Dimension dimension;
        // A length holding a percentage of the layout's base, and the bounds min()/max()/clamp() put on it.
        bool percentage = false;
        double percent = 0;
        std::optional<Linear> lower{}, upper{};

        bool bounded() const { return lower.has_value() || upper.has_value(); }
        Linear linear() const { return {number, percent}; }
    };
    std::string_view source;
    std::size_t offset = 0;
    double width, height;
    std::optional<double> root_font_size;
    bool percentages;
    bool root_relative = false;

    [[noreturn]] void refuse() const {
        throw std::runtime_error(
            "UI CSS math requires finite px/rem/viewport lengths, s/ms times, deg/rad/turn angles, "
            "percentages of a layout length within one min()/max()/clamp() level, and scalar "
            "arithmetic: " +
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
    static Linear scaled(Linear term, double factor) {
        return {term.number * factor, term.percent * factor};
    }
    /** `value` times a scalar: a negative factor turns lower bounds into upper ones. */
    static Value scaled(Value value, double factor) {
        value.number *= factor;
        value.percent *= factor;
        std::optional<Linear> lower, upper;
        if (value.lower)
            lower = scaled(*value.lower, factor);
        if (value.upper)
            upper = scaled(*value.upper, factor);
        value.lower = factor < 0 ? upper : lower;
        value.upper = factor < 0 ? lower : upper;
        return value;
    }
    /** `left + right`: a bounded term shifts, with its bounds, by an unbounded one. */
    Value added(Value left, const Value& right) const {
        if (left.dimension != right.dimension || (left.bounded() && right.bounded()))
            refuse();
        Value result = left.bounded() ? left : right;
        const Linear shift = left.bounded() ? right.linear() : left.linear();
        result.number += shift.number;
        result.percent += shift.percent;
        for (auto* bound : {&result.lower, &result.upper})
            if (*bound) {
                (*bound)->number += shift.number;
                (*bound)->percent += shift.percent;
            }
        result.percentage = left.percentage || right.percentage;
        return result;
    }
    /** min() or max() of unbounded terms: at most a percentage term and one bound of the same form. */
    Value extremum(bool minimum, const std::vector<Value>& terms) const {
        for (const auto& term : terms)
            if (term.dimension != terms.front().dimension || term.bounded())
                refuse();
        const auto pick = [minimum](double a, double b) {
            return minimum ? std::min(a, b) : std::max(a, b);
        };
        std::optional<Value> fixed;
        std::vector<Value> relative;
        for (const auto& term : terms) {
            if (term.percentage)
                relative.push_back(term);
            else if (fixed)
                fixed->number = pick(fixed->number, term.number);
            else
                fixed = term;
        }
        if (relative.empty())
            return *fixed;
        if (relative.size() + (fixed ? 1 : 0) > 2)
            refuse();
        Value result = relative.front();
        if (relative.size() == 1 && !fixed)
            return result;
        // Two relative terms leave no room for a fixed one.
        const Linear bound = fixed ? fixed->linear() : relative.back().linear();
        (minimum ? result.upper : result.lower) = bound;
        return result;
    }
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
        if (take('-'))
            return scaled(atom(), -1);
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
                    value.dimension != maximum.dimension || value.bounded() ||
                    preferred.bounded() || maximum.bounded())
                    refuse();
                if (!value.percentage && !preferred.percentage && !maximum.percentage) {
                    value.number =
                        std::max(value.number, std::min(preferred.number, maximum.number));
                    return value;
                }
                // clamp(MIN, VAL, MAX) is max(MIN, min(VAL, MAX)), as LengthCalc resolves it.
                Value result = preferred;
                result.percentage = true;
                result.lower = value.linear();
                result.upper = maximum.linear();
                return result;
            }
            std::vector<Value> terms{value};
            while (take(','))
                terms.push_back(sum());
            if (!take(')'))
                refuse();
            return extremum(name == "min", terms);
        }
        const auto parsed = detail::css_decimal(source, offset);
        if (!parsed)
            refuse();
        const double number = *parsed;
        if (offset < source.size() && source[offset] == '%') {
            ++offset;
            if (!percentages)
                refuse();
            return {0, Dimension::Length, true, number};
        }
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
            value = !multiply                              ? scaled(value, 1 / other.number)
                    : value.dimension == Dimension::Number ? scaled(other, value.number)
                                                           : scaled(value, other.number);
        }
    }
    Value sum() {
        auto value = product();
        for (;;) {
            const bool add = take('+');
            if (!add && !take('-'))
                return value;
            const auto other = product();
            value = added(value, add ? other : scaled(other, -1));
        }
    }
    static std::string term(const Linear& linear) {
        return std::to_string(linear.percent) + " " + std::to_string(linear.number);
    }

public:
    UiLengthMath(std::string_view expression, double viewport_width, double viewport_height,
                 std::optional<double> root_font = std::nullopt, bool layout_percentages = false)
        : source(expression), width(viewport_width), height(viewport_height),
          root_font_size(root_font), percentages(layout_percentages) {}
    bool uses_root_font() const { return root_relative; }
    std::pair<std::string, std::size_t> resolve() {
        const auto value = atom();
        const auto finite = [](const Linear& linear) {
            return std::isfinite(linear.number) && std::isfinite(linear.percent);
        };
        if (!finite(value.linear()) || (value.lower && !finite(*value.lower)) ||
            (value.upper && !finite(*value.upper)))
            refuse();
        if (value.percentage) {
            std::string text = "bbl-calc(" + term(value.linear());
            if (value.lower)
                text += " lower " + term(*value.lower);
            if (value.upper)
                text += " upper " + term(*value.upper);
            return {text + ")", offset};
        }
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
    // How many functions other than math enclose the current index within its declaration.
    int depth = 0;
    detail::scan_css_value(value, [&](std::size_t index) {
        const char token = value[index];
        if (token == '(')
            ++depth;
        else if (token == ')')
            depth = std::max(depth - 1, 0);
        if (token == ';' || token == '{' || token == '}') {
            declaration_start = index + 1;
            property = property_name;
            depth = 0;
        } else if (token == ':') {
            property = value.substr(declaration_start, index - declaration_start);
            const auto first = property.find_first_not_of(" \t\r\n");
            const auto last = property.find_last_not_of(" \t\r\n");
            property = first == std::string::npos ? "" : property.substr(first, last - first + 1);
        }
        if (const auto extreme = detail::css_viewport_extreme(value, index, width, height)) {
            const std::string replacement = std::to_string(extreme->second) + "px";
            value.replace(index, extreme->first, replacement);
            return index + replacement.size() - 1;
        }
        const auto tail = std::string_view(value).substr(index);
        if (!detail::css_function_at(value, index, "calc(") &&
            !detail::css_function_at(value, index, "min(") &&
            !detail::css_function_at(value, index, "max(") &&
            !detail::css_function_at(value, index, "clamp("))
            return index;
        const std::size_t end = detail::css_function_end(value, value.find('(', index));
        const auto function = std::string_view(value).substr(index, end - index);
        // Math over var() resolves once the style engine substitutes the variables; clip-path math keeps its
        // percentages for the shape to resolve against its reference box; a carried value's percentage
        // is one of the length its later projection lands in.
        const bool decorator = detail::css_decorator_property(property);
        const bool carried = detail::css_carried_property(property);
        if (property == "clip-path" || function.find("var(") != std::string::npos ||
            (carried && !decorator && function.find('%') != std::string::npos))
            return end;
        // A decorator's own math sizes and places its layer box (RmlUi patch 0025); math inside its
        // image function is the image's.
        UiLengthMath math(tail, width, height, root_font,
                          detail::css_layout_percentage_property(property) ||
                              (decorator && depth == 0));
        const auto [replacement, consumed] = math.resolve();
        if (math.uses_root_font() &&
            (property == "font" || property == "font-size" || (carried && !decorator)))
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
