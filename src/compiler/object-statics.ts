import { writable } from "./emission-transaction.js";
import ts from "typescript";
import { cppIdentifierPattern } from "../cpp-literals.js";
import { argumentAt, expressionMayRunCode } from "./syntax.js";
import type { LoweringServices } from "./lowering-services.js";
import { booleanValue, staticStringValue, type Value } from "./types.js";
import { callMember, type DataType, type OwnPresence } from "./data-types.js";
import { isJsonValue } from "./json-bridge.js";
import { refuseErrorReflection } from "./error-values.js";
import { isSymbolPropertyKey } from "./symbols.js";
import { DynamicBindingStorageRequired } from "./dynamic-binding-storage.js";
import { functionUsesDynamicThis } from "./user-functions.js";
import {
    compileCollectionEntries,
    compileEntryCollection,
} from "./collection-methods.js";

type ObjectStaticContext = Pick<
    LoweringServices,
    | "checker"
    | "compileValue"
    | "moduleNamespaces"
    | "captureEmittedLines"
    | "probeEmission"
    | "dataLowerer"
    | "dataTypes"
    | "cppString"
    | "reachJsData"
    | "reachJson"
    | "expectArgumentCount"
    | "allocateTemporaryCppName"
    | "emit"
    | "emitDiscardedValue"
    | "isInRuntimeControlFlow"
    | "bindings"
    | "refuseBorrowedPlatformEventEscape"
    | "resolveRecordValue"
    | "unwrap"
    | "libraryGlobal"
    | "fail"
    | "emitUiDatasetProperty"
>;

/** What the own-entry walks read. */
type OwnEntryContext = Pick<
    ObjectStaticContext,
    "dataTypes" | "dataLowerer" | "fail"
>;

type OwnObjectContext = OwnEntryContext &
    Pick<ObjectStaticContext, "moduleNamespaces">;

/** Raw descriptor order, with JavaScript's integer keys first. */
export function recordPropertyKeys(owner: Value): string[] {
    const keys = owner.recordPropertyOrder ?? [
        ...Object.keys(owner.recordProperties ?? {}),
        ...Object.keys(owner.recordMethods ?? {}),
        ...Object.keys(owner.recordGetters ?? {}),
        ...Object.keys(owner.recordSetters ?? {}),
    ];
    return Object.keys(Object.fromEntries(keys.map((key) => [key, undefined])));
}

/** Change a raw data property without replacing the alias-shared tables. */
export function setRecordProperty(
    owner: Value,
    key: string,
    value: Value,
): void {
    if (owner.recordPropertyOrder && !owner.recordPropertyOrder.includes(key))
        writable(owner.recordPropertyOrder).push(key);
    writable((writable(owner).recordProperties ??= {}))[key] = value;
}

export function deleteRecordProperty(owner: Value, key: string): void {
    if (owner.recordProperties) delete writable(owner.recordProperties)[key];
    if (owner.recordMethods) delete writable(owner.recordMethods)[key];
    if (owner.recordGetters) delete writable(owner.recordGetters)[key];
    if (owner.recordSetters) delete writable(owner.recordSetters)[key];
    const index = owner.recordPropertyOrder?.indexOf(key) ?? -1;
    if (index !== -1) writable(owner.recordPropertyOrder!).splice(index, 1);
}

/** A string-typed value's native text, static or data. */
function stringCpp(
    context: ObjectStaticContext,
    value: Value,
    node: ts.Node,
): string {
    return context.dataLowerer.compileKnownValueForSink(
        value,
        { kind: "string" },
        node,
    );
}

/**
 * One own property of a compile-time record or a struct: its key, its
 * value and, for a key whose storage or tags decide whether it is own, its
 * presence; the value of such a key is the one it holds while it is own.
 */
export interface OwnEntry {
    key: string;
    value: Value;
    presence?: OwnPresence;
    /**
     * The slot of a key own exactly while it holds a value: a member a
     * compile-time record holds as a conditionally own key
     * (`Value.conditionalOwnKey`).
     */
    slot?: Value;
}

