import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { waitForSceneReady, withBrowserPage } from "../src/browser-harness.js";

/** A scene page whose canvases write `script` at timed steps. */
const scenePage = (script: string): ReturnType<typeof createServer> =>
    createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(
            `<!doctype html><title>Settles</title><canvas id="renderCanvas"></canvas><canvas id="other"></canvas><script>${script}</script>`,
        );
    });

const options = { serverName: "capture settle server" } as const;

test("the browser capture holds the data-ready gate and a settle on any canvas", async () => {
    const elapsed = await withBrowserPage(
        scenePage(`
            const other = document.getElementById("other");
            setTimeout(() => { other.dataset.ready = "true"; }, 50);
            setTimeout(() => { other.dataset.streamPhase = "idle"; }, 100);
        `),
        options,
        async (page, origin) => {
            const started = Date.now();
            await waitForSceneReady(page, origin, false, undefined, undefined, {
                key: "streamPhase",
                values: ["idle"],
                settleMilliseconds: 300,
            });
            return Date.now() - started;
        },
    );
    assert.ok(elapsed >= 400, `settled after ${elapsed} ms`);
});

test("a canvas's data-error fails the browser capture at once", async () => {
    await assert.rejects(
        withBrowserPage(
            scenePage(`
                setTimeout(() => {
                    document.getElementById("other").dataset.error = "stream failed";
                }, 50);
            `),
            options,
            async (page, origin) => {
                const started = Date.now();
                try {
                    await waitForSceneReady(page, origin, false);
                } finally {
                    assert.ok(Date.now() - started < 10_000);
                }
            },
        ),
        /A canvas reported data-error: stream failed/,
    );
});
