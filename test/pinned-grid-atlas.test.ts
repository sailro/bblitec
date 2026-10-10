import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { gridSpriteAtlasCpp } from "../src/lowering/pinned-grid-atlas.js";
import { SpriteLowerer } from "../src/lowering/sprite-lowerer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("grid atlases accept textures retained in asynchronous source records", () => {
    const result = compileSource(
        `import {createEngine,loadTexture2D,createGridSpriteAtlas,type EngineContext,type Texture2D} from "@babylonjs/lite";
        async function assets(engine:EngineContext):Promise<{texture:Texture2D}>{return {texture:await loadTexture2D(engine,"atlas.png")};}
        async function main(){const engine=await createEngine(document.querySelector("canvas")!);const loaded=await assets(engine);createGridSpriteAtlas(loaded.texture,{cellWidthPx:loaded.texture.width,cellHeightPx:loaded.texture.height});}void main();`,
        { fileName: "stored-grid-atlas.ts" },
    );
    assert(result.manifest.features.includes("sprite:2d"));
    assert.match(result.cpp, /create_grid_sprite_atlas\(.*texture/);
    assert.match(result.cpp, /std::visit\(.*texture.width/);
    assert.match(result.cpp, /std::visit\(.*texture.height/);
});

test("the complete grid atlas factory preserves defaults, explicit zeroes and frame order natively", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    const directory = resolve("artifacts/test-pinned-grid-atlas");
    mkdirSync(directory, { recursive: true });
    const source = resolve(directory, "check.cpp");
    writeFileSync(
        source,
        `#include <bblite/runtime.hpp>
#include <bblite/pinned_records.hpp>
#include <cassert>
${gridSpriteAtlasCpp(new LoweringContext())}
namespace bbl {
SpriteAtlasHandle create_grid_sprite_atlas(Engine&, const FileTexture&, GridSpriteAtlasOptions) {return SpriteAtlasHandle{7};}
SpriteAtlasHandle create_grid_sprite_atlas(Engine&, const PixelsTexture&, GridSpriteAtlasOptions) {return SpriteAtlasHandle{11};}
}
int main() {
    bbl::Engine engine;
    bbl::StoredTexture stored=bbl::FileTexture{};
    assert(bbl::create_grid_sprite_atlas(engine,stored,{}).value==7);
    stored=bbl::PixelsTexture{};
    assert(bbl::create_grid_sprite_atlas(engine,stored,{}).value==11);
    bbl::SpriteAtlasRecord atlas;
    atlas.width = 64;
    atlas.height = 32;
    bbl::GridSpriteAtlasOptions options;
    options.cell_width_px = 16;
    options.cell_height_px = 16;
    bbl::upstream::create_grid_sprite_atlas_frames(atlas, options);
    assert(atlas.frames.size() == 8);
    assert(atlas.frames[4].uv_min.x == 0 && atlas.frames[4].uv_min.y == 0.5f);
    assert(atlas.frames[0].pivot.x == 0.5f && !atlas.premultiplied_alpha);
    options.has_columns = options.has_rows = options.has_pivot = true;
    options.columns = 2;
    options.rows = 1;
    options.pivot = {0, 1};
    options.has_margin_px = options.has_spacing_px = true;
    options.margin_px = 2;
    options.spacing_px = 4;
    options.has_premultiplied_alpha = options.premultiplied_alpha = true;
    bbl::upstream::create_grid_sprite_atlas_frames(atlas, options);
    assert(atlas.frames.size() == 2 && atlas.premultiplied_alpha);
    assert(atlas.frames[1].uv_min.x == 22.0f / 64.0f);
    assert(atlas.frames[1].pivot.x == 0 && atlas.frames[1].pivot.y == 1);
    options.columns = 0;
    bbl::upstream::create_grid_sprite_atlas_frames(atlas, options);
    assert(atlas.frames.empty());
}
`,
    );
    const executable = resolve(directory, "check.exe");
    runNativeFixtureCompiler(native, [
        source,
        `/Fo${resolve(directory, "check.obj")}`,
        `/Fe${executable}`,
    ]);
    assert.equal(execFileSync(executable, [], { encoding: "utf8" }), "");
});

