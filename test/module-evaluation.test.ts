import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("an import used only as a type does not run its module", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/module-evaluation");
    mkdirSync(directory, { recursive: true });
    const write = (name: string, source: string): void =>
        writeFileSync(resolve(directory, name), source);
    write("log.ts", "export const log: string[] = [];");
    write(
        "opts.ts",
        'import { log } from "./log.js";\nexport interface Opts { a: number }\nlog.push("opts");',
    );
    write(
        "effects.ts",
        'import { log } from "./log.js";\nlog.push("effects");\nexport const value = 7;\nexport class Base { kind(): string { return "base"; } }\nexport interface Shape { n: number }',
    );
    write("types.ts", 'export type { Shape } from "./effects.js";');
    const { cpp } = compileSource(
        `import { log } from "./log.js";
        import { Opts } from "./opts.js";
        import "./effects.js";
        import { Base } from "./effects.js";
        import * as ns from "./effects.js";
        import { Shape } from "./types.js";
        class Derived extends Base {}
        const o: Opts = { a: 1 };
        const s: Shape = { n: ns.value };
        if (o.a !== 1 || s.n !== 7 || new Derived().kind() !== "base" || log.join() !== "effects")
            throw new Error("module evaluation: " + log.join());`,
        { fileName: resolve(directory, "entry.ts") },
    );
    runGeneratedProgram(tools, "module-evaluation", cpp, {});
});

test("an imported record's member kept by another owner is the same object", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/module-kept-members");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        resolve(directory, "config.ts"),
        "export const CFG = { a: { n: 1 }, b: { n: 1 }, c: { n: 1 } };",
    );
    const { cpp } = compileSource(
        `import { CFG } from "./config.js";
        class H { constructor(public o: { n: number }) {} bump(): void { this.o.n++; } }
        new H(CFG.a).bump();
        const holder = { o: CFG.b };
        holder.o.n = 3;
        const list: { n: number }[] = [];
        list.push(CFG.c);
        list[0]!.n = 4;
        if (CFG.a.n !== 2 || CFG.b.n !== 3 || CFG.c.n !== 4)
            throw new Error("kept members " + CFG.a.n + CFG.b.n + CFG.c.n);`,
        { fileName: resolve(directory, "entry.ts") },
    );
    runGeneratedProgram(tools, "module-kept-members", cpp, {});
});

test("an imported container kept by another owner is the same object", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/module-kept-containers");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        resolve(directory, "registry.ts"),
        'export const held: string[] = [];\nexport const pushed: string[] = [];\nexport const built: string[] = [];\nfunction entries(): [string, number][] { return [["a", 1]]; }\nexport const M = new Map(entries());',
    );
    const { cpp } = compileSource(
        `import { held, pushed, built, M } from "./registry.js";
        class Box { constructor(public items: string[]) {} add(v: string): void { this.items.push(v); } }
        const holder = { list: held };
        holder.list.push("x");
        const lists: string[][] = [];
        lists.push(pushed);
        lists[0]!.push("y");
        new Box(built).add("z");
        let view = new Map<string, number>();
        view = M;
        view.set("a", 2);
        if (held.length !== 1 || pushed.length !== 1 || built.length !== 1 || M.get("a") !== 2)
            throw new Error("kept containers " + held.length + pushed.length + built.length + M.get("a"));`,
        { fileName: resolve(directory, "entry.ts") },
    );
    runGeneratedProgram(tools, "module-kept-containers", cpp, {});
});

test("a module constant a rebound local only reads stays folded", (t) => {
    const directory = resolve("artifacts/module-rebound-reader");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        resolve(directory, "sizes.ts"),
        "let reads = 0;\nconst SIZES = [4, 5];\nexport function firstSize(): number {\n    reads++;\n    let current: readonly number[] = [];\n    current = SIZES;\n    return current[0]! + reads;\n}",
    );
    const { cpp } = compileSource(
        `import { firstSize } from "./sizes.js";
        if (firstSize() !== 5) throw new Error("rebound reader");`,
        { fileName: resolve(directory, "entry.ts") },
    );
    // Rebinding `current` writes the name, not the array it held.
    assert.doesNotMatch(cpp, /SIZES/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "module-rebound-reader", cpp, {});
});

test("an imported constant array read past its end yields the source's default", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/module-constant-default");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        resolve(directory, "hot.ts"),
        "export enum B { A = 1, C = 2, D = 3 }\nexport const HOT: B[] = [B.A, B.C];",
    );
    const { cpp } = compileSource(
        `import { B, HOT } from "./hot.js";
        class Slots { slot = 0; pick(): B { return HOT[this.slot] ?? B.D; } }
        const slots = new Slots();
        slots.slot = 1;
        const inRange = slots.pick();
        slots.slot = 5;
        if (slots.pick() !== B.D || inRange !== B.C) throw new Error("imported default " + slots.pick());`,
        { fileName: resolve(directory, "entry.ts") },
    );
    runGeneratedProgram(tools, "module-constant-default", cpp, {});
});
