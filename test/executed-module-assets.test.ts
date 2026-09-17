import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { drawSpriteAtlasPng } from "../src/executed-module-assets.js";
import { createSuiteSceneServer } from "../src/capture-suite-reference.js";
import { runPageGlobal, screenshotCaptureBrowserArgs } from "../src/browser-harness.js";
import { resolveBrowserPath } from "../src/browser-path.js";
import { parseDataUrl } from "../src/data-url.js";

let browserAvailable = false;
try { resolveBrowserPath(); browserAvailable = true; } catch {}

test("baked Canvas atlas pixels match the reference browser's rasterizer", { skip: !browserAvailable }, async () => {
    const modulePath = "corpus/babylon-lite/lab/lite/src/_shared/sprite-atlas-image.ts";
    const baked = PNG.sync.read(Buffer.from(await drawSpriteAtlasPng({
        modulePath: resolve(modulePath), exportName: "getSpriteAtlasDataUrl",
    })));
    const server = createSuiteSceneServer(`
window.__atlas = async () => {
    const module = await import(${JSON.stringify(`/${modulePath}`)});
    return module.getSpriteAtlasDataUrl();
};`);
    const value = await runPageGlobal(server, "__atlas", {
        serverName: "Canvas atlas reference",
        browserArgs: screenshotCaptureBrowserArgs,
    });
    assert.ok(typeof value === "string");
    const payload = parseDataUrl(value);
    assert.ok(payload && payload.mediaType === "image/png");
    const browser = PNG.sync.read(Buffer.from(payload.bytes));
    assert.equal(baked.width, browser.width);
    assert.equal(baked.height, browser.height);
    assert.deepEqual(baked.data, browser.data);
});
