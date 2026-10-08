import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("property definitions collect values before applying and retain the evaluated target", (t) => {
    const source = `
        interface State { x: number; y: number; }
        let target: State = {x: 1, y: 2};
        const original = target;
        const order: string[] = [];
        function receiver(): State { order.push("target"); return target; }
        function first(): number { order.push("first"); return 10; }
        function second(): number {
            order.push("second");
            const before = original.x;
            target = {x: 100, y: 200};
            return before;
        }
        const result = Object.defineProperties(receiver(), {
            x: {value: first(), writable: true, enumerable: true, configurable: true},
            y: {value: second(), writable: true, enumerable: true, configurable: true},
        });
        if (result !== original || original.x !== 10 || original.y !== 1 || target.x !== 100)
            throw new Error("collection or target identity");
        if (order.join() !== "target,first,second") throw new Error("argument order");
        function failure(flag: boolean): number { if (flag) throw new Error("stop"); return 9; }
        let caught = false;
        try {
            Object.defineProperties(original, {
                x: {value: 30, writable: true, enumerable: true, configurable: true},
                y: {value: failure(true), writable: true, enumerable: true, configurable: true},
            });
        } catch { caught = true; }
        if (!caught || original.x !== 10 || original.y !== 1) throw new Error("partial definition");
        Object.defineProperty(original, "x", {value: 40, writable: true, enumerable: true, configurable: true});
        if (result.x !== 40) throw new Error("single definition identity");
        Object.defineProperty(receiver(), (order.push("key"), "x"), {
            value: first(), writable: true, enumerable: true, configurable: true,
        });
        if (order.join() !== "target,first,second,target,key,first" || target.x !== 10)
            throw new Error("single definition evaluation order");
    `;
    runInNewContext(ts.transpile(source));
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "object-definition-order", result.cpp);
});

test("defined accessors preserve receivers, captures and replacement semantics", (t) => {
    const source = `
        interface State { x: number; y: number; base: number; }
        const target: State = {x: 1, y: 2, base: 3};
        const alias = target;
        let reads = 0;
        let current = 7;
        let oldSetterCalls = 0;
        const returned = Object.defineProperties(target, {
            x: {
                enumerable: true, configurable: true,
                get(this: State) { reads++; return this.base * 2; },
                set(this: State, value: number) { oldSetterCalls++; this.base = value; },
            },
            y: {enumerable: true, configurable: true, get: () => current},
        });
        if (returned !== alias || reads !== 0 || alias.x !== 6 || reads !== 1 || alias.y !== 7)
            throw new Error("accessor installation");
        alias.x = 8;
        current = 11;
        if (target.base !== 8 || target.x !== 16 || target.y !== 11 || oldSetterCalls !== 1)
            throw new Error("receiver or capture");
        let denied = false;
        try { alias.y = 99; } catch { denied = true; }
        if (!denied || alias.y !== 11) throw new Error("getter-only write");
        Object.defineProperty(target, "x", {value: 25, writable: true, enumerable: true, configurable: true});
        if (alias.x !== 25 || oldSetterCalls !== 1) throw new Error("definition ran old setter");
        alias.x = 30;
        if (target.x !== 30 || oldSetterCalls !== 1) throw new Error("data descriptor remained an accessor");
        Object.defineProperties(target, {
            y: {enumerable: true, configurable: true, get: () => current + 1},
        });
        current = 20;
        if (alias.y !== 21 || Object.keys(target).join() !== "x,y,base") throw new Error("replacement");
    `;
    runInNewContext('"use strict";' + ts.transpile(source));
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "object-definition-accessors", result.cpp);
});

test("property definitions refuse descriptor attributes and layouts without native semantics", () => {
    const cases = [
        [
            "{x: {value: 1, writable: true, enumerable: true, configurable: false}}",
            /descriptor attribute 'configurable'/,
        ],
        [
            "{x: {value: 1, writable: true, enumerable: true}}",
            /writable, enumerable and configurable all true/,
        ],
        [
            "{x: {get: () => 1, enumerable: true, configurable: true, writable: true}}",
            /combine data and accessor/,
        ],
        [
            "{x: {set: (v: number) => {}, enumerable: true, configurable: true}}",
            /setter-only/,
        ],
        [
            "{x: {get: () => 1, enumerable: false, configurable: true}}",
            /descriptor attribute 'enumerable'/,
        ],
        [
            "{get x() { return {value: 1, writable: true, enumerable: true, configurable: true}; }}",
            /literal property keys/,
        ],
        ["{x: descriptor}", /literal property descriptors/],
    ] as const;
    for (const [descriptors, message] of cases)
        assert.throws(
            () =>
                compileSource(`
                const target: {x: number} = {x: 0};
                const descriptor = {value: 1, writable: true, enumerable: true, configurable: true};
                Object.defineProperties(target, ${descriptors});
            `),
            message,
        );
    assert.throws(
        () =>
            compileSource(`
            const target: {x?: number} = {};
            Object.defineProperties(target, {x: {get: () => 1, enumerable: true, configurable: true}});
        `),
        /accessor property that is always own/,
    );
    assert.throws(
        () =>
            compileSource(`
            const target: {x: number} = {x: 0};
            Object.defineProperties(target, {x: {
                get: () => 1, set: (value: number) => {}, enumerable: true, configurable: true,
            }});
            Object.defineProperties(target, {x: {get: () => 2, enumerable: true, configurable: true}});
        `),
        /explicit setter when the property can already hold one/,
    );
});
