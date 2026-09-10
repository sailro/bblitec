import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const source = `
    import { createEngine } from "@babylonjs/lite";
    async function main() {
        const engine = await createEngine({});
        let polls = 0;
        function score(pad: Gamepad | null): number {
            if (!pad) return 0;
            if (pad.index < 0) throw new Error("shared gamepad score");
            return pad.index + (pad.axes[0] ?? 0) + (pad.buttons[0]?.pressed ? 10 : 0);
        }
        function poll(): number {
            polls++;
            const pads = navigator.getGamepads?.() ?? [];
            let total = 0;
            for (let index = 0; index < pads.length; index++) total += score(pads[index] ?? null);
            return total;
        }
        class Reader {
            button(pad: Gamepad): boolean {
                if (pad.index < 0) throw new Error("shared gamepad method");
                return !!pad.buttons[0]?.pressed;
            }
        }
        const first = poll(), second = poll();
        if (first !== 11.25 || second !== 1.5 || polls !== 2) throw new Error("poll values and capture");
        const reader = new Reader();
        const pads = navigator.getGamepads();
        const firstButton = reader.button(pads[1]!), secondButton = reader.button(pads[1]!);
        if (!firstButton || !secondButton) throw new Error("method values");
        if (score(null) !== 0) throw new Error("missing gamepad");
    }
`;

test("native platform reads share function and method bodies", () => {
    const result = compileSource(source);
    assert.equal(result.cpp.split("shared gamepad score").length - 1, 1);
    assert.equal(result.cpp.split("shared gamepad method").length - 1, 1);
    assert.equal(result.cpp.match(/bbl::platform_gamepads\(/g)?.length, 2);
});

const tools = optionalNativeFixtureTools(false);
test("shared gamepad reads preserve live state, nullable arguments and closure updates", { skip: !tools }, () => {
    const output = resolve("artifacts/shared-platform-handles-check");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "program.hpp"), compileSource(source).cpp);
    const file = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(file, `
        #define main generated_main
        #include "program.hpp"
        #undef main
        #include <cassert>
        namespace { unsigned int samples = 0; }
        namespace bbl {
            Engine create_engine(EngineOptions) { return {}; }
            js::Array<js::Nullable<GamepadHandle>> platform_gamepads(Engine&) {
                ++samples;
                return {std::nullopt, GamepadHandle{7, 1}};
            }
            double gamepad_index(Engine&, GamepadHandle pad) { assert(pad.instance_id == 7); return pad.index; }
            js::Array<double> gamepad_axes(Engine&, GamepadHandle pad) {
                assert(pad.instance_id == 7);
                return {samples * 0.25};
            }
            js::Array<GamepadButtonHandle> gamepad_buttons(Engine&, GamepadHandle pad) {
                assert(pad.instance_id == 7);
                return {GamepadButtonHandle{pad, 0}};
            }
            bool gamepad_button_pressed(Engine&, GamepadButtonHandle button) {
                assert(button.gamepad.instance_id == 7 && button.index == 0);
                return samples % 2 != 0;
            }
        }
        int main() { assert(generated_main() == 0); assert(samples == 3); }
    `);
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", output, "/I", "native\\include", file]);
    execFileSync(executable, { encoding: "utf8" });
});