/** Read current field storage, using proven own keys when a record snapshot names them. */
export function structOwnEntries(
    context: OwnEntryContext,
    owner: Value,
    dataType: DataType & { kind: "struct" },
    node: ts.Node,
    excludedKeys?: ReadonlySet<string>,
): OwnEntry[] {
    refuseErrorReflection(context, owner, node);
    const access = context.dataTypes.isReferenceStruct(dataType.name)
        ? "->"
        : ".";
    const sourceFields = owner.recordOwnKeys
        ? owner.recordOwnKeys.map((key) =>
              context.dataTypes.structField(
                  dataType.name,
                  key,
                  node,
                  "accessors",
              ),
          )
        : context.dataTypes.structFields(dataType.name, node, "accessors");
    const fields = excludedKeys?.size
        ? sourceFields.filter((field) => !excludedKeys.has(field.sourceName))
        : sourceFields;
    const accessor = fields.find(
        (field) => field.accessor && !field.accessorReceiver,
    );
    if (accessor)
        context.dataTypes.structField(dataType.name, accessor.sourceName, node);
    return fields.map((field) => {
        const key = field.sourceName;
        const slot = `${owner.cpp}${access}${field.name}`;
        const value = context.dataLowerer.leafValue(
            `${slot}${field.accessor ? ".get()" : ""}`,
            field.type,
        );
        const presence = owner.recordOwnKeys
            ? undefined
            : context.dataTypes.ownPresence(
                  dataType.name,
                  field,
                  owner.cpp,
                  access,
                  node,
              );
        const original = owner.recordProperties?.[key];
        // A key own by tags alone may hold an empty slot while own.
        const definitelyPresent =
            (presence !== undefined && presence.holdsValueCpp === undefined) ||
            (original &&
                original.kind !== "json-null" &&
                original.dataType?.kind !== "optional");
        return {
            key,
            value: {
                ...(!field.accessorReceiver &&
                definitelyPresent &&
                field.type.kind === "optional"
                    ? context.dataLowerer.leafValue(
                          `(*${value.cpp})`,
                          field.type.inner,
                      )
                    : value),
                nativeCaptures: owner.nativeCaptures ?? [],
            },
            ...(presence ? { presence } : {}),
            ...(presence?.emptySlot === "absent"
                ? {
                      slot: {
                          ...value,
                          nativeCaptures: owner.nativeCaptures ?? [],
                      },
                  }
                : {}),
        };
    });
}

/**
 * The string-keyed own entries of a compile-time record or a struct, in key
 * order; undefined for another owner. A record's methods and accessors are
 * not among them, nor are symbol-keyed properties.
 */
export function ownEntries(
    context: OwnEntryContext,
    owner: Value,
    node: ts.Node,
): OwnEntry[] | undefined {
    if (owner.kind === "record")
        return Object.entries(owner.recordProperties ?? {})
            .filter(([key]) => !isSymbolPropertyKey(key))
            .map(([key, member]) =>
                context.dataLowerer.recordMemberEntry(key, member, node),
            );
    if (owner.kind === "data" && owner.dataType?.kind === "struct")
        return structOwnEntries(context, owner, owner.dataType, node).filter(
            (entry) => !isSymbolPropertyKey(entry.key),
        );
    return undefined;
}

/**
 * Whether every own key of a compile-time record or a struct is known at
 * generation: no record member a conditional spread wrote, no struct
 * field whose storage or tags decide it, unless a record snapshot proved
 * the struct's keys.
 */
export function ownKeysKnown(
    context: Pick<OwnObjectContext, "dataTypes">,
    owner: Value,
    node: ts.Node,
): boolean {
    if (owner.kind === "record")
        return !Object.values(owner.recordProperties ?? {}).some(
            (member) => member.conditionalOwnKey,
        );
    return (
        owner.dataType?.kind !== "struct" ||
        owner.recordOwnKeys !== undefined ||
        context.dataTypes.ownKeysDecided(owner.dataType.name, node)
    );
}

/**
 * The own keys, values or `[key, value]` entries of a compile-time record
 * or a struct as a fresh array, built at run time so a key joins it only
 * while it is own. Undefined when every key is known (a fixed list).
 */
