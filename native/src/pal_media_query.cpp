#include <bblite/pal_window_objects.hpp>
#include <bblite/pal_event_loop.hpp>
#include <regex>
#include <cctype>
#include <bblite/js_data.hpp>

namespace bbl::pal {

MediaQueryList::MediaQueryList(std::string query, double (*read_pixel_ratio)(),
                               bool (*read_motion_preference)(),
                               InputCapabilities (*read_input_capabilities)())
    : read_pixel_ratio_(read_pixel_ratio), read_motion_preference_(read_motion_preference),
      read_input_capabilities_(read_input_capabilities) {
    std::smatch result;
    static const std::regex resolution(
        R"(^\s*\(\s*resolution\s*:\s*([0-9]+(?:\.[0-9]+)?)dppx\s*\)\s*$)", std::regex::icase);
    static const std::regex motion(
        R"(^\s*\(\s*prefers-reduced-motion\s*(?::\s*(reduce|no-preference)\s*)?\)\s*$)",
        std::regex::icase);
    static const std::regex input(
        R"(^\s*\(\s*(pointer|hover)\s*:\s*(none|coarse|fine|hover)\s*\)(?:\s+and\s+\(\s*(pointer|hover)\s*:\s*(none|coarse|fine|hover)\s*\))?\s*$)",
        std::regex::icase);
    if (std::regex_match(query, result, resolution)) {
        resolution_ = std::stod(result[1].str());
        media_ = "(resolution: " + js::number_to_string(resolution_) + "dppx)";
    } else if (std::regex_match(query, result, motion)) {
        feature_ = Feature::ReducedMotion;
        std::string preference = result[1].str();
        std::transform(preference.begin(), preference.end(), preference.begin(),
                       [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
        reduce_ = !result[1].matched || preference == "reduce";
        media_ = !result[1].matched ? "(prefers-reduced-motion)"
                 : reduce_          ? "(prefers-reduced-motion: reduce)"
                                    : "(prefers-reduced-motion: no-preference)";
    } else if (std::regex_match(query, result, input)) {
        if (!read_input_capabilities_)
            throw std::invalid_argument("Input media queries require native device capabilities.");
        feature_ = Feature::Input;
        for (const auto index : {1u, 3u}) {
            if (!result[index].matched)
                continue;
            const auto feature = js::string_lower(result[index].str());
            const auto value = js::string_lower(result[index + 1].str());
            if (feature == "pointer" && value != "hover") {
                input_conditions_.emplace_back(value == "fine"     ? PointerPrecision::Fine
                                               : value == "coarse" ? PointerPrecision::Coarse
                                                                   : PointerPrecision::None);
            } else if (feature == "hover" && (value == "none" || value == "hover")) {
                input_conditions_.emplace_back(value == "hover");
            } else {
                throw std::invalid_argument("Invalid pointer or hover media query value.");
            }
            if (!media_.empty())
                media_ += " and ";
            media_ += "(" + feature + ": " + value + ")";
        }
    } else {
        throw std::invalid_argument(
            "Only resolution, reduced-motion, pointer and hover media queries are admitted by the Window realm.");
    }
    matches_ = matches();
}

bool MediaQueryList::matches() const {
    if (feature_ == Feature::Resolution)
        return resolution_ == read_pixel_ratio_();
    if (feature_ == Feature::ReducedMotion)
        return reduce_ == read_motion_preference_();
    const auto input = read_input_capabilities_();
    return std::all_of(input_conditions_.begin(), input_conditions_.end(),
                       [&](const auto& condition) {
                           return std::visit(
                               [&](const auto& expected) {
                                   if constexpr (std::is_same_v<std::decay_t<decltype(expected)>,
                                                                PointerPrecision>)
                                       return input.pointer == expected;
                                   else
                                       return input.hover == expected;
                               },
                               condition);
                       });
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
    listeners_.dispatch_with(
        [](const auto& callback) { EventLoop::current().dispatch_callback(callback); });
}

} // namespace bbl::pal
