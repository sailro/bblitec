import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { compileSource } from "../src/compiler.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const WIDTH = 5;
const HEIGHT = 3;
/** Straight-alpha texels, partial alpha included; a transparent texel keeps black. */
const PIXELS = Array.from({ length: WIDTH * HEIGHT }, (_, index) => [
    (index * 37) % 256,
    (index * 91 + 13) % 256,
    (index * 53 + 200) % 256,
    index === 4 ? 0 : (index * 29 + 40) % 256,
]).map((texel) => (texel[3] === 0 ? [0, 0, 0, 0] : texel));

test("createImageBitmap decodes WebP exactly on native workers and settles realm promises", async (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/image-bitmaps");
    mkdirSync(directory, { recursive: true });
    const png = new PNG({ width: WIDTH, height: HEIGHT });
    png.data = Buffer.from(PIXELS.flat());
    writeFileSync(join(directory, "sample.png"), PNG.sync.write(png));
    const webpPath = join(directory, "sample.webp").replaceAll("\\", "/");
    const pngPath = join(directory, "sample.png").replaceAll("\\", "/");
    const check = join(directory, "decode-check.cpp");
    writeFileSync(
        check,
        `
#include <bblite/pal_image_bitmap.hpp>
#include <webp/encode.h>
#include <cassert>
#include <fstream>
#include <iterator>
using namespace bbl;
static std::vector<std::uint8_t> encode_lossless(const std::vector<std::uint8_t>& rgba) {
    WebPConfig config;
    assert(WebPConfigInit(&config));
    config.lossless = 1;
    config.exact = 1;
    WebPPicture picture;
    assert(WebPPictureInit(&picture));
    picture.use_argb = 1;
    picture.width = ${WIDTH};
    picture.height = ${HEIGHT};
    assert(WebPPictureImportRGBA(&picture, rgba.data(), ${WIDTH} * 4));
    WebPMemoryWriter writer;
    WebPMemoryWriterInit(&writer);
    picture.writer = WebPMemoryWrite;
    picture.custom_ptr = &writer;
    assert(WebPEncode(&config, &picture));
    std::vector<std::uint8_t> bytes(writer.mem, writer.mem + writer.size);
    WebPMemoryWriterClear(&writer);
    WebPPictureFree(&picture);
    return bytes;
}
int main() {
    const std::vector<std::uint8_t> expected{${PIXELS.flat().join(",")}};
    const auto webp = encode_lossless(expected);
    std::ofstream("${webpPath}", std::ios::binary).write(reinterpret_cast<const char*>(webp.data()), static_cast<std::streamsize>(webp.size()));
    std::ifstream png_file("${pngPath}", std::ios::binary);
    const std::vector<std::uint8_t> png((std::istreambuf_iterator<char>(png_file)), std::istreambuf_iterator<char>());
    const js::RealmScope scope;
    pal::EventLoop loop;
    int settled = 0;
    const auto done = [&] {
        if (++settled == 11)
            loop.close();
    };
    loop.run([&] {
        // Two chunks, as a streamed body builds them.
        js::Array<js::U8Array> chunks;
        chunks.push_back(js::U8Array(js::ArrayBuffer(std::vector<std::uint8_t>(webp.begin(), webp.begin() + 7))));
        chunks.push_back(js::U8Array(js::ArrayBuffer(std::vector<std::uint8_t>(webp.begin() + 7, webp.end()))));
        const auto blob = js::Blob::from_parts(chunks, "IMAGE/WebP");
        assert(blob.type() == "image/webp" && blob.size() == webp.size());
        assert(js::Blob::from_parts(chunks, "image/\\x01").type().empty());
        for (int copy = 0; copy < 8; ++copy) {
            pal::create_image_bitmap(blob, {false}).then([&](const pal::ImageBitmap& bitmap) {
                assert(bitmap.width() == ${WIDTH} && bitmap.height() == ${HEIGHT} && !bitmap.premultiplied());
                assert(*bitmap.pixels() == expected);
                bitmap.close();
                assert(bitmap.width() == 0 && bitmap.height() == 0 && bitmap.closed());
                bool closed = false;
                try { static_cast<void>(bitmap.pixels()); } catch (const js::NamedError& error) { closed = error.name == "InvalidStateError"; }
                assert(closed);
                done();
            });
        }
        pal::create_image_bitmap(blob, {true}).then([&](const pal::ImageBitmap& bitmap) {
            auto premultiplied = expected;
            for (std::size_t index = 0; index < premultiplied.size(); index += 4)
                for (std::size_t channel = 0; channel < 3; ++channel)
                    premultiplied[index + channel] = static_cast<std::uint8_t>(
                        (expected[index + channel] * expected[index + 3] + 127u) / 255u);
            assert(bitmap.premultiplied() && *bitmap.pixels() == premultiplied);
            done();
        });
        js::Array<js::U8Array> png_parts;
        png_parts.push_back(js::U8Array(js::ArrayBuffer(png)));
        pal::create_image_bitmap(js::Blob::from_parts(png_parts, "image/png"), {false}).then([&](const pal::ImageBitmap& bitmap) {
            assert(*bitmap.pixels() == expected);
            done();
        });
        js::Array<js::U8Array> broken;
        broken.push_back(js::U8Array(js::ArrayBuffer(std::vector<std::uint8_t>(webp.begin(), webp.begin() + 20))));
        pal::create_image_bitmap(js::Blob::from_parts(broken, ""), {false}).then(
            [](const pal::ImageBitmap&) { assert(false); },
            [&](std::exception_ptr error) {
                assert(js::error_is(error, "DOMException") && js::error_name(error) == "InvalidStateError");
                done();
            });
    });
    assert(settled == 11);
    return 0;
}
`,
    );
    const executable = join(directory, "decode-check.exe");
    const libraries = [
        join(nativeFixtureVcpkgRoot, "lib/libwebp.lib"),
        join(nativeFixtureVcpkgRoot, "lib/SDL3.lib"),
        join(nativeFixtureVcpkgRoot, "lib/SDL3_image.lib"),
    ];
    const environment = {
        ...process.env,
        PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${process.env.PATH ?? ""}`,
    };
    runNativeFixtureCompiler(tools, [
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_HAS_IMAGE_DECODER=1",
        "/DBBLITE_HAS_WEBP_DECODER=1",
        check,
        "native/src/pal_image.cpp",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        ...libraries,
    ]);
    execFileSync(executable, {
        stdio: "pipe",
        env: environment,
        timeout: 30000,
    });

    // The library's flow: a streamed body into a Blob of its chunks, then a decode.
    const webp = readFileSync(join(directory, "sample.webp"));
    const server = createServer((request, response) => {
        if (request.url === "/sample.webp") {
            response.writeHead(200, { "content-type": "image/webp" });
            response.write(webp.subarray(0, 9));
            setTimeout(() => response.end(webp.subarray(9)), 10);
            return;
        }
        response.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
        });
        response.end("﻿héllo");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const source = `
        async function blobOf(url: string): Promise<Blob> {
            const response = await fetch(url, {});
            const reader = response.body!.getReader();
            const chunks: Uint8Array[] = [];
            for (;;) {
                const part = await reader.read();
                if (part.done) break;
                chunks.push(new Uint8Array(part.value));
            }
            reader.releaseLock();
            return new Blob(chunks, { type: response.headers.get("content-type") ?? "" });
        }
        async function run(): Promise<void> {
            const image = await blobOf("${base}/sample.webp");
            if (image.type !== "image/webp" || image.size !== ${webp.length}) throw new Error("blob " + image.type);
            const bitmap = await createImageBitmap(image, { premultiplyAlpha: "none", colorSpaceConversion: "none", imageOrientation: "none" });
            if (bitmap.width !== ${WIDTH} || bitmap.height !== ${HEIGHT}) throw new Error("bitmap size");
            bitmap.close();
            if (bitmap.width !== 0) throw new Error("closed bitmap");
            const bytes = await image.bytes();
            const buffer = await image.arrayBuffer();
            if (bytes.byteLength !== ${webp.length} || buffer.byteLength !== ${webp.length} || bytes[0] !== 0x52) throw new Error("blob bytes");
            const text = await blobOf("${base}/text");
            if (await text.text() !== "h\\u00e9llo" || text.type !== "text/plain; charset=utf-8") throw new Error("blob text");
            let rejected = false;
            try { await createImageBitmap(text, { premultiplyAlpha: "premultiply", colorSpaceConversion: "none" }); }
            catch (error) { rejected = error instanceof DOMException && error.name === "InvalidStateError"; }
            if (!rejected) throw new Error("undecodable blob");
            globalThis.close();
        }
        run();
    `;
    const entry = resolve(directory, "entry.ts");
    writeFileSync(entry, source);
    const compiled = compileSource(source, { fileName: entry });
    assert.ok(compiled.manifest.features.includes("image:runtime-decode"));
    const cpp = resolve(directory, "main.cpp"),
        application = resolve(directory, "check.exe");
    writeFileSync(cpp, compiled.cpp);
    runNativeFixtureCompiler(tools, [
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_HAS_BROWSER_FILE=1",
        "/DBBLITE_HAS_IMAGE_DECODER=1",
        "/DBBLITE_HAS_WEBP_DECODER=1",
        cpp,
        "native/src/pal_http.cpp",
        "native/src/pal_image.cpp",
        `/Fo${directory}/`,
        `/Fe${application}`,
        ...libraries,
        "/link",
        "winhttp.lib",
    ]);
    const output = await promisify(execFile)(application, [], {
        timeout: 30000,
        env: environment,
    });
    assert.equal(output.stdout + output.stderr, "");
});

test("image decode and Blob forms without a native representation refuse", () => {
    const realm = (body: string): string =>
        `async function run(): Promise<void> { const chunks: Uint8Array[] = []; chunks.push(new Uint8Array(4)); const blob = new Blob(chunks, { type: "image/webp" }); ${body} } run();`;
    for (const [body, message] of [
        [
            `await createImageBitmap(blob, { premultiplyAlpha: "default", colorSpaceConversion: "none" });`,
            /createImageBitmap premultiplyAlpha lowers "none" or "premultiply"/,
        ],
        [
            `await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "default" });`,
            /createImageBitmap colorSpaceConversion lowers "none"/,
        ],
        [
            `await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none", resizeWidth: 4 });`,
            /createImageBitmap option 'resizeWidth' is not lowered/,
        ],
        [
            `await createImageBitmap(blob, { premultiplyAlpha: "none" });`,
            /requires an explicit colorSpaceConversion/,
        ],
    ] as const)
        assert.throws(() => compileSource(realm(body)), message);
});
