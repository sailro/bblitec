#define main generated_main
#include "../../artifacts/ui-optional-calls/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
void update_window_document() {}
Engine& window_document_engine() {
    static Engine document;
    return document;
}
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    std::exception_ptr failure;
    loop.on_error([&](std::exception_ptr error) {
        failure = error;
        loop.close();
    });
    loop.run([&] { initialize(realm); });
    if (failure)
        std::rethrow_exception(failure);
    return 0;
}
} // namespace bbl::pal

int main() {
    assert(generated_main() == 0);
    const auto& engine = bbl::pal::window_document_engine();
    const auto& roots = engine.ui_document_roots;
    assert(roots.active() && engine.ui_root_children.size() == 1 &&
           engine.ui_root_children.front() == roots.html);
    assert(engine.ui_elements.at(roots.body.value).children.empty());
    std::vector<const bbl::UiElementRecord*> authored;
    for (std::size_t index = 0; index < engine.ui_elements.size(); ++index) {
        const auto id = engine.ui_elements[index].attributes.find("id");
        if (id != engine.ui_elements[index].attributes.end() && id->second == "host") {
            assert(!engine.ui_elements[index].attached_to_root);
            continue;
        }
        if (index != roots.html.value && index != roots.head.value && index != roots.body.value)
            authored.push_back(&engine.ui_elements.at(index));
    }
    assert(authored.size() == 6);
    assert(authored[0]->children.size() == 1 && authored[1]->text == "child");
    assert(authored[2]->children.size() == 1 &&
           &engine.ui_elements.at(authored[2]->children.front().value) == authored[3]);
    assert(authored[5]->attributes.at("class") == "swatch active");
}
