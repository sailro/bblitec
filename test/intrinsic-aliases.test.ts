import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

test("namespace members and immutable function aliases use pinned intrinsic lowering", () => {
    const result = compileSource(`
        import * as lite from "babylon-lite";
        const start = lite.createEngine;
        const makeNode = (lite as unknown as { createTransformNode?: (name: string) => unknown }).createTransformNode;
        const alias = makeNode;
        const canvas = document.getElementById("canvas") as HTMLCanvasElement;
        const engine = await start(canvas);
        alias?.("root");
        lite["createTransformNode"]("child");
        function local(): number {
            const lite = { createTransformNode: (name: string): number => name.length };
            return lite.createTransformNode("local");
        }
        if (local() !== 5) throw new Error("namespace shadow");
    `);
    assert.match(result.cpp, /bbl::create_engine/);
    assert.match(result.cpp, /bbl::create_transform_node/);
    assert.equal((result.cpp.match(/bbl::create_transform_node\(/g) ?? []).length, 2);
});
