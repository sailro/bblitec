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

const imports = `
    import {createStandardMaterial,createPbrMaterial,type Texture2D,type EngineContext} from '@babylonjs/lite';
    type Standard = ReturnType<typeof createStandardMaterial>;
    type Pbr = ReturnType<typeof createPbrMaterial>;
    type Produced<F> = F extends (...arguments_: never[]) => infer R ? R : never;
    type View<T> = {readonly [K in keyof T]: T[K]};
`;

function compileChecked(source: string) {
    const fileName = resolve("native-owner-type-views.ts");
    const { program } = createCompilerProgram(source, fileName);
    assert.deepEqual(
        ts
            .getPreEmitDiagnostics(program)
            .map((diagnostic) =>
                ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
            ),
        [],
    );
    return compileSource(source, { fileName });
}

test("existing native owner aliases share storage in containers and factory results", (t) => {
    const { cpp } = compileChecked(`${imports}
        function table<T>(first: T, second: T): Map<T, number> {
            const result = new Map<T, number>();
            result.set(first, 3);
            result.set(second, 8);
            return result;
        }
        function factory<T>(first: T): () => Map<T, number> {
            return () => {const result = new Map<T, number>(); result.set(first, 11); return result;};
        }
        function material(engine: EngineContext): Standard {return createStandardMaterial();}
        function inspect(firstEngine: EngineContext, secondEngine: EngineContext): number {
            const first = material(firstEngine), second = material(secondEngine);
            const values = table(first, second);
            const alias: View<Standard> = first;
            const views = new Map<Readonly<Standard>, number>();
            views.set(alias, values.get(first)!);
            views.set(second, values.get(second)!);
            const picked = new Set<Pick<Standard, keyof Standard>>([first]);
            const omitted = new Set<Omit<Standard, never>>([second]);
            if(!picked.has(first) || picked.has(second) || !omitted.has(second)) throw new Error('mapped owner identity');
            const conditional = new Map<NonNullable<Produced<typeof createStandardMaterial> | undefined>, number>();
            conditional.set(first, 2);
            const awaited = new Set<Awaited<Promise<Standard>>>([first, second, first]);
            const make = factory(first);
            const makers: Array<typeof make> = [make];
            const retained = makers[0]!();
            if(!retained.has(first) || retained.has(second)) throw new Error('factory owner identity');
            if(!views.delete(first) || views.has(first) || !views.has(second)) throw new Error('map owner identity');
            return values.size + views.get(second)! + conditional.get(first)! + awaited.size + retained.get(first)!;
        }
        const functions: Array<typeof inspect> = [inspect];
    `);
    const callback =
        /double (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+\);/.exec(
            cpp,
        );
    assert.ok(
        callback,
        "retained producer callback has concrete engine parameters",
    );
    assert.match(
        cpp,
        /bbl::js::Map<std::pair<bbl::StoredEngine, bbl::MaterialHandle>, double>/,
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        tools,
        "native-owner-type-views/aliases",
        `
        #define main generated_main
        ${cpp}
        #undef main
        #include <cassert>
        namespace bbl {
            MaterialHandle create_standard_material(Engine& engine) {
                engine.materials.emplace_back();
                return {static_cast<std::uint32_t>(engine.materials.size() - 1)};
            }
        }
        int main() {
            bbl::js::RealmScope realm;
            const auto first = std::make_shared<bbl::Engine>(), second = std::make_shared<bbl::Engine>();
            bblscene::${callback[2]} environment{};
            assert(bblscene::${callback[1]}(environment, bbl::StoredEngine{first}, bbl::StoredEngine{second}) == 25);
        }
    `,
    );
});

test("engine-scoped key callback parameters require represented owners", () => {
    const { cpp } = compileChecked(`${imports}
            function store(value: Standard): number {
                const values = new Map<Standard, number>();
                values.set(value, 1);return values.size;
            }
            const callbacks: Array<typeof store> = [store];
        `);
    assert.match(
        cpp,
        /\[\[maybe_unused\]\] std::pair<bbl::StoredEngine, bbl::MaterialHandle> \w+/,
    );
});

