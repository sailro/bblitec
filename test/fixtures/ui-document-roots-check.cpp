#define BBLITE_WORKERS 1
#define BBLITE_OFFSCREEN_SURFACES 1
#define main generated_main
#include "../../artifacts/ui-document-roots/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected fixture asset read"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
Engine& window_document_engine() { static Engine document; return document; }
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.run([&] { initialize(realm); });
    return 0;
}
}

int main() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("Document root fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        auto& engine = pal::window_document_engine();
        const auto earlier = ui_create_element(engine, "div");
        ui_set_attribute(engine, earlier, "style", "width:20px;height:9px");
        ui_append_to_root(engine, earlier);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        auto* earlier_raw = runtime.projected_elements.at(earlier.value).element;
        assert(earlier_raw->GetClientWidth() == 20.f);
        assert(generated_main() == 0);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        const auto html = ui_document_root(engine, UiDocumentPart::Html);
        const auto head = ui_document_root(engine, UiDocumentPart::Head);
        const auto body = ui_document_root(engine, UiDocumentPart::Body);
        assert(runtime.projected_elements.at(html.value).element == runtime.document);
        assert(runtime.document->GetTagName() == "html");
        assert(runtime.document_head->GetTagName() == "head");
        assert(runtime.document_body->GetTagName() == "body");
        assert(runtime.document_head->GetParentNode() == runtime.document);
        assert(runtime.document_body->GetParentNode() == runtime.document);
        assert(engine.ui_elements.at(head.value).parent == html);
        assert(engine.ui_elements.at(body.value).parent == html);
        assert(engine.ui_elements.at(earlier.value).parent == body);
        assert(runtime.projected_elements.at(earlier.value).element == earlier_raw);
        assert(earlier_raw->GetParentNode() == runtime.document_body);
        const auto direct = ui_get_element_by_id(engine, "direct");
        const auto inner = ui_get_element_by_id(engine, "inner");
        assert(runtime.projected_elements.at(direct.value).element->GetClientWidth() == 83.f);
        assert(runtime.projected_elements.at(inner.value).element->GetClientWidth() == 83.f);
        ui_set_style_property(engine, html, "--Width", "47px");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(runtime.projected_elements.at(direct.value).element->GetClientWidth() == 47.f);
        assert(runtime.projected_elements.at(inner.value).element->GetClientWidth() == 47.f);
        assert(runtime.projected_elements.at(earlier.value).element == earlier_raw);
        ui_append_child(engine, html, inner);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        auto* inner_raw = runtime.projected_elements.at(inner.value).element;
        auto* direct_raw = runtime.projected_elements.at(direct.value).element;
        assert(inner_raw->GetParentNode() == runtime.document);
        assert(direct_raw->GetNextSibling() == inner_raw);
        ui_append_child(engine, html, direct);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(inner_raw->GetNextSibling() == direct_raw);
        assert(runtime.projected_elements.at(direct.value).element == direct_raw);
        ui_append_to_root(engine, inner);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(inner_raw->GetParentNode() == runtime.document_body);
        const auto first = ui_create_element(engine, "style");
        const auto last = ui_create_element(engine, "style");
        ui_add_style_rule(engine, first, UiStyleSelectorKind::TagChildClass, "direct", {}, "html", false, -1, "height:13px");
        ui_add_style_rule(engine, last, UiStyleSelectorKind::TagChildClass, "direct", {}, "html", false, -1, "height:17px");
        ui_append_child(engine, head, first);
        ui_append_child(engine, head, last);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(direct_raw->GetClientHeight() == 17.f);
        ui_append_child(engine, head, first);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(direct_raw->GetClientHeight() == 13.f);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
