import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { waitForSceneReady, withBrowserPage } from "../src/browser-harness.js";
import { fixedAnimationFrameScript } from "../src/capture-suite-reference.js";

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

test("fixed captures preserve CSS effect start times, delays and the frozen phase", async () => {
    await withBrowserPage(
        scenePage(`
            ${fixedAnimationFrameScript(18)}
            const sheet = document.createElement("style");
            sheet.textContent = "@keyframes slide{from{transform:translateX(0px)}to{transform:translateX(100px)}}" +
                "#initial{animation:slide 1s linear infinite}#negative{animation:slide 1s linear -100ms infinite}" +
                "#positive{animation:slide 1s linear 200ms infinite}.late{animation:slide 1s linear infinite}" +
                "#fade{opacity:1;transition:opacity 1s linear}";
            document.head.appendChild(sheet);
            for (const id of ["initial", "negative", "positive", "late", "fade"]) {
                const element = document.createElement("div");
                element.id = id;
                document.body.appendChild(element);
            }
            document.getElementById("renderCanvas").dataset.ready = "true";
            document.documentElement.dataset.fixedEngineStarting = "true";
            let armed = false;
            function turn() {
                if (!armed) {
                    armed = true;
                    setTimeout(() => {
                        document.getElementById("late").className = "late";
                        document.getElementById("fade").style.opacity = "0";
                    }, 100);
                }
                requestAnimationFrame(turn);
            }
            requestAnimationFrame(turn);
        `),
        options,
        async (page, origin) => {
            await waitForSceneReady(page, origin, false, undefined, 18);
            const sample = () =>
                page.evaluate(() => {
                    const style = (id: string) => {
                        const element = document.getElementById(id);
                        if (!element)
                            throw new Error(`Missing CSS clock element ${id}`);
                        return getComputedStyle(element);
                    };
                    return {
                        now: performance.now(),
                        opacity: Number(style("fade").opacity),
                        translations: Object.fromEntries(
                            ["initial", "negative", "positive", "late"].map(
                                (id) => [
                                    id,
                                    new DOMMatrixReadOnly(style(id).transform)
                                        .m41,
                                ],
                            ),
                        ),
                        states: document
                            .getAnimations()
                            .map((animation) => animation.playState),
                    };
                });
            const captured = await sample();
            assert.equal(captured.now, 300);
            assert.ok(Math.abs(captured.opacity - 0.8) < 0.0001);
            for (const [id, expected] of Object.entries({
                initial: 30,
                negative: 40,
                positive: 10,
                late: 20,
            })) {
                const actual = captured.translations[id];
                assert.ok(
                    actual !== undefined && Math.abs(actual - expected) < 0.001,
                    id,
                );
            }
            assert.ok(captured.states.every((state) => state === "paused"));
            await page.waitForTimeout(250);
            assert.deepEqual(await sample(), captured);
        },
    );
});
