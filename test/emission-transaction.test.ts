import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { DataLowerer } from "../src/compiler/data-lowering.js";
import {
    emissionArray,
    EmissionMap,
    emissionRecord,
    EmissionSet,
    EmissionTransaction,
    emissionTransactionStatistics,
    EmissionWeakMap,
    EmissionWeakSet,
    journaled,
    writable,
} from "../src/compiler/emission-transaction.js";

class Counter {
    @journaled public accessor next = 0;
    @journaled public accessor label: string | undefined;
}

function decline(probe: () => void): void {
    new EmissionTransaction().run(() => {
        probe();
        return false;
    }, Boolean);
}

test("declined emission restores every journaled container in place", () => {
    const symbol = Symbol("nested");
    const row: { readonly count: number } = { count: 1 },
        key = {};
    const counter = new Counter();
    const state = {
        body: emissionArray(["before"]),
        rows: new EmissionMap([[key, row]]),
        marks: new EmissionSet([key]),
        record: emissionRecord<Record<PropertyKey, unknown>>({
            [symbol]: true,
        }),
    };
    const rowsAlias = state.rows;
    decline(() => {
        counter.next = 99;
        counter.label = "declined";
        state.body.push("declined");
        state.rows.delete(key);
        state.rows.set({}, { count: 8 });
        writable(row).count = 7;
        state.marks.clear();
        state.record[symbol] = false;
        state.record.leaked = true;
    });
    assert.equal(counter.next, 0);
    assert.equal(counter.label, undefined);
    assert.deepEqual([...state.body], ["before"]);
    assert.equal(state.rows, rowsAlias);
    assert.equal(state.rows.get(key), row);
    assert.deepEqual([...state.rows.values()], [{ count: 1 }]);
    assert.deepEqual([...state.marks], [key]);
    assert.equal(state.record[symbol], true);
    assert.equal("leaked" in state.record, false);
});

test("opening a transaction copies nothing and a rollback replays only the probe's writes", () => {
    const counter = new Counter();
    const map = new EmissionMap<string, number>([["kept", 1]]);
    const before = emissionTransactionStatistics();
    new EmissionTransaction().run(() => false, Boolean);
    const idle = emissionTransactionStatistics();
    assert.equal(idle.journaledWrites, before.journaledWrites);
    decline(() => {
        counter.next = 1;
        counter.next = 1;
        map.set("kept", 1);
        map.set("added", 2);
    });
    const after = emissionTransactionStatistics();
    assert.deepEqual(
        {
            transactions: after.transactions - before.transactions,
            rollbacks: after.rollbacks - before.rollbacks,
            journaledWrites: after.journaledWrites - before.journaledWrites,
            undoneWrites: after.undoneWrites - before.undoneWrites,
        },
        { transactions: 2, rollbacks: 2, journaledWrites: 2, undoneWrites: 2 },
    );
    assert.equal(counter.next, 0);
    assert.deepEqual([...map], [["kept", 1]]);
});

test("nested commits remain reversible by their enclosing probe", () => {
    const values = emissionArray([1]);
    new EmissionTransaction().run(() => {
        values.push(2);
        new EmissionTransaction().run(() => {
            values.push(3);
            return true;
        }, Boolean);
        assert.deepEqual([...values], [1, 2, 3]);
        new EmissionTransaction().run(() => {
            values.length = 0;
            return false;
        }, Boolean);
        assert.deepEqual([...values], [1, 2, 3]);
        return false;
    }, Boolean);
    assert.deepEqual([...values], [1]);
    new EmissionTransaction().run(() => {
        values.push(4);
        return true;
    }, Boolean);
    assert.deepEqual([...values], [1, 4]);
});

test("throwing probes and answer predicates restore state and release the transaction", () => {
    const counter = new Counter();
    assert.throws(
        () =>
            new EmissionTransaction().run(() => {
                counter.next++;
                throw new Error("probe");
            }, Boolean),
        /probe/,
    );
    assert.equal(counter.next, 0);
    assert.throws(
        () =>
            new EmissionTransaction().run(
                () => ++counter.next,
                () => {
                    throw new Error("answer");
                },
            ),
        /answer/,
    );
    assert.equal(counter.next, 0);
    new EmissionTransaction().run(() => ++counter.next, Boolean);
    assert.equal(counter.next, 1);
});

