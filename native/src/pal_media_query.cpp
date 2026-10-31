#include <bblite/pal_window_objects.hpp>
#include <bblite/pal_event_loop.hpp>
#include <cctype>
#include <set>
#include <stdexcept>
#include <bblite/js_data.hpp>

namespace bbl::pal {

namespace {
std::string_view trim_media(std::string_view text) {
    while (!text.empty() && std::isspace(static_cast<unsigned char>(text.front())))
        text.remove_prefix(1);
    while (!text.empty() && std::isspace(static_cast<unsigned char>(text.back())))
        text.remove_suffix(1);
    return text;
}

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
                               InputCapabilities (*read_input_capabilities)())
    : read_pixel_ratio_(read_pixel_ratio), read_motion_preference_(read_motion_preference),
      read_input_capabilities_(read_input_capabilities) {
    const auto refuse = [] {
        throw std::invalid_argument(
            "Only resolution, reduced-motion, pointer and hover media queries are admitted by "
            "the Window realm.");
    };
    // An `and` conjunction of features, each named once; resolution stands alone.
    const std::string lowered = js::string_lower(query);
    std::string_view rest = trim_media(lowered);
    std::set<std::string_view> named;
    while (true) {
        if (rest.empty() || rest.front() != '(')
            refuse();
        const auto close = rest.find(')');
        if (close == std::string_view::npos)
            refuse();
        const std::string_view feature = rest.substr(1, close - 1);
        const auto colon = feature.find(':');
        const std::string_view name = trim_media(feature.substr(0, colon));
        const std::optional<std::string_view> value =
            colon == std::string_view::npos
                ? std::nullopt
                : std::optional<std::string_view>(trim_media(feature.substr(colon + 1)));
        if (!named.insert(name).second)
            refuse();
        if (!media_.empty())
            media_ += " and ";
        if (name == "resolution" && value && value->ends_with("dppx")) {
            const std::string number(value->substr(0, value->size() - 4));
            std::size_t parsed = 0;
            try {
                resolution_ = std::stod(number, &parsed);
            } catch (const std::logic_error&) {
                refuse();
            }
            if (parsed != number.size() || number.empty() || !std::isdigit(number.front()))
                refuse();
            media_ += "(resolution: " + js::number_to_string(*resolution_) + "dppx)";
        } else if (name_media_feature(condition_, name, value)) {
            media_ += "(" + std::string(name) + (value ? ": " + std::string(*value) : "") + ")";
        } else {
            refuse();
        }
        rest = trim_media(rest.substr(close + 1));
        if (rest.empty())
            break;
        if (!rest.starts_with("and") || rest.size() == 3 ||
            !std::isspace(static_cast<unsigned char>(rest[3])))
            refuse();
        rest = trim_media(rest.substr(3));
    }
    if (resolution_ && named.size() > 1)
        refuse();
    if (condition_.names_input() && !read_input_capabilities_)
        throw std::invalid_argument("Input media queries require native device capabilities.");
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