test("native owner fields retain identity, null, and own undefined", (t) => {
    const { cpp } = compileChecked(`${imports}
        type MaterialView = Pbr & {baseColorTexture?: Texture2D};
        interface Bucket {material: MaterialView | null; next: number}
        function material(engine: EngineContext): Pbr {return createPbrMaterial({});}
        function inspect(firstEngine: EngineContext, secondEngine: EngineContext): number {
            const first = material(firstEngine), second = material(secondEngine);
            const buckets = new Map<string, Bucket>();
            buckets.set('first', {material: first, next: 1});
            const alias = buckets.get('first')!;
            if(alias.material !== first) throw new Error('nested owner identity');
            alias.material = second;
            if(buckets.get('first')!.material !== second) throw new Error('nested owner replacement');
            alias.material = null;
            if(buckets.get('first')!.material !== null) throw new Error('nullable owner');
            const materialSlot: {value?: MaterialView} = {};
            const mapSlot: {value?: Map<string, number>} = {};
            const arraySlot: {value?: number[]} = {};
            if(Object.hasOwn(materialSlot, 'value') || Object.hasOwn(mapSlot, 'value') || Object.hasOwn(arraySlot, 'value'))
                throw new Error('initial own presence');
            materialSlot.value = first;
            mapSlot.value = new Map<string, number>([['first', 1]]);
            arraySlot.value = [1, 2];
            if(!Object.hasOwn(materialSlot, 'value') || !Object.hasOwn(mapSlot, 'value') || !Object.hasOwn(arraySlot, 'value'))
                throw new Error('present own fields');
            materialSlot.value = undefined;
            mapSlot.value = undefined;
            arraySlot.value = undefined;
            if(!Object.hasOwn(materialSlot, 'value') || materialSlot.value !== undefined ||
               !Object.hasOwn(mapSlot, 'value') || mapSlot.value !== undefined ||
               !Object.hasOwn(arraySlot, 'value') || arraySlot.value !== undefined)
                throw new Error('own undefined fields');
            return buckets.size + alias.next;
        }
        const functions: Array<typeof inspect> = [inspect];
    `);
    const callback =
        /double (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+\);/.exec(
            cpp,
        );
    assert.ok(
        callback,
        "retained producer callback has concrete engine parameters",
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        tools,
        "native-owner-type-views/intersections",
        `
        #define main generated_main
        ${cpp}
        #undef main
        #include <cassert>
        namespace bbl {
            MaterialHandle create_pbr_material(Engine& engine, PbrMaterialOptions) {
                engine.materials.emplace_back();
                return {static_cast<std::uint32_t>(engine.materials.size() - 1)};
            }
        }
        int main() {
            bbl::js::RealmScope realm;
            const auto first = std::make_shared<bbl::Engine>(), second = std::make_shared<bbl::Engine>();
            bblscene::${callback[2]} environment{};
            assert(bblscene::${callback[1]}(environment, bbl::StoredEngine{first}, bbl::StoredEngine{second}) == 2);
        }
    `,
    );
});

test("native owner views require the pinned declaration and unchanged property storage", () => {
    for (const type of [
        "Standard & {alpha: string}",
        "Standard & {label: string}",
        "Partial<Standard>",
    ])
        assert.throws(
            () =>
                compileChecked(`${imports}
                type Changed = ${type};
                const values = new Map<Changed, number>();
                if(values.size !== 0) throw new Error('size');
            `),
            /concrete data type arguments|native data|represented/,
        );
    for (const field of ["number", "unknown"]) {
        const changed = compileChecked(`${imports}
            type Changed<T> = {[K in keyof T]: ${field}};
            const values = new Map<Changed<Standard>, number>();
            if(values.size !== 0) throw new Error('size');
        `);
        assert.doesNotMatch(changed.cpp, /MaterialHandle/);
    }
    assert.throws(
        () =>
            compileChecked(`${imports}
            type Changed<T> = {[K in keyof T]: ReturnType<typeof JSON.parse>};
            const values = new Map<Changed<Standard>, number>();
            if(values.size !== 0) throw new Error('size');
        `),
        /concrete data type arguments/,
    );
    const { cpp } = compileChecked(`
        interface StandardMaterialProps {value: number}
        const first: StandardMaterialProps = {value: 1};
        const second: StandardMaterialProps = {value: 1};
        const values = new Map<StandardMaterialProps, number>();
        values.set(first, 2);values.set(second, 3);
        if(values.size !== 2 || values.get(first) !== 2) throw new Error('local record identity');
    `);
    assert.doesNotMatch(cpp, /MaterialHandle/);
});
