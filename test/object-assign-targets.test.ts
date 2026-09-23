/**
 * `Object.assign` copies plain properties. A target without stored fields
 * refuses rather than erasing the statement and the writes it names.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

const scene = (body: string): string => `
    import { createBox, createEngine } from "@babylonjs/lite";
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const box = createBox(engine, { size: 1 });
        ${body}
    }
    void main();
`;

test("Object.assign into an engine handle refuses instead of erasing its writes", () => {
    assert.throws(
        () =>
            compileSource(scene(`Object.assign(box, { isVisible: false });`), {
                fileName: "assign-handle.ts",
            }),
        /Object\.assign cannot write into a mesh value/,
    );
});

test("Object.assign into a record still stores each field", () => {
    const result = compileSource(
        scene(`
            const state = { speed: 1, label: "a" };
            Object.assign(state, { speed: 2 });
            box.position.x = state.speed;
        `),
        { fileName: "assign-record.ts" },
    );
    assert.match(result.cpp, /position\.x = /);
});
