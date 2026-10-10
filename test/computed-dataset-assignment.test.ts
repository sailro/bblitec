import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("computed dataset property names share attribute writes and snapshot their receiver", (t) => {
    const result = compileSource(`
        let element:HTMLElement = document.createElement("button");
        const second = document.createElement("button");
        let calls = 0;
        function value():string { calls++; element = second; return "first"; }
        element.dataset["value"] = value();
        const key = "camelCase";
        element.dataset[key] = "second";
        element.dataset.value = "third";
        const setters:Array<(target:HTMLElement) => void> = [target => { target.dataset["value"] = "retained"; }];
        setters[0]!(second);
        if (calls !== 1) throw new Error("dataset right operand count");
        globalThis.close();
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("The native fixture compiler is unavailable.");
    runGeneratedProgram(
        tools,
        "computed-dataset-assignment",
        `
        #define main generated_main
        ${result.cpp}
        #undef main
        #include <cassert>
        namespace bbl {
            unsigned created = 0, writes = 0;
            UiElementHandle ui_create_element(Engine& owner, std::string_view tag) {
                assert(&owner == &pal::window_document_engine() && tag == "button");
                return UiElementHandle{created++};
            }
            void ui_set_attribute(Engine& owner, UiElementHandle element, std::string name, std::string value) {
                assert(&owner == &pal::window_document_engine() && writes < 4);
                const char* names[] = {"data-value", "data-camel-case", "data-value", "data-value"};
                const char* values[] = {"first", "second", "third", "retained"};
                assert(element.value == (writes == 0 ? 0u : 1u) && name == names[writes] && value == values[writes]);
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
        int main() { const int result = generated_main(); assert(bbl::created == 2 && bbl::writes == 4); return result; }
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

test("dynamic and compound dataset writes retain explicit refusals", () => {
    for (const write of [
        `function write(key:string) { element.dataset[key] = "value"; } const writers:Array<typeof write>=[write];writers[0]!("value");`,
        `element.dataset["value"] += "extra";`,
    ])
        assert.throws(
            () =>
                compileSource(
                    `const element = document.createElement("button");${write}globalThis.close();`,
                ),
            /Retained dataset assignments require a static property name|Compound retained dataset assignments/,
        );
});
