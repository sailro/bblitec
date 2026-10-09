import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("arrays with wider annotations retain represented buffer owners through mutation", (t) => {
    const result = compileSource(`
        function check(first: Float32Array, second: Uint16Array): number {
            const values: Transferable[] = [first.buffer];
            const alias = values;
            if (alias.push(second.buffer, first.buffer) !== 3 || values.length !== 3)
                throw new Error("multi-push length and alias");
            for (let i = 0; i < 2; i++) values.push(second.buffer);
            if (Number(values.length) !== 5 || values[0] !== first.buffer || values[4] !== second.buffer)
                throw new Error("runtime mutation and identity");
            const removed = alias.splice(1, 1);
            if (removed[0] !== second.buffer || Number(values.length) !== 4 || values[1] !== first.buffer)
                throw new Error("splice shares stored owners");
            alias.reverse();
            if (values.shift() !== second.buffer || values.pop() !== first.buffer)
                throw new Error("reorder and removal");
            values.unshift(first.buffer, second.buffer);
            return values.length;
        }
        if (check(new Float32Array(2), new Uint16Array(3)) !== 4) throw new Error("result");
        let selected: Transferable[] = [new ArrayBuffer(1)];
        const original = selected;
        let calls = 0;
        function replace(): ArrayBuffer {
            calls++;
            selected = [new ArrayBuffer(2)];
            return new ArrayBuffer(3);
        }
        if (selected.push(replace()) !== 2 || calls !== 1 || original.length !== 2 || selected.length !== 1)
            throw new Error("receiver retained before argument effects");
        if ((original[1] as ArrayBuffer).byteLength !== 3 || (selected[0] as ArrayBuffer).byteLength !== 2)
            throw new Error("replacement owners");
    `);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "mutable-tuple-buffer-storage", result.cpp);
});

test("empty erased arrays support multi-argument mutation and preserve primitive tags", (t) => {
    const result = compileSource(`
        const values: unknown[] = [];
        const alias = values;
        if (values.push(NaN, -0, 0, null, undefined, "0", false) !== 7 || alias.length !== 7)
            throw new Error("erased array length");
        if (!Object.is(alias[0], NaN) || !Object.is(alias[1], -0) || Object.is(alias[2], -0) ||
            alias[3] !== null || alias[4] !== undefined || alias[5] !== "0" || alias[6] !== false)
            throw new Error("primitive values and absence tags");
        alias.splice(3, 2, true);
        if (values.length !== 6 || values[3] !== true || values[4] !== "0")
            throw new Error("erased splice");
    `);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "mutable-tuple-erased-storage", result.cpp);
});

test("represented initializer storage refuses writes outside its retained element type", () => {
    assert.throws(
        () =>
            compileSource(`
            const values: (ArrayBuffer | MessagePort | number)[] = [new ArrayBuffer(1)];
            values.push(3);
        `),
        /ArrayBuffer|arraybuffer|data type/,
    );
});
