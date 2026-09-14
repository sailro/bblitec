import assert from "node:assert/strict";
import test from "node:test";
import {compileSource} from "../src/compiler.js";

test("canvas rectangle reads use CSS extents while sprite coordinates use backing pixels", () => {
    const result = compileSource(`
        import {createEngine} from "@babylonjs/lite";
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const output = document.createElement("div");
            document.body.appendChild(output);
            canvas.addEventListener("pointermove", event => {
                const rect = canvas.getBoundingClientRect();
                output.textContent = String((event.clientX - rect.left) * canvas.width / rect.width) + "," +
                    String((event.clientY - rect.top) * canvas.height / rect.height);
            });
        }
        void main();
    `);
    assert.match(result.cpp, /canvas_client_width/);
    assert.match(result.cpp, /canvas_client_height/);
    assert.match(result.cpp, /options\.width/);
    assert.match(result.cpp, /options\.height/);
});
