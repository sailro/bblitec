import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { FunctionSpecializations } from "../src/compiler/function-specializations.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const controls = `
    import { createEngine, createBox, createStandardMaterial, markMaterialUboDirty, type Mesh } from "@babylonjs/lite";
    async function main() {
        const engine = await createEngine({});
        let total = 0;
        let argumentCalls = 0;
        function argument(n: number): number { argumentCalls++; return n; }
        function drain(n: number): void { if (n <= 0) return; total += n; drain(n - 1); }
        drain(argument(3));
        const unrelated = 100;
        drain(argument(4));
        if (total !== 16 || unrelated !== 100 || argumentCalls !== 2) throw new Error("recursive capture");
        const mesh = createBox(engine);
        class Stepper {
            constructor(public mesh: Mesh) {}
            walk(n: number): void { if (n <= 0) return; this.mesh.position.x += n; this.walk(n - 1); }
        }
        const stepper = new Stepper(mesh);
        stepper.walk(argument(3));
        stepper.walk(argument(4));
        if (mesh.position.x !== 16 || argumentCalls !== 4) throw new Error("recursive receiver");
        { drain(1); }
        { drain(2); }
        if (total !== 20) throw new Error("sibling scope");
        function move(target: Mesh, amount: number): number {
            if (amount < 0) throw new Error("shared move body");
            target.position.x += amount;
            return target.position.x;
        }
        const first = move(mesh, argument(2));
        const second = move(mesh, argument(3));
        if (first !== 18 || second !== 21 || argumentCalls !== 6) throw new Error("shared values");
        const other = createBox(engine);
        move(other, 5);
        class Mover {
            constructor(public mesh: Mesh) {}
            move(amount: number): number {
                if (amount < 0) throw new Error("shared method body");
                this.mesh.position.x += amount;
                return this.mesh.position.x;
            }
            copy(source: Mesh): void {
                this.mesh.position.y = source.position.x;
            }
            before(limit: number): boolean {
                this.mesh.position.z += 1;
                return this.mesh.position.z < limit;
            }
        }
        const mover = new Mover(mesh);
        const third = mover.move(argument(4));
        const fourth = mover.move(argument(5));
        if (third !== 25 || fourth !== 30 || other.position.x !== 5 || argumentCalls !== 8)
            throw new Error("shared receiver");
        mover.copy(other);
        other.position.x = 8;
        mover.copy(other);
        let iterations = 0;
        while (mover.before(4)) iterations++;
        if (mesh.position.y !== 8 || mesh.position.z !== 4 || iterations !== 3)
            throw new Error("shared method arguments and condition");
        let rounds = 0;
        function recursiveRounds(depth: number): void {
            if (depth <= 0) return;
            for (let index = 0; index < 3; index++) {
                rounds++;
                recursiveRounds(depth - 1);
            }
        }
        recursiveRounds(2);
        if (rounds !== 12) throw new Error("recursive loop bindings");
        class StoredMover {
            value: number;
            constructor(value: number) { this.value = value; this.shift(1); }
            shift(amount: number): void { this.value += amount; mesh.position.z = this.value; }
        }
        const movers = [new StoredMover(10), new StoredMover(20)];
        function runtimeIndex(): number { return 0; }
        const selectedIndex = runtimeIndex();
        movers[selectedIndex]!.shift(2);
        movers[selectedIndex + 1]!.shift(3);
        if (movers[0]!.value !== 13 || movers[1]!.value !== 24 || mesh.position.z !== 24)
            throw new Error("stored receivers");
        function mutualFirst(target: Mesh, count: number): void {
            if (count <= 0) return;
            target.position.x += 1;
            mutualSecond(target, count);
        }
        function mutualSecond(target: Mesh, count: number): void {
            const next = count - 1;
            mutualFirst(target, next);
        }
        mutualFirst(other, 3);
        if (other.position.x !== 11) throw new Error("recursive reference arguments");
        const records = new Map<string, { amount: number }>();
        records.set("a", { amount: 30 });
        records.set("b", { amount: 40 });
        for (const [key, record] of records) {
            function applyRecord(): void {
                mesh.position.z = record.amount;
                record.amount += key.length;
            }
            applyRecord();
            applyRecord();
        }
        if (records.get("a")!.amount !== 32 || records.get("b")!.amount !== 42 || mesh.position.z !== 41)
            throw new Error("map receiver captures");
        function touchTuple(tuple: [number, number, number]): void {
            tuple[0] += 1;
            mesh.position.z = tuple[0];
        }
        touchTuple([2, 3, 4]);
        if (mesh.position.z !== 3) throw new Error("temporary tuple argument");
        const tuple: [number, number, number] = [8, 9, 10];
        touchTuple(tuple);
        if (tuple[0] !== 9 || mesh.position.z !== 9) throw new Error("borrowed tuple argument");
        class Colors {
            rgb: [number, number, number] = [0.1, 0.2, 0.3];
        }
        const colors = new Colors();
        const material = createStandardMaterial();
        material.emissiveColor = colors.rgb;
        const refresh = (): void => {
            colors.rgb[0] = 0.75;
            markMaterialUboDirty(material);
        };
        const callbacks: (() => void)[] = [refresh];
        callbacks[runtimeIndex()]!();
        if (colors.rgb[0] !== 0.75)
            throw new Error("retained material array");
    }
