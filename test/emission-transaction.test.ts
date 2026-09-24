import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
import { sourcePaths } from "./source-facts.js";

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
    assert.equal(idle.journaledSlots, before.journaledSlots);
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
            journaledSlots: after.journaledSlots - before.journaledSlots,
            restoredContainers:
                after.restoredContainers - before.restoredContainers,
        },
        {
            transactions: 2,
            rollbacks: 2,
            journaledSlots: 2,
            restoredContainers: 2,
        },
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
    const before = emissionTransactionStatistics().journaledSlots;
    let born: EmissionMap<string, number> | undefined;
    new EmissionTransaction().run(() => {
        born = new EmissionMap();
        born.set("inside", 1);
        assert.equal(emissionTransactionStatistics().journaledSlots, before);
        new EmissionTransaction().run(() => {
            born!.set("nested", 2);
            return false;
        }, Boolean);
        assert.deepEqual([...born], [["inside", 1]]);
        return true;
    }, Boolean);
    assert.equal(emissionTransactionStatistics().journaledSlots, before + 1);
    decline(() => born!.delete("inside"));
    assert.deepEqual([...born!], [["inside", 1]]);
});

test("a transaction saves each slot's original once, and nothing for slots past an array's starting length", () => {
    const counter = new Counter();
    const map = new EmissionMap<string, number>([["kept", 0]]);
    const set = new EmissionSet<number>();
    const stack = emissionArray<number>([0]);
    const before = emissionTransactionStatistics().journaledSlots;
    decline(() => {
        for (let index = 1; index <= 100; ++index) {
            counter.next = index;
            map.set("kept", index);
            set.add(1);
            stack.push(index);
            stack.pop();
            stack[0] = index;
        }
        assert.equal(
            emissionTransactionStatistics().journaledSlots - before,
            4,
        );
    });
    assert.equal(counter.next, 0);
    assert.deepEqual([...map], [["kept", 0]]);
    assert.deepEqual([...set], []);
    assert.deepEqual([...stack], [0]);
});

test("a commit keeps the enclosing transaction's older originals", () => {
    const counter = new Counter();
    const map = new EmissionMap<string, number>([
        ["a", 0],
        ["b", 0],
    ]);
    const stack = emissionArray<number>([0, 1, 2]);
    decline(() => {
        counter.next = 1;
        map.set("a", 1);
        stack.push(3);
        new EmissionTransaction().run(() => {
            counter.next = 2;
            map.set("a", 2);
            map.set("b", 2);
            stack.length = 1;
            return true;
        }, Boolean);
        counter.next = 3;
        map.set("b", 3);
        map.delete("a");
        stack.push(9);
    });
    assert.equal(counter.next, 0);
    assert.deepEqual(
        [...map],
        [
            ["a", 0],
            ["b", 0],
        ],
    );
    assert.deepEqual([...stack], [0, 1, 2]);
});

test("writable() refuses a journaled container", () => {
    decline(() => {
        assert.throws(
            () => writable(emissionArray([1])),
            /journaled container/,
        );
        assert.throws(() => writable(new EmissionMap()), /journaled container/);
    });
});

/** A container a field can hold whose writes nothing journals. */
function plainContainer(initializer: ts.Expression | undefined): boolean {
    if (!initializer) return false;
    if (
        ts.isArrayLiteralExpression(initializer) ||
        ts.isObjectLiteralExpression(initializer)
    )
        return true;
    return (
        ts.isNewExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        ["Array", "Map", "Set", "WeakMap", "WeakSet"].includes(
            initializer.expression.text,
        )
    );
}

/** The reason a declaration gives in its `@unjournaled` tag, if it has one. */
function unjournaledReason(node: ts.Node): string | undefined {
    for (const tag of ts.getJSDocTags(node))
        if (tag.tagName.text === "unjournaled")
            return ts.getTextOfJSDocComment(tag.comment)?.trim() ?? "";
    return undefined;
}

