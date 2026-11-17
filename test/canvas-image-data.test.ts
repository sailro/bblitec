import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

/**
 * A retained canvas's `putImageData(new ImageData(rgba, width, height), dx,
 * dy)` over a Uint8ClampedArray, the array `ImageData` itself holds, and
 * over a Uint8Array.
 */

test("putImageData takes a Uint8ClampedArray's RGBA bytes, as it takes a Uint8Array's", (t) => {
    const result =
        compileSource(`import { createEngine, createBox } from "@babylonjs/lite";
        async function main(): Promise<void> {
            const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
            const canvas = document.createElement("canvas");
            canvas.width = 2;
            canvas.height = 1;
            const context = canvas.getContext("2d")!;
            const clamped = new Uint8ClampedArray(8);
            clamped[0] = 300;
            clamped[3] = 255;
            context.putImageData(new ImageData(clamped, 2, 1), 0, 0);
            document.body.appendChild(canvas);
            createBox(engine);
        }
        void main();
    `);
    assert.match(
        result.cpp,
        /bbl::ui_canvas_put_image_data\([^;]*v_\w*clamped[^;]*, 2\.0, 1\.0, 0\.0, 0\.0\)/,
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    // Both array kinds reach the one byte-span owner, viewing their bytes in place.
    runGeneratedProgram(
        tools,
        "test-canvas-image-data/forwarding",
        `#include <bblite/pal_ui.hpp>
#include <cassert>
#include <cstdio>
namespace bbl {
std::span<const std::uint8_t> received;
void ui_canvas_put_image_data(Engine&, UiElementHandle, std::span<const std::uint8_t> rgba,
                              double, double, double, double) {
    received = rgba;
}
} // namespace bbl
int main() {
    bbl::Engine engine;
    const bbl::js::U8CArray clamped{bbl::js::to_uint8_clamp(300), bbl::js::ClampedByte{7}};
    bbl::ui_canvas_put_image_data(engine, bbl::UiElementHandle{}, clamped, 1, 1, 0, 0);
    std::printf("%u %u %d ", bbl::received[0], bbl::received[1],
                static_cast<int>(bbl::received.data() ==
                                 reinterpret_cast<const std::uint8_t*>(clamped.data())));
    const bbl::js::U8Array bytes(bbl::js::ArrayBuffer(std::vector<std::uint8_t>{1, 2, 3}));
    bbl::ui_canvas_put_image_data(engine, bbl::UiElementHandle{}, bytes, 1, 1, 0, 0);
    std::printf("%zu", bbl::received.size());
}
`,
        { timeoutMs: 10000, expectedOutput: "255 7 1 3" },
    );
});
