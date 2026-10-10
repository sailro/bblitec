import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    runGeneratedProgram,
} from "./native-fixture.js";

const source = `
    import { createEngine } from "@babylonjs/lite";
    async function main() {
        const engine = await createEngine({});
        interface Controls { show():void; fill():void; clear():void; }
        let effects = 0;
        function absent():undefined { effects++; return undefined; }
        function make():Controls {
            let button:HTMLButtonElement|null = (null);
            let span:HTMLSpanElement|undefined = absent();
            let image:HTMLImageElement|null = null;
            const show = ():void => {
                if (button) button.textContent = "button";
                if (span) span.textContent = "span";
                if (image) image.textContent = "image";
            };
            const fill = ():void => {
                button = document.createElement("button");
                span = document.createElement("span");
                image = document.createElement("img");
            };
            const clear = ():void => { button = null; span = void ++effects; image = null; };
            return { show, fill, clear };
        }
        const makers:Array<() => Controls> = [make];
        const first = makers[0]!();
        const second = makers[0]!();
        first.show();
        first.fill();
        first.show();
        second.show();
        second.fill();
        second.show();
        first.clear();
        first.show();
        second.show();
        if (effects !== 3) throw new Error("absence initializer effects");
    }
`;

test("nullable DOM subtype bindings retain separate closure cells and initializer effects", (t) => {
    const result = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("The native fixture compiler is unavailable.");
    const directory = resolve("artifacts/nullable-resource-bindings");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    const file = join(directory, "check.cpp");
    const executable = join(directory, "check.exe");
    writeFileSync(
        file,
        `
        #define main generated_main
        #include "program.hpp"
        #undef main
        #include <cassert>
        namespace bbl {
            unsigned created = 0, written = 0;
            Engine* document = nullptr;
            Engine create_engine(EngineOptions) { return {}; }
            UiElementHandle ui_create_element(Engine& owner, std::string_view tag) {
                const char* tags[] = {"button", "span", "img"};
                assert(created < 6 && tag == tags[created % 3]);
                if (document) assert(document == &owner);
                document = &owner;
                return UiElementHandle{created++};
            }
            void ui_set_text(Engine& owner, UiElementHandle element, std::string text) {
                const char* labels[] = {"button", "span", "image"};
                assert(document == &owner && written < 9);
                const unsigned expected = written < 6 ? written : written - 3;
                assert(element.value == expected && text == labels[written % 3]);
                ++written;
            }
        }
        int main() {
            assert(generated_main() == 0);
            assert(bbl::created == 6 && bbl::written == 9);
        }
    `,
    );
    runNativeFixtureCompiler(tools, [
        "/DBBLITE_HAS_UI=1",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        file,
    ]);
    assert.equal(
        execFileSync(executable, {
            encoding: "utf8",
            timeout: 10000,
            stdio: "pipe",
        }),
        "",
    );
});

test("application records named after DOM subtypes keep ordinary nullable storage", (t) => {
    const result = compileSource(`
        export {};
        interface HTMLButtonElement { value:number; }
        function factory() {
            let current:HTMLButtonElement|null = null;
            return { read:() => current?.value ?? -1, set:(value:HTMLButtonElement|null) => { current = value; } };
        }
        const box = factory();
        box.set({value:4});
        if (box.read() !== 4) throw new Error("record value");
        box.set(null);
        if (box.read() !== -1) throw new Error("record absence");
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("The native fixture compiler is unavailable.");
    runGeneratedProgram(tools, "nullable-resource-record-control", result.cpp, {
        timeoutMs: 10000,
        expectedOutput: "",
    });
});

test("nullable resources do not treat an erased void callback result as absent", () => {
    for (const binding of [
        "let selected:HTMLSpanElement|void = callbacks[0]!();",
        "let selected:HTMLSpanElement|void = undefined; selected = callbacks[0]!();",
    ])
        assert.throws(
            () =>
                compileSource(`
                    import { createEngine } from "@babylonjs/lite";
                    async function main() {
                        const engine = await createEngine({});
                        const callbacks:Array<() => void> = [() => document.createElement("span")];
                        ${binding}
                    }
                `),
            /does not produce a native value|Nullable ui-element assignment received void|Optional storage requires a proven undefined completion/,
        );
});
