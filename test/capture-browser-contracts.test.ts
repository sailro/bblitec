import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import {
    canvasBakeBrowserArgs,
    pageBase64Script,
    screenshotCaptureBrowserArgs,
} from "../src/browser-harness.js";

test("Canvas2D bakes share Linux capture flags without changing Windows or macOS", () => {
    assert.deepEqual(
        canvasBakeBrowserArgs,
        process.platform === "linux" ? screenshotCaptureBrowserArgs : [],
    );
});

function functionSource(path: string, name: string): string {
    const file = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
    );
    const declaration = file.statements.find(
        (statement) =>
            ts.isFunctionDeclaration(statement) &&
            statement.name?.text === name,
    );
    assert.ok(declaration, name);
    return ts.transpileModule(declaration.getText(file), {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.CommonJS,
        },
    }).outputText;
}

test("browser sharing follows the resolved platform and headed mode without changing isolation or cleanup", async () => {
    const source = functionSource("src/browser-harness.ts", "withBrowserPage");
    for (const platform of ["linux", "win32", "darwin"]) {
        for (const headless of [undefined, false, true]) {
            for (const shared of [undefined, false, true]) {
                for (const fail of [false, true]) {
                    await runInNewContext(
                        `
                        (async () => {
                            ${source}
                            const calls = [];
                            let recordedLaunch;
                            const browserArgs = ["--force-color-profile=srgb", "--enable-unsafe-webgpu"];
                            const page = {};
                            const browser = {
                                async newContext(options) {
                                    calls.push("context");
                                    assert.deepEqual(options, {
                                        viewport: { width: 640, height: 480 },
                                        deviceScaleFactor: 2,
                                    });
                                    return { async newPage() { calls.push("page"); return page; } };
                                },
                                async close() { calls.push("browser-close"); },
                            };
                            const chromium = {
                                async launch(launch) {
                                    calls.push("launch");
                                    recordedLaunch = launch;
                                    return browser;
                                },
                                async connect(endpoint, options) {
                                    calls.push("connect");
                                    assert.equal(endpoint, "ws://generation");
                                    assert.equal(options.timeout, 60000);
                                    return browser;
                                },
                            };
                            const generationBrowserEndpoint = async (launch) => {
                                calls.push("endpoint");
                                recordedLaunch = launch;
                                return "ws://generation";
                            };
                            const launchOptions = (launch) => launch;
                            const resolveBrowserPath = () => "/browser";
                            const server = {
                                listen(port, host, done) {
                                    assert.equal(port, 0);
                                    assert.equal(host, "127.0.0.1");
                                    done();
                                },
                                address() { return { port: 1234 }; },
                                close(done) { calls.push("server-close"); done(); },
                            };
                            const run = withBrowserPage(server, {
                                serverName: "routing contract",
                                shared, headless, browserArgs, showScrollbars: true,
                                viewport: { width: 640, height: 480 }, deviceScaleFactor: 2,
                            }, async (actualPage, origin) => {
                                calls.push("body");
                                assert.equal(actualPage, page);
                                assert.equal(origin, "http://127.0.0.1:1234");
                                if (fail) throw new Error("bake failure");
                                return "baked";
                            });
                            if (fail) await assert.rejects(run, /bake failure/);
                            else assert.equal(await run, "baked");
                            const resolvedHeadless = headless ?? process.platform !== "linux";
                            const connected = shared === true &&
                                (process.platform !== "linux" || resolvedHeadless);
                            assert.deepEqual(calls, [
                                ...(connected ? ["endpoint", "connect"] : ["launch"]),
                                "context", "page", "body", "browser-close", "server-close",
                            ]);
                            assert.deepEqual(recordedLaunch, {
                                executablePath: "/browser", headless: resolvedHeadless,
                                args: browserArgs, ignoreDefaultArgs: ["--hide-scrollbars"],
                            });
                        })()
                        `,
                        {
                            assert,
                            exports: {},
                            process: { platform },
                            headless,
                            shared,
                            fail,
                        },
                    );
                }
            }
        }
    }
});

test("instrumented draw counts retain bundles and only the current submitted frame", () => {
    const script: unknown = runInNewContext(
        `${functionSource("src/capture-instrumented.ts", "initScript")}\ninitScript(0)`,
        { pageBase64Script },
    );
    assert.ok(typeof script === "string");
    runInNewContext(
        `
        const callbacks = [];
        const window = { requestAnimationFrame(callback) { callbacks.push(callback); } };
        class GPUDevice {
            createShaderModule() { return {}; }
            createTexture() { return {}; }
            createBuffer() { return {}; }
        }
        class GPUQueue {
            writeBuffer() {} writeTexture() {} copyExternalImageToTexture() {}
            submit() { this.submissions = (this.submissions || 0) + 1; }
        }
        class GPURenderPassEncoder {
            drawIndexed() {} draw() {} drawIndexedIndirect() {}
        }
        class GPURenderBundleEncoder {
            drawIndexed() {} draw() {} drawIndexedIndirect() {}
        }
        ${script}
        const device = new GPUDevice(), queue = new GPUQueue();
        const bundle = new GPURenderBundleEncoder(), pass = new GPURenderPassEncoder();
        const buffer = device.createBuffer({size: 32, usage: 1});
        bundle.drawIndexed(6, 2);
        bundle.drawIndexed(6, 2);
        function frame(draw) {
            window.requestAnimationFrame(draw);
            callbacks.shift()(100);
        }
        frame(() => { pass.draw(3); queue.submit([]); });
        assert.equal(window.__draws["bundle.drawIndexed(6,2,0,0)"], 2);
        assert.equal(window.__draws["pass.draw(3,1,0)"], 1);
        frame(() => {
            pass.draw(4, 5); pass.draw(4, 5);
            pass.drawIndexedIndirect(buffer, 8);
            queue.submit([]);
        });
        assert.equal(window.__draws["pass.draw(3,1,0)"], undefined);
        assert.equal(window.__draws["pass.draw(4,5,0)"], 2);
        assert.equal(window.__draws["pass.drawIndexedIndirect(buffer#1,8)"], 1);
        assert.equal(window.__draws["bundle.drawIndexed(6,2,0,0)"], 2);
        frame(() => { queue.submit([]); });
        assert.equal(Object.keys(window.__draws).length, 1);
        pass.drawIndexed(9); queue.submit([]);
        assert.equal(window.__draws["pass.drawIndexed(9,1,0,0)"], 1);
        pass.draw(7); queue.submit([]);
        assert.equal(window.__draws["pass.drawIndexed(9,1,0,0)"], undefined);
        assert.equal(window.__draws["pass.draw(7,1,0)"], 1);
        const failure = new Error("frame failed");
        assert.throws(() => frame(() => { pass.draw(8); throw failure; }), error => error === failure);
        assert.equal(window.__draws["pass.draw(7,1,0)"], undefined);
        assert.equal(window.__draws["pass.draw(8,1,0)"], 1);
        assert.equal(queue.submissions, 5);
    `,
        { assert },
    );
});
