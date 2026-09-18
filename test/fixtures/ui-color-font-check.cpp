#include <bblite/pal_system_fonts.hpp>
#include <RmlUi/Core.h>
#include "pal_ui_font_color.hpp"
#include <array>
#include <iostream>
#include <map>
#include <stdexcept>

namespace {
void require(bool value, const char* message) {
    if (!value) throw std::runtime_error(message);
}

struct Recorder final : Rml::RenderInterface {
    struct Texture { Rml::Vector2i size; std::vector<Rml::byte> bytes; };
    std::map<Rml::TextureHandle, Texture> textures;
    std::size_t next = 1;
    Rml::CompiledGeometryHandle CompileGeometry(Rml::Span<const Rml::Vertex>, Rml::Span<const int>) override { return next++; }
    void RenderGeometry(Rml::CompiledGeometryHandle, Rml::Vector2f, Rml::TextureHandle) override {}
    void ReleaseGeometry(Rml::CompiledGeometryHandle) override {}
    Rml::TextureHandle LoadTexture(Rml::Vector2i&, const Rml::String&) override { return 0; }
    Rml::TextureHandle GenerateTexture(Rml::Span<const Rml::byte> bytes, Rml::Vector2i size) override {
        const auto id = next++;
        textures.emplace(id, Texture{size, {bytes.begin(), bytes.end()}});
        return id;
    }
    void ReleaseTexture(Rml::TextureHandle id) override { require(textures.erase(id) == 1, "Texture released twice."); }
    void EnableScissorRegion(bool) override {}
    void SetScissorRegion(Rml::Rectanglei) override {}
};
}

int main() try {
    Recorder recorder;
    Rml::SystemInterface system;
    Rml::SetSystemInterface(&system);
    Rml::SetRenderInterface(&recorder);
    require(Rml::Initialise(), "RmlUi initialization failed.");
    bbl::pal::ColorUiFontEngine engine(*Rml::GetFontEngineInterface());
    Rml::SetFontEngineInterface(&engine);
    const auto emoji = bbl::pal::find_system_font("Apple Color Emoji", 400);
    require(emoji.has_value(), "iOS system emoji font is missing.");
    require(engine.LoadFontFace(emoji->path.string(), emoji->face_index, "bbl-emoji",
        Rml::Style::FontStyle::Normal, Rml::Style::FontWeight::Normal, true), "Emoji face load failed.");
    auto* layout = Rml::CreateContext("color-font", {320, 100});
    require(layout != nullptr, "Font context creation failed.");
    const Rml::String language = "en-us";
    Rml::TextShapingContext shaping{language};
    const std::array<Rml::String, 4> symbols{
        "\xF0\x9F\x8F\x81", "\xF0\x9F\x8E\xAE", "\xF0\x9F\x9B\xA0", "\xF0\x9F\x93\xBA"};
    for (const int size : {16, 24, 32}) {
        const auto handle = engine.GetFontFaceHandle("bbl-emoji", Rml::Style::FontStyle::Normal, Rml::Style::FontWeight::Normal, size);
        require(handle != 0, "Emoji handle creation failed.");
        for (const auto& symbol : symbols) {
            const int advance = engine.GetStringWidth(handle, symbol, shaping, Rml::Character::Null);
            require(advance > 0 && advance < size * 3, "Invalid emoji advance.");
            Rml::TexturedMeshList meshes;
            require(engine.GenerateString(layout->GetRenderManager(), handle, 0, symbol, {0, 40},
                Rml::Colourb{255, 255, 255}.ToPremultiplied(), 1, shaping, meshes) == advance, "Layout/render advances differ.");
            require(meshes.size() == 1 && meshes[0].mesh.vertices.size() == 4, "Emoji has no glyph quad.");
            auto geometry = layout->GetRenderManager().MakeGeometry(std::move(meshes[0].mesh));
            geometry.Render({}, meshes[0].texture);
            const auto& pixels = recorder.textures.rbegin()->second.bytes;
            std::size_t visible = 0, colored = 0;
            for (std::size_t offset = 0; offset < pixels.size(); offset += 4) {
                const auto alpha = pixels[offset + 3];
                if (alpha) ++visible;
                if (alpha && (pixels[offset] != pixels[offset + 1] || pixels[offset] != pixels[offset + 2])) ++colored;
                require(pixels[offset] <= alpha && pixels[offset + 1] <= alpha && pixels[offset + 2] <= alpha, "Emoji pixels are not premultiplied.");
            }
            require(visible > static_cast<std::size_t>(size), "Emoji bitmap is empty.");
            if (symbol != symbols[0]) require(colored > 0, "Color emoji became monochrome.");
            const auto count = recorder.textures.size();
            Rml::TexturedMeshList retained;
            engine.GenerateString(layout->GetRenderManager(), handle, 0, symbol, {0, 40},
                Rml::Colourb{255, 255, 255}.ToPremultiplied(), 1, shaping, retained);
            auto duplicate = layout->GetRenderManager().MakeGeometry(std::move(retained[0].mesh));
            duplicate.Render({}, retained[0].texture);
            require(recorder.textures.size() == count, "An unchanged emoji was rasterized twice.");
            std::cout << "emoji=" << symbol << " size=" << size << " advance=" << advance << " visible=" << visible << " colored=" << colored << '\n';
        }
    }
    Rml::Shutdown();
    require(recorder.textures.empty(), "Emoji textures survived shutdown.");
    std::cout << "ui-color-font-check: ok\n";
} catch (const std::exception& error) {
    std::cerr << "ui-color-font-check: " << error.what() << '\n';
    return 1;
}
