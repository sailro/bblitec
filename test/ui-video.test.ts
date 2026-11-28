import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const directory = resolve("artifacts/ui-video");
const publicDir = join(directory, "public");

/** `body` after a worker that starts and ends, as an application realm compiles it. */
function compile(body: string) {
    mkdirSync(publicDir, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    // poster.png: 40x20, opaque green.
    const poster = new PNG({ width: 40, height: 20 });
    for (let index = 0; index < poster.data.length; index += 4)
        poster.data.set([0, 200, 0, 255], index);
    writeFileSync(join(publicDir, "poster.png"), PNG.sync.write(poster));
    return compileSource(
        `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        ${body}`,
        { fileName: join(directory, "entry.ts"), publicDir },
    );
}

test("a video element lowers its media members and packages its poster, not its source", () => {
    const result = compile(`
        const video = document.createElement("video");
        video.dataset.clip = "field";
        video.preload = "none";
        video.muted = true;
        video.setAttribute("muted", "");
        video.loop = true;
        video.controls = true;
        video.tabIndex = 0;
        video.width = 1196;
        video.height = 720;
        video.poster = "/poster.png";
        video.src = "/clip.mp4";
        video.addEventListener("error", () => { video.hidden = true; });
        document.body.appendChild(video);
        function stop(block: { video: HTMLVideoElement }): void {
            block.video.pause();
            block.video.removeAttribute("src");
            block.video.load();
        }
        stop({ video });
    `);
    const cpp = result.cpp;
    assert.match(cpp, /bbl::ui_create_element\([^;]+"video"\)/);
    assert.match(cpp, /bbl::ui_video_set_muted\([^;]+, true\)/);
    assert.match(
        cpp,
        /bbl::ui_set_dimension_attribute\([^;]+"width", 1196(?:\.0)?\)/,
    );
    assert.match(cpp, /bbl::ui_set_boolean_attribute\([^;]+"loop", true\)/);
    assert.match(
        cpp,
        /bbl::ui_set_attribute\([^;]+"poster", "\/poster\.png"\)/,
    );
    assert.match(cpp, /bbl::on_dom_pointer\([^;]+"error"/);
    assert.match(cpp, /bbl::ui_video_pause\(/);
    assert.match(cpp, /bbl::ui_video_load\(/);
    const manifest = JSON.stringify(result.manifest);
    assert.match(manifest, /poster\.png/);
    assert.doesNotMatch(manifest, /clip\.mp4/);
    // A media element that never loads a source has no position to seek.
    assert.throws(
        () =>
            compile(
                'const video = document.createElement("video"); video.currentTime = 2;',
            ),
        /HTMLVideoElement.currentTime writes are not lowered/,
    );
    // A program declaring a video producer generation bakes stores baked
    // videos as HTMLVideoElement: a retained video element beside it refuses.
    assert.throws(
        () =>
            compile(`
                function bakedVideo() {
                    const video = document.createElement("video");
                    video.muted = true;
                    return { video };
                }
                const shown = document.createElement("video");
                document.body.append(shown);
            `),
        /A retained <video> element cannot share a program with a video producer generation bakes/,
    );
});

test("native video renders its poster in its reserved box and rejects play with NotSupportedError", (t) => {
    const cpp = compile(`
        const log = document.createElement("div");
        log.id = "log";
        document.body.append(log);
        let order = "";
        function record(value: string): void { order += value; log.textContent = order; }
        const video = document.createElement("video");
        video.id = "clip";
        video.preload = "none";
        video.muted = true;
        video.loop = true;
        video.controls = true;
        video.width = 160;
        video.height = 90;
        video.poster = "/poster.png";
        video.src = "/clip.mp4";
        document.body.append(video);
        record(video.paused && !video.ended && video.currentTime === 0 && Number.isNaN(video.duration) ? "p" : "x");
        // muted is the element's state, which its content attribute does not reflect.
        record(video.muted && !video.hasAttribute("muted") && video.loop && video.controls && !video.autoplay ? "m" : "x");
        record(video.preload === "none" && video.width === 160 && video.height === 90 ? "w" : "x");
        record(video.src === "http://localhost/clip.mp4" && video.poster === "http://localhost/poster.png" ? "u" : "x");
        video.addEventListener("error", () => record("E"));
        // preload="none" fetches nothing until play() asks: its source fails as no decoder
        // supports it, firing error before the promise rejects.
        video.play().then(() => record("R"), (error: unknown) => {
            record(error instanceof DOMException && error.name === "NotSupportedError" ? "N" : "x");
            // Once the source failed, play() rejects at once and fires no second error.
            video.play().catch((again: unknown) => {
                record(again instanceof DOMException && again.name === "NotSupportedError" ? "n" : "x");
                video.pause();
                video.removeAttribute("src");
                video.load();
                record(video.src === "" && video.paused ? "l" : "x");
                globalThis.close();
            });
        });
        record("|");
    `).cpp;
    writeFileSync(join(directory, "program.hpp"), cpp);
    runRmlUiFixture(t, "ui-video", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
        },
        imageDecoder: true,
    });
});
