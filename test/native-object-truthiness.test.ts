import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("native object conditions preserve presence, short circuits and call effects", (t) => {
    const { cpp } = compileSource(`
        import {type Mesh} from '@babylonjs/lite';
        function inspect(mesh: Mesh, optional: Mesh | undefined): number {
            let count = 0;
            if (mesh) count++;
            if (!mesh) throw new Error('present object');
            const holder = {mesh};
            if (holder.mesh) count++;
            if (Boolean(mesh)) count++;
            if (optional) count += 10;
            if (optional ?? mesh) count++;
            function read(): Mesh {count++; return mesh;}
            if (read()) count++;
            if (mesh || read()) count++;
            if (mesh && read()) count++;
            const list: Mesh[] = [mesh];
            if (list[2]) throw new Error('absent element');
            return count;
        }
        const callbacks: Array<typeof inspect> = [inspect];
    `);
    const entry =
        /double (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] std::pair<bbl::StoredEngine, bbl::MeshHandle> \w+, \[\[maybe_unused\]\] bbl::js::Nullable<bbl::MeshHandle> \w+\);/.exec(
            cpp,
        );
    assert.ok(entry, "retained native condition function");
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "native-object-truthiness/handles",
        `
        #define main generated_main
        ${cpp}
        #undef main
        #include <cassert>
        int main() {
            bblscene::${entry[2]} environment{};
            bbl::Engine engine;
            const bbl::MeshHandle zero{0, 0};
            const std::pair<bbl::StoredEngine, bbl::MeshHandle> owned{bbl::StoredEngine{engine}, zero};
            assert(bblscene::${entry[1]}(environment, owned, {std::nullopt}) == 9);
            assert(bblscene::${entry[1]}(environment, owned, {zero}) == 19);
        }
    `,
    );
});

test("nullish conditions use selected primitive truthiness and lazy defaults", (t) => {
    const { cpp } = compileSource(`
        let calls = 0;
        function fallback(): number {calls++; return 3;}
        function inspect(value: number | undefined, text: string | undefined): number {
            let count = 0;
            if (value ?? fallback()) count++;
            if (text ?? 'fallback') count++;
            return count;
        }
        if (inspect(0, '') !== 0 || calls !== 0) throw new Error('present falsy');
        if (inspect(undefined, undefined) !== 2 || calls !== 1) throw new Error('absent defaults');
        if (inspect(Number.NaN, 'yes') !== 1 || calls !== 1) throw new Error('selected truthiness');
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "native-object-truthiness/nullish", cpp);
});

test("borrowed native event conditions preserve optional payload presence", (t) => {
    const { cpp } = compileSource(`
        import {createEngine} from '@babylonjs/lite';
        const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;
        await createEngine(canvas);
        function inspect(event: MouseEvent | undefined): number {
            return event ? event.clientX : 7;
        }
        window.addEventListener('mousedown', event => {
            if (!event) throw new Error('present event');
            if (inspect(event) !== event.clientX || inspect(undefined) !== 7)
                throw new Error('optional payload');
        });
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "native-object-truthiness/events",
        `
        #define main generated_main
        ${cpp}
        #undef main
        #include <cassert>
        namespace { const auto truthiness_input = std::make_shared<bbl::DomInput>(); }
        namespace bbl {
            Engine create_engine(EngineOptions) {Engine engine; engine.dom_input=truthiness_input; return engine;}
        }
        int main() {
            assert(generated_main() == 0);
            bbl::PlatformMouseEvent event;
            event.client_x = 23;
            event.dom = std::make_shared<bbl::DomEventState>();
            event.dom->type = "mousedown";
            event.dom->target = bbl::DomEventTarget::window();
            event.dom->path = {event.dom->target};
            truthiness_input->pointer.dispatch(event);
        }
    `,
    );
});
