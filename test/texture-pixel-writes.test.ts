import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { CompileError } from "../src/compiler/compile-error.js";
import { LoweringContext } from "../src/lowering/context.js";
import { FactoryLowerer } from "../src/lowering/factory/material-factories.js";
import { lowerPixelsTextureWrites } from "../src/lowering/pixels-texture-writes.js";
import { doctoredContext } from "./doctored-store.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

/** The write shapes a real application reaches, in fresh minimal form. */
const APPLICATION_SHAPES = `
import {createEngine,createTexture2DFromPixels,updateTexture2DFromPixels,type EngineContext,type Texture2D} from "babylon-lite";
interface Field {readonly tex: Uint8Array; readonly res: number; readonly dirtyRow0?: number; readonly dirtyRow1?: number;}
interface FieldTextures {domain: Texture2D;}
interface UploadState {readonly rect: Int32Array; scratch: Uint8Array;}
function createFieldTexture(engine: EngineContext, field: Field, filter: "linear" | "nearest" = "linear"): Texture2D {
    return createTexture2DFromPixels(engine, field.tex, field.res, field.res, {addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", minFilter: filter, magFilter: filter});
}
function uploadDomain(engine: EngineContext, textures: FieldTextures, field: Field): void {
    updateTexture2DFromPixels(engine, textures.domain, field.tex);
}
function uploadField(engine: EngineContext, texture: Texture2D, field: Field): void {
    const row0 = field.dirtyRow0;
    const row1 = field.dirtyRow1;
    if (row0 === undefined || row1 === undefined) {
        updateTexture2DFromPixels(engine, texture, field.tex);
        return;
    }
    if (row1 < row0 || row0 < 0 || row1 >= field.res) return;
    const stride = field.res * 4;
    updateTexture2DFromPixels(engine, texture, field.tex.subarray(row0 * stride, (row1 + 1) * stride), 0, row0, field.res, row1 - row0 + 1);
}
function createLightTable(engine: EngineContext) {
    const data = new Uint8Array(8 * 2 * 4);
    const texture = createTexture2DFromPixels(engine, data, 8, 2, {addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", minFilter: "nearest", magFilter: "nearest"});
    return {
        texture,
        set(value: number): void {
            data[0] = value;
            updateTexture2DFromPixels(engine, texture, data);
        },
    };
}
interface Bounds {x: number; y: number; width: number; height: number;}
const states = new WeakMap<Texture2D, UploadState>();
function planRect(bounds: Bounds, out: Int32Array): Int32Array {
    out[0] = bounds.x;
    out[1] = bounds.y;
    out[2] = bounds.width;
    out[3] = bounds.height;
    return out;
}
function uploadRegion(engine: EngineContext, texture: Texture2D, source: Uint8Array, res: number, bounds?: Bounds): void {
    if (!bounds) {
        updateTexture2DFromPixels(engine, texture, source);
        return;
    }
    let state = states.get(texture);
    if (!state) {
        state = {rect: new Int32Array(4), scratch: new Uint8Array(0)};
        states.set(texture, state);
    }
    const rect = planRect(bounds, state.rect);
    const width = rect[2]!;
    const height = rect[3]!;
    if (width < 1 || height < 1) return;
    const byteLength = width * height * 4;
    if (state.scratch.length < byteLength) state.scratch = new Uint8Array(byteLength);
    let write = 0;
    for (let row = 0; row < height; row++)
        for (let read = ((rect[1]! + row) * res + rect[0]!) * 4, end = read + width * 4; read < end; read++)
            state.scratch[write++] = source[read]!;
    updateTexture2DFromPixels(engine, texture, state.scratch, rect[0]!, rect[1]!, width, height);
}
`;

const APPLICATION_DRIVER = `
const engine = await createEngine({});
const field: Field = {tex: new Uint8Array(4 * 4 * 4), res: 4};
const rows: Field = {tex: new Uint8Array(4 * 4 * 4), res: 4, dirtyRow0: 1, dirtyRow1: 2};
const textures: FieldTextures = {domain: createFieldTexture(engine, field)};
uploadDomain(engine, textures, field);
const rowTexture = createFieldTexture(engine, rows, "nearest");
uploadField(engine, rowTexture, rows);
uploadField(engine, rowTexture, field);
const lights = createLightTable(engine);
lights.set(7);
uploadRegion(engine, textures.domain, field.tex, 4, {x: 1, y: 2, width: 2, height: 1});
uploadRegion(engine, textures.domain, field.tex, 4);
if (states.get(textures.domain)?.scratch.length !== 8) throw new Error("scratch");
`;

