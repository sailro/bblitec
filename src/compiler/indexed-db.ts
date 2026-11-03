import ts from "typescript";
import { snakeCase } from "../cpp-literals.js";
import type { DataLowerer } from "./data-lowering.js";
import type { DataType } from "./data-types.js";
import type { LoweringServices } from "./lowering-services.js";
import { libraryName, namedMember } from "./symbols.js";
import { argumentAt } from "./syntax.js";
import type { Value } from "./types.js";
import { valueDataType } from "./values/model.js";

/**
 * IndexedDB (`bblite/js_indexed_db.hpp` over the PAL's SQLite files):
 * `indexedDB.open`, the connection, out-of-line-keyed object stores,
 * readonly/readwrite transactions, get/put/delete and a cursor, with the
 * request and transaction event handlers assigned as properties. A stored
 * value reads back as a dynamic value, as a `JSON.parse` result does; a key
 * is a number or a string.
 */

export type IndexedDbKind =
    | "idb-factory"
    | "idb-open-request"
    | "idb-request"
    | "idb-cursor-request"
    | "idb-database"
    | "idb-transaction"
    | "idb-object-store"
    | "idb-cursor"
    | "dom-string-list";

/** The DOM interfaces each kind stores, for the library object table. */
export const INDEXED_DB_OBJECTS: readonly (readonly [string, IndexedDbKind])[] =
    [
        ["IDBFactory", "idb-factory"],
        ["IDBOpenDBRequest", "idb-open-request"],
        ["IDBDatabase", "idb-database"],
        ["IDBTransaction", "idb-transaction"],
        ["IDBObjectStore", "idb-object-store"],
        ["IDBCursorWithValue", "idb-cursor"],
        ["DOMStringList", "dom-string-list"],
    ];

const KEY: DataType = { kind: "json" };
const STRING: DataType = { kind: "string" };
const NUMBER: DataType = { kind: "number" };
const ERROR: DataType = { kind: "optional", inner: { kind: "error" } };

/** The properties one kind reads, by name, with the types they read. */
type Properties = ReadonlyMap<string, DataType>;

/** A request's two properties: its result, of what the request reads, and its error. */
function requestProperties(result: DataType): Properties {
    return new Map([
        ["result", result],
        ["error", ERROR],
    ]);
}

/** Each kind's properties; each reads the native member of its snake_case name. */
const PROPERTIES: ReadonlyMap<IndexedDbKind, Properties> = new Map<
    IndexedDbKind,
    Properties
>([
    ["idb-open-request", requestProperties({ kind: "idb-database" })],
    ["idb-request", requestProperties(KEY)],
    [
        "idb-cursor-request",
        requestProperties({ kind: "optional", inner: { kind: "idb-cursor" } }),
    ],
    [
        "idb-database",
        new Map<string, DataType>([
            ["name", STRING],
            ["version", NUMBER],
            ["objectStoreNames", { kind: "dom-string-list" }],
        ]),
    ],
    ["idb-transaction", new Map([["error", ERROR]])],
    ["idb-object-store", new Map([["name", STRING]])],
    [
        "idb-cursor",
        new Map([
            ["value", KEY],
            ["primaryKey", KEY],
            ["key", KEY],
        ]),
    ],
    ["dom-string-list", new Map([["length", NUMBER]])],
]);

/** The handlers each request or transaction kind takes as properties. */
const HANDLERS: ReadonlyMap<DataType["kind"], ReadonlySet<string>> = new Map([
    [
        "idb-open-request",
        new Set(["onsuccess", "onerror", "onupgradeneeded", "onblocked"]),
    ],
    ["idb-request", new Set(["onsuccess", "onerror"])],
    ["idb-cursor-request", new Set(["onsuccess", "onerror"])],
    ["idb-transaction", new Set(["oncomplete", "onerror", "onabort"])],
]);

/** Every IndexedDB kind, requests included. */
export const INDEXED_DB_KINDS: readonly IndexedDbKind[] = [
    ...INDEXED_DB_OBJECTS.map(([, kind]) => kind),
    "idb-request",
    "idb-cursor-request",
];

const KINDS: ReadonlySet<string> = new Set(INDEXED_DB_KINDS);

function isIndexedDbKind(kind: string | undefined): kind is IndexedDbKind {
    return kind !== undefined && KINDS.has(kind);
}

/** `IDBRequest<T>` as the kind its result decides: a cursor, or a value or key. */
export function indexedDbRequestKind(
    checker: ts.TypeChecker,
    type: ts.Type,
): "idb-request" | "idb-cursor-request" {
    const reference = type as ts.TypeReference;
    const [result] = reference.typeArguments ?? [];
    if (!result) return "idb-request";
    const present = checker.getNonNullableType(result);
    return libraryName(present) === "IDBCursorWithValue"
        ? "idb-cursor-request"
        : "idb-request";
}

