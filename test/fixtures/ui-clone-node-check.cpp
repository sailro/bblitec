#include "pal_ui_rml.cpp"

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() try {
    using namespace bbl;
    const auto check = [](bool result, const char* message) {
        if (!result)
            throw std::runtime_error(message);
    };
    Engine engine;
    const auto footer = ui_create_element(engine, "div");
    ui_set_attribute(engine, footer, "class", "footer wide");
    ui_set_attribute(engine, footer, "data-page", "2");
    ui_set_style_property(engine, footer, "min-height", "12px");
    const auto coin = ui_create_element(engine, "button");
    ui_set_attribute(engine, coin, "type", "button");
    ui_element(engine, coin).click_callbacks.emplace_back([] {});
    const auto art = ui_create_element(engine, "img");
    ui_set_attribute(engine, art, "src", "/assets/ui/follow.png");
    ui_append_child(engine, coin, art);
    ui_append_child(engine, coin, ui_create_text_node(engine, "Follow"));
    ui_append_child(engine, footer, coin);
    const auto box = ui_create_element(engine, "input");
    ui_set_attribute(engine, box, "type", "checkbox");
    ui_set_checked(engine, box, true);
    ui_append_child(engine, footer, box);
    ui_append_to_root(engine, footer);

    const auto deep = ui_clone_node(engine, footer, true);
    const auto& copy = ui_element(engine, deep);
    check(copy.parent.value == invalid_handle && !copy.attached_to_root, "a clone is detached");
    check(ui_get_attribute(engine, deep, "class") == "footer wide", "attributes are copied");
    check(ui_get_attribute(engine, deep, "data-page") == "2", "every attribute is copied");
    check(ui_get_style_property(engine, deep, "min-height") == "12px", "inline style is copied");
    check(copy.children.size() == 2, "a deep clone copies the children");
    const auto coin_copy = copy.children[0];
    check(coin_copy != coin && ui_element(engine, coin_copy).parent == deep,
          "children are new nodes of the clone");
    check(ui_element(engine, coin_copy).click_callbacks.empty(), "listeners are not copied");
    const auto& coin_children = ui_element(engine, coin_copy).children;
    check(coin_children.size() == 2 &&
              ui_get_attribute(engine, coin_children[0], "src") == "/assets/ui/follow.png" &&
              ui_element(engine, coin_children[1]).text == "Follow",
          "grandchildren and text nodes are copied");
    check(ui_get_checked(engine, ui_element(engine, deep).children[1]), "checkedness is copied");
    check(ui_element(engine, footer).children.size() == 2 &&
              ui_element(engine, coin).parent == footer,
          "the source keeps its children");

    const auto shallow = ui_clone_node(engine, footer, false);
    check(ui_element(engine, shallow).children.empty() &&
              ui_get_attribute(engine, shallow, "class") == "footer wide",
          "a shallow clone copies the node alone");

    const auto markup = ui_create_element(engine, "div");
    ui_set_inner_rml(engine, markup, "<span>a</span>");
    bool refused = false;
    try {
        static_cast<void>(ui_clone_node(engine, markup, true));
    } catch (const std::runtime_error&) {
        refused = true;
    }
    check(refused, "innerHTML content refuses");
    const auto canvas = ui_create_element(engine, "canvas");
    std::string name;
    try {
        static_cast<void>(ui_clone_node(engine, canvas, false));
    } catch (const js::NamedError& error) {
        name = error.name;
    }
    check(name == "NotSupportedError", "a canvas clone throws NotSupportedError");
} catch (const std::exception& error) {
    std::fprintf(stderr, "Clone node fixture: %s\n", error.what());
    return 1;
}
