import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("Map iterable literals retain stored pairs, spreads and evaluation order", (t) => {
    const result = compileSource(`
        type Pair = [number, number];
        let selected: Pair = [1, 10];
        const original = selected;
        const tail: readonly Pair[] = [[4, 40], [1, 11]];
        let calls = 0;
        function replace(): Pair {
            calls++;
            selected = [2, 20];
            original[1] = 12;
            return [3, 30];
        }
        const map = new Map([selected, replace(), ...tail]);
        if (calls !== 1 || map.size !== 3 || map.get(1) !== 11 || map.has(2) ||
            map.get(3) !== 30 || [...map.keys()].join() !== "1,3,4")
            throw new Error("iterable order and pair owners");
        const aliases: Pair[] = [original];
        function mutate(): Pair { original[0] = 5; return [6, 60]; }
        const late = new Map([...aliases, mutate()]);
        if (late.has(1) || late.get(5) !== 12 || late.get(6) !== 60)
            throw new Error("pairs read after iterable evaluation");
        let key = 7;
        function next(): number { key = 8; return 70; }
        const mixed = new Map([[key, next()], selected]);
        if (mixed.get(7) !== 70 || mixed.has(8) || mixed.get(2) !== 20)
            throw new Error("literal lanes snapshot before later effects");
        const child = {count: 1};
        const stored: readonly [string, typeof child] = ["child", child];
        const objects = new Map([stored, ...[stored]]);
        objects.get("child")!.count++;
        if (objects.size !== 1 || objects.get("child") !== child || child.count !== 2)
            throw new Error("stored value identity");
    `);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "collection-constructor-inputs", result.cpp);
});

test("collection constructors evaluate absent iterables once and create fresh owners", (t) => {
    const result = compileSource(`
        let calls = 0;
        function absent(): undefined { calls++; return undefined; }
        function nil(): null { calls++; return null; }
        const map = new Map<string, number>(nil());
        const other = new Map<string, number>(absent());
        const set = new Set<number>(absent());
        const weakMap = new WeakMap<object, number>(null);
        const weakSet = new WeakSet<{id: number}>(undefined);
        map.set("x", 3);
        set.add(4);
        if (calls !== 3 || map === other || other.size !== 0 || map.get("x") !== 3 || !set.has(4))
            throw new Error("absent initialization");
        const key = {id: 1};
        weakMap.set(key, 5);
        weakSet.add(key);
        if (weakMap.get(key) !== 5 || !weakSet.has(key)) throw new Error("empty weak owners");
    `);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "collection-constructor-absent", result.cpp);
});

test("Map constructors copy optional iterable owners and preserve entry values", (t) => {
    const result = compileSource(`
        interface Item { count: number; }
        function copy(entries?: readonly (readonly [string, Item])[] | null) {
            return new Map(entries);
        }
        const factories: Array<typeof copy> = [copy];
        const child = {count: 2};
        const input: readonly (readonly [string, Item])[] = [["key", child]];
        const present = factories[0]!(input);
        if (factories[0]!().size !== 0 || factories[0]!(null).size !== 0 || present.get("key") !== child)
            throw new Error("optional iterable");
        present.get("key")!.count++;
        if (child.count !== 3 || input.length !== 1) throw new Error("entry identity");
        let calls = 0;
        function maybe(): Map<string, Item> | null {
            calls++;
            return calls % 2 ? present : null;
        }
        const first = new Map(maybe()), second = new Map(maybe());
        first.delete("key");
        if (calls !== 2 || first.size !== 0 || second.size !== 0 || !present.has("key"))
            throw new Error("one evaluation and distinct map owner");
    `);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "collection-constructor-optional", result.cpp);
});
