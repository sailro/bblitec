import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const cases = {
    construction: `
        const map = new Map<Mesh, number>([[left, 1], [right, 2], [left, 3]]);
        if (map.size !== 2 || map.get(left) !== 3 || map.get(right) !== 2)
            throw new Error("Map constructor key owner");
        const empty = new Map<Mesh, number>();
        empty.set(left, 1).set(right, 2).set(left, 3);
        if (empty.size !== 2 || empty.get(left) !== 3 || !empty.delete(right) ||
            !empty.has(left) || empty.has(right)) throw new Error("Map mutation key owner");
        const set = new Set<Mesh>([left, right, left]);
        const added = new Set<Mesh>();
        added.add(left).add(right).add(left);
        if (set.size !== 2 || added.size !== 2 || !added.delete(right) ||
            !added.has(left) || added.has(right)) throw new Error("Set key owner");
        const copy = new Map(map);
        const entries = new Map(map.entries());
        const keys = new Set(map.keys());
        const setCopy = new Set(set);
        const setKeys = new Set(set.values());
        const pairs = new Map(set.entries());
        if (copy.size !== 2 || copy.get(right) !== 2 || entries.get(left) !== 3 ||
            keys.size !== 2 || !keys.has(right) || setCopy.size !== 2 ||
            !setCopy.has(right) || setKeys.size !== 2 || pairs.size !== 2 ||
            pairs.get(left) !== left || pairs.get(right) !== right)
            throw new Error("copied iterator key owner");
        const projected = pairs.get(right)!;
        projected.visible = false;
        if (left.visible !== true || right.visible !== false)
            throw new Error("entry value resource owner");
        function clear(): Mesh { pairs.clear(); return right; }
        if (pairs.get(right) !== clear() || pairs.get(right) === right ||
            pairs.get(right) !== undefined) throw new Error("optional value evaluation order");
    `,
    iteration: `
        const map = new Map<Mesh, number>([[left, 1], [right, 2]]);
        let calls = 0;
        map.forEach((value, key, owner) => {
            if (owner.get(key) !== value) throw new Error("Map callback key");
            key.visible = false;
            calls++;
        });
        for (let [key, value] of map) {
            if (map.get(key) !== value) throw new Error("loop key");
            key.visible = true;
            key = right;
            if (!map.has(key)) throw new Error("writable loop binding");
        }
        for (const pair of map) {
            if (map.get(pair[0]) !== pair[1]) throw new Error("stored loop pair owner");
        }
        const reads: Array<() => boolean> = [];
        map.forEach((_value, key) => { reads.push(() => key.visible === true); });
        left.visible = false;
        if (reads[0]!() || !reads[1]!()) throw new Error("captured callback key owner");
        new Set(map.keys()).forEach((key, duplicate, owner) => {
            if (key !== duplicate || !owner.has(key)) throw new Error("Set callback key");
            key.visible = false;
            calls++;
        });
        if (calls !== 4 || left.visible !== false || right.visible !== false)
            throw new Error("iteration resource owner");
    `,
    storedCallback: `
        const map = new Map<Mesh, number>([[left, 1], [right, 2]]);
        let calls = 0;
        function visit(value: number, key: Mesh, owner: Map<Mesh, number>): void {
            if (owner.get(key) !== value) throw new Error("stored callback key");
            key.visible = false;
            calls++;
        }
        type Visit = (value: number, key: Mesh, owner: Map<Mesh, number>) => void;
        const visitors: Visit[] = [visit];
        const visitor = visitors[0]!;
        map.forEach(visitor);
        if (calls !== 2 || left.visible !== false || right.visible !== false)
            throw new Error("stored callback resource owner");
    `,
    nullable: `
        const map = new Map<Mesh | null | undefined, number>([
            [left, 1], [right, 2], [null, 3], [undefined, 4],
        ]);
        const set = new Set<Mesh | null | undefined>([left, right, null, undefined, left]);
        if (map.size !== 4 || map.get(right) !== 2 || map.get(null) !== 3 ||
            map.get(undefined) !== 4 || set.size !== 4 || !set.has(left))
            throw new Error("nullable resource keys");
        const copied = new Map(map.entries());
        if (!copied.delete(null) || copied.has(null) || copied.get(undefined) !== 4 ||
            !copied.has(left) || !copied.has(right)) throw new Error("nullable key copy");
        const erased = new Map<Mesh | null | undefined, unknown>([[left, 1], [right, 2], [null, 3], [undefined, 4]]);
        if (erased.size !== 4 || erased.get(null) !== 3 || erased.get(undefined) !== 4 ||
            erased.get(left) !== 1 || erased.get(right) !== 2)
            throw new Error("nullable keys with erased values");
        const union = new Map<Mesh | string, number>([[left, 1], [right, 2], ["key", 3]]);
        let calls = 0;
        union.forEach((value, key) => {
            if (union.get(key) !== value) throw new Error("union callback key");
            calls++;
        });
        if (new Map(union.entries()).size !== 3 || calls !== 3)
            throw new Error("union iterator key");
    `,
    storedNullableCallback: `
        type Key = Mesh | string | null | undefined;
        const map = new Map<Key, number>([[left, 1], [right, 2], ["key", 3], [null, 4], [undefined, 5]]);
        let calls = 0;
        function visit(value: number, key: Key, owner: Map<Key, number>): void {
            if (owner.get(key) !== value) throw new Error("stored nullable key");
            if (key !== null && key !== undefined && typeof key !== "string" && !key.visible)
                throw new Error("stored resource view");
            calls++;
        }
        type Visit = (value: number, key: Key, owner: Map<Key, number>) => void;
        const visitors: Visit[] = [visit];
        const visitor = visitors[0]!;
        map.forEach(visitor);
        if (calls !== 5) throw new Error("stored nullable callback count");
    `,
} as const;

