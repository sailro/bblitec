#define main generated_main
#include "../../artifacts/dom-form-controls/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include "pal_platform_events.hpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
Engine& window_document_engine() {
    static Engine document;
    return document;
}
// The realm's location: the fixture never navigates.
std::string window_location_search(const std::string& initial) { return initial; }
void window_location_assign(const std::string&, const std::string&) {
    throw std::logic_error("The fixture never activates a link.");
}
} // namespace bbl::pal
#include "realm-application-fixture.hpp"

int main() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    {
        auto& engine = pal::window_document_engine();
        assert(generated_main() == 0);
        const auto panel = ui_get_element_by_id(engine, "panel");
        const auto& record = ui_element(engine, panel);
        assert(record.inner_rml.empty());
        // The template's runtime operand is the heading's text.
        assert(ui_text_content(engine, record.children.front()) == "Beta");
        const auto status = record.children.back();
        // Controls by name, the entry list, and the link resolved against the document URL.
        assert(ui_element(engine, status).text ==
               "NVDE|http://localhost/lite/page.html?view=front");
        // Several controls of one name are a RadioNodeList, not represented.
        const auto form = *std::find_if(
            record.children.begin(), record.children.end(),
            [&](UiElementHandle child) { return ui_element(engine, child).tag == "form"; });
        const auto twin = ui_create_element(engine, "input");
        ui_set_attribute(engine, twin, "name", "view");
        static_cast<void>(ui_append_child(engine, form, twin));
        bool several = false;
        try {
            static_cast<void>(ui_form_named_item(engine, form, "view"));
        } catch (const js::NamedError&) {
            several = true;
        }
        assert(several);
        // A file input's entry is not represented.
        ui_set_attribute(engine, twin, "type", "file");
        bool file = false;
        try {
            static_cast<void>(ui_form_entries(engine, form));
        } catch (const js::NamedError&) {
            file = true;
        }
        assert(file);
    }
    SDL_Quit();
    return 0;
}
