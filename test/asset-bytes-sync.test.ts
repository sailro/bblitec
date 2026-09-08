import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAssetBytesSync } from "../src/compiler/asset-bytes-sync.js";

test("synchronous local assets follow their entry directory and same-process edits", t => {
    const directory = mkdtempSync(join(tmpdir(), "bblite-asset-bytes-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const [name, value] of [["first", 1], ["second", 2]] as const) {
        mkdirSync(join(directory, name));
        writeFileSync(join(directory, name, "asset.bin"), new Uint8Array([value]));
    }
    const first = join(directory, "first", "scene.ts");
    assert.deepEqual([...readAssetBytesSync("asset.bin", first)], [1]);
    assert.deepEqual([...readAssetBytesSync("asset.bin", join(directory, "second", "scene.ts"))], [2]);
    writeFileSync(join(directory, "first", "asset.bin"), new Uint8Array([3, 4]));
    assert.deepEqual([...readAssetBytesSync("asset.bin", first)], [3, 4]);
});
