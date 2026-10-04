import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const source = `
    import { createEngine } from "@babylonjs/lite";
    async function main() {
        const engine = await createEngine({});
        const pads = navigator.getGamepads();
        const pad = pads[0]!;
        if (pad.buttons[14]?.pressed || pad.buttons[15]?.pressed || pad.buttons[7]?.pressed)
            throw new Error("short controller buttons");
        if (!pad.buttons[0]?.pressed || pad.buttons[1]?.pressed)
            throw new Error("present controller buttons");
        let indices = 0;
        function nextIndex(): number { indices++; return pad.index; }
        if (!pad.buttons[nextIndex()]?.pressed) throw new Error("computed index");
        const empty = pads[2]!;
        if (empty.buttons[0]?.pressed) throw new Error("empty controller buttons");
        const absent = pads[1];
        if (absent?.buttons[nextIndex()]?.pressed) throw new Error("absent controller");
        if (indices !== 1) throw new Error("absent receiver evaluated index");
        const stored = pad.buttons;
        if (stored[9]?.pressed !== undefined) throw new Error("missing stored button");
        const selected = pad.buttons[0];
        const readers: Array<() => boolean> = [() => !!selected?.pressed];
        if (!readers[0]!()) throw new Error("retained selected button");
        if (!pad?.buttons[pad.index]?.pressed) throw new Error("present controller chain");
    }
`;

test("optional platform array elements guard short arrays and evaluate receiver before index once", async (t) => {
    let buttonReads = 0;
    let pressedReads = 0;
    let indexReads = 0;
    const button = (pressed: boolean) => ({
        get pressed() {
            pressedReads++;
            return pressed;
        },
    });
    const pad = {
        get buttons() {
            buttonReads++;
            return [button(true), button(false)];
        },
        get index() {
            assert.ok(buttonReads === 6 || buttonReads === 10);
            indexReads++;
            return 0;
        },
    };
    const empty = {
        get buttons() {
            buttonReads++;
            return [];
        },
    };
    await runInNewContext(
        ts.transpileModule(`${source}\nmain();`, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.CommonJS,
            },
        }).outputText,
        {
            exports: {},
            require: () => ({ createEngine: () => ({}) }),
            navigator: { getGamepads: () => [pad, null, empty] },
        },
    );
    assert.equal(buttonReads, 10);
    assert.equal(pressedReads, 5);
    assert.equal(indexReads, 2);

    const result = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("The native fixture compiler is unavailable.");
    const output = resolve("artifacts/optional-platform-elements");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "program.hpp"), result.cpp);
    const file = join(output, "check.cpp");
    const executable = join(output, "check.exe");
    writeFileSync(
        file,
        `
        #define main generated_main
        #include "program.hpp"
        #undef main
        #include <cassert>
        namespace { unsigned button_reads = 0, pressed_reads = 0, index_reads = 0; }
        namespace bbl {
            Engine create_engine(EngineOptions) { return {}; }
            js::Array<js::Nullable<GamepadHandle>> platform_gamepads(Engine&) {
                return {GamepadHandle{7u, 0u}, std::nullopt, GamepadHandle{8u, 0u}};
            }
            js::Array<GamepadButtonHandle> gamepad_buttons(Engine&, GamepadHandle pad) {
                ++button_reads;
                if (pad.instance_id == 8u) return {};
                assert(pad.instance_id == 7u);
                return {GamepadButtonHandle{pad, 0u}, GamepadButtonHandle{pad, 1u}};
            }
            double gamepad_index(Engine&, GamepadHandle pad) {
                assert(pad.instance_id == 7u && (button_reads == 6u || button_reads == 10u));
                ++index_reads;
                return pad.index;
            }
            bool gamepad_button_pressed(Engine&, GamepadButtonHandle button) {
                assert(button.gamepad.instance_id == 7u && button.index < 2u);
                ++pressed_reads;
                return button.index == 0u;
            }
        }
        int main() {
            assert(generated_main() == 0);
            assert(button_reads == 10u && pressed_reads == 5u && index_reads == 2u);
        }
        `,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        "/MD",
        `/Fo:${output}\\`,
        `/Fe:${executable}`,
        "/I",
        "native/include",
        file,
    ]);
    execFileSync(executable, { stdio: "pipe", timeout: 10000 });
});

test("guarded data elements snapshot receivers across index rebinding and retain optional results", (t) => {
    const source = `
        interface Item { value:number; }
        let rows:Item[]=[{value:4}];
        const original=rows;
        function switchIndex():number { rows=[{value:9}]; return 0; }
        const first=rows[switchIndex()]?.value;
        if(first!==4 || original[0]!.value!==4 || rows[0]!.value!==9)
            throw new Error('receiver before index rebinding');
        let calls=0;
        function choose(present:boolean):readonly Item[]|undefined { calls++; return present ? rows : undefined; }
        const present=choose(true)?.[0]?.value;
        const missing=choose(true)?.[8]?.value;
        let indices=0;
        function index():number { indices++; return 0; }
        const absent=choose(false)?.[index()]?.value;
        if(present!==9 || missing!==undefined || absent!==undefined || calls!==3 || indices!==0)
            throw new Error('guarded readonly array');
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("The native fixture compiler is unavailable.");
    runGeneratedProgram(tools, "optional-data-elements", result.cpp, {
        timeoutMs: 10000,
        expectedOutput: "",
    });
});