export function ownArray(
    context: OwnEntryContext &
        Pick<
            ObjectStaticContext,
            "cppString" | "captureEmittedLines" | "reachJsData"
        >,
    owner: Value,
    resultType: DataType<"vector">,
    projection: "keys" | "values" | "entries",
    node: ts.Node,
): Value | undefined {
    const struct = owner.kind === "data" && owner.dataType?.kind === "struct";
    if (
        (!struct && owner.kind !== "record") ||
        ownKeysKnown(context, owner, node)
    )
        return undefined;
    if (
        !struct &&
        (Object.keys(owner.recordMethods ?? {}).length > 0 ||
            Object.keys(owner.recordGetters ?? {}).length > 0 ||
            Object.keys(owner.recordSetters ?? {}).length > 0)
    )
        context.fail(
            node,
            "A record with methods or accessors and keys a conditional spread decides does not enumerate.",
        );
    // A struct is read once; its fields are read through that reference.
    const entries = ownEntries(
        context,
        struct ? { ...owner, cpp: "own_owner" } : owner,
        node,
    )!;
    context.reachJsData();
    const element = resultType.element;
    const pushes: string[] = [];
    const emitted = context.captureEmittedLines(() => {
        for (const { key, value, presence } of entries) {
            const keyValue = staticStringValue(key, (text) =>
                context.cppString(text),
            );
            const projected: Value =
                projection === "keys"
                    ? keyValue
                    : projection === "values"
                      ? value
                      : {
                            kind: "tuple",
                            cpp: "",
                            tupleElements: [keyValue, value],
                        };
            const push = `own.push_back(${context.dataLowerer.compileKnownValueForSink(projected, element, node)});`;
            pushes.push(presence ? `if (${presence.ownCpp}) ${push}` : push);
        }
    });
    if (emitted.length > 0)
        context.fail(
            node,
            `A ${struct ? "struct" : "record"}'s own properties enumerate as an array when each value converts to its element in place.`,
        );
    const build = `${context.dataTypes.cppType(resultType)} own; ${pushes.join(" ")} return own;`;
    return {
        kind: "data",
        cpp: struct
            ? `[](const auto& own_owner) { ${build} }(${owner.cpp})`
            : `[&]() { ${build} }()`,
        dataType: resultType,
        freshData: true,
    };
}

/**
 * A compile-time record's or a struct's own properties as a fixed list,
 * which a key decided at run time refuses; undefined for another owner.
 */
function fixedOwnEntries(
    context: OwnEntryContext,
    owner: Value,
    node: ts.Node,
): Array<[string, Value]> | undefined {
    const entries = ownEntries(context, owner, node);
    if (entries?.some((entry) => entry.presence !== undefined))
        context.fail(
            node,
            owner.kind === "record"
                ? "Enumerating a record whose keys a conditional spread decides as a fixed list requires known own keys; its keys and values enumerate as arrays."
                : "Enumerating a struct with optional properties as a fixed list requires known own keys; its keys and values enumerate as arrays.",
        );
    return entries?.map(({ key, value }) => [key, value]);
}

/** Common own-property projection for Object keys, values, entries and assign. */
export function ownObjectEntries(
    context: OwnObjectContext,
    owner: Value,
    node: ts.Node,
): Array<[string, Value]> | undefined {
    refuseErrorReflection(context, owner, node);
    const namespace = context.moduleNamespaces.entries(owner, node);
    if (namespace) return namespace;
    const entries = fixedOwnEntries(context, owner, node);
    if (entries) return entries;
    if (
        owner.kind === "data" &&
        owner.dataType?.kind === "enummap" &&
        owner.recordOwnKeys
    ) {
        const type = owner.dataType;
        return owner.recordOwnKeys.map((key) => {
            const tag = context.dataTypes.enumMemberCpp(
                { kind: "enum", name: type.enumName },
                key,
                node,
            );
            return [
                key,
                context.dataLowerer.leafValue(
                    `bbl::js::enum_map_at(${owner.cpp}, ${tag})`,
                    type.element,
                ),
            ];
        });
    }
    return undefined;
}

/**
 * `Object.is(a, b)`: SameValue over the scalar kinds, where it differs from
 * `===` only for NaN (equal) and signed zeros (different).
 */