/** `indexedDB`, read from the Window rather than from a binding of the program's. */
export function compileIndexedDbValue(
    context: Pick<
        LoweringServices,
        "libraryGlobal" | "reachFeature" | "reachJsData" | "dataLowerer"
    >,
    expression: ts.Expression,
): Value | undefined {
    if (context.libraryGlobal(expression) !== "indexedDB") return undefined;
    context.reachJsData();
    context.reachFeature("storage:indexeddb", expression);
    return context.dataLowerer.leafValue("bbl::js::IdbFactory{}", {
        kind: "idb-factory",
    });
}

/** `indexedDB.open(...)`: a call on the global itself, which no binding holds. */
export function compileIndexedDbCall(
    context: Pick<
        LoweringServices,
        | "libraryGlobal"
        | "reachFeature"
        | "reachJsData"
        | "dataLowerer"
        | "checker"
        | "unwrap"
    >,
    call: ts.CallExpression,
): Value | undefined {
    const callee = namedMember(
        context.checker,
        context.unwrap(call.expression),
    );
    const owner =
        callee &&
        compileIndexedDbValue(context, context.unwrap(callee.expression));
    return owner
        ? compileIndexedDbMethod(context.dataLowerer, call, owner, callee.name)
        : undefined;
}

/** A property read on an IndexedDB value. */
export function indexedDbProperty(
    lowerer: DataLowerer,
    owner: Value,
    property: string,
    access?: ts.Node,
): Value | undefined {
    const kind = owner.dataType?.kind;
    if (!isIndexedDbKind(kind)) return undefined;
    const type = PROPERTIES.get(kind)?.get(property);
    if (type)
        return {
            ...lowerer.leafValue(
                `(${owner.cpp}).${snakeCase(property)}()`,
                type,
            ),
            impure: true,
        };
    return access
        ? lowerer.context.fail(
              access,
              `IndexedDB property '${property}' is not lowered on this object.`,
          )
        : undefined;
}

/** The values a store's records read back as: a dynamic value's shapes and Blobs. */
function storedValuePosition(
    lowerer: DataLowerer,
    type: DataType,
    path: string,
    node: ts.Node,
): string | undefined {
    switch (type.kind) {
        case "undefined":
        case "null":
        case "number":
        case "boolean":
        case "string":
        case "json":
        case "blob":
        case "enum":
            return undefined;
        case "optional":
            return storedValuePosition(lowerer, type.inner, path, node);
        case "vector":
            return storedValuePosition(
                lowerer,
                type.element,
                `${path}[]`,
                node,
            );
        case "struct":
            for (const field of lowerer.context.dataTypes.structFields(
                type.name,
                node,
            )) {
                const position = storedValuePosition(
                    lowerer,
                    field.type,
                    `${path}.${field.sourceName}`,
                    node,
                );
                if (position) return position;
            }
            return undefined;
        default:
            return `'${path}' is a ${type.kind}, which reads back from a store as no dynamic value`;
    }
}

