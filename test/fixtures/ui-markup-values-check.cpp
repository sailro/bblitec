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
        assert(contents(*runtime.document->GetElementById("later-span")) ==
               "changed after captureafter span");
        assert(contents(*runtime.document->GetElementById("later-condition")) ==
               "after spanafter condition");
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
        refuses([&] { ui_replace_children(engine, owner); });
        refuses([&] { ui_set_text(engine, owner, "replacement"); });
        refuses([&] { ui_set_inner_rml(engine, owner, "<span>replacement</span>"); });
        const auto nested_owner = ui_create_element(engine, "div");
        ui_set_inner_rml(engine, nested_owner,
                         "<div data-bbl-node=\"0\"><span data-bbl-node=\"1\">leaf</span></div>");
        const auto branch = ui_query_markup(engine, nested_owner, 0, "div");
        const auto leaf = ui_query_markup(engine, nested_owner, 1, "span");
        refuses([&] { ui_set_text(engine, branch, "replacement"); });
        refuses([&] { ui_set_inner_rml(engine, branch, "<b>replacement</b>"); });
        refuses([&] { ui_replace_children(engine, branch); });
        ui_set_text(engine, leaf, "replacement");
        assert(ui_element(engine, leaf).text == "replacement");

        const auto replacements = ui_create_element(engine, "div");
        ui_set_inner_rml(
            engine, replacements,
            "<div data-bbl-node=\"0\" id=\"empty-markup\"></div>"
            "<div data-bbl-node=\"1\" id=\"text-markup\" class=\"live\">"
            "old<b data-bbl-node=\"2\">nested</b></div>"
            "<div data-bbl-node=\"3\" id=\"empty-text\"><b data-bbl-node=\"4\">old</b></div>"
            "<div data-bbl-node=\"5\" id=\"empty-children\"><b data-bbl-node=\"6\">old</b></div>"
            "<button data-bbl-node=\"7\" id=\"original-sibling\">sibling</button>"
            "<div data-bbl-node=\"8\" id=\"empty-html\"><b data-bbl-node=\"9\">old</b></div>"
            "<button data-bbl-node=\"10\" id=\"late-sibling\">unqueried</button>");
        const auto empty_markup = ui_query_markup(engine, replacements, 0, "div");
        const auto text_markup = ui_query_markup(engine, replacements, 1, "div");
        const auto empty_text = ui_query_markup(engine, replacements, 3, "div");
        const auto empty_children = ui_query_markup(engine, replacements, 5, "div");
        const auto sibling = ui_query_markup(engine, replacements, 7, "button");
        const auto empty_html = ui_query_markup(engine, replacements, 8, "div");
        int text_clicks = 0;
        int sibling_clicks = 0;
        int replacement_clicks = 0;
        ui_on_click(engine, text_markup, [&] { ++text_clicks; });
        ui_on_click(engine, sibling, [&] { ++sibling_clicks; });
        ui_set_inner_rml(engine, empty_markup,
                         "<b data-bbl-node=\"7\" id=\"replacement-child\">new</b>");
        const auto replacement_child = ui_query_markup(engine, empty_markup, 7, "b");
        ui_on_click(engine, replacement_child, [&] { ++replacement_clicks; });
        ui_set_text(engine, text_markup, "replacement");
        ui_set_text(engine, empty_text, "");
        ui_replace_children(engine, empty_children);
        ui_set_inner_rml(engine, empty_html, "");
        ui_append_to_root(engine, replacements);
        pal::update_ui_rml_runtime(runtime, 640, 480);

        const auto projected = [&](UiElementHandle handle) {
            return runtime.projected_elements.at(handle.value).element;
        };
        auto* raw_text = projected(text_markup);
        auto* raw_sibling = projected(sibling);
        auto* raw_replacement = projected(replacement_child);
        assert(contents(*projected(empty_markup)) == "new");
        assert(contents(*raw_text) == "replacement");
        for (const auto handle : {empty_text, empty_children, empty_html})
            assert(projected(handle)->GetNumChildren() == 0);
        assert(raw_sibling != raw_replacement && contents(*raw_sibling) == "sibling");
        assert(raw_sibling == runtime.document->GetElementById("original-sibling"));
        assert(raw_replacement == runtime.document->GetElementById("replacement-child"));
        raw_sibling->DispatchEvent("click", {});
        raw_replacement->DispatchEvent("click", {});
        raw_text->DispatchEvent("click", {});
        assert(sibling_clicks == 1 && replacement_clicks == 1 && text_clicks == 1);

        const UiSelectorTest live{UiSelectorTestKind::Class, "live", ""};
        const auto query_text = [&] {
            const auto first = ui_query_markup_first(engine, replacements, {{1, "div"}}, live);
            const auto all = ui_query_markup_all(engine, replacements, {{1, "div"}}, live);
            assert(first && first.value() == text_markup);
            assert(all.size() == 1 && all[0] == text_markup);
            assert(ui_query_markup(engine, replacements, 1, "div") == text_markup);
        };
        query_text();
        const UiSelectorTest bold{UiSelectorTestKind::Tag, "b", ""};
        assert(!ui_query_markup_first(engine, replacements,
                                      {{2, "b"}, {4, "b"}, {6, "b"}, {9, "b"}}, bold));
        assert(ui_query_markup_all(engine, replacements, {{2, "b"}, {4, "b"}, {6, "b"}, {9, "b"}},
                                   bold)
                   .empty());
        for (const auto id : {2u, 4u, 6u, 9u})
            refuses([&] { ui_query_markup(engine, replacements, id, "b"); });

        ui_set_text(engine, text_markup, "second");
        ui_set_text(engine, empty_text, "");
        ui_replace_children(engine, empty_children);
        ui_set_inner_rml(engine, empty_html, "");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(projected(text_markup) == raw_text && contents(*raw_text) == "second");
        assert(projected(sibling) == raw_sibling &&
               projected(replacement_child) == raw_replacement);
        raw_text->DispatchEvent("click", {});
        assert(text_clicks == 2);
        query_text();
        ui_set_text(engine, text_markup, "");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(projected(text_markup) == raw_text && raw_text->GetNumChildren() == 0);
        query_text();
        ui_set_inner_rml(engine, text_markup,
                         "<span data-bbl-node=\"10\" id=\"late-replacement\">late</span>");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        auto* raw_late_child = runtime.document->GetElementById("late-replacement");
        auto* raw_late_sibling = runtime.document->GetElementById("late-sibling");
        assert(raw_late_child && raw_late_sibling && raw_late_child != raw_late_sibling);
        const auto late_child = ui_query_markup(engine, text_markup, 10, "span");
        const auto late_sibling = ui_query_markup(engine, replacements, 10, "button");
        int late_clicks = 0;
        ui_on_click(engine, late_child, [&] { ++late_clicks; });
        ui_set_text(engine, late_child, "late child");
        ui_set_text(engine, late_sibling, "late sibling");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(projected(late_child) == raw_late_child &&
               contents(*raw_late_child) == "late child");
        assert(projected(late_sibling) == raw_late_sibling &&
               contents(*raw_late_sibling) == "late sibling");
        raw_late_child->DispatchEvent("click", {});
        assert(late_clicks == 1);
        query_text();
        refuses([&] { ui_set_text(engine, empty_markup, "replacement"); });
        refuses([&] { ui_set_inner_rml(engine, empty_markup, "<b>replacement</b>"); });
        refuses([&] { ui_replace_children(engine, empty_markup); });
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
