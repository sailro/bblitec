import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { gridSpriteAtlasCpp } from "../src/lowering/pinned-grid-atlas.js";
import {
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
        "/nologo",
        "/std:c++20",
        "/EHsc",
        "/W4",
        "/WX",
        "/permissive-",
        `/I${resolve("native/include")}`,
        source,
        `/Fo${resolve(directory, "check.obj")}`,
        `/Fe${executable}`,
    ]);
    assert.equal(execFileSync(executable, [], { encoding: "utf8" }), "");
});
