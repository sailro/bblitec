#include <bblite/pal_window_realm.hpp>
#include <regex>
#include <cctype>
#include <bblite/js_data.hpp>

namespace bbl::pal {

MediaQueryList::MediaQueryList(std::string query, double (*read_pixel_ratio)(), bool (*read_motion_preference)())
    : read_pixel_ratio_(read_pixel_ratio), read_motion_preference_(read_motion_preference) {
    std::smatch result;
    static const std::regex resolution(R"(^\s*\(\s*resolution\s*:\s*([0-9]+(?:\.[0-9]+)?)dppx\s*\)\s*$)", std::regex::icase);
    static const std::regex motion(R"(^\s*\(\s*prefers-reduced-motion\s*(?::\s*(reduce|no-preference)\s*)?\)\s*$)", std::regex::icase);
    if (std::regex_match(query, result, resolution)) {
        resolution_ = std::stod(result[1].str());
        media_ = "(resolution: " + js::number_to_string(resolution_) + "dppx)";
    } else if (std::regex_match(query, result, motion)) {
        feature_ = Feature::ReducedMotion;
        std::string preference = result[1].str();
        std::transform(preference.begin(), preference.end(), preference.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
        reduce_ = !result[1].matched || preference == "reduce";
        media_ = !result[1].matched ? "(prefers-reduced-motion)"
            : reduce_ ? "(prefers-reduced-motion: reduce)" : "(prefers-reduced-motion: no-preference)";
    } else {
        throw std::invalid_argument("Only resolution and reduced-motion media queries are admitted by the Window realm.");
    }
    matches_ = matches();
}

bool MediaQueryList::matches() const {
    return feature_ == Feature::Resolution ? resolution_ == read_pixel_ratio_() : reduce_ == read_motion_preference_();
}

void MediaQueryList::add_change_listener(js::Callback<void()> callback) { listeners_.add(callback.identity(), std::move(callback)); }

void MediaQueryList::deliver() {
    const bool next = matches();
    if (matches_ == next) return;
    matches_ = next;
    listeners_.dispatch_with([](const auto& callback) {
        EventLoop::current().dispatch_callback(callback);
    });
}

} // namespace bbl::pal
