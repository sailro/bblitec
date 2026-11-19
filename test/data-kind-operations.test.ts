import assert from "node:assert/strict";
import test from "node:test";
import type { DataType } from "../src/compiler/data-types/model.js";
import {
    containsDataKind,
    dataTypeKey,
    dataTypesEqual,
    functionArmIndex,
} from "../src/compiler/data-types/operations.js";

test("stored-type traversal distinguishes callback signatures from contained resources", () => {
    const callback: DataType = {
        kind: "function",
        parameters: [
            { kind: "borrowed-platform-event", event: "mouse" },
            { kind: "handle", handle: "mesh" },
        ],
    };
    const fields = (name: string): DataType[] =>
        name === "Owner"
            ? [
                  {
                      kind: "optional",
                      inner: { kind: "struct", name: "Owner" },
                  },
                  { kind: "map", key: { kind: "string" }, value: callback },
              ]
            : [];
    const root: DataType = { kind: "struct", name: "Owner" };
    assert.equal(
        containsDataKind(root, "function", fields, false, new Set()),
        true,
    );
    assert.equal(
        containsDataKind(
            root,
            "borrowed-platform-event",
            fields,
            false,
            new Set(),
        ),
        false,
    );
    assert.equal(
        containsDataKind(root, "handle", fields, true, new Set()),
        true,
    );
    assert.equal(
        containsDataKind(root, "json", fields, true, new Set()),
        false,
    );
});

test("function union arms use parameter and result storage, not declaration proofs", () => {
    const scalar: DataType<"function"> = {
        kind: "function",
        signatureSite: "scalar-interface",
        parameters: [{ kind: "number" }],
    };
    const list: DataType<"function"> = {
        ...scalar,
        signatureSite: "list-interface",
        parameters: [{ kind: "vector", element: { kind: "number" } }],
    };
    const union: DataType<"union"> = { kind: "union", members: [scalar, list] };
    assert.equal(
        functionArmIndex(union, () => ({
            ...list,
            signatureSite: "list-body",
            identity: true,
            undefinedCompletion: true,
            awaitedUndefinedCompletion: true,
            nonThenableCompletion: true,
        })),
        1,
    );
    assert.equal(
        functionArmIndex(union, () => ({
            ...scalar,
            parameters: [{ kind: "boolean" }],
        })),
        -1,
    );
    assert.equal(
        functionArmIndex(union, () => ({
            ...scalar,
            result: { kind: "number" },
        })),
        -1,
    );
    assert.equal(
        functionArmIndex(union, () => ({
            ...scalar,
            optionalParameters: [0],
        })),
        -1,
    );
    assert.equal(
        functionArmIndex(union, () => ({
            ...list,
            restParameter: 0,
        })),
        -1,
    );
    const numeric: DataType<"function"> = {
        ...scalar,
        result: { kind: "number" },
    };
    const text: DataType<"function"> = {
        ...scalar,
        result: { kind: "string" },
    };
    assert.equal(
        functionArmIndex(
            { kind: "union", members: [numeric, text] },
            () => text,
        ),
        1,
    );
    // Equivalent declarations share storage; differing parameter/result
    // storage above cannot be selected just because the arity agrees.
    assert.equal(
        functionArmIndex(
            {
                kind: "union",
                members: [
                    scalar,
                    { ...scalar, signatureSite: "another-interface" },
                ],
            },
            () => scalar,
        ),
        0,
    );
});

test("nested type equality and keys preserve callback and container distinctions", () => {
    const callback: DataType<"function"> = {
        kind: "function",
        parameters: [{ kind: "tuple", arity: 3 }],
        result: { kind: "optional", inner: { kind: "handle", handle: "mesh" } },
    };
    const equal: DataType = {
        ...callback,
        parameters: [{ kind: "tuple", arity: 3 }],
    };
    assert.equal(dataTypesEqual(callback, equal), true);
    assert.equal(dataTypeKey(callback), dataTypeKey(equal));
    const alternatives: DataType[] = [
        { ...callback, identity: true },
        { ...callback, erasedParameters: [0] },
        { ...callback, parameters: [{ kind: "tuple", arity: 4 }] },
        { ...callback, result: { kind: "handle", handle: "mesh" } },
        {
            ...callback,
            result: {
                kind: "optional",
                inner: { kind: "handle", handle: "material" },
            },
        },
        { kind: "vector", element: callback },
    ];
    for (const other of alternatives) {
        assert.equal(dataTypesEqual(callback, other), false);
        assert.equal(dataTypesEqual(other, callback), false);
        assert.notEqual(dataTypeKey(callback), dataTypeKey(other));
    }
});
