import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { cppFunction, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

test("native glTF albedo hydration preserves associations, fallback objects and per-load lifetimes", { skip: !tools }, () => {
    const template = readFileSync("src/lowering/templates/gltf-loader-cpp.ts", "utf8");
    const start = template.indexOf("    const auto& source_albedo =");
    const lambda = template.indexOf("    const auto retain_source_albedo =", start);
    assert(start >= 0 && lambda > start);
    // This template island is emitted verbatim. Exercise its real JSON guards,
    // association map, producer adaptation and publication, without GPU work.
    const hydrate = template.slice(start, lambda) + cppFunction(template.slice(lambda), "    const auto retain_source_albedo =") + ";";
    assert(!hydrate.includes("${"));
    const helpers = ["const ts::JsonValue& required(", "const ts::JsonValue* optional(", "std::size_t unsigned_value("]
        .map(signature => cppFunction(template, signature)).join("\n");
    const directory = resolve("artifacts/test-gltf-albedo-hydration");
    mkdirSync(directory, { recursive: true });
    const source = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(source, `#include <bblite/runtime.hpp>
#include <bblite/ts_runtime.hpp>
#include <cassert>
#include <cstdio>
namespace bbl {
using JsonArray = ts::JsonValue::Array;
using JsonObject = ts::JsonValue::Object;
${helpers}
void hydrate_albedo(Engine& engine, const JsonObject& document, const std::vector<MaterialHandle>& materials) {
    const JsonArray material_json(materials.size() - 1);
${hydrate}
    for (std::size_t i = 0; i < materials.size(); ++i) retain_source_albedo(materials[i], i);
}
const std::vector<std::uint8_t>& texture_bytes(const FileTexture& texture) { return texture.data.bytes; }
}
int main() {
    using namespace bbl;
    Engine engine;
    engine.materials.resize(6);
    const std::vector<MaterialHandle> materials{{0}, {1}, {2}, {3}, {4}, {5}};
    for (auto& record : engine.materials) {
        record.has_public_base_color_texture = true;
        record.base_color_texture.bytes = std::vector<std::uint8_t>{11, 22, 33, 255};
        record.base_color_texture.rgba_width = record.base_color_texture.rgba_height = 1;
        record.base_color_texture.sampler.address_u = TextureAddressMode::mirror;
        record.base_color_texture.uv_transform.u_offset = .125;
        record.base_color_texture.uv_invert_y = true;
    }
    const auto document = ts::json_parse(R"({"__bblitecSourceAlbedoIdentities": {
        "materials": [0,0,1,2,3,4],
        "fallbackTexels": {"2":[137,188,225,128],"3":[137,188,225,128],"4":[255,255,255,255]}
    }})");
    hydrate_albedo(engine, document.as_object(), materials);
    const auto get = [&](std::uint32_t index) {
        return std::get<FileTexture>(material_source_texture(engine, MaterialHandle{index}, MaterialTextureSlot::base_color));
    };
    const auto first = get(0), shared = get(1), separate = get(2);
    assert(first == shared && first != separate);
    assert(texture_bytes(first) == texture_bytes(separate));
    assert(first.srgb && first.data.uv_invert_y && first.data.uv_transform.u_offset == .125);
    assert(first.data.sampler.address_u == TextureAddressMode::mirror);
    const auto fallback = get(3), equal_fallback = get(4), implicit = get(5);
    assert(fallback != equal_fallback);
    assert((texture_bytes(fallback) == std::vector<std::uint8_t>{137,188,225,128}));
    assert(texture_bytes(fallback) == texture_bytes(equal_fallback));
    assert(fallback.width == 1 && fallback.height == 1);
    assert((texture_bytes(implicit) == std::vector<std::uint8_t>{255,255,255,255}));
    const auto previous_next = engine.next_file_texture_identity;
    // A new invocation is a fresh glTF load even for identical association IDs.
    hydrate_albedo(engine, document.as_object(), materials);
    assert(get(0) == get(1) && get(0) != first);
    assert(get(0).identity >= previous_next);
    assert(get(3) != fallback && get(3) != get(4));
    engine.materials.clear();
    assert(first == shared);
    assert((texture_bytes(first) == std::vector<std::uint8_t>{11,22,33,255}));
    assert((texture_bytes(fallback) == std::vector<std::uint8_t>{137,188,225,128}));
    std::puts("gltf-albedo-hydration: ok");
}
`);
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2", "/fp:precise",
        `/Fo:${directory}\\`, `/Fe:${executable}`, "/I", "native/include", "/I", join(nativeFixtureVcpkgRoot, "include"), source]);
    assert.match(execFileSync(executable, { encoding: "utf8" }), /gltf-albedo-hydration: ok/);
});