test("weak entries and writable() records participate in nested transactions", () => {
    const key = {},
        added = {},
        value: { readonly count: number } = { count: 1 };
    const map = new EmissionWeakMap<object, { readonly count: number }>([
        [key, value],
    ]);
    const set = new EmissionWeakSet([key]);
    decline(() => {
        writable(map.get(key)!).count++;
        map.set(added, { count: 3 });
        set.delete(key);
        set.add(added);
        new EmissionTransaction().run(() => {
            map.delete(key);
            writable(map.get(added)!).count++;
            set.add(key);
            return true;
        }, Boolean);
    });
    assert.equal(map.get(key), value);
    assert.equal(value.count, 1);
    assert.equal(map.has(added), false);
    assert.equal(set.has(key), true);
    assert.equal(set.has(added), false);
});

test("strong collection rollback preserves iteration order and aliased values", () => {
    const first = { count: 1 },
        second: { readonly count: number } = { count: 2 };
    const map = new EmissionMap<string, { readonly count: number }>([
        ["first", first],
        ["second", second],
    ]);
    const set = new EmissionSet<object>([first, second]);
    decline(() => {
        map.delete("first");
        map.set("third", { count: 3 });
        map.set("first", first);
        writable(map.get("second")!).count = 20;
        set.delete(first);
        set.add({ count: 3 });
        set.add(first);
    });
    assert.deepEqual([...map.keys()], ["first", "second"]);
    assert.deepEqual([...map.values()], [first, second]);
    assert.deepEqual([...set], [first, second]);
    assert.equal(second.count, 2);
    decline(() => {
        new EmissionTransaction().run(() => {
            map.clear();
            set.clear();
            return true;
        }, Boolean);
    });
    assert.deepEqual([...map.keys()], ["first", "second"]);
    assert.deepEqual([...set], [first, second]);
});

test("array journals restore overwritten slots, holes, truncation and nested writes", () => {
    const entry: { readonly count: number } = { count: 1 },
        entries = emissionArray<{ readonly count: number }>([entry]);
    entries.length = 3;
    const expected = entries.slice();
    decline(() => {
        writable(entries[0]!).count = 2;
        entries.push({ count: 4 });
        entries[1] = { count: 3 };
        new EmissionTransaction().run(() => {
            entries.splice(0, 2, { count: 9 });
            return true;
        }, Boolean);
        entries.length = 0;
    });
    assert.deepEqual(entries, expected);
    assert.equal(entries[0], entry);
    assert.equal(entry.count, 1);
    assert.equal(1 in entries, false);
    assert.equal(2 in entries, false);
});

test("records restore a deleted key to its place in the key order", () => {
    const record = emissionRecord<Record<string, number>>({ a: 1, b: 2, c: 3 });
    const plain: { a?: number; readonly b: number; c?: number } = {
        a: 1,
        b: 2,
        c: 3,
    };
    decline(() => {
        delete record.a;
        record.b = 20;
        record.d = 4;
        delete writable(plain).a;
        writable(plain).c = 30;
    });
    assert.deepEqual(Object.entries(record), [
        ["a", 1],
        ["b", 2],
        ["c", 3],
    ]);
    assert.deepEqual(Object.entries(plain), [
        ["a", 1],
        ["b", 2],
        ["c", 3],
    ]);
});

test("containers created inside a probe journal only writes of transactions they predate", () => {
    const before = emissionTransactionStatistics().journaledWrites;
    let born: EmissionMap<string, number> | undefined;
    new EmissionTransaction().run(() => {
        born = new EmissionMap();
        born.set("inside", 1);
        assert.equal(emissionTransactionStatistics().journaledWrites, before);
        new EmissionTransaction().run(() => {
            born!.set("nested", 2);
            return false;
        }, Boolean);
        assert.deepEqual([...born], [["inside", 1]]);
        return true;
    }, Boolean);
    assert.equal(emissionTransactionStatistics().journaledWrites, before + 1);
    decline(() => born!.delete("inside"));
    assert.deepEqual([...born!], [["inside", 1]]);
});

test("a plain object written without writable() is not rolled back", () => {
    const plain = { count: 1 };
    decline(() => {
        plain.count = 2;
    });
    assert.equal(plain.count, 2);
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
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Saved for .call(this, ...) and exact restoration.
    const original = DataLowerer.prototype.compileDataPath;
    let injected = false;
    DataLowerer.prototype.compileDataPath = function (expression, mode) {
        if (
            !injected &&
            ts.isIdentifier(expression) &&
            expression.text === "values" &&
            this.context.bindings.lookupOptional(expression)?.kind === "data"
        ) {
            injected = true;
            const declaration = this.context.sourceFile.statements.find(
                ts.isFunctionDeclaration,
            );
            const returned = declaration?.body?.statements.find(
                ts.isReturnStatement,
            )?.expression;
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
