import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("Object.assign style carriers preserve target and argument order", (t) => {
    const result = compileSource(`
        const first = document.createElement('div');
        const second = document.createElement('div');
        let selected: HTMLElement = first;
        const source = {width: '10px', height: '20px'};
        let calls = 0;
        function later(): {height: string; pointerEvents: string} {
            calls += 1;
            selected = second;
            source.width = '30px';
            return {height: '40px', pointerEvents: 'none'};
        }
        const copied = Object.assign(selected.style, source, later());
        if (copied !== first.style || calls !== 1) throw new Error('style target');
        second.style.width = '50px';
        function failed(): {width: string} { throw new Error('source'); }
        let caught = false;
        try { Object.assign(first.style, {width: 'bad'}, failed()); } catch { caught = true; }
        if (!caught) throw new Error('source failure');
        globalThis.close();
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("The native fixture compiler is unavailable.");
    runGeneratedProgram(
        tools,
        "assign-style-carrier",
        `
        #define main generated_main
        ${result.cpp}
        #undef main
        #include <cassert>
        namespace bbl {
            unsigned created = 0, writes = 0;
            UiElementHandle ui_create_element(Engine& owner, std::string_view tag) {
                assert(&owner == &pal::window_document_engine() && tag == "div");
                return UiElementHandle{created++};
            }
            void ui_set_style_property(Engine& owner, UiElementHandle element, std::string name, std::string value) {
                assert(&owner == &pal::window_document_engine() && writes < 5);
                const char* names[] = {"width", "height", "height", "pointer-events", "width"};
                const char* values[] = {"30px", "20px", "40px", "none", "50px"};
                assert(element.value == (writes == 4 ? 1u : 0u) && name == names[writes] && value == values[writes]);
                ++writes;
            }
        }
        namespace bbl::pal {
            Engine& window_document_engine() { static Engine host; return host; }
            int run_window_application(WorkerEntry initialize, EngineOptions) {
                const js::RealmScope scope;
                EventLoop loop;
                WorkerRealm realm(loop);
                loop.run([&] { initialize(realm); });
                return 0;
            }
        }
        int main() { const int result = generated_main(); assert(bbl::created == 2 && bbl::writes == 5); return result; }
    `,
        {
            flags: [
                "/DBBLITE_HAS_UI=1",
                "/DBBLITE_WORKERS=1",
                "/DBBLITE_OFFSCREEN_SURFACES=1",
            ],
            timeoutMs: 10000,
            expectedOutput: "",
        },
    );
});

test("Object.assign styles reuse property adaptation and capability admission", () => {
    const result = compileSource(`
        const panel = document.createElement('img');
        Object.assign(panel.style, {position:'absolute', left:'0px', top:'0px', width:'40px', height:'40px',
            objectFit:'contain', imageRendering:'auto', display:'block', flex:'0 0 auto', filter:'none',
            pointerEvents:'none', background:'#dcc18b'});
        globalThis.close();
    `);
    for (const property of [
        "position",
        "left",
        "top",
        "width",
        "height",
        "object-fit",
        "image-rendering",
        "display",
        "flex",
        "filter",
        "pointer-events",
        "--bbl-background-color",
    ])
        assert.ok(result.cpp.includes(`"${property}"`), property);
    const source = `const panel=document.createElement('div');Object.assign(panel.style,{clipPath:'inset(1px)'});globalThis.close();`;
    assert.throws(() => compileSource(source), /Retained UI style/);
    assert.deepEqual(
        compileSource(source, {
            deferredCapabilities: "runtime-throw",
        }).manifest.deferredCapabilities?.map((entry) => entry.id),
        ["css:property:clip-path"],
    );
});

test("Object.assign style carriers refuse unsupported sources and setters", () => {
    for (const source of [
        `{get width(){return '1px';}}`,
        `{width(){return '1px';}}`,
    ])
        assert.throws(
            () =>
                compileSource(
                    `const panel=document.createElement('div');Object.assign(panel.style,${source});`,
                ),
            /Object.assign copies plain properties/,
        );
    assert.throws(
        () =>
            compileSource(
                `const panel=document.createElement('div');Object.assign(panel.style,{imaginaryProperty:'x'});`,
            ),
        /reviewed retained-UI surface/,
    );
    assert.throws(
        () =>
            compileSource(
                `const panel=document.createElement('div');Object.assign(panel,{imaginaryProperty:'x'});`,
            ),
        /Object.assign cannot write into a ui-element value/,
    );
});