test("updateTexture2DFromPixels lowers the application's write shapes in strict mode", () => {
    for (const deferredCapabilities of [undefined, "runtime-throw"] as const) {
        const compiled = compileSource(
            APPLICATION_SHAPES + APPLICATION_DRIVER,
            deferredCapabilities ? { deferredCapabilities } : {},
        );
        assert(compiled.manifest.features.includes("texture:pixels-writes"));
        assert.equal(compiled.manifest.deferredCapabilities?.length ?? 0, 0);
        assert.match(compiled.cpp, /bbl::update_texture_2d_from_pixels\(/);
    }
    assert.throws(
        () =>
            compileSource(`import {createEngine,createSolidTexture2D,updateTexture2DFromPixels} from "babylon-lite";
            const engine = await createEngine({});
            updateTexture2DFromPixels(engine, createSolidTexture2D(engine, 1, 0, 0, 1), new Uint8Array(4));`),
        (error: unknown) =>
            error instanceof CompileError &&
            /updateTexture2DFromPixels writes createTexture2DFromPixels textures/.test(
                error.message,
            ),
    );
    const pixels = new FactoryLowerer(
        new LoweringContext(),
    ).lowerPixelsTextureFactory().source;
    assert.doesNotMatch(pixels, /update_texture_2d_from_pixels/);
});

test("generated writes keep argument order, defaults and the pinned errors", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const compiled = compileSource(`${APPLICATION_SHAPES}
${APPLICATION_DRIVER}
const texture = createTexture2DFromPixels(engine, new Uint8Array(16 * 4), 4, 4);
const order: number[] = [];
function selected(): Texture2D {order.push(1); return texture;}
function bytes(): Uint8Array {order.push(2); return new Uint8Array(8);}
function origin(): number {order.push(3); return 1;}
updateTexture2DFromPixels(engine, selected(), bytes(), origin(), undefined, 2, 1);
if (order.join(",") !== "1,2,3") throw new Error("argument order");
const expectError = (code: string, write: () => void): void => {
    let caught = false;
    try {write();} catch (error) {if ((error as Error).message !== code) throw error; caught = true;}
    if (!caught) throw new Error("expected " + code);
};
expectError("#832", () => updateTexture2DFromPixels(engine, texture, new Uint8Array(64), 0, 0, 0, 1));
expectError("#833", () => updateTexture2DFromPixels(engine, texture, new Uint8Array(8), 0, 0, 2, 2));
expectError("#833", () => updateTexture2DFromPixels(engine, texture, new Uint8Array(60)));
expectError("GPU texture write exceeds its destination texture.", () => updateTexture2DFromPixels(engine, texture, new Uint8Array(8), 3, 0, 2, 1));
`);
    const factory = new FactoryLowerer(
        new LoweringContext(),
    ).lowerPixelsTextureFactory({ writes: true }).source;
    runGeneratedProgram(
        native,
        "texture-pixel-writes-program",
        `#include <bblite/pal_pixels_texture.hpp>
#include <optional>
#include <variant>
namespace bbl {
namespace {
${cppFunction(factory, "PixelsTexture create_texture_2d_from_bytes(")}
}
PixelsTexture create_texture_2d_from_pixels(Engine& engine, const js::U8Array& pixels, double width, double height, PixelsTextureOptions options) {
    return create_texture_2d_from_bytes(engine, pixels.to_vector(), width, height, options);
}
${lowerPixelsTextureWrites(new LoweringContext())}
Engine create_engine(EngineOptions options) {Engine engine; engine.options = options; return engine;}
}
${compiled.cpp}`,
        { flags: ["/Gy"], timeoutMs: 20000 },
    );
});