`;

test("recursive specializations share bodies within their native scope", () => {
    const result = compileSource(controls);
    assert.equal(result.cpp.match(/make_recursive_group\(/g)?.length, 6);
    assert.equal(result.cpp.match(/"shared move body"/g)?.length, 1);
    assert.equal(result.cpp.match(/"shared method body"/g)?.length, 1);
    assert.match(result.cpp, /storedmover_receiver/);
});

test("specialization snapshots distinguish changed facts, aliases and scopes", () => {
    const cache = new FunctionSpecializations<string>();
    const scope = { lexical: {}, emission: 0, block: 0, continuation: -1 };
    const metadata = { kind: "mesh", cpp: "mesh", sceneMeshIndex: 1 };
    const before = cache.key(scope, [metadata]);
    assert.equal(before, cache.key(scope, [{ ...metadata }]));
    metadata.sceneMeshIndex = 2;
    assert.notEqual(before, cache.key(scope, [metadata]));
    assert.notEqual(cache.key(scope, [metadata]), cache.key({ ...scope, emission: 1 }, [metadata]));
    assert.notEqual(cache.key(scope, [metadata]), cache.key({ ...scope, block: 1 }, [metadata]));
    assert.notEqual(cache.key(scope, [metadata]), cache.key({ ...scope, continuation: 1 }, [metadata]));
    assert.notEqual(cache.key(scope, [metadata, metadata]), cache.key(scope, [metadata, { ...metadata }]));
    assert.notEqual(cache.key(scope, [0]), cache.key(scope, [-0]));
    assert.notEqual(cache.key(scope, [Symbol("same")]), cache.key(scope, [Symbol("same")]));
    assert.notEqual(cache.key(scope, [new Uint8Array([1])]), cache.key(scope, [new Int8Array([1])]));
    const buffer = new Uint8Array([1]).buffer;
    const original = cache.key(scope, [buffer]);
    new Uint8Array(buffer)[0] = 2;
    assert.notEqual(original, cache.key(scope, [buffer]));
    const key = Symbol("metadata");
    assert.notEqual(cache.key(scope, [{ [key]: 1 }]), cache.key(scope, [{ [key]: 2 }]));
});

test("escaping recursive groups share their traced callable within one scope", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            let calls = 0;
            function poll(): void {
                calls++;
                if (calls < 4) setTimeout(poll, 0);
            }
            poll();
            poll();
        }
    `);
    assert.equal(result.cpp.match(/make_gc_shared<bbl::js::Callback<void\(\)>>/g)?.length, 1);
});

const native = optionalNativeFixtureTools(false);
test("reused recursive groups retain live captures, receivers and sibling lifetimes", { skip: !native }, () => {
    const output = resolve("artifacts/function-specializations-check");
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(source, compileSource(controls).cpp + `
        namespace bbl {
            Engine create_engine(EngineOptions) { return {}; }
            MeshHandle create_box(Engine& engine, BoxOptions) { engine.meshes.emplace_back(); return {static_cast<std::uint32_t>(engine.meshes.size() - 1)}; }
            void mark_mesh_dirty(Engine&, MeshHandle) {}
            MaterialHandle create_standard_material(Engine& engine) { engine.materials.emplace_back(); return {static_cast<std::uint32_t>(engine.materials.size() - 1)}; }
            void mark_material_ubo_dirty(Engine& engine, MaterialHandle material) {
                if (std::abs(engine.materials[material.value].emissive_factor.r - 0.75f) > 0.000001f)
                    throw std::runtime_error("retained material array upload");
            }
        }
    `);
    runNativeFixtureCompiler(native!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native\\include", source]);
    execFileSync(executable, { encoding: "utf8" });
});
