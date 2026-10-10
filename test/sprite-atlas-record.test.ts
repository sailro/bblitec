import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { compileSource } from "../src/compiler.js";
import {
    cppFunction,
    cppRecord,
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("stored sprite atlases remain warning-clean under LTCG with and without image codecs", (t) => {
    const native = optionalNativeFixtureTools();
    if (!native) return t.skip("Native fixture compiler unavailable.");
    const result = compileSource(`
        import {createEngine,createSprite2DLayer,createTexture2DFromPixels,type SpriteAtlas,type Texture2D} from '@babylonjs/lite';
        async function assets(texture:Texture2D):Promise<{texture:Texture2D,frames:SpriteAtlas['frames']}>{
            return {texture,frames:[{uvMin:[0,0],uvMax:[1,1],sourceSizePx:[1,1],pivot:[0.5,0.5]}]};
        }
        async function main(){
            const engine=await createEngine({});
            const texture=createTexture2DFromPixels(engine,new Uint8Array([80,40,20,128]),1,1);
            const loaded=await assets(texture);
            const atlas:SpriteAtlas={texture:loaded.texture,textureSizePx:[1,1],frames:loaded.frames,premultipliedAlpha:true};
            createSprite2DLayer(atlas);
        } void main();
    `);
    assert.match(
        result.cpp,
        /#include <bblite\/features\/has_image_decoder\.hpp>/,
    );
    const helper = result.cpp.match(
        /bbl::SpriteAtlasHandle (\w+sprite_atlas_record_\d+)\(/,
    )?.[1];
    assert(helper);
    const directory = resolve("artifacts/test-sprite-atlas-record");
    mkdirSync(directory, { recursive: true });
    const image = new PNG({ width: 1, height: 1 });
    image.data = Buffer.from([80, 40, 20, 128]);
    const png = PNG.sync.write(image);
    const source = join(directory, "check.cpp");
    writeFileSync(
        source,
        `
#include <bblite/runtime.hpp>
#include <bblite/pal_texture_texels.hpp>
#include "pal_image.cpp"
#include <cassert>
namespace bbl::pal { std::string environment_variable(const char*) { return {}; } }
namespace bblscene {
${cppRecord(result.cpp, "struct SpriteFrameData {")}
using SpriteFrame = bbl::js::Ref<SpriteFrameData>;
template <typename Texture>
${cppFunction(result.cpp, `bbl::SpriteAtlasHandle ${helper}(`)}
}
int main() {
    bbl::Engine engine;
    bbl::PixelsTexture pixels;
    pixels.rgba = {80,40,20,128};
    bbl::StoredTexture texture = pixels;
    const bbl::js::Array<bblscene::SpriteFrame> frames{
        bbl::js::make_ref<bblscene::SpriteFrameData>(bblscene::SpriteFrameData{
            std::nullopt, {0,0}, {1,1}, {1,1}, {0.5,0.5}})};
    const auto first = bblscene::${helper}(engine,texture,1,1,true,frames);
    const auto& atlas = engine.sprite_atlases.at(first.value);
    const std::vector<std::uint8_t> original{80,40,20,128};
    assert(*atlas.rgba == original && atlas.width == 1 && atlas.height == 1);
    assert(atlas.frames.size() == 1 && atlas.frames[0].pivot.x == 0.5f);
    assert(atlas.premultiplied_alpha && !atlas.mip_maps);
    bbl::FileTexture file;
    file.data.bytes = {${[...png].join(",")}};
    file.data.premultiply_alpha = true;
    texture = file;
#if BBLITE_HAS_IMAGE_DECODER
    const auto second = bblscene::${helper}(engine,texture,1,1,true,frames);
    const std::vector<std::uint8_t> expected{40,20,10,128};
    assert(*engine.sprite_atlases.at(second.value).rgba == expected);
#else
    try {
        bblscene::${helper}(engine,texture,1,1,true,frames);
        assert(false);
    } catch (const std::runtime_error& error) {
        assert(std::string_view(error.what()) == "This scene was built without image decoding.");
        assert(engine.sprite_atlases.size() == 1);
    }
#endif
}
`,
    );
    for (const decoder of [0, 1]) {
        const executable = join(directory, `decoder-${decoder}.exe`);
        runNativeFixtureCompiler(native, [
            "/O1",
            "/Ob1",
            "/GL",
            `/DBBLITE_HAS_IMAGE_DECODER=${decoder}`,
            `/I${resolve("native/src")}`,
            source,
            `/Fo${join(directory, `decoder-${decoder}.obj`)}`,
            `/Fe${executable}`,
            join(nativeFixtureVcpkgRoot, "lib/SDL3.lib"),
            ...(decoder
                ? [join(nativeFixtureVcpkgRoot, "lib/SDL3_image.lib")]
                : []),
            "/link",
            "/LTCG",
        ]);
        execFileSync(executable, [], {
            stdio: "pipe",
            windowsHide: true,
            env: {
                ...process.env,
                PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${process.env.PATH ?? ""}`,
            },
        });
    }
});