function compileObjectIs(
    context: ObjectStaticContext,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 2, 2);
    const left = context.compileValue(argumentAt(call, 0));
    const right = context.compileValue(argumentAt(call, 1));
    if (left.staticNumber !== undefined && right.staticNumber !== undefined) {
        return booleanValue(
            Object.is(left.staticNumber, right.staticNumber) ? "true" : "false",
        );
    }
    const numeric = (value: Value): boolean =>
        value.kind === "number" || value.dataType?.kind === "number";
    const textual = (value: Value): boolean =>
        value.kind === "string" || value.dataType?.kind === "string";
    const boolean = (value: Value): boolean =>
        value.kind === "boolean" || value.dataType?.kind === "boolean";
    if (numeric(left) && numeric(right)) {
        context.reachJsData();
        return booleanValue(`bbl::js::same_value(${left.cpp}, ${right.cpp})`);
    }
    if (textual(left) && textual(right)) {
        return booleanValue(
            `(${stringCpp(context, left, argumentAt(call, 0))} == ${stringCpp(context, right, argumentAt(call, 1))})`,
        );
    }
    if (boolean(left) && boolean(right)) {
        return booleanValue(`(${left.cpp} == ${right.cpp})`);
    }
    return context.fail(
        call,
        "Object.is compares numbers, strings and booleans; object identity takes `===`.",
    );
}

/** `Object.hasOwn(object, key)`: membership without inherited properties. */
function compileObjectHasOwn(
    context: ObjectStaticContext,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 2, 2);
    const ownerNode = argumentAt(call, 0);
    const keyNode = argumentAt(call, 1);
    return booleanValue(
        context.dataLowerer.compileMembership(
            ownerNode,
            keyNode,
            "Object.hasOwn",
        ),
    );
}

/** The unbound own-property predicate uses the same owner/key contract as Object.hasOwn. */
export function compileObjectPrototypeCall(
    context: ObjectStaticContext,
    call: ts.CallExpression,
): Value | undefined {
    const callee = context.unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "call")
        return undefined;
    const method = context.unwrap(callee.expression);
    if (
        !ts.isPropertyAccessExpression(method) ||
        method.name.text !== "hasOwnProperty"
    )
        return undefined;
    const prototype = context.unwrap(method.expression);
    if (
        !ts.isPropertyAccessExpression(prototype) ||
        prototype.name.text !== "prototype"
    )
        return undefined;
    const owner = context.unwrap(prototype.expression);
    if (context.libraryGlobal(owner) !== "Object") return undefined;
    return compileObjectHasOwn(context, call);
}

/**
 * `[name, value]` pairs as a fresh array, pushed by a loop over the owner
 * that binds `name` and the value's spelling.
 */
function pairArray(
    context: ObjectStaticContext,
    owner: Value,
    ownerType: string,
    value: Value,
    loop: (push: string) => string,
    resultType: DataType<"vector">,
    node: ts.Node,
): Value {
    context.reachJson();
    let pair = "";
    const emitted = context.captureEmittedLines(() => {
        pair = context.dataLowerer.compileKnownValueForSink(
            {
                kind: "tuple",
                cpp: "",
                tupleElements: [
                    context.dataLowerer.leafValue("name", { kind: "string" }),
                    value,
                ],
            },
            resultType.element,
            node,
        );
    });
    if (emitted.length > 0)
        context.fail(
            node,
            "Object entries enumerate as an array when each pair converts to its element in place.",
        );
    return {
        kind: "data",
        cpp: `[](const ${ownerType}& own_owner) { ${context.dataTypes.cppType(resultType)} own; ${loop(`own.push_back(${pair});`)} return own; }(${owner.cpp})`,
        dataType: resultType,
        freshData: true,
    };
}

/**
 * `Object.entries(object)` as a value: a compile-time record's pairs are a
 * compile-time tuple of `[key, value]` tuples, which the static tuple
 * methods and loops consume. A dictionary's entries are iterated in a
 * for...of, where the loop walks the map itself.
 */
