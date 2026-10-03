import assert from "node:assert/strict";
import test from "node:test";
import {
    emissionArray,
    EmissionMap,
    EmissionTransaction,
    writable,
} from "../src/compiler/emission-transaction.js";
import { ScopedValueIndex } from "../src/compiler/scoped-value-index.js";
import type { Value, VariableBinding } from "../src/compiler/types.js";

function array(cpp: string): Value {
    return {
        kind: "data",
        cpp,
        dataType: { kind: "vector", element: { kind: "number" } },
        staticElements: [{ kind: "number", cpp: "1" }],
    };
}

test("scoped fact aliases follow mutations, rebinding, disconnected cycles and rollback", () => {
    const owner = array("source"),
        other = array("other");
    const alias: Value = { ...owner, cpp: "alias", staticElementsOwner: owner };
    const fields: Record<string, Value> = { alias };
    const record: Value = { kind: "record", cpp: "", recordProperties: fields };
    fields.self = record;
    const root = new EmissionMap<string, VariableBinding>([
        ["source", { name: "source", value: owner }],
    ]);
    const nested = new EmissionMap<string, VariableBinding>([
        ["record", { name: "record", value: record }],
    ]);
    const scopes = emissionArray([root, nested]);
    const index = new ScopedValueIndex(scopes);
    assert.deepEqual(index.matching([owner]), new Set([owner, alias]));
    new EmissionTransaction().run(() => {
        writable(alias).staticElementsOwner = other;
        writable(alias).staticElements = other.staticElements!;
        assert.deepEqual(index.matching([owner]), new Set([owner]));
        assert.deepEqual(index.matching([other]), new Set([alias]));
        scopes.pop();
        assert.equal(index.matching([other]).size, 0);
        return false;
    }, Boolean);
    assert.deepEqual(index.matching([owner]), new Set([owner, alias]));
    assert.equal(index.matching([other]).size, 0);
    const retained = new EmissionMap<string, VariableBinding>([
        ["alias", { name: "alias", value: alias }],
    ]);
    scopes.push(retained);
    scopes.splice(1, 1);
    assert.deepEqual(index.matching([owner]), new Set([owner, alias]));
    assert.equal(index.matching([record]).size, 0);
    retained.clear();
    assert.deepEqual(index.matching([owner]), new Set([owner]));
});

test("facts installed after a reentrant right-hand side remain observable", () => {
    const owner = array("source"),
        alias: Value = { kind: "record", cpp: "" };
    const root = new EmissionMap<string, VariableBinding>([
        ["alias", { name: "alias", value: alias }],
    ]);
    const index = new ScopedValueIndex(emissionArray([root]));
    const evaluate = (): Value => {
        assert.equal(index.matching([owner]).size, 0);
        return owner;
    };
    writable(alias).staticElementsOwner = evaluate();
    assert.deepEqual(index.matching([owner]), new Set([alias]));
});

test("unrelated live value subgraphs are not revisited by repeated alias lookups", () => {
    let reads = 0;
    const owner = array("source");
    const fields: Record<string, Value> = {};
    for (let i = 0; i < 1000; i++)
        fields[String(i)] = { kind: "number", cpp: String(i) };
    const unrelated: Value = {
        kind: "record",
        cpp: "",
        get recordProperties() {
            reads++;
            return fields;
        },
    };
    const scope = new EmissionMap<string, VariableBinding>([
        ["unrelated", { name: "unrelated", value: unrelated }],
        ["source", { name: "source", value: owner }],
    ]);
    const index = new ScopedValueIndex(emissionArray([scope]));
    const baseline = reads;
    for (let i = 0; i < 100; i++)
        assert.deepEqual(index.matching([owner]), new Set([owner]));
    assert.equal(reads, baseline);
    scope.set("another", { name: "another", value: array("another") });
    index.matching([owner]);
    assert.equal(reads, baseline);
    writable(fields).last = owner;
    index.matching([owner]);
    assert.equal(reads, baseline);
});
