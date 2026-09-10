import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { pageBase64Script } from "../src/browser-harness.js";

function functionSource(path: string, name: string): string {
    const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const declaration = file.statements.find(statement =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(declaration, name);
    return ts.transpileModule(declaration.getText(file), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
}

test("instrumented draw counts retain bundles and only the current submitted frame", () => {
    const script: string = runInNewContext(
        `${functionSource("src/capture-instrumented.ts", "initScript")}\ninitScript(0)`,
        { pageBase64Script },
    );
    runInNewContext(`
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
    `, { assert });
});

test("canvas capture hides sibling chrome and clears focus decoration without changing canvas content", async () => {
    await runInNewContext(`
        ${functionSource("src/browser-harness.ts", "hideNonCanvasChrome")}
        class HTMLElement { style = {}; }
        const canvas = new HTMLElement(), controls = new HTMLElement(), overlay = new HTMLElement();
        canvas.style.outline = "2px solid blue";
        canvas.style.width = "640px";
        canvas.pixels = [1, 2, 3];
        const document = {
            getElementById(id) { assert.equal(id, "renderCanvas"); return canvas; },
            body: { children: [controls, canvas, overlay] },
        };
        hideNonCanvasChrome({evaluate: async callback => callback()}).then(() => {
            assert.equal(canvas.style.outline, "none");
            assert.equal(canvas.style.visibility, undefined);
            assert.equal(canvas.style.width, "640px");
            assert.equal(canvas.pixels.join(","), "1,2,3");
            assert.equal(controls.style.visibility, "hidden");
            assert.equal(overlay.style.visibility, "hidden");
        });
    `, { assert, exports: {} });
});