function compileObjectEntries(
    context: ObjectStaticContext,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 1, 1);
    const raw = context.compileValue(argumentAt(call, 0));
    const owner =
        raw.kind === "data"
            ? context.dataLowerer.narrowOptional(raw, argumentAt(call, 0))
            : raw;
    const resultType = context.dataLowerer.dataTypeAt(call);
    const array =
        resultType?.kind === "vector"
            ? ownArray(context, owner, resultType, "entries", call)
            : undefined;
    if (array) return array;
    if (isJsonValue(owner)) {
        // A document's values are documents too, also where TypeScript
        // types them `any` (the entries of an `object`).
        const typed = context.dataTypes.withDynamicJsonTypes(true, () =>
            context.dataLowerer.dataTypeAt(call),
        );
        const documentType: DataType<"vector"> =
            typed?.kind === "vector"
                ? typed
                : {
                      kind: "vector",
                      element: {
                          kind: "product",
                          elements: [{ kind: "string" }, { kind: "json" }],
                      },
                  };
        // A parsed document's own pairs, in property order.
        return pairArray(
            context,
            owner,
            "bbl::js::JsonValue",
            context.dataLowerer.leafValue("own_owner.get(name)", {
                kind: "json",
            }),
            (push) =>
                `for (const std::string& name : own_owner.own_keys()) ${push}`,
            documentType,
            call,
        );
    }
    if (
        owner.kind === "data" &&
        owner.dataType?.kind === "map" &&
        owner.dataType.dictionary
    )
        // A dictionary's pairs in property order, a number key spelled as a
        // name; its values keep their type where TypeScript erases them
        // (`unknown`, or `any` for an `object`).
        return pairArray(
            context,
            owner,
            "auto",
            context.dataLowerer.leafValue("value", owner.dataType.value),
            (push) =>
                `bbl::js::for_each_property_entry(own_owner, [&](const std::string& name, const auto& value) { ${push} });`,
            resultType?.kind === "vector"
                ? resultType
                : {
                      kind: "vector",
                      element: {
                          kind: "product",
                          elements: [{ kind: "string" }, owner.dataType.value],
                      },
                  },
            call,
        );
    const pairs = ownObjectEntries(context, owner, call);
    if (!pairs) {
        return context.fail(
            argumentAt(call, 0),
            "Object.entries takes a compile-time record, a struct or a dictionary.",
        );
    }
    return {
        kind: "tuple",
        cpp: "",
        tupleElements: pairs.map(([key, value]) => ({
            kind: "tuple",
            cpp: "",
            tupleElements: [
                staticStringValue(key, (text) => context.cppString(text)),
                value.cpp && value.kind !== "callback"
                    ? context.bindings.pinValueToTemporary(
                          value,
                          "object_entry",
                      )
                    : value,
            ],
        })),
    };
}

/**
 * `Object.fromEntries(entries)`: a Map becomes the dictionary with its
 * pairs; a compile-time tuple of `[key, value]` tuples becomes a
 * dictionary literal.
 */
function compileObjectFromEntries(
    context: ObjectStaticContext,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 1, 1);
    const resultType = context.dataLowerer.dataTypeAt(call);
    const record = context.probeEmission(() => {
        const entries = compileCollectionEntries(
            context.dataLowerer,
            argumentAt(call, 0),
            resultType?.kind === "map" ? resultType : undefined,
        );
        if (entries.kind !== "tuple") return undefined;
        const properties = Object.create(null) as Record<string, Value>;
        for (const entry of entries.tupleElements ?? []) {
            if (entry.kind !== "tuple" || entry.tupleElements?.length !== 2)
                return undefined;
            const [key, value] = entry.tupleElements;
            const name =
                key?.staticString ??
                (key?.staticNumber !== undefined
                    ? String(key.staticNumber)
                    : undefined);
            if (name === undefined) return undefined;
            if (properties[name]) context.emitDiscardedValue(properties[name]);
            properties[name] = value!;
        }
        return {
            kind: "record" as const,
            cpp: "",
            recordProperties: properties,
        };
    });
    if (record) return record;
    if (resultType?.kind !== "map") {
        return context.fail(
            call,
            "Object.fromEntries requires a string-keyed dictionary result type.",
        );
    }
    context.reachJsData();
    return compileEntryCollection(
        context.dataLowerer,
        argumentAt(call, 0),
        resultType,
    );
}

/**
 * `Object.assign(target, ...sources)`: an empty literal target merges its
 * sources into a fresh compile-time record, as an object spread does; a
 * struct target stores each source field in place. Sources are compile-time
 * records, object literals or structs of the target's own type.
 */
