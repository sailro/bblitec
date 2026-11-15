import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { compileSource } from "../src/compiler.js";
import { contentKey } from "../src/content-key.js";
import { isZip, zipMember, zipMembers } from "../src/zip-archive.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

/** A zip of `members`, each stored or deflated. */
function zip(
    members: readonly { path: string; bytes: Uint8Array; deflate?: boolean }[],
): Uint8Array {
    const locals: Buffer[] = [];
    const directory: Buffer[] = [];
    let offset = 0;
    for (const { path, bytes, deflate } of members) {
        const name = Buffer.from(path, "utf8");
        const data = deflate ? deflateRawSync(bytes) : Buffer.from(bytes);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(deflate ? 8 : 0, 8);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(bytes.length, 22);
        local.writeUInt16LE(name.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(deflate ? 8 : 0, 10);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(bytes.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, name, data);
        directory.push(central, name);
        offset += local.length + name.length + data.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(members.length, 8);
    end.writeUInt16LE(members.length, 10);
    end.writeUInt32LE(
        directory.reduce((size, part) => size + part.length, 0),
        12,
    );
    end.writeUInt32LE(offset, 16);
    return new Uint8Array(Buffer.concat([...locals, ...directory, end]));
}

/** Bytes that begin as a KTX 2.0 file does, then `filler`. */
function ktx2(filler: string): Uint8Array {
    return new Uint8Array(
        Buffer.concat([
            Buffer.from([
                0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a,
                0x1a, 0x0a,
            ]),
            Buffer.from(filler),
        ]),
    );
}

test("a zip's members read back whether stored or deflated", () => {
    const text = new Uint8Array(Buffer.from("member text ".repeat(40)));
    const archive = zip([
        { path: "stored.bin", bytes: new Uint8Array([1, 2, 3]) },
        { path: "folder/deflated.txt", bytes: text, deflate: true },
    ]);
    assert.equal(isZip(archive), true);
    assert.equal(isZip(text), false);
    assert.deepEqual(
        zipMembers(archive, "test.zip").map((member) => member.path),
        ["stored.bin", "folder/deflated.txt"],
    );
    assert.deepEqual(
        [...zipMember(archive, "test.zip", "stored.bin")],
        [1, 2, 3],
    );
    assert.deepEqual(
        [...zipMember(archive, "test.zip", "folder/deflated.txt")],
        [...text],
    );
    assert.throws(
        () => zipMember(archive, "test.zip", "absent.bin"),
        /No member 'absent.bin' in test.zip/,
    );
});

test("the content key is the same text in TypeScript and natively", (t) => {
    const encode = (text: string): Uint8Array =>
        new Uint8Array(Buffer.from(text));
    // The published FNV-1a 64 vectors.
    assert.equal(contentKey(encode("")), "cbf29ce484222325-0");
    assert.equal(contentKey(encode("a")), "af63dc4c8601ec8c-1");
    assert.equal(contentKey(encode("foobar")), "85944171f73967e8-6");
    const long = new Uint8Array(100000);
    for (let index = 0; index < long.length; index++)
        long[index] = (index * 31 + 7) & 255;
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        native,
        "content-key",
        `
#include <bblite/runtime.hpp>
#include <cassert>
int main() {
    const auto bytes = [](std::string_view text) {
        return std::vector<std::uint8_t>(text.begin(), text.end());
    };
    assert(bbl::content_key(bytes("")) == "cbf29ce484222325-0");
    assert(bbl::content_key(bytes("a")) == "af63dc4c8601ec8c-1");
    assert(bbl::content_key(bytes("foobar")) == "85944171f73967e8-6");
    std::vector<std::uint8_t> pattern(100000);
    for (std::size_t index = 0; index < pattern.size(); ++index)
        pattern[index] = static_cast<std::uint8_t>((index * 31 + 7) & 255);
    assert(bbl::content_key(pattern) == "${contentKey(long)}");
    return 0;
}
`,
        { expectedOutput: "" },
    );
});

const loads = `
    import { createEngine, loadKtx2Texture2D, loadTexture2D, type EngineContext, type Texture2D } from "@babylonjs/lite";
    const REPEAT = { addressModeU: "repeat" as const, addressModeV: "repeat" as const, invertY: false, mipMaps: true };
    function loadMap(engine: EngineContext, name: string, bytes: Uint8Array, srgb: boolean): Promise<Texture2D> {
        const url = URL.createObjectURL(new Blob([bytes], { type: name.endsWith(".ktx2") ? "application/octet-stream" : "image/png" }));
        const loading = name.endsWith(".ktx2") ? loadKtx2Texture2D(engine, url, srgb) : loadTexture2D(engine, url, { srgb, ...REPEAT });
        return loading.finally(() => URL.revokeObjectURL(url));
    }
    const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    const packFile = await fetch("/pack.zip"), againFile = await fetch("/again.zip"), singleFile = await fetch("/single.ktx2");
    const pack = new Uint8Array(await packFile.arrayBuffer());
    const again = new Uint8Array(await againFile.arrayBuffer());
    const single = new Uint8Array(await singleFile.arrayBuffer());
`;

/** A deployment holding two archives and one file of KTX2 images. */
function contentDeployment(name: string): {
    directory: string;
    publicDir: string;
    albedo: Uint8Array;
    normal: Uint8Array;
    single: Uint8Array;
} {
    const directory = resolve("artifacts", name);
    const publicDir = join(directory, "public");
    mkdirSync(publicDir, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const albedo = ktx2("albedo"),
        normal = ktx2("normal ".repeat(60)),
        single = ktx2("single");
    writeFileSync(
        join(publicDir, "pack.zip"),
        zip([
            { path: "albedo.ktx2", bytes: albedo },
            { path: "maps/normal.ktx2", bytes: normal, deflate: true },
            { path: "icon.png", bytes: new Uint8Array([137, 80, 78, 71]) },
            { path: "material.json", bytes: new Uint8Array([123, 125]) },
        ]),
    );
    // The same image in a second archive.
    writeFileSync(
        join(publicDir, "again.zip"),
        zip([{ path: "copy.ktx2", bytes: albedo, deflate: true }]),
    );
    writeFileSync(join(publicDir, "single.ktx2"), single);
    return { directory, publicDir, albedo, normal, single };
}

test("a KTX2 load of an object URL packages each KTX2 image the program's packaged bytes hold, by content", () => {
    const { directory, publicDir, albedo, normal, single } =
        contentDeployment("content-images");
    const result = compileSource(
        `${loads}
    const textures = await Promise.all([
        loadMap(engine, "albedo.ktx2", pack.subarray(0, 18), true),
        loadMap(engine, "icon.png", again, false),
        loadMap(engine, "single.ktx2", single, false),
    ]);
    console.log(textures.length);
    `,
        { fileName: join(directory, "entry.ts"), publicDir },
    );
    const content = result.manifest.assets
        .filter((asset) => asset.kind === "ktx2")
        .map(({ source, archiveMember, output }) => ({
            source: source.replace(/^.*\//, ""),
            archiveMember,
            output,
        }));
    assert.deepEqual(content, [
        {
            source: "pack.zip",
            archiveMember: "albedo.ktx2",
            output: `content/${contentKey(albedo)}.ktx`,
        },
        {
            source: "pack.zip",
            archiveMember: "maps/normal.ktx2",
            output: `content/${contentKey(normal)}.ktx`,
        },
        {
            source: "single.ktx2",
            archiveMember: undefined,
            output: `content/${contentKey(single)}.ktx`,
        },
    ]);
    assert.deepEqual(
        result.manifest.assets
            .filter((asset) => asset.kind !== "ktx2")
            .map((asset) => asset.kind),
        ["binary", "binary", "binary"],
    );
    // The fetches make the program a realm, whose loads are promises: the
    // image is the URL's own bytes, the KTX2 chain is selected by them.
    assert.match(
        result.cpp,
        /bbl::pal::load_realm_ktx2_texture\([^,]+, bbl::js::object_url_ktx2_path\([^,]+, \w+\), true\)/,
    );
    assert.match(
        result.cpp,
        /bbl::pal::load_realm_file_texture\([^,]+, bbl::js::object_url_image\([^,]+, \w+\), bbl::TextureSamplerState\{[^}]*bbl::TextureAddressMode::repeat, bbl::TextureAddressMode::repeat[^}]*\}, false, /,
    );
});

test("a program that loads no KTX2 from an object URL packages no image by content", () => {
    const { directory, publicDir } = contentDeployment("content-images-none");
    const result = compileSource(
        `${loads}
    const texture = await loadMap(engine, "icon.png", again, false);
    console.log(texture.width + pack.length + single.length);
    `.replace(
            'name.endsWith(".ktx2") ? loadKtx2Texture2D(engine, url, srgb) : loadTexture2D',
            "loadTexture2D",
        ),
        { fileName: join(directory, "entry.ts"), publicDir },
    );
    assert.deepEqual(
        result.manifest.assets.map((asset) => asset.kind),
        ["binary", "binary", "binary"],
    );
});

test("object URL texture loads outside a realm read the URL's bytes at the call", () => {
    const result = compileSource(`
        import { createEngine, loadKtx2Texture2D, loadTexture2D } from "@babylonjs/lite";
        const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
        const url = URL.createObjectURL(new Blob([new Uint8Array([1, 2, 3])]));
        const compressed = await loadKtx2Texture2D(engine, url, true);
        const image = await loadTexture2D(engine, URL.createObjectURL(new Blob([new Uint8Array([4, 5])], { type: "image/png" })), { invertY: false });
        URL.revokeObjectURL(url);
        console.log(compressed.width + image.width);
    `);
    assert.match(
        result.cpp,
        /bbl::load_ktx2_texture\(v_engine, bbl::js::object_url_ktx2_path\(v_engine, v_url\), true\)/,
    );
    assert.match(
        result.cpp,
        /bbl::load_file_texture\(v_engine, bbl::js::object_url_image\(v_engine, bbl::js::create_object_url\(/,
    );
    // No packaged bytes: no image to select.
    assert.deepEqual(result.manifest.assets, []);
});
