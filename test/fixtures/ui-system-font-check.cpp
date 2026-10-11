#include "pal_ui_font_system.hpp"
#include <cassert>
#include <iostream>

namespace {
int discoveries = 0;
using Weight = Rml::Style::FontWeight;
using Style = Rml::Style::FontStyle;
using Key = std::tuple<std::string, Style, Weight>;

struct Renderer final : Rml::FontEngineInterface {
    Rml::FontFaceHandle face = std::make_shared<int>(0);
    std::set<Key> loaded;
    int loads = 0;
    int last_index = 0;
    Weight last_query_weight = Weight::Auto;
    bool LoadFontFace(const Rml::String&, int index, const Rml::String& family, Style style,
                      Weight weight, bool) override {
        ++loads;
        last_index = index;
        assert(loaded.emplace(family, style, weight).second);
        return true;
    }
    bool LoadFontFace(Rml::Span<const Rml::byte>, int index, const Rml::String& family, Style style,
                      Weight weight, bool fallback) override {
        return LoadFontFace("memory", index, family, style, weight, fallback);
    }
    Rml::FontFaceHandle GetFontFaceHandle(const Rml::String& family, Style style, Weight weight,
                                          float) override {
        assert(family == Rml::StringUtilities::ToLower(family));
        last_query_weight = weight;
        return loaded.contains(Key{family, style, weight}) ? face : nullptr;
    }
    void Shutdown() override { loaded.clear(); }
};
} // namespace

namespace bbl::pal {
std::optional<SystemFontFace> find_system_font(std::string_view family, int weight, bool) {
    ++discoveries;
    if (family == "missing")
        return std::nullopt;
    if (family == "variable") {
        const int named = weight >= 700 ? 700 : 600;
        return SystemFontFace{"variable.ttf", "variable", (named / 100) << 16, named};
    }
    return SystemFontFace{"static.ttf", std::string(family), 0};
}
} // namespace bbl::pal

int main() {
    Renderer renderer;
    bbl::pal::SystemUiFontEngine engine(renderer, "static");
    const auto request = [&](std::string family, int weight, Style style = Style::Normal) {
        assert(engine.GetFontFaceHandle(family, style, static_cast<Weight>(weight), 16) ==
               renderer.face);
    };
    request("variable", 650);
    assert(renderer.loaded.contains(Key{"variable", Style::Normal, static_cast<Weight>(600)}));
    assert(renderer.last_index == 6 << 16);
    assert(renderer.loads == 1 && discoveries == 1);
    request("variable", 650);
    assert(renderer.loads == 1 && discoveries == 1);
    request("variable", 625);
    request("variable", 600);
    assert(renderer.loads == 1 && discoveries == 2);
    request("variable", 700);
    assert(renderer.loads == 2 && renderer.last_index == 7 << 16);
    request("variable", 650, Style::Italic);
    assert(renderer.loads == 3);
    assert(renderer.loaded.contains(Key{"variable", Style::Italic, static_cast<Weight>(600)}));
    request("static", 650);
    assert(renderer.loaded.contains(Key{"static", Style::Normal, static_cast<Weight>(650)}));
    request("variable", static_cast<int>(Weight::Auto));
    assert(renderer.loaded.contains(Key{"variable", Style::Normal, Weight::Auto}));
    const int prior = discoveries;
    request("missing, variable", 650);
    request("missing, variable", 650);
    assert(discoveries == prior + 1);
    assert(engine.LoadFontFace("explicit.ttf", 0, "variable", Style::Normal,
                               static_cast<Weight>(650), false));
    request("variable", 650);
    assert(renderer.last_query_weight == static_cast<Weight>(650));
    const Rml::byte bytes[] = {0};
    assert(engine.LoadFontFace(Rml::Span<const Rml::byte>{bytes, 1}, 0, "variable", Style::Normal,
                               static_cast<Weight>(625), false));
    request("variable", 625);
    assert(renderer.last_query_weight == static_cast<Weight>(625));
    const int loads = renderer.loads;
    engine.Shutdown();
    request("variable", 650);
    assert(renderer.loads == loads + 1 && discoveries == prior + 2);
    request("'MiSsInG', \"VaRiAbLe\"", 650);
    request("VARIABLE", 650);
    assert(renderer.loads == loads + 1 && discoveries == prior + 3);
    request("'Mixed, Family'", 400);
    assert(renderer.loaded.contains(Key{"mixed, family", Style::Normal, Weight::Normal}));
    const int mixed_discoveries = discoveries;
    const int mixed_loads = renderer.loads;
    request("\"MIXED, FAMILY\"", 400);
    assert(discoveries == mixed_discoveries && renderer.loads == mixed_loads);
    std::cout << "ui-system-font-check: ok\n";
}
