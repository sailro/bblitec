#define main generated_main
#include "../../artifacts/dom-queries/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
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
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.on_error([](std::exception_ptr error) { std::rethrow_exception(error); });
    loop.run([&] { initialize(realm); });
    return 0;
}
} // namespace bbl::pal

int main() {
    assert(generated_main() == 0);
    auto& engine = bbl::pal::window_document_engine();
    const auto log = bbl::ui_get_element_by_id(engine, "query-log");
    assert(bbl::handle_at(engine.ui_elements, log).text == "complete");
    bbl::UiElementHandle leaf;
    for (std::uint32_t index = 0; index < engine.ui_elements.size(); ++index) {
        const auto& attributes = engine.ui_elements[index].attributes;
        const auto id = attributes.find("id");
        if (id != attributes.end() && id->second == "query-leaf") leaf = {index};
    }
    assert(leaf.value != bbl::invalid_handle);
    const auto event = bbl::dom_event(bbl::PlatformMouseEvent{}, "pointerdown", bbl::dom_ui_path(engine, leaf));
    engine.dom_input->pointer.dispatch(event, [](auto& callback, const auto& value) { callback(value); }, &engine);
    assert(bbl::ui_get_attribute(engine, leaf, "data-event-query") == "complete");
    const auto refuses = [](auto operation) {
        try { operation(); } catch (const std::exception&) { return true; }
        return false;
    };
    assert(refuses([&] { static_cast<void>(bbl::dom_target_element(bbl::dom_target_value(engine, bbl::DomEventTarget::document()))); }));
    assert(refuses([&] { static_cast<void>(bbl::dom_target_element(bbl::dom_target_value(engine, bbl::DomEventTarget::window()))); }));
    assert(refuses([&] { static_cast<void>(bbl::dom_target_element(bbl::dom_target_value(engine, bbl::DomEventTarget::canvas()))); }));
    const auto canvas = bbl::ui_primary_canvas(engine, "query-canvas");
    assert(bbl::dom_target_element(bbl::dom_target_value(engine, bbl::DomEventTarget::canvas())) == canvas);
    const auto text = bbl::ui_create_text_node(engine, "text");
    assert(refuses([&] { static_cast<void>(bbl::dom_target_element(bbl::dom_target_value(engine, bbl::DomEventTarget::node(text.value)))); }));
    bbl::DomEventTargetValue stale;
    { bbl::Engine owner; stale = bbl::dom_target_value(owner, bbl::DomEventTarget::node(0)); }
    assert(refuses([&] { static_cast<void>(bbl::dom_target_element(stale)); }));
}
