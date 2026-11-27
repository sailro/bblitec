#include <bblite/pal_window_objects.hpp>
#include <bblite/pal_event_loop.hpp>
#include <algorithm>
#include <cctype>
#include <iterator>
#include <set>
#include <stdexcept>
#include <bblite/js_data.hpp>
#include "pal_ui_length_math.hpp"

namespace bbl::pal {

namespace {
/**
 * Names one device feature of `condition`, as a retained sheet's `@media`
 * admits it (`parseUiMediaQuery`): `prefers-reduced-motion` and `hover`
 * bare or with a value, `pointer` with one. False for anything else.
 */
bool name_media_feature(UiMediaCondition& condition, std::string_view name,
                        std::optional<std::string_view> value) {
    if (name == "prefers-reduced-motion" && (!value || *value == "reduce"))
        condition.reduced_motion = true;
    else if (name == "prefers-reduced-motion" && *value == "no-preference")
        condition.reduced_motion = false;
    else if (name == "hover" && (!value || *value == "hover" || *value == "none"))
        condition.hover = !value || *value == "hover";
    else if (name == "pointer" && value && (*value == "none" || *value == "coarse"))
        condition.pointer = *value == "none" ? PointerPrecision::None : PointerPrecision::Coarse;
    else if (name == "pointer" && value && *value == "fine")
        condition.pointer = PointerPrecision::Fine;
    else
        return false;
    return true;
}
} // namespace

MediaQueryList::MediaQueryList(std::string query, double (*read_pixel_ratio)(),
                               bool (*read_motion_preference)(),
                               InputCapabilities (*read_input_capabilities)(),
                               UiClientRect (*read_viewport)())
    : read_pixel_ratio_(read_pixel_ratio), read_motion_preference_(read_motion_preference),
      read_input_capabilities_(read_input_capabilities), read_viewport_(read_viewport) {
    const auto refuse = [] {
        throw std::invalid_argument(
            "Only resolution, viewport width and height bounds, reduced-motion, pointer and hover "
            "media queries are admitted by the Window realm.");
    };
    // A nonnegative CSS decimal followed by `unit`, as `(resolution: 1.5dppx)` spells it.
    const auto measure = [&](std::optional<std::string_view> value, std::string_view unit) {
        if (!value || !value->ends_with(unit))
            refuse();
        const auto number = value->substr(0, value->size() - unit.size());
        std::size_t parsed = 0;
        const auto measured = detail::css_decimal(number, parsed);
        if (!measured || parsed != number.size() || *measured < 0)
            refuse();
        return *measured;
    };
    double* const bounds[] = {&min_width_, &max_width_, &min_height_, &max_height_};
    constexpr std::string_view bound_names[] = {"min-width", "max-width", "min-height",
                                                "max-height"};
    // An `and` conjunction of features, each named once; resolution stands alone.
    const std::string lowered = js::string_lower(query);
    std::string_view rest = detail::trim_css_token(lowered);
    std::set<std::string_view> named;
    while (true) {
        if (rest.empty() || rest.front() != '(')
            refuse();
        const auto close = rest.find(')');
        if (close == std::string_view::npos)
            refuse();
        const std::string_view feature = rest.substr(1, close - 1);
        const auto colon = feature.find(':');
        const std::string_view name = detail::trim_css_token(feature.substr(0, colon));
        const std::optional<std::string_view> value =
            colon == std::string_view::npos
                ? std::nullopt
                : std::optional<std::string_view>(
                      detail::trim_css_token(feature.substr(colon + 1)));
        if (!named.insert(name).second)
            refuse();
        if (!media_.empty())
            media_ += " and ";
        const auto bound = std::find(std::begin(bound_names), std::end(bound_names), name);
        if (name == "resolution") {
            resolution_ = measure(value, "dppx");
            media_ += "(resolution: " + js::number_to_string(*resolution_) + "dppx)";
        } else if (bound != std::end(bound_names)) {
            const double pixels = measure(value, "px");
            *bounds[bound - std::begin(bound_names)] = pixels;
            media_ += "(" + std::string(name) + ": " + js::number_to_string(pixels) + "px)";
        } else if (name_media_feature(condition_, name, value)) {
            media_ += "(" + std::string(name) + (value ? ": " + std::string(*value) : "") + ")";
        } else {
            refuse();
        }
        const auto trailing = rest.substr(close + 1);
        rest = detail::trim_css_token(trailing);
        if (rest.empty())
            break;
        if (rest.data() == trailing.data() || !rest.starts_with("and") || rest.size() == 3 ||
            std::string_view(" \t\n\f\r").find(rest[3]) == std::string_view::npos)
            refuse();
        rest = detail::trim_css_token(rest.substr(3));
    }
    if (resolution_ && named.size() > 1)
        refuse();
    if (condition_.names_input() && !read_input_capabilities_)
        throw std::invalid_argument("Input media queries require native device capabilities.");
    if ((min_width_ >= 0 || max_width_ >= 0 || min_height_ >= 0 || max_height_ >= 0) &&
        !read_viewport_)
        throw std::invalid_argument("Viewport media queries require the window's viewport.");
    matches_ = matches();
}

bool MediaQueryList::matches() const {
    if (resolution_)
        return *resolution_ == read_pixel_ratio_();
    // Only the features the query names are read.
    UiMediaDevice device{};
    if (condition_.reduced_motion)
        device.reduced_motion = read_motion_preference_();
    if (condition_.names_input())
        device.input = read_input_capabilities_();
    if (min_width_ >= 0 || max_width_ >= 0 || min_height_ >= 0 || max_height_ >= 0) {
        const UiClientRect viewport = read_viewport_();
        const auto within = [](double size, double minimum, double maximum) {
            return (minimum < 0 || size >= minimum) && (maximum < 0 || size <= maximum);
        };
        if (!within(viewport.width, min_width_, max_width_) ||
            !within(viewport.height, min_height_, max_height_))
            return false;
    }
    return condition_.matches(device);
}

void MediaQueryList::add_change_listener(js::Callback<void()> callback) {
    listeners_.add(std::move(callback));
}
void MediaQueryList::add_change_listener(std::size_t identity, js::Callback<void()> callback) {
    listeners_.add(identity, std::move(callback));
}
void MediaQueryList::remove_change_listener(std::size_t identity) { listeners_.remove(identity); }

void MediaQueryList::deliver() {
    const bool next = matches();
    if (matches_ == next)
        return;
    matches_ = next;
    dispatch_platform_event(EventLoop::current(), listeners_);
}

} // namespace bbl::pal