function compileObjectAssign(
    context: ObjectStaticContext,
    call: ts.CallExpression,
): Value {
    if (call.arguments.length < 1) {
        context.fail(call, "Object.assign takes a target and its sources.");
    }
    const targetExpression = context.unwrap(argumentAt(call, 0));
    // A bound record is written in place, so its later reads see the
    // stores; reading it as a value would write into a copy.
    let target =
        context.probeEmission(() =>
            context.resolveRecordValue(targetExpression),
        ) ?? context.compileValue(targetExpression);
    const sources = call.arguments.slice(1);
    // A function given properties is a callable record: a fresh record
    // whose call is that function, filled below as a struct target is. It
    // is built as the callable type its result is stored as, when it has
    // one, so the record needs no conversion there.
    const contextual = context.checker.getContextualType(call);
    const callable = context.dataTypes.fromStoredTsType(
        contextual &&
            context.checker.getNonNullableType(contextual).getCallSignatures()
                .length === 1
            ? context.checker.getNonNullableType(contextual)
            : context.checker.getTypeAtLocation(call),
        call,
    );
    const callType =
        callable?.kind === "struct"
            ? context.dataTypes.structCall(callable.name)
            : undefined;
    if (
        callable?.kind === "struct" &&
        callType &&
        (target.kind === "callback" || target.dataType?.kind === "function")
    ) {
        const record = context.allocateTemporaryCppName("callable_record");
        context.emit({
            kind: "declaration",
            type: "auto",
            name: record,
            initializer: `bbl::js::make_ref<bblscene::${callable.name}Data>()`,
        });
        context.emit({
            kind: "expression",
            code: `${record}->${callMember} = ${context.dataLowerer.compileKnownValueForSink(target, callType, targetExpression)};`,
        });
        target = {
            ...context.dataLowerer.leafValue(record, callable),
            freshData: true,
        };
    }
    const fresh = ts.isObjectLiteralExpression(targetExpression);
    const readPairs = (
        source: ts.Expression,
        value = context.compileValue(source),
        functions = false,
    ): Array<[string, Value]> => {
        // A method is an own property holding its function; one reading
        // `this` would read whichever object it is later called on. Only a
        // target storing functions takes it.
        const methods = Object.entries(value.recordMethods ?? {});
        if (
            value.kind === "record" &&
            (Object.keys(value.recordGetters ?? {}).length > 0 ||
                methods.some(
                    ([, method]) =>
                        !functions ||
                        (!ts.isIdentifier(method) &&
                            functionUsesDynamicThis(method)),
                ))
        ) {
            context.fail(
                source,
                "Object.assign copies plain properties, and methods without `this` into a target storing functions; this source's accessors or methods are not represented.",
            );
        }
        const pairs =
            fixedOwnEntries(context, value, source) ??
            context.fail(
                source,
                "Object.assign sources are compile-time records, object literals or structs.",
            );
        return value.kind === "record"
            ? [
                  ...pairs,
                  ...methods.map(([name, method]): [string, Value] => [
                      name,
                      {
                          kind: "callback",
                          cpp: "",
                          callbackDeclaration: method,
                          callbackRecordOwner: value,
                      },
                  ]),
              ]
            : pairs;
    };
    // An existing target keeps what it receives, as a field store does.
    const sourcePairs = (
        source: ts.Expression,
        value?: Value,
    ): Array<[string, Value]> => {
        const pairs = readPairs(source, value, true);
        if (!fresh)
            for (const [, value] of pairs)
                context.refuseBorrowedPlatformEventEscape(
                    value,
                    source,
                    "Object.assign",
                );
        return pairs;
    };
    if (target.kind === "ui-element" && target.uiDataset) {
        const owner = context.bindings.pinValueToTemporary(
            target,
            "dataset_target",
            targetExpression,
        );
        // Call arguments are evaluated before Object.assign starts writing.
        // Pin their values, then read each source's fields in copy order.
        const values = sources.map((source) => {
            const value = context.compileValue(source);
            if (value.kind === "record") {
                readPairs(source, value);
                // A later argument can mutate an earlier source. Retain that
                // source's identity rather than snapshotting its scalar fields.
                const declaration = context.bindings.recordDeclaration(
                    value,
                    source,
                );
                if (declaration)
                    throw new DynamicBindingStorageRequired(
                        declaration,
                        "source",
                    );
            }
            return context.bindings.pinValueToTemporary(
                value,
                "dataset_source",
                source,
            );
        });
        sources.forEach((source, index) => {
            for (const [key, value] of readPairs(source, values[index]))
                context.emitUiDatasetProperty(owner, key, value, source);
        });
        return owner;
    }
    if (target.kind === "record") {
        if (target.moduleNamespace)
            context.fail(call, "Module namespace properties are read-only.");
        if (!fresh && context.isInRuntimeControlFlow()) {
            context.fail(
                call,
                "A compile-time record cannot be populated from runtime control flow.",
            );
        }
        const result = fresh
            ? {
                  ...target,
                  recordProperties: { ...target.recordProperties },
                  ...(target.recordPropertyOrder
                      ? {
                            recordPropertyOrder: [
                                ...target.recordPropertyOrder,
                            ],
                        }
                      : {}),
              }
            : target;
        const properties = (writable(result).recordProperties ??= {});
        for (const source of sources) {
            for (const [key, value] of sourcePairs(source)) {
                const existing = properties[key];
                // A property with native storage takes the store there; the
                // record then reads its storage rather than a folded value.
                if (
                    !fresh &&
                    existing !== undefined &&
                    (existing.kind === "number" ||
                        existing.kind === "string" ||
                        existing.kind === "boolean") &&
                    cppIdentifierPattern.test(existing.cpp)
                ) {
                    const scalarKind = existing.kind;
                    const stored = context.dataLowerer.compileKnownValueForSink(
                        value,
                        { kind: scalarKind },
                        source,
                    );
                    context.emit({
                        kind: "expression",
                        code: `${existing.cpp} = ${stored};`,
                    });
                    writable(properties)[key] = {
                        kind: scalarKind,
                        cpp: existing.cpp,
                        dataType: { kind: scalarKind },
                    };
                    continue;
                }
                setRecordProperty(result, key, value);
            }
        }
        return result;
    }
    if (target.kind === "data" && target.dataType?.kind === "struct") {
        const structType = target.dataType;
        const access = context.dataTypes.isReferenceStruct(structType.name)
            ? "->"
            : ".";
        for (const source of sources) {
            const sourceValue = context.compileValue(source);
            if (
                sourceValue.kind === "data" &&
                sourceValue.dataType?.kind === "struct"
            ) {
                context.dataLowerer.copyStructOwnProperties(
                    { cpp: target.cpp, type: structType },
                    sourceValue,
                    sourceValue.dataType,
                    source,
                    "Object.assign",
                );
                continue;
            }
            for (const [key, value] of sourcePairs(source, sourceValue)) {
                const field = context.dataTypes.structField(
                    structType.name,
                    key,
                    source,
                );
                const stored = context.dataLowerer.compileKnownValueForSink(
                    value,
                    field.type,
                    source,
                );
                context.emit({
                    kind: "expression",
                    code: `${target.cpp}${access}${field.name} = ${stored};`,
                });
            }
        }
        // The stores changed fields whose generation snapshot lives on the
        // binding the target was read from, not only on this read of it.
        context.bindings.invalidateRecordProperties(target);
        const bound = ts.isIdentifier(targetExpression)
            ? context.bindings.lookupOptional(targetExpression)
            : undefined;
        if (bound) {
            context.bindings.invalidateRecordProperties(bound);
        }
        return target;
    }
    // Nothing else has stored fields to copy into: an engine handle's
    // properties are setters with native effects, which a copy of plain
    // properties would bypass. Browser-only targets never reach here; the
    // instrumentation path erases those statements whole.
    return context.fail(
        call,
        `Object.assign cannot write into a ${target.kind} value: only records, object literals and structs have plain properties to copy into.`,
    );
}

