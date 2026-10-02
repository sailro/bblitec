#define main generated_main
#include "../../artifacts/ui-markup-values/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected markup asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
Engine& window_document_engine() {
    static Engine engine;
    return engine;
}
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.run([&] { initialize(realm); });
    return 0;
}
} // namespace bbl::pal

std::string contents(Rml::Element& element) {
    if (auto* text = dynamic_cast<Rml::ElementText*>(&element))
        return text->GetText();
    std::string result;
    for (int i = 0; i < element.GetNumChildren(); i++)
        result += contents(*element.GetChild(i));
    return result;
}

int run() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("Markup values", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window && generated_main() == 0);
    {
        auto& engine = pal::window_document_engine();
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const std::string label = "old <span>&\"data-bbl-node=0\"</span>";
        const std::string go = "\xcf\x80\xf0\x9f\x8e\xae" + label + "\xe5\xbe\x8c";
        for (const auto* id : {"stacked", "horizontal"}) {
            auto* root = runtime.document->GetElementById(id);
            assert(root && root->GetNumChildren() == 1);
            auto* choices = root->GetChild(0);
            assert(choices->GetNumChildren() == 2);
            const bool stacked = std::string_view(id) == "stacked";
            assert(choices->IsClassSet("stacked") == stacked);
            auto* action = choices->GetChild(stacked ? 0 : 1);
            auto* cancel = choices->GetChild(stacked ? 1 : 0);
            assert(action->IsClassSet("go") && cancel->IsClassSet("cancel"));
            if (contents(*action) != go || contents(*cancel) != label)
                throw std::runtime_error(std::string(id) + " action=[" + contents(*action) +
                                         "] cancel=[" + contents(*cancel) + "]");
        }
        assert(contents(*runtime.document->GetElementById("ordered")) == "ACE");
        const auto empty = ui_create_element(engine, "div");
        const UiSelectorTest span{UiSelectorTestKind::Tag, "span", ""};
        assert(ui_query_markup_all(engine, empty, {{1, "span"}}, span).empty());
        assert(!ui_query_markup_first(engine, empty, {{1, "span"}}, span));
        const auto owner = ui_get_element_by_id(engine, "stacked");
        const auto child = ui_element(engine, owner).markup_children.at(0);
        const auto refuses = [](auto action) {
            bool failed = false;
            try {
                action();
            } catch (const std::runtime_error&) {
                failed = true;
            }
            assert(failed);
        };
        refuses([&] { ui_remove(engine, child); });
        refuses([&] { ui_append_child(engine, empty, child); });
        refuses([&] { ui_replace_children(engine, child); });
        refuses([&] { ui_replace_children(engine, owner); });
        refuses([&] { ui_set_text(engine, owner, "replacement"); });
        refuses([&] { ui_set_inner_rml(engine, owner, "<span>replacement</span>"); });
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}
int main() {
    try {
        return run();
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