for (const [label, body] of Object.entries(cases))
    test(`collections retain resource key owners through ${label}`, (t) => {
        const { cpp } = compileSource(`
            import {createBox, type Mesh, type EngineContext} from "@babylonjs/lite";
            function inspect(first: EngineContext, second: EngineContext): number {
                const left = createBox(first), right = createBox(second);
                ${body}
                return 1;
            }
            const callbacks: Array<typeof inspect> = [inspect];
        `);
        const entry =
            /double (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+\);/.exec(
                cpp,
            );
        assert.ok(entry, "two-engine collection callback");
        const native = optionalNativeFixtureTools(false);
        if (!native) return t.skip("Native fixture compiler unavailable.");
        runGeneratedProgram(
            native,
            `collection-resource-identities/${label}`,
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

test("collection method arguments preserve receiver and key evaluation order", (t) => {
    const { cpp } = compileSource(`
        let map = new Map<string, number>();
        const original = map;
        let key = "before";
        function value(): number { key = "after"; return 1; }
        map.set(key, value());
        function replace(): string { map = new Map<string, number>(); return "next"; }
        original.set(replace(), 2);
        map = original;
        map.set(replace(), 3);
        if (original.get("before") !== 1 || original.has("after") ||
            original.get("next") !== 3 || map.size !== 0)
            throw new Error("Map argument order");
        let set = new Set<number>();
        const first = set;
        function member(): number { set = new Set<number>(); return 4; }
        set.add(member());
        if (!first.has(4) || set.size !== 0) throw new Error("Set argument order");
    `);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "collection-method-argument-order", cpp);
});

test("retained collection keys keep their engines alive across closure calls", (t) => {
    const { cpp } = compileSource(`
        import {createBox, type Mesh, type EngineContext} from "@babylonjs/lite";
        function retain(first: EngineContext, second: EngineContext): () => number {
            const keys = new Set<Mesh>([createBox(first), createBox(second)]);
            return () => {
                let count = 0;
                for (const key of keys) { key.visible = false; count++; }
                keys.clear();
                return count;
            };
        }
        const factories: Array<typeof retain> = [retain];
    `);
    const entry =
        /bbl::js::Callback<double\(\)> (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+\);/.exec(
            cpp,
        );
    assert.ok(entry, "collection closure factory");
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        native,
        "collection-resource-identities/lifetime",
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
                std::weak_ptr<bbl::Engine> left = first, right = second;
                bblscene::${entry[2]} environment{};
                auto callback = bblscene::${entry[1]}(environment, bbl::StoredEngine{first}, bbl::StoredEngine{second});
                first.reset(); second.reset();
                assert(!left.expired() && !right.expired());
                assert(callback() == 2 && callback() == 0);
                callback = {};
                bbl::js::collect_cycles();
                assert(left.expired() && right.expired());
            }
        `,
    );
});
