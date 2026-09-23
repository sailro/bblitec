import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const nativeTools = optionalNativeFixtureTools(false);

test(
    "shared methods preserve narrowed optional record aliases",
    { skip: !nativeTools },
    () => {
        const result = compileSource(`
        interface Sector { floorHeight: number; ceilHeight: number; tag: number; }
        class Movers {
            dirty = false;
            private stepFloor(sector: { floorHeight: number }): void {
                sector.floorHeight -= 4;
                this.dirty = true;
            }
            private stepCeiling(sector: { ceilHeight: number }): void {
                sector.ceilHeight += 2;
                this.dirty = true;
            }
            tick(sectors: Sector[], index: number, floor: boolean): void {
                const sector = sectors[index];
                if (!sector) return;
                if (floor) this.stepFloor(sector);
                else this.stepCeiling(sector);
            }
        }
        const sectors: Sector[] = [{ floorHeight: 64, ceilHeight: 128, tag: 1 }];
        const alias = sectors[0]!;
        const movers = new Movers();
        for (let i = 0; i < 3; i++) movers.tick(sectors, 0, true);
        movers.tick(sectors, 0, false);
        movers.tick(sectors, 3, true);
        if (alias.floorHeight !== 52 || sectors[0]!.floorHeight !== 52 ||
            alias.ceilHeight !== 130 || alias.tag !== 1 || !movers.dirty)
            throw new Error("narrowed optional records must retain caller identity");
    `);
        const directory = resolve("artifacts/shared-method-optional-alias");
        mkdirSync(directory, { recursive: true });
        const source = join(directory, "check.cpp");
        const executable = join(directory, "check.exe");
        writeFileSync(source, result.cpp);
        runNativeFixtureCompiler(nativeTools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/permissive-",
            "/EHsc",
            `/Fo:${directory}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/include",
            source,
        ]);
        execFileSync(executable, { stdio: "pipe" });
    },
);

test(
    "shared data methods retain distinct receivers and live callback captures without expanding every call",
    { skip: !nativeTools },
    () => {
        const result = compileSource(`
        class Store {
            values: number[] = [2, 5, 9];
            read(index: number): number { return this.values[index]!; }
            fill(output: Set<number>): void { output.add(this.values[0]!); }
        }
        class Reader {
            private store: Store;
            bias = 1;
            constructor(store: Store) { this.store = store; }
            private apply(callback: (index: number) => number, count: number): number {
                let total = 0;
                for (let i = 0; i < count; i++) total += callback(i);
                return total;
            }
            compute(count: number): number {
                const lightingProbe = this.bias;
                const sample = (index: number): number => this.store.read(index) + lightingProbe;
                return this.apply(sample, count);
            }
            collect(output: Set<number>): void { this.store.fill(output); }
        }
        const firstStore = new Store();
        const secondStore = new Store();
        const first = new Reader(firstStore);
        const second = new Reader(secondStore);
        ${Array.from(
            { length: 12 },
            () => `
            if (first.compute(3) !== 19 || second.compute(2) !== 9)
                throw new Error("initial receiver state");
        `,
        ).join("\n")}
        firstStore.values[0] = 10;
        first.bias = 4;
        second.bias = 7;
        if (first.compute(3) !== 36 || second.compute(2) !== 21)
            throw new Error("live receiver and callback state");
        const output = new Set<number>();
        first.collect(output);
        second.collect(output);
        if (output.size !== 2 || !output.has(10) || !output.has(2))
            throw new Error("user methods named fill can mutate their arguments");
        class NativeOwner {
            count = 1;
            adjust(pair: [number, number]): number {
                this.count += pair[0];
                pair[1] += this.count;
                return pair[1];
            }
            run(): number { return this.adjust([2, 3]); }
        }
        const native = new NativeOwner();
        if (native.run() !== 6 || native.run() !== 8 || native.count !== 5)
            throw new Error("shared callees retain native method field channels");
    `);
        const bodies =
            result.cpp.match(/(?:const )?double v_\w+_lightingProbe =/g) ?? [];
        assert.ok(
            bodies.length > 0 && bodies.length <= 4,
            "the method body must be shared across repeated calls",
        );
        const directory = resolve("artifacts/shared-data-methods");
        mkdirSync(directory, { recursive: true });
        const source = join(directory, "check.cpp");
        const executable = join(directory, "check.exe");
        writeFileSync(source, result.cpp);
        runNativeFixtureCompiler(nativeTools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/permissive-",
            "/EHsc",
            `/Fo:${directory}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/include",
            source,
        ]);
        execFileSync(executable, { stdio: "pipe" });
    },
);
