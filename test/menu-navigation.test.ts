import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

test("retained button navigation helpers preserve focus, activeElement and click", () => {
    const nav = readFileSync("corpus/babylon-lite/lab/lite/src/demos/antigravity-racer/gamepad-list-nav.ts", "utf8")
        .replace(/^import type .*;\r?\n/m, "");
    const cpp = compileSource(`
        import { createEngine } from "babylon-lite";
        interface InputSystem {
            resetNavEdges(): void;
            consumeMenuDown(): boolean;
            consumeMenuUp(): boolean;
            consumeConfirm(): boolean;
        }
        ${nav}
        const engine = await createEngine({});
        const root = document.createElement("div");
        root.innerHTML = '<button class="entry">One</button><button class="entry">Two</button>';
        document.body.appendChild(root);
        const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>(".entry"));
        const nav = createButtonListNav(buttons);
        const input: InputSystem = {
            resetNavEdges() {}, consumeMenuDown() { return true; },
            consumeMenuUp() { return false; }, consumeConfirm() { return true; }
        };
        nav.activate(input);
        nav.poll(input);
    `).cpp;
    assert.match(cpp, /bbl::ui_focus\(/);
    assert.match(cpp, /bbl::ui_active_element\(/);
    assert.match(cpp, /bbl::ui_click\(/);
    assert.match(cpp, /bbl::ui_on_event\([^\n]+"focus"/);
    assert.match(cpp, /bbl::js::array_index_of\(/);
});

test("every renderer device entry initializes reached gamepads", () => {
    for (const file of ["pal_sdl_gpu_shared.hpp", "pal_dawn_shared.hpp"]) {
        assert.match(readFileSync(`native/src/${file}`, "utf8"), /BBLITE_HAS_GAMEPAD[\s\S]*?init_flags \|= SDL_INIT_GAMEPAD;[\s\S]*?initialize_run_sdl\(init_flags\)/);
    }
});

test("host focus-visible outline retains its authored color and offset", () => {
    const cpp = compileSource(`
        import { createEngine } from "babylon-lite";
        const engine = await createEngine({});
        const button = document.createElement("button");
        button.className = "entry";
        document.body.appendChild(button);
        button.focus();
    `, { nativeHostUi: { sourcePath: "fixture.json", elements: [], styleRules: [
        { kind: "class", primary: "entry", focusVisible: true, style: "outline:2px solid #7fe0ff;outline-offset:2px;" },
    ] } }).cpp;
    assert.match(cpp, /ui_add_host_style_rule\([^\n]+--bbl-outline:2px solid #7fe0ff;--bbl-outline-offset:2px;", true, false, bbl::UiScrollbarPart::None, bbl::UiMotionPreference::Any\)/);
});

test("Antigravity hover rules are independent of keyboard focus", () => {
    const host = JSON.parse(readFileSync("ui/antigravity-racer-host.json", "utf8"));
    for (const primary of ["ag-btn", "ag-attract-btn"]) {
        const hover = host.styleRules.find((rule: { primary: string; hover?: boolean }) => rule.primary === primary && rule.hover);
        assert.ok(hover);
        assert.equal(hover.focusVisible, undefined);
        assert.match(hover.style, /background:rgba\(255,255,255,0.12\)/);
        assert.match(hover.style, /border-color:rgba\(150,200,255,0.45\)/);
    }
});

test("button labels and emoji share their owning button's mouse activation target", () => {
    const source = readFileSync("native/src/pal_ui_defaults.hpp", "utf8");
    assert.match(source, /button \*\{focus:none;\}/);
    assert.match(source, /text-align:center;tab-index:auto;/);
});

const nativeTools = optionalNativeFixtureTools();
const compilerNativeTools = optionalNativeFixtureTools(false);

test("generated gamepad indexing retains fresh arrays and source evaluation order", { skip: !compilerNativeTools }, () => {
    const output = resolve("artifacts/gamepad-indexing-check");
    mkdirSync(output, { recursive: true });
    const compiled = compileSource(`
        import { createEngine } from "babylon-lite";
        const engine = await createEngine({});
        const pads = navigator.getGamepads();
        let pressed = 0;
        let axes = 0;
        let indexCalls = 0;
        function nextIndex(index: number): number { indexCalls++; return index; }
        for (const pad of pads) {
            if (!pad) continue;
            for (let index = 0; index < 3; index++) {
                if (pad.buttons[index]!.pressed) pressed++;
                axes += pad.axes[index]!;
                if (pad.buttons[nextIndex(index)]!.pressed) pressed++;
            }
            const retained = pad.buttons[2]!;
            if (retained.pressed) pressed++;
            if (pad.buttons[pad.index]!.pressed) pressed++;
        }
        const absent = pads[1];
        if (absent && absent.buttons[0]!.pressed) throw new Error("absent gamepad");
        const fallback = absent ? absent.axes[0]! : 10;
        const present = pads[0];
        if (present && present.buttons[0]!.pressed) pressed++;
        if (pressed !== 6 || axes !== 1.5 || indexCalls !== 3 || fallback !== 10)
            throw new Error("gamepad indexing changed");
    `);
    writeFileSync(join(output, "program.hpp"), compiled.cpp);
    writeFileSync(join(output, "check.cpp"), `
        #define main generated_scene_main
        #include "program.hpp"
        #undef main
        #include <cassert>
        namespace { unsigned button_reads = 0, axis_reads = 0, pressed_reads = 0, index_reads = 0; }
        namespace bbl {
        Engine create_engine(EngineOptions) { return {}; }
        js::Array<js::Nullable<GamepadHandle>> platform_gamepads(Engine&) {
            return {GamepadHandle{7u, 1u}, std::nullopt};
        }
        js::Array<GamepadButtonHandle> gamepad_buttons(Engine&, GamepadHandle pad) {
            assert(pad.instance_id == 7u); ++button_reads;
            return {GamepadButtonHandle{pad, 0u}, GamepadButtonHandle{pad, 1u}, GamepadButtonHandle{pad, 2u}};
        }
        js::Array<double> gamepad_axes(Engine&, GamepadHandle pad) {
            assert(pad.instance_id == 7u); ++axis_reads; return {0.25, 0.5, 0.75};
        }
        double gamepad_index(Engine&, GamepadHandle pad) {
            assert(pad.instance_id == 7u && button_reads == 8u); ++index_reads; return pad.index;
        }
        bool gamepad_button_pressed(Engine&, GamepadButtonHandle button) {
            assert(button.gamepad.instance_id == 7u && button.index < 3u);
            ++pressed_reads; return button.index != 1u;
        }
        }
        int main() {
            assert(generated_scene_main() == 0);
            assert(button_reads == 9u && axis_reads == 3u && pressed_reads == 9u && index_reads == 1u);
        }
    `);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(compilerNativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", join(output, "check.cpp"),
    ]);
    execFileSync(executable, { stdio: "pipe" });
});

test("transparent button borders and backgrounds are not gradient text colors", () => {
    const cpp = compileSource(`
        import { createEngine } from "babylon-lite";
        const engine = await createEngine({});
        const button = document.createElement("button");
        button.style.cssText = "border-color:transparent;background-color:transparent;";
        document.body.appendChild(button);
    `).cpp;
    assert.match(cpp, /border-color:transparent;background-color:transparent/);
    assert.doesNotMatch(cpp, /color:#fff/);
});

test("native links retain browser user-agent decoration below author rules", () => {
    const source = readFileSync("native/src/pal_ui_defaults.hpp", "utf8");
    assert.match(source, /a\[href\]\{color:#0000ee;text-decoration:underline;cursor:pointer;\}/);
    assert.match(readFileSync("native/src/pal_ui_rml.cpp", "utf8"), /std::string source\(ui_user_agent_css\)/);
});

test("per-glyph gradient spans preserve inter-word spaces", () => {
    const source = readFileSync("native/src/pal_ui_rml.cpp", "utf8");
    assert.ok(source.includes('CreateTextNode(character == " " ? "\\xC2\\xA0" : character)'));
});

test("canvas focus clears the previously focused retained button", () => {
    const source = readFileSync("src/lowering/scene-lowerer.ts", "utf8");
    assert.match(source, /void focus_canvas\(Engine& engine\)[\s\S]*?engine\.ui_focused_element = \{\};[\s\S]*?\+\+engine\.ui_focus_revision;/);
});

test("virtual controller buttons/axes and UI keyboard bubbling use the platform bridge", { skip: !nativeTools }, () => {
    const output = resolve("artifacts/gamepad-check");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "gamepad-check.exe");
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", "/I", "native/src",
        "/I", join(nativeFixtureVcpkgRoot, "include"),
        "test/fixtures/js-callback/gamepad-check.cpp", join(nativeFixtureVcpkgRoot, "lib/SDL3.lib"),
    ]);
    assert.match(execFileSync(executable, [], {
        encoding: "utf8",
        env: { ...process.env, SDL_VIDEODRIVER: "dummy", PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${process.env.PATH ?? ""}` },
    }), /gamepad-check: ok/);
});
