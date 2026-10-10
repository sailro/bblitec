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
        Object.defineProperty(target, "x", {
            get(this: State) { return this.base * 3; }, enumerable: true, configurable: true,
        });
        alias.x = 9;
        if (target.base !== 9 || target.x !== 27 || oldSetterCalls !== 2)
            throw new Error("omitted setter retained");
        let denied = false;
        try { alias.y = 99; } catch { denied = true; }
        if (!denied || alias.y !== 11) throw new Error("getter-only write");
        Object.defineProperty(target, "x", {value: 25, writable: true, enumerable: true, configurable: true});
        if (alias.x !== 25 || oldSetterCalls !== 2) throw new Error("definition ran old setter");
        alias.x = 30;
        if (target.x !== 30 || oldSetterCalls !== 2) throw new Error("data descriptor remained an accessor");
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

test("nonconfigurable properties retain per-object state, writable data and failed redefinitions", (t) => {
    const source = `
        interface State { x: number; y: number; }
        const locked: State = {x: 1, y: 2};
        const ordinary: State = {x: 3, y: 4};
        const alias = locked;
        Object.defineProperty(locked, "x", {value: 5, writable: true, enumerable: true, configurable: false});
        alias.x = 6;
        Object.assign(locked, {x: 7});
        if (alias.x !== 7) throw new Error("writable data");
        Object.defineProperty(locked, "x", {value: 8, writable: true, enumerable: true, configurable: false});
        let denied = 0;
        try {
            Object.defineProperty(locked, "x", {value: 9, writable: true, enumerable: true, configurable: true});
        } catch { denied++; }
        try {
            Object.defineProperty(locked, "x", {get: () => 10, enumerable: true, configurable: false});
        } catch { denied++; }
        if (denied !== 2 || alias.x !== 8) throw new Error("data redefinition");
        Object.defineProperty(ordinary, "x", {get: () => 11, enumerable: true, configurable: true});
        Object.defineProperty(ordinary, "x", {value: 12, writable: true, enumerable: true, configurable: true});
        if (ordinary.x !== 12) throw new Error("independent descriptor state");
        let current = 13;
        let reads = 0;
        Object.defineProperty(locked, "y", {
            get: () => { reads++; return current; }, enumerable: true, configurable: false,
        });
        current = 14;
        if (alias.y !== 14 || reads !== 1) throw new Error("live accessor");
        try {
            Object.defineProperty(locked, "y", {get: () => 15, enumerable: true, configurable: false});
        } catch { denied++; }
        try {
            Object.defineProperty(locked, "y", {value: 16, writable: true, enumerable: true, configurable: false});
        } catch { denied++; }
        try { Object.assign(locked, {y: 17}); } catch { denied++; }
        if (denied !== 5 || alias.y !== 14 || reads !== 2) throw new Error("accessor redefinition");
        const copy: State = {...locked};
        if (reads !== 3 || copy.x !== 8 || copy.y !== 14) throw new Error("spread getter");
        Object.defineProperty(copy, "x", {value: 18, writable: true, enumerable: true, configurable: true});
        Object.defineProperty(copy, "y", {value: 19, writable: true, enumerable: true, configurable: true});
        if (copy.x !== 18 || copy.y !== 19 || Object.keys(locked).join() !== "x,y")
            throw new Error("fresh spread attributes");
        let collected = 0;
        function value(n: number): number { collected++; return n; }
        try {
            Object.defineProperties(locked, {
                x: {value: value(20), writable: true, enumerable: true, configurable: false},
                y: {value: value(21), writable: true, enumerable: true, configurable: false},
            });
        } catch { denied++; }
        if (collected !== 2 || denied !== 6 || locked.x !== 20 || locked.y !== 14)
            throw new Error("collected descriptors and partial application");
        const writableAccessor: State = {x: 0, y: 0};
        Object.defineProperty(writableAccessor, "x", {
            get(this: State) { return this.y; },
            set(this: State, value: number) { this.y = value; },
            enumerable: true, configurable: false,
        });
        writableAccessor.x = 22;
        Object.assign(writableAccessor, {x: 23});
        if (writableAccessor.x !== 23 || writableAccessor.y !== 23)
            throw new Error("nonconfigurable setter");
        try {
            Object.defineProperty(writableAccessor, "x", {
                get(this: State) { return this.y; },
                set(this: State, value: number) { this.y = value + 1; },
                enumerable: true, configurable: false,
            });
        } catch { denied++; }
        writableAccessor.x = 24;
        if (denied !== 7 || writableAccessor.y !== 24) throw new Error("original setter retained");
    `;
    runInNewContext('"use strict";' + ts.transpile(source));
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        native,
        "object-definition-nonconfigurable",
        result.cpp,
    );
});

test("Object.assign evaluates owners and arguments before descriptor copy effects", (t) => {
    const source = `
        const locked = {x: 0, y: 0};
        Object.defineProperty(locked, "x", {get: () => 1, enumerable: true, configurable: false});
        let effects = 0;
        function next() { effects++; return {y: 2}; }
        let caught = false;
        try { Object.assign(locked, {x: 3}, next()); } catch { caught = true; }
        if (!caught || effects !== 1 || locked.y !== 0) throw new Error("argument effects before setter");

        let target = {x: 0};
        const original = target;
        Object.defineProperty(original, "x", {value: 0, writable: true, enumerable: true, configurable: false});
        function reseat() { target = {x: 5}; return {x: 7}; }
        const assigned = Object.assign(target, reseat());
        if (assigned !== original || original.x !== 7 || target.x !== 5) throw new Error("held target");

        const early = {x: 1};
        function mutate() { early.x = 9; return {y: 10}; }
        const result = {x: 0, y: 0};
        Object.defineProperty(result, "x", {value: 0, writable: true, enumerable: true, configurable: false});
        Object.assign(result, early, mutate());
        if (result.x !== 9 || result.y !== 10) throw new Error("held source identity");

        let reads = 0;
        const getterSource = {x: 0};
        Object.defineProperty(getterSource, "x", {get: () => { reads++; return effects; }, enumerable: true, configurable: true});
        Object.assign(result, getterSource, next());
        if (reads !== 1 || result.x !== 2 || result.y !== 2) throw new Error("getter after arguments");
    `;
    runInNewContext('"use strict";' + ts.transpile(source));
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "object-assign-descriptor-order", result.cpp);
});

test("property definitions refuse descriptor attributes and layouts without native semantics", () => {
    const cases = [
        [
            "{x: {value: 1, writable: false, enumerable: true, configurable: true}}",
            /descriptor attribute 'writable'/,
        ],
        [
            "{x: {value: 1, writable: true, enumerable: true}}",
            /explicit boolean configurable/,
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
});
