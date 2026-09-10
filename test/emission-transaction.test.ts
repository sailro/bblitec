import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { DataLowerer } from "../src/compiler/data-lowering.js";
import { emissionArray, EmissionMap, EmissionSet, EmissionTransaction, EmissionWeakMap, EmissionWeakSet } from "../src/compiler/emission-transaction.js";

test("declined emission restores object graphs and shared identities in place", () => {
    const symbol = Symbol("nested");
    const row = { count: 1 }, key = {};
    const state = { next: 2, body: ["before"], rows: new Map([[key, row]]), marks: new Set([key]),
        bytes: new Uint8Array([1, 2]), [symbol]: { enabled: true } };
    const alias = state.rows, rowAlias = row;
    new EmissionTransaction(state).run(() => {
        state.next = 99;
        state.body.push("declined");
        state.rows.delete(key);
        state.rows.set({}, { count: 8 });
        row.count = 7;
        state.marks.clear();
        state.bytes[0] = 9;
        state[symbol].enabled = false;
        Object.assign(state, { leaked: true });
        return undefined;
    }, value => value !== undefined);
    assert.equal(state.next, 2);
    assert.deepEqual(state.body, ["before"]);
    assert.equal(state.rows, alias);
    assert.equal(state.rows.get(key), rowAlias);
    assert.deepEqual([...state.rows.values()], [{ count: 1 }]);
    assert.deepEqual([...state.marks], [key]);
    assert.deepEqual([...state.bytes], [1, 2]);
    assert.equal(state[symbol].enabled, true);
    assert.equal("leaked" in state, false);
});

test("nested commits remain reversible by their enclosing probe", () => {
    const state = { values: [1] };
    new EmissionTransaction(state).run(() => {
        state.values.push(2);
        new EmissionTransaction(state).run(() => { state.values.push(3); return true; }, Boolean);
        assert.deepEqual(state.values, [1, 2, 3]);
        new EmissionTransaction(state).run(() => { state.values.length = 0; return false; }, Boolean);
        assert.deepEqual(state.values, [1, 2, 3]);
        return false;
    }, Boolean);
    assert.deepEqual(state.values, [1]);
    new EmissionTransaction(state).run(() => { state.values.push(4); return true; }, Boolean);
    assert.deepEqual(state.values, [1, 4]);
});

test("throwing probes and answer predicates restore state and release the transaction", () => {
    const state = { next: 0 };
    assert.throws(() => new EmissionTransaction(state).run(() => {
        state.next++;
        throw new Error("probe");
    }, Boolean), /probe/);
    assert.equal(state.next, 0);
    assert.throws(() => new EmissionTransaction(state).run(() => ++state.next, () => {
        throw new Error("answer");
    }), /answer/);
    assert.equal(state.next, 0);
    new EmissionTransaction(state).run(() => ++state.next, Boolean);
    assert.equal(state.next, 1);
});

test("weak entries and mutations of cached values participate in nested transactions", () => {
    const key = {}, added = {}, value = { count: 1 };
    const map = new EmissionWeakMap([[key, value]]), set = new EmissionWeakSet([key]);
    new EmissionTransaction({}).run(() => {
        map.get(key)!.count++;
        map.set(added, { count: 3 });
        set.delete(key);
        set.add(added);
        new EmissionTransaction({}).run(() => {
            map.delete(key);
            map.get(added)!.count++;
            set.add(key);
            return true;
        }, Boolean);
        return false;
    }, Boolean);
    assert.equal(map.get(key), value);
    assert.equal(value.count, 1);
    assert.equal(map.has(added), false);
    assert.equal(set.has(key), true);
    assert.equal(set.has(added), false);
});

test("strong collection rollback preserves iteration order and aliased values", () => {
    const first = { count: 1 }, second = { count: 2 };
    const map = new EmissionMap([["first", first], ["second", second]]);
    const set = new EmissionSet([first, second]);
    new EmissionTransaction({ map, set }).run(() => {
        map.delete("first");
        map.set("third", { count: 3 });
        map.values().next().value!.count = 20;
        set.delete(first);
        set.add({ count: 3 });
        return false;
    }, Boolean);
    assert.deepEqual([...map.keys()], ["first", "second"]);
    assert.deepEqual([...map.values()], [first, second]);
    assert.deepEqual([...set], [first, second]);
    assert.equal(second.count, 2);
    new EmissionTransaction({ map, set }).run(() => {
        new EmissionTransaction({}).run(() => { map.clear(); set.clear(); return true; }, Boolean);
        return false;
    }, Boolean);
    assert.deepEqual([...map.keys()], ["first", "second"]);
    assert.deepEqual([...set], [first, second]);
});

test("array journals restore overwritten slots, holes, truncation and nested writes", () => {
    const entry = { count: 1 }, entries = emissionArray([entry]);
    entries.length = 3;
    const expected = entries.slice();
    new EmissionTransaction({ entries }).run(() => {
        entries[0]!.count = 2;
        entries.push({ count: 4 });
        entries[1] = { count: 3 };
        new EmissionTransaction({}).run(() => {
            entries.splice(0, 2, { count: 9 });
            return true;
        }, Boolean);
        entries.length = 0;
        return false;
    }, Boolean);
    assert.deepEqual(entries, expected);
    assert.equal(entries[0], entry);
    assert.equal(entry.count, 1);
    assert.equal(1 in entries, false);
    assert.equal(2 in entries, false);
});

test("binding an existing value inside a probe captures later writes through that alias", () => {
    const value = { count: 1 }, cache = new EmissionMap([["existing", value]]);
    new EmissionTransaction({ cache }).run(() => {
        const locals = new EmissionMap<string, { value: typeof value }>();
        locals.set("parameter", { value });
        value.count = 2;
        return false;
    }, Boolean);
    assert.equal(value.count, 1);
});

test("checker-owned inputs retain their caches while compiler state rolls back", () => {
    const source = ts.createSourceFile("input.ts", "const x = 1;", ts.ScriptTarget.Latest, true);
    const external = { cached: false };
    const state = { source, external, compiled: false };
    new EmissionTransaction(state, [external]).run(() => {
        external.cached = true;
        state.compiled = true;
        return false;
    }, Boolean);
    assert.equal(external.cached, true);
    assert.equal(state.source, source);
    assert.equal(state.compiled, false);
});

test("a declined resource-producing probe leaves generated code and composition unchanged", () => {
    const source = `
        import { createEngine, createBox } from "@babylonjs/lite";
        const engine = await createEngine({});
        function speculative() { return createBox(engine); }
        const values = new Uint8Array([1, 2]);
        const total = values[0]! + values[1]!;
        if (total !== 3) throw new Error("Unexpected sum");
    `;
    const expected = compileSource(source);
    const original = DataLowerer.prototype.compileDataPath;
    let injected = false;
    DataLowerer.prototype.compileDataPath = function (expression, mode) {
        if (!injected && ts.isIdentifier(expression) && expression.text === "values" &&
            this.context.lookupOptional(expression)?.kind === "data") {
            injected = true;
            const declaration = this.context.sourceFile.statements.find(ts.isFunctionDeclaration);
            const returned = declaration?.body?.statements.find(ts.isReturnStatement)?.expression;
            assert.ok(returned);
            this.context.probeEmission(() => {
                this.context.compileValue(returned);
                this.context.allocateTemporaryCppName("declined");
                return undefined;
            });
        }
        return original.call(this, expression, mode);
    };
    try {
        const actual = compileSource(source);
        assert.equal(injected, true);
        assert.deepEqual(actual, expected);
    } finally {
        DataLowerer.prototype.compileDataPath = original;
    }
});