/** A method call on an IndexedDB value. */
export function compileIndexedDbMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
    method: string,
): Value | undefined {
    const context = lowerer.context;
    const kind = owner.dataType?.kind;
    const argument = (index: number, type: DataType): string =>
        lowerer.compileForSink(argumentAt(call, index), type);
    const value = (cpp: string, type: DataType): Value => ({
        ...lowerer.leafValue(cpp, type),
        impure: true,
    });
    const refuse = (forms: string): never =>
        context.fail(call, `IndexedDB ${forms}`);
    switch (kind) {
        case "idb-factory":
            if (method !== "open")
                return refuse(`'${method}' is not lowered; indexedDB.open is.`);
            context.expectArgumentCount(call, 1, 2);
            return value(
                `(${owner.cpp}).open(${argument(0, STRING)}${
                    call.arguments.length > 1
                        ? `, std::optional<double>(${argument(1, NUMBER)})`
                        : ""
                })`,
                { kind: "idb-open-request" },
            );
        case "idb-database":
            if (method === "close") {
                context.expectArgumentCount(call, 0, 0);
                return { kind: "void", cpp: `(${owner.cpp}).close()` };
            }
            if (method === "createObjectStore") {
                if (call.arguments.length !== 1)
                    return refuse(
                        "object stores are created by name alone: keys are given to put, without a key path or generator.",
                    );
                return value(
                    `(${owner.cpp}).create_object_store(${argument(0, STRING)})`,
                    { kind: "idb-object-store" },
                );
            }
            if (method === "transaction") {
                context.expectArgumentCount(call, 1, 2);
                const scope = lowerer.dataTypeAt(argumentAt(call, 0));
                const names =
                    scope?.kind === "vector"
                        ? argument(0, { kind: "vector", element: STRING })
                        : argument(0, STRING);
                return value(
                    `(${owner.cpp}).transaction(${names}${
                        call.arguments.length > 1
                            ? `, ${argument(1, STRING)}`
                            : ""
                    })`,
                    { kind: "idb-transaction" },
                );
            }
            return refuse(
                `database method '${method}' is not lowered; createObjectStore, transaction and close are.`,
            );
        case "idb-transaction":
            if (method !== "objectStore")
                return refuse(
                    `transaction method '${method}' is not lowered; objectStore is.`,
                );
            context.expectArgumentCount(call, 1, 1);
            return value(
                `(${owner.cpp}).object_store(${argument(0, STRING)})`,
                {
                    kind: "idb-object-store",
                },
            );
        case "idb-object-store": {
            if (method === "get" || method === "delete") {
                context.expectArgumentCount(call, 1, 1);
                return value(
                    `(${owner.cpp}).${method === "get" ? "get" : "remove"}(${argument(0, KEY)})`,
                    { kind: "idb-request" },
                );
            }
            if (method === "put") {
                if (call.arguments.length !== 2)
                    return refuse(
                        "put takes a value and its key: native object stores keep their keys out of line.",
                    );
                // The value as it is held -- a record its struct, a scalar
                // its kind -- or, with no storage of its own (a literal
                // passed as `unknown`), as a dynamic value.
                const stored = argumentAt(call, 0);
                const compiled = context.compileValue(stored);
                const type: DataType = valueDataType(compiled) ??
                    lowerer.dataTypeAt(stored) ?? { kind: "json" };
                const position = storedValuePosition(
                    lowerer,
                    type,
                    "value",
                    stored,
                );
                if (position)
                    return context.fail(stored, `IndexedDB put: ${position}.`);
                return value(
                    `(${owner.cpp}).put(${lowerer.compileKnownValueForSink(compiled, type, stored)}, ${argument(1, KEY)})`,
                    { kind: "idb-request" },
                );
            }
            if (method === "openCursor") {
                if (call.arguments.length !== 0)
                    return refuse(
                        "openCursor walks the whole store: a key range or direction is not lowered.",
                    );
                return value(`(${owner.cpp}).open_cursor()`, {
                    kind: "idb-cursor-request",
                });
            }
            return refuse(
                `object store method '${method}' is not lowered; get, put, delete and openCursor are.`,
            );
        }
        case "idb-cursor":
            if (method !== "continue")
                return refuse(
                    `cursor method '${method}' is not lowered; continue is.`,
                );
            if (call.arguments.length !== 0)
                return refuse(
                    "continue takes no key: the cursor steps to the next record.",
                );
            return { kind: "void", cpp: `(${owner.cpp}).advance()` };
        case "dom-string-list":
            if (method === "contains") {
                context.expectArgumentCount(call, 1, 1);
                return value(
                    `(${owner.cpp}).contains(${argument(0, STRING)})`,
                    {
                        kind: "boolean",
                    },
                );
            }
            if (method === "item") {
                context.expectArgumentCount(call, 1, 1);
                return value(`(${owner.cpp}).item(${argument(0, NUMBER)})`, {
                    kind: "optional",
                    inner: STRING,
                });
            }
            return refuse(`DOMStringList method '${method}' is not lowered.`);
        default:
            return undefined;
    }
}

/**
 * `request.onsuccess = handler` and the other event handler properties.
 * Events fire in later tasks, so a handler assigned any time before then
 * runs; a handler takes no event argument.
 */
export function compileIndexedDbAssignment(
    lowerer: DataLowerer,
    expression: ts.BinaryExpression,
): Value | undefined {
    const context = lowerer.context;
    const left = context.unwrap(expression.left);
    if (!ts.isPropertyAccessExpression(left)) return undefined;
    const kind = lowerer.dataTypeAt(left.expression)?.kind;
    const handlers = kind && HANDLERS.get(kind);
    if (!handlers) return undefined;
    const property = left.name.text;
    if (
        !handlers.has(property) ||
        expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    )
        return context.fail(
            left,
            `IndexedDB property '${property}' is not written natively; assign ${[...handlers].join(", ")}.`,
        );
    const owner = context.bindings.pinValueToTemporary(
        context.compileValue(left.expression),
        "idb_receiver",
    );
    const handler = context.callbacks.compilePlatformCallback(
        expression.right,
        undefined,
        [],
        undefined,
        true,
        false,
    );
    return {
        kind: "void",
        cpp: `(${owner.cpp}).set_${property}(${handler.cpp})`,
    };
}
