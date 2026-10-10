import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const cases = {
    callback: `
        const map = new Map<Mesh | string | null | undefined, number>([
            [left, 1], [right, 2], ["plain", 3], [null, 4], [undefined, 5],
        ]);
        let calls = 0;
        function visit(value: number, key: Mesh | string | null | undefined,
                       owner: Map<Mesh | string | null | undefined, number>): void {
            if (owner.get(key) !== value) throw new Error("callback key identity");
            if (key !== null && key !== undefined && typeof key !== "string")
                key.visible = false;
            calls++;
        }
        const visitors: Array<typeof visit> = [visit];
        const visitor = visitors[0]!;
        map.forEach(visitor);
        if (calls !== 5 || left.visible !== false || right.visible !== false)
            throw new Error("callback member owner");
    `,
    entry: `
        const map = new Map<Mesh, number>([[left, 1], [right, 2]]);
        for (const pair of map) {
            const key = pair[0];
            key.visible = false;
        }
        if (left.visible !== false || right.visible !== false)
            throw new Error("entry member owner");
    `,
    rebound: `
        let calls = 0;
        function hide(key: Mesh | string | null | undefined, replacement: Mesh): void {
            function replace(): boolean { key = replacement; calls++; return false; }
            if (key !== null && key !== undefined && typeof key !== "string")
                key.visible = replace();
            if (key !== replacement) throw new Error("right side rebind");
        }
        const hiders: Array<typeof hide> = [hide];
        hiders[0]!(left, right);
        if (calls !== 1 || left.visible !== false || right.visible !== true)
            throw new Error("member owner snapshot before right side");
    `,
};

for (const [label, body] of Object.entries(cases))
    test(`narrowed resource writes retain their owner through ${label}`, (t) => {
        const source = `
            import {createBox, type EngineContext, type Mesh} from "@babylonjs/lite";
            function inspect(first: EngineContext, second: EngineContext): number {
                const left = createBox(first), right = createBox(second);
                ${body}
                return 1;
            }
            const callbacks: Array<typeof inspect> = [inspect];
            void callbacks;
        `;
        const fileName = resolve("narrowed-resource-writes.ts");
        const { program } = createCompilerProgram(source, fileName);
        assert.deepEqual(
            ts
                .getPreEmitDiagnostics(program)
                .map((diagnostic) =>
                    ts.flattenDiagnosticMessageText(
                        diagnostic.messageText,
                        " ",
                    ),
                ),
            [],
        );
        const { cpp } = compileSource(source, { fileName });
        const entry =
            /double (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+\);/.exec(
                cpp,
            );
        assert.ok(entry, "two-engine resource callback");
        const native = optionalNativeFixtureTools(false);
        if (!native) return t.skip("Native fixture compiler unavailable.");
        runGeneratedProgram(
            native,
            `narrowed-resource-writes/${label}`,
            `
            #define main generated_main
            ${cpp}
            #undef main
            #include <cassert>
            namespace bbl {
                MeshHandle create_box(Engine& engine, BoxOptions) {
                    engine.meshes.emplace_back();
                    engine.meshes.back().visible = true;
                    return {0, 0};
                }
            }
            int main() {
                const bbl::js::RealmScope realm;
                auto first = std::make_shared<bbl::Engine>();
                auto second = std::make_shared<bbl::Engine>();
                bblscene::${entry[2]} environment{};
                assert(bblscene::${entry[1]}(environment, bbl::StoredEngine{first}, bbl::StoredEngine{second}) == 1);
            }
        `,
        );
    });
