import assert from "node:assert/strict";
import test from "node:test";
import type { DataType } from "../src/compiler/data-types/model.js";
import { containsDataKind, dataTypeKey, dataTypesEqual } from "../src/compiler/data-types/operations.js";

test("stored-type traversal distinguishes callback signatures from contained resources", () => {
    const callback: DataType = { kind: "function", parameters: [
        { kind: "borrowed-platform-event", event: "mouse" },
        { kind: "handle", handle: "mesh" },
    ] };
    const fields = (name: string): DataType[] => name === "Owner" ? [
        { kind: "optional", inner: { kind: "struct", name: "Owner" } },
        { kind: "map", key: { kind: "string" }, value: callback },
    ] : [];
    const root: DataType = { kind: "struct", name: "Owner" };
    assert.equal(containsDataKind(root, "function", fields, false, new Set()), true);
    assert.equal(containsDataKind(root, "borrowed-platform-event", fields, false, new Set()), false);
    assert.equal(containsDataKind(root, "handle", fields, true, new Set()), true);
    assert.equal(containsDataKind(root, "json", fields, true, new Set()), false);
});

test("nested type equality and keys preserve callback and container distinctions", () => {
    const callback: DataType<"function"> = {
        kind: "function", parameters: [{ kind: "tuple", arity: 3 }],
        result: { kind: "optional", inner: { kind: "handle", handle: "mesh" } },
    };
    const equal: DataType = { ...callback, parameters: [{ kind: "tuple", arity: 3 }] };
    assert.equal(dataTypesEqual(callback, equal), true);
    assert.equal(dataTypeKey(callback), dataTypeKey(equal));
    const alternatives: DataType[] = [
        { ...callback, identity: true },
        { ...callback, erasedParameters: [0] },
        { ...callback, parameters: [{ kind: "tuple", arity: 4 }] },
        { ...callback, result: { kind: "handle", handle: "mesh" } },
        { ...callback, result: { kind: "optional", inner: { kind: "handle", handle: "material" } } },
        { kind: "vector", element: callback },
    ];
    for (const other of alternatives) {
        assert.equal(dataTypesEqual(callback, other), false);
        assert.equal(dataTypesEqual(other, callback), false);
        assert.notEqual(dataTypeKey(callback), dataTypeKey(other));
    }
});