test("pixels writes share texels, upload written regions and recover the latest bytes", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const writes = lowerPixelsTextureWrites(new LoweringContext());
    const pixelsOnly = (source: string): string =>
        source.slice(0, source.indexOf("// Typed Texture2D storage"));
    const changed = pixelsOnly(
        lowerPixelsTextureWrites(
            doctoredContext(
                "src/texture/pixels-texture.ts",
                "export function updateTexture2DFromPixels(engine: EngineContext, tex: Texture2D, data: Uint8Array, x = 0, y = 0, width = tex.width, height = tex.height): void {\n    if (width < 1 || height < 1) {",
                "export function updateTexture2DFromPixels(engine: EngineContext, tex: Texture2D, data: Uint8Array, x = 0, y = 0, width = tex.width, height = tex.height): void {\n    if (width < 2 || height < 1) {",
            ),
        ),
    );
    assert.throws(
        () =>
            lowerPixelsTextureWrites(
                doctoredContext(
                    "src/texture/pixels-texture.ts",
                    "    engine._dlr?.w(tex, data, x, y, width, height);\n",
                    "",
                ),
            ),
        /no longer makes the write 'engine\._dlr\?\.w/,
    );
    runGeneratedProgram(
        native,
        "texture-pixel-writes-check",
        `#include <bblite/pal_pixels_texture.hpp>
#include "pal_texture_upload_cache.hpp"
#include <cassert>
#include <limits>
#include <optional>
#include <string>
#include <variant>
using namespace bbl;
namespace bbl {${writes}}
namespace changed {${changed}}
template <class F> void rejects(F function, const std::string& message) {
    bool caught = false;
    try { function(); } catch (const std::runtime_error& error) { caught = true; assert(error.what() == message); }
    assert(caught);
}
std::vector<std::uint8_t> ramp(std::size_t count, std::uint8_t first) {
    std::vector<std::uint8_t> bytes(count);
    for (std::size_t index = 0; index < count; ++index) bytes[index] = static_cast<std::uint8_t>(first + index);
    return bytes;
}
bool same(PixelsTexels::Region a, PixelsTexels::Region b) {
    return a.x == b.x && a.y == b.y && a.width == b.width && a.height == b.height;
}
struct Image { std::vector<std::uint8_t> texels; std::uint32_t width = 0; };
using Uploads = std::vector<PixelsTexels::Region>;
void sync(pal::TextureUploadCache<Image>& cache, Uploads& uploads) {
    // The region's rows arrive tightly packed.
    cache.upload_pixels_writes([&](Image& image, std::span<const std::uint8_t> texels, PixelsTexels::Region region) {
        uploads.push_back(region);
        const std::size_t row_bytes = static_cast<std::size_t>(region.width) * 4u;
        assert(texels.size() == row_bytes * region.height);
        for (std::uint32_t row = 0; row < region.height; ++row)
            for (std::size_t byte = 0; byte < row_bytes; ++byte)
                image.texels[(static_cast<std::size_t>(region.y + row) * image.width + region.x) * 4u + byte] =
                    texels[row * row_bytes + byte];
    });
}
std::shared_ptr<Image> bind(pal::TextureUploadCache<Image>& cache, const TextureData& binding) {
    return cache.acquire(binding, false, {255, 255, 255, 255}, [&] {
        return Image{std::vector<std::uint8_t>(binding.bytes.begin(), binding.bytes.end()), binding.rgba_width};
    });
}
int main() {
    Engine engine;
    PixelsTexture texture;
    texture.width = 4; texture.height = 3; texture.identity = 9;
    texture.rgba = std::vector<std::uint8_t>(48, 0);
    const PixelsTexture copy = texture;
    const TextureData binding = pixels_texture_data(copy);
    assert(binding.pixels == texture.rgba.state() && binding.pixels_version == texture.rgba.version());
    pal::TextureUploadCache<Image> cache;
    const auto image = bind(cache, binding);
    Uploads uploads;
    sync(cache, uploads);
    assert(uploads.empty());

    // A region: the pin's rows into the texels every copy shares, then the
    // binding's image takes exactly that region.
    update_texture_2d_from_pixels(engine, copy, js::U8Array(js::ArrayBuffer(ramp(8, 1))), 1.0, 1.0, 2.0, 1.0);
    assert(texture.rgba[20] == 1 && texture.rgba[27] == 8 && texture.rgba[19] == 0 && texture.rgba[28] == 0);
    // Written in place: the binding shares the texels rather than a snapshot.
    assert(binding.bytes[20] == 1 && binding.bytes.data() == texture.rgba.data());
    sync(cache, uploads);
    assert(uploads.size() == 1 && same(uploads[0], {1, 1, 2, 1}));
    assert(image->texels == std::vector<std::uint8_t>(texture.rgba.begin(), texture.rgba.end()));
    sync(cache, uploads);
    assert(uploads.size() == 1);

    // Defaults: an absent origin is 0 and an absent extent the texture's;
    // the source is read through a view's own offset.
    const js::ArrayBuffer whole(ramp(52, 100));
    update_texture_2d_from_pixels(engine, StoredTexture{texture}, js::U8Array(whole, 4, 48), std::nullopt, std::nullopt, std::nullopt, std::nullopt);
    assert(texture.rgba[0] == 104 && texture.rgba[47] == 151);
    update_texture_2d_from_pixels(engine, texture, js::U8Array(js::ArrayBuffer(ramp(16, 200))), std::nullopt, 2.0, std::nullopt, 1.0);
    assert(texture.rgba[32] == 200 && texture.rgba[31] == 135);
    update_texture_2d_from_pixels(engine, texture, js::U8Array(js::ArrayBuffer(ramp(4, 50))), 3.0, 0.0, 1.0, 1.0);
    sync(cache, uploads);
    assert(uploads.size() == 2 && same(uploads[1], {0, 0, 4, 3}));
    assert(image->texels == std::vector<std::uint8_t>(texture.rgba.begin(), texture.rgba.end()));

    // The pin's validation, then WebGPU's copy rules, and nothing written.
    const auto version = texture.rgba.version();
    rejects([&] { update_texture_2d_from_pixels(engine, texture, js::U8Array(64), 0.0, 0.0, 0.0, 1.0); }, "#832");
    rejects([&] { update_texture_2d_from_pixels(engine, texture, js::U8Array(64), 0.0, 0.0, 1.0, std::numeric_limits<double>::quiet_NaN()); }, "GPU extent is not a supported WebGPU size.");
    rejects([&] { update_texture_2d_from_pixels(engine, texture, js::U8Array(7), 0.0, 0.0, 2.0, 1.0); }, "#833");
    rejects([&] { update_texture_2d_from_pixels(engine, texture, js::U8Array(8), 3.0, 0.0, 2.0, 1.0); }, "GPU texture write exceeds its destination texture.");
    rejects([&] { update_texture_2d_from_pixels(engine, texture, js::U8Array(4), 0.0, 2.0, 1.0, 2.0); }, "#833");
    rejects([&] { update_texture_2d_from_pixels(engine, texture, js::U8Array(32), 0.0, 2.0, 1.0, 2.0); }, "GPU texture write exceeds its destination texture.");
    rejects([&] { update_texture_2d_from_pixels(engine, texture, js::U8Array(8), 0.5, 0.0, 2.0, 1.0); }, "GPU extent is not a supported WebGPU size.");
    rejects([&] { update_texture_2d_from_pixels(engine, texture, js::U8Array(8), -1.0, 0.0, 2.0, 1.0); }, "GPU extent is not a supported WebGPU size.");
    rejects([&] { update_texture_2d_from_pixels(engine, StoredTexture{FileTexture{}}, js::U8Array(48), std::nullopt, std::nullopt, std::nullopt, std::nullopt); },
        "updateTexture2DFromPixels writes createTexture2DFromPixels textures; loadTexture2D, solid and render textures are not represented.");
    assert(texture.rgba.version() == version);
    rejects([&] { changed::update_texture_2d_from_pixels(engine, texture, js::U8Array(64), 0.0, 0.0, 1.0, 1.0); }, "#832");

    // Device recovery: a rebuilt device uploads the binding's bytes, which
    // are the latest texels, then everything written since its version.
    pal::TextureUploadCache<Image> recovered;
    const auto rebuilt = bind(recovered, binding);
    assert(rebuilt->texels == image->texels);
    Uploads replayed;
    sync(recovered, replayed);
    assert(replayed.size() == 1 && same(replayed[0], {0, 0, 4, 3}));
    assert(rebuilt->texels == image->texels);

    // A later binding shares the live image; the log stays bounded and a
    // merged entry still covers every older write.
    assert(bind(cache, pixels_texture_data(texture)) == image);
    const auto before = texture.rgba.version();
    for (int write = 0; write < 20; ++write)
        update_texture_2d_from_pixels(engine, texture, js::U8Array(4), 1.0 + (write % 2), 2.0, 1.0, 1.0);
    const auto& state = *texture.rgba.state();
    assert(state.writes.size() == 16 && state.version == before + 20);
    assert(same(state.written_since(state.version - 1), {2, 2, 1, 1}));
    assert(same(state.written_since(state.writes[0].first), {1, 2, 2, 1}));
    assert(state.writes[0].second.whole() && state.written_since(before).whole());
    sync(cache, uploads);
    assert(uploads.size() == 3 && same(uploads[2], {0, 0, 4, 3}));

    // A whole-texture write and an atlas copy, which later writes refuse.
    PixelsTexture alias = copy;
    alias.rgba = ramp(48, 0);
    assert(texture.rgba[5] == 5);
    sync(cache, uploads);
    assert(uploads.size() == 4 && same(uploads[3], {0, 0, 4, 3}));
    assert(texture.rgba.snapshot()[7] == 7);
    rejects([&] { update_texture_2d_from_pixels(engine, copy, js::U8Array(4), 0.0, 0.0, 1.0, 1.0); },
        "Writes to a pixels texture whose texels a sprite atlas copied are not represented.");
}
`,
        { flags: ["/Gy", "/I", "native/src"], timeoutMs: 20000 },
    );
});
