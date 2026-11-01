import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { readAssetBytesSync } from "../src/compiler/asset-bytes-sync.js";
import { resolveBundledAsset } from "../src/compiler/assets.js";
import {
    pinnedLabPublicAsset,
    pinnedLabPublicFile,
    servedFile,
} from "../src/pinned-lab-materializers.js";
import {
    LAB_PUBLIC_ROOT,
    pinnedLabPublicUrl,
} from "../src/pinned-lab-public.js";

const entry = resolve("corpus/babylon-lite/lab/lite/src/demos/playroom.ts");
const publicDirectory = resolve(LAB_PUBLIC_ROOT);

test("pinned public directories precede same-named source directories without becoming served files", () => {
    const options = { publicUrl: pinnedLabPublicUrl() };
    for (const path of ["/playroom/", "/playroom/sounds/"]) {
        assert.equal(
            resolveBundledAsset(path, entry, options),
            resolve(publicDirectory, `.${path}`),
        );
        assert.equal(servedFile(publicDirectory, path), undefined);
        assert.equal(pinnedLabPublicFile(resolve("."), path), undefined);
    }
    const sound = "/playroom/sounds/projectile-launch.mp3";
    assert.equal(
        resolveBundledAsset(sound, entry, options),
        servedFile(publicDirectory, sound),
    );
    assert.equal(servedFile(publicDirectory, "/"), undefined);
    assert.equal(
        servedFile(publicDirectory, "/../lite/demo-playroom.html"),
        undefined,
    );
    for (const path of [
        "/",
        "/../lite/src/demos/playroom",
        "/playroom/missing.mp3",
    ])
        assert.equal(pinnedLabPublicAsset(resolve("."), path), undefined);
});

for (const publicDir of [undefined, publicDirectory]) {
    test(`pinned audio startup packages readable sounds with ${publicDir ? "publicDir" : "publicUrl"}`, () => {
        // Compile only the pin's audio startup, retaining its callback-produced
        // URLs and async decode path, not the scene or its native renderer.
        const result = compileSource(
            `
            import { startPlayroomAudioLoad } from "./playroom/audio.js";
            import { demoAssetUrl } from "./demo-asset-url.js";
            function asset(relative: string): string {
                return demoAssetUrl(\`./playroom/\${relative}\`, import.meta.url);
            }
            async function main(): Promise<void> {
                const load = startPlayroomAudioLoad(file => asset(\`sounds/\${file}\`));
                await load.ready;
                if (load.state.status !== "ready") throw new Error("audio not ready");
                globalThis.close();
            }
            void main();
            `,
            {
                fileName: entry,
                publicUrl: pinnedLabPublicUrl(),
                ...(publicDir ? { publicDir } : {}),
            },
        );
        const soundDirectory = resolve(publicDirectory, "playroom/sounds");
        const expected = readdirSync(soundDirectory)
            .filter((file) => file.endsWith(".mp3"))
            .sort();
        assert.equal(expected.length, 28);
        const sounds = result.manifest.assets.filter((asset) =>
            asset.source.endsWith(".mp3"),
        );
        assert.deepEqual(
            sounds.map((asset) => resolve(dirname(entry), asset.source)).sort(),
            expected.map((file) => resolve(soundDirectory, file)).sort(),
        );
        for (const asset of result.manifest.assets) {
            assert(!asset.source.endsWith(".ts"), asset.source);
            assert(
                readAssetBytesSync(asset.source, entry).byteLength > 0,
                asset.source,
            );
        }
        const keys = [
            ...result.cpp.matchAll(/PackagedFetchEntry\{"([^"]+)"/g),
        ].map((match) => match[1]!);
        assert.deepEqual(
            keys.filter((key) => key.endsWith(".mp3")).sort(),
            expected.map((file) => `/playroom/sounds/${file}`).sort(),
        );
        assert(!keys.some((key) => key.endsWith(".ts")));
        // Keep the closed lookup's explicit refusal for an unlisted URL.
        assert.match(result.cpp, /co_await bbl::pal::fetch_packaged\(/);
    });
}
