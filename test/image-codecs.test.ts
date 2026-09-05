import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CompileAsset } from "../src/compiler/types.js";
import { reachedImageCodecs } from "../src/image-codecs.js";
import { buildGlb } from "./glb-fixture.js";

test("image codecs follow packaged content independently of capture", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bblite-image-codecs-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "assets"));
    const asset = (output: string, kind: CompileAsset["kind"] = "texture"): CompileAsset => ({ source: output, output, kind });
    assert.deepEqual(reachedImageCodecs(root, []), []);
    assert.deepEqual(reachedImageCodecs(root, [asset("pixels.rgba16f", "pixels")]), []);
    assert.deepEqual(reachedImageCodecs(root, [asset("environment-data", "environment")]), ["png"]);
    assert.deepEqual(reachedImageCodecs(root, [asset("face.PNG"), asset("photo.jpg"), asset("photo.JPEG"), asset("icon.webp")]), ["png", "jpeg", "webp"]);
    writeFileSync(join(root, "assets", "opaque"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.deepEqual(reachedImageCodecs(root, [asset("opaque", "binary")]), ["png"]);
    writeFileSync(join(root, "assets", "opaque"), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    assert.deepEqual(reachedImageCodecs(root, [asset("opaque", "binary")]), ["jpeg"]);
    writeFileSync(join(root, "assets", "opaque"), Buffer.from("RIFF0000WEBP"));
    assert.deepEqual(reachedImageCodecs(root, [asset("opaque", "binary")]), ["webp"]);
});

test("container image references select codecs without scanning unrelated glTF text", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bblite-container-codecs-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "assets"));
    const document = { extras: { label: "unused.png" }, images: [{ mimeType: "image/jpeg" }, { uri: "data:image/webp;base64,AAAA" }] };
    writeFileSync(join(root, "assets", "model.gltf"), JSON.stringify(document));
    const asset: CompileAsset = { source: "model.gltf", output: "model.gltf", kind: "gltf" };
    assert.deepEqual(reachedImageCodecs(root, [asset]), ["jpeg", "webp"]);
    writeFileSync(join(root, "assets", "model.glb"), buildGlb(document));
    assert.deepEqual(reachedImageCodecs(root, [{ ...asset, output: "model.glb" }]), ["jpeg", "webp"]);
    writeFileSync(join(root, "assets", "model.babylon"), JSON.stringify({ textures: [{ name: "face.png?version=2" }, { data: "data:image/jpeg;base64,AAAA" }] }));
    assert.deepEqual(reachedImageCodecs(root, [{ ...asset, output: "model.babylon", kind: "babylon" }]), ["png", "jpeg"]);
});
