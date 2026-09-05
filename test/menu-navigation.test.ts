import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
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
    for (const file of ["pal_sdl_gpu.cpp", "pal_sdl_gpu_shared.hpp", "pal_dawn_shared.hpp"]) {
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
    assert.match(cpp, /ui_add_host_style_rule\([^\n]+--bbl-outline:2px solid #7fe0ff;--bbl-outline-offset:2px;", true\)/);
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
    const source = readFileSync("native/src/pal_ui_rml.cpp", "utf8");
    assert.match(source, /button \*\{focus:none;\}/);
    assert.match(source, /text-align:center;tab-index:auto;/);
});

const nativeTools = optionalNativeFixtureTools();
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
    const source = readFileSync("native/src/pal_ui_rml.cpp", "utf8");
    assert.match(source, /a\[href\]\{color:#0000ee;text-decoration:underline;cursor:pointer;\}/);
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