/**
 * `Object.create(null)` where a dictionary is expected: a dictionary has no
 * prototype chain in its representation, so it is exactly an object with a
 * null prototype. Any other prototype refuses.
 */
function compileObjectCreate(
    context: ObjectStaticContext,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 1, 1);
    const prototype = context.unwrap(argumentAt(call, 0));
    if (prototype.kind !== ts.SyntaxKind.NullKeyword)
        return context.fail(
            call,
            "Object.create lowers with a null prototype only; other prototypes are not represented.",
        );
    const contextual = context.checker.getContextualType(call);
    const type = contextual
        ? context.dataTypes.fromTsType(contextual, call)
        : undefined;
    if (type?.kind !== "map" || !type.dictionary)
        return context.fail(
            call,
            "Object.create(null) needs a contextual string-keyed dictionary type.",
        );
    context.reachJsData();
    return {
        kind: "data",
        cpp: `${context.dataTypes.cppType(type)}{}`,
        dataType: type,
        recordProperties: {},
    };
}

/**
 * `Object.defineProperty(object, key, descriptor)` with a writable,
 * enumerable and configurable data descriptor: the own data property an
 * assignment creates, stored in a struct's field. Other attributes,
 * accessors and targets are not represented.
 */
function compileObjectDefineProperty(
    context: ObjectStaticContext,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 3, 3);
    const descriptor = context.unwrap(argumentAt(call, 2));
    const refuse = (message: string): never =>
        context.fail(call, `Object.defineProperty ${message}`);
    if (!ts.isObjectLiteralExpression(descriptor))
        return refuse("needs a literal data descriptor.");
    let valueNode: ts.Expression | undefined;
    const attributes = new Set<string>();
    for (const property of descriptor.properties) {
        if (
            !ts.isPropertyAssignment(property) ||
            !ts.isIdentifier(property.name)
        )
            return refuse("needs a literal data descriptor.");
        const name = property.name.text;
        if (name === "value") valueNode = property.initializer;
        else if (
            ["writable", "enumerable", "configurable"].includes(name) &&
            property.initializer.kind === ts.SyntaxKind.TrueKeyword
        )
            attributes.add(name);
        else
            return refuse(
                `represents writable, enumerable and configurable data properties only, not '${name}: ${property.initializer.getText()}'.`,
            );
    }
    if (!valueNode || attributes.size !== 3)
        return refuse(
            "represents a value with writable, enumerable and configurable all true only.",
        );
    const keyNode = argumentAt(call, 1);
    const key = context.compileValue(keyNode).staticString;
    if (key === undefined)
        return refuse("needs a property key known at generation.");
    const targetNode = argumentAt(call, 0);
    const target = context.compileValue(targetNode);
    if (target.kind !== "data" || target.dataType?.kind !== "struct")
        return refuse(
            `writes a struct's field; a ${target.kind} target is not represented.`,
        );
    const structType = target.dataType;
    // A shared object is held while the value runs; a value struct is written
    // where it is stored, which a value that runs code could replace first.
    const reference = context.dataTypes.isReferenceStruct(structType.name);
    if (!reference && expressionMayRunCode(valueNode))
        return refuse(
            "with a value that runs code writes a struct that value could replace.",
        );
    const owner = reference
        ? context.bindings.pinValueToTemporary(
              target,
              "defined_object",
              targetNode,
          )
        : target;
    const field = context.dataTypes.structField(structType.name, key, keyNode);
    const stored = context.dataLowerer.compileForSink(valueNode, field.type);
    const access = reference ? "->" : ".";
    context.emit({
        kind: "expression",
        code: `${owner.cpp}${access}${field.name} = ${stored};`,
    });
    context.bindings.invalidateRecordProperties(target);
    const targetName = context.unwrap(targetNode);
    const bound = ts.isIdentifier(targetName)
        ? context.bindings.lookupOptional(targetName)
        : undefined;
    if (bound) context.bindings.invalidateRecordProperties(bound);
    return owner;
}

/**
 * The `Object` statics lowered here, beside `Object.keys`/`values` (the
 * expression lowerer's projection) and `Object.freeze`/`seal` (identities
 * the static evaluator sees through).
 */
export const OBJECT_STATIC_HANDLERS: ReadonlyMap<
    string,
    (context: ObjectStaticContext, call: ts.CallExpression) => Value
> = new Map([
    ["assign", compileObjectAssign],
    ["create", compileObjectCreate],
    ["defineProperty", compileObjectDefineProperty],
    ["entries", compileObjectEntries],
    ["fromEntries", compileObjectFromEntries],
    ["hasOwn", compileObjectHasOwn],
    ["is", compileObjectIs],
]);
