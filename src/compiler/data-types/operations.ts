import { containerKinds } from "./containers.js";
import type {
    DataKindOperations,
    DataTypeCppContext,
    StructFieldTypes,
} from "./contracts.js";
import type { DataKind, DataType } from "./model.js";
import { namedKinds } from "./named.js";
import { scalarKinds } from "./scalars.js";

export type { DataTypeCppContext } from "./contracts.js";

const kinds: DataKindOperations = {
    ...scalarKinds,
    ...containerKinds,
    ...namedKinds,
};

export function dataTypeCppType<K extends DataKind>(
    type: DataType<K>,
    context: DataTypeCppContext,
): string {
    return kinds[type.kind].cpp(type, context);
}

export function dataTypeKey<K extends DataKind>(type: DataType<K>): string {
    return kinds[type.kind].key(type, dataTypeKey);
}

export function dataTypesEqual<K extends DataKind>(
    left: DataType<K>,
    right: DataType<K>,
): boolean {
    return (
        left.kind === right.kind &&
        kinds[left.kind].equal(left, right, dataTypesEqual)
    );
}

export function passesByReferenceKind(type: DataType): boolean {
    return kinds[type.kind].byReference;
}

export function isOpaqueReference(type: DataType | undefined): boolean {
    return type !== undefined && kinds[type.kind].opaqueReference === true;
}

/** Walk stored members, optionally including the types in a function signature. */
export function containsDataKind(
    type: DataType,
    target: DataKind,
    fields: StructFieldTypes,
    signatures: boolean,
    seen: Set<string>,
): boolean {
    if (type.kind === target) return true;
    if (type.kind === "struct") {
        if (seen.has(type.name)) return false;
        seen.add(type.name);
    }
    return children(type, fields, signatures).some((child) =>
        containsDataKind(child, target, fields, signatures, seen),
    );
}

/** A native predicate is needed only for fields whose handle decides traceability. */
export type TraceCondition = boolean | string;

export function tracedEdgeCondition(
    type: DataType,
    record: (name: string) => TraceCondition,
): TraceCondition {
    if (type.kind === "struct") return record(type.name);
    return kindTraceCondition(type, record);
}

function kindTraceCondition<K extends DataKind>(
    type: DataType<K>,
    record: (name: string) => TraceCondition,
): TraceCondition {
    const traced = kinds[type.kind].tracedEdges;
    if (typeof traced === "function") return traced(type);
    if (traced !== "children") return traced === "always";
    return anyTraceCondition(
        children(type, () => [], false).map((child) =>
            tracedEdgeCondition(child, record),
        ),
    );
}

function anyTraceCondition(
    conditions: readonly TraceCondition[],
): TraceCondition {
    if (conditions.includes(true)) return true;
    const predicates = [
        ...new Set(
            conditions.filter(
                (condition): condition is string =>
                    typeof condition === "string",
            ),
        ),
    ];
    return predicates.length ? predicates.join(" || ") : false;
}

/** Recursive records remain traced; acyclic handle fields defer to the native trait. */
export function recordTraceConditions(
    names: Iterable<string>,
    fields: StructFieldTypes,
): ReadonlyMap<string, TraceCondition> {
    const conditions = new Map<string, TraceCondition>();
    const pending = new Set<string>();
    const record = (name: string): TraceCondition => {
        const cached = conditions.get(name);
        if (cached !== undefined) return cached;
        if (pending.has(name)) return true;
        pending.add(name);
        const condition = anyTraceCondition(
            fields(name).map((field) => tracedEdgeCondition(field, record)),
        );
        pending.delete(name);
        conditions.set(name, condition);
        return condition;
    };
    for (const name of names) record(name);
    return conditions;
}

function children<K extends DataKind>(
    type: DataType<K>,
    fields: StructFieldTypes,
    signatures: boolean,
): readonly DataType[] {
    return kinds[type.kind].children(type, fields, signatures);
}