test("grid atlases over a loaded file texture share the texels its load decoded", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    const directory = resolve("artifacts/test-loaded-grid-atlas");
    mkdirSync(directory, { recursive: true });
    const context = new LoweringContext();
    const factory = cppFunction(
        new SpriteLowerer(context).lowerCore().source,
        "SpriteAtlasHandle create_grid_sprite_atlas( Engine& engine, const FileTexture& texture,",
    );
    const source = resolve(directory, "check.cpp");
    writeFileSync(
        source,
        `#include <bblite/runtime.hpp>
#include <bblite/pinned_records.hpp>
#include <bblite/pal_texture_texels.hpp>
#include <cassert>
${gridSpriteAtlasCpp(context)}
namespace bbl::pal {
int decodes = 0;
// A stand-in decoder: two size bytes, then the texels.
DecodedImage decode_image(std::span<const std::uint8_t> bytes) {
    ++decodes;
    return DecodedImage{bytes[0], bytes[1], std::vector<std::uint8_t>(bytes.begin() + 2, bytes.end())};
}
}
namespace bbl {
${factory}
SpriteAtlasHandle create_grid_sprite_atlas(Engine&, const PixelsTexture&, GridSpriteAtlasOptions) {return {};}
}
int main() {
    bbl::Engine engine;
    bbl::FileTexture record;
    record.data.invert_y = true;
    record.data.premultiply_alpha = true;
    const std::vector<std::uint8_t> file{1, 2, 10, 20, 30, 255, 40, 50, 60, 128};
    // The load decodes once, as its upload transforms the image: premultiplied, rows flipped.
    const auto texture = bbl::pal::decode_file_texture(record, file);
    assert(bbl::pal::decodes == 1 && texture.width == 1 && texture.height == 2);
    assert(texture.data.bytes.size() == 10);
    bbl::GridSpriteAtlasOptions options;
    options.cell_width_px = 1;
    options.cell_height_px = 1;
    const auto atlas = [&](const bbl::FileTexture& source) -> const bbl::SpriteAtlasRecord& {
        const auto handle = bbl::create_grid_sprite_atlas(engine, source, options);
        return engine.sprite_atlases[handle.value];
    };
    // Atlases share the load's texels, before and after its frame boundary drops them.
    const bbl::SharedTexels first = atlas(texture).rgba;
    const bbl::SharedTexels second = atlas(texture).rgba;
    texture.data.loaded_texels->release();
    const bbl::SharedTexels third = atlas(texture).rgba;
    assert(bbl::pal::decodes == 1 && second == first && third == first);
    const std::vector<std::uint8_t> expected{20, 25, 30, 128, 10, 20, 30, 255};
    assert(*first == expected && engine.sprite_atlases.back().width == 1 &&
           engine.sprite_atlases.back().height == 2 && engine.sprite_atlases.back().frames.size() == 2);
    // An upload copies the texels an atlas keeps.
    assert(bbl::pal::texture_image_texels(texture.data).rgba == expected && bbl::pal::decodes == 1);
    // An upload that is the only reader moves the load's texels out; an atlas then decodes
    // the file again, and the next atlas shares that decode.
    const auto uploaded = bbl::pal::decode_file_texture(record, file);
    assert(bbl::pal::texture_image_texels(uploaded.data).rgba == expected && bbl::pal::decodes == 2);
    const bbl::SharedTexels decoded = atlas(uploaded).rgba;
    assert(bbl::pal::decodes == 3 && *decoded == expected && atlas(uploaded).rgba == decoded);
    assert(bbl::pal::decodes == 3);
}
`,
    );
    const executable = resolve(directory, "check.exe");
    runNativeFixtureCompiler(native, [
        source,
        `/Fo${resolve(directory, "check.obj")}`,
        `/Fe${executable}`,
    ]);
    assert.equal(execFileSync(executable, [], { encoding: "utf8" }), "");
});