/** Whether `Object.assign`'s target is a writable() record or a fresh local. */
function journaledAssignTarget(target: ts.Expression): boolean {
    if (
        ts.isCallExpression(target) &&
        ts.isIdentifier(target.expression) &&
        target.expression.text === "writable"
    )
        return true;
    if (ts.isObjectLiteralExpression(target)) return true;
    if (!ts.isIdentifier(target)) return false;
    for (let scope: ts.Node = target; scope.parent; scope = scope.parent) {
        if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
        for (const statement of scope.statements) {
            if (!ts.isVariableStatement(statement)) continue;
            for (const declaration of statement.declarationList.declarations)
                if (
                    ts.isIdentifier(declaration.name) &&
                    declaration.name.text === target.text
                ) {
                    const initializer = declaration.initializer;
                    return (
                        initializer !== undefined &&
                        (ts.isObjectLiteralExpression(initializer) ||
                            (ts.isCallExpression(initializer) &&
                                initializer.expression.getText() ===
                                    "Object.create"))
                    );
                }
        }
    }
    return false;
}

test("compiler state escapes the journal only where it is declared @unjournaled", () => {
    const violations: string[] = [];
    const compilerSources = sourcePaths.filter(
        (path) =>
            (path === "src/compiler.ts" || path.startsWith("src/compiler/")) &&
            path !== "src/compiler/emission-transaction.ts",
    );
    for (const path of compilerSources) {
        const file = ts.createSourceFile(
            path,
            readFileSync(path, "utf8"),
            ts.ScriptTarget.Latest,
            true,
        );
        const site = (node: ts.Node, what: string): void => {
            const { line } = file.getLineAndCharacterOfPosition(
                node.getStart(file),
            );
            violations.push(`${path}:${line + 1} ${what}`);
        };
        const visit = (node: ts.Node): void => {
            const modifiers = ts.canHaveModifiers(node)
                ? (ts.getModifiers(node) ?? [])
                : [];
            const has = (kind: ts.SyntaxKind): boolean =>
                modifiers.some((modifier) => modifier.kind === kind);
            const reason = unjournaledReason(node);
            if (reason === "") site(node, "@unjournaled without a reason");
            if (
                ts.isPropertyDeclaration(node) &&
                !has(ts.SyntaxKind.StaticKeyword) &&
                reason === undefined
            ) {
                const journaledField =
                    has(ts.SyntaxKind.AccessorKeyword) &&
                    (ts.getDecorators(node) ?? []).some(
                        (decorator) =>
                            ts.isIdentifier(decorator.expression) &&
                            decorator.expression.text === "journaled",
                    );
                if (
                    !journaledField &&
                    (!has(ts.SyntaxKind.ReadonlyKeyword) ||
                        plainContainer(node.initializer))
                )
                    site(node, node.name.getText(file));
            }
            if (
                ts.isParameter(node) &&
                ts.isConstructorDeclaration(node.parent) &&
                (has(ts.SyntaxKind.PrivateKeyword) ||
                    has(ts.SyntaxKind.ProtectedKeyword) ||
                    has(ts.SyntaxKind.PublicKeyword)) &&
                !has(ts.SyntaxKind.ReadonlyKeyword) &&
                reason === undefined
            )
                site(node, node.name.getText(file));
            if (
                ts.isCallExpression(node) &&
                node.expression.getText(file) === "Object.assign" &&
                node.arguments[0] !== undefined &&
                !journaledAssignTarget(node.arguments[0])
            )
                site(node, "Object.assign into an unjournaled target");
            ts.forEachChild(node, visit);
        };
        visit(file);
    }
    assert.deepEqual(
        violations,
        [],
        "A compiler class field is a @journaled accessor, a readonly journaled " +
            "container, or declares @unjournaled with a reason; Object.assign " +
            "writes a writable() record or a fresh local.",
    );
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
