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

/**
 * Whether a stored value of `type` can own an edge the native cycle collector
 * traces. A record answers from `untraced`, the records proven to own none.
 */
export function ownsTracedEdge(
    type: DataType,
    fields: StructFieldTypes,
    untraced: ReadonlySet<string>,
): boolean {
    if (type.kind === "struct") return !untraced.has(type.name);
    const traced = tracedEdges(type);
    return traced === "children"
        ? children(type, fields, false).some((child) =>
              ownsTracedEdge(child, fields, untraced),
          )
        : traced === "always";
}

/**
 * The records that own no traced edge, as the least fixed point: a record that
 * reaches itself through references stays traced, since it can close a cycle.
 * Such a record declares no `gc_trace_edges`, so `bbl::js::make_ref` leaves
 * it out of the collector's registry.
 */
export function untracedRecords(
    names: Iterable<string>,
    fields: StructFieldTypes,
): Set<string> {
    const untraced = new Set<string>();
    const candidates = [...names];
    for (let changed = true; changed;) {
        changed = false;
        for (const name of candidates) {
            if (
                !untraced.has(name) &&
                fields(name).every(
                    (field) => !ownsTracedEdge(field, fields, untraced),
                )
            ) {
                untraced.add(name);
                changed = true;
            }
        }
    }
    return untraced;
}

function tracedEdges<K extends DataKind>(
    type: DataType<K>,
): "always" | "never" | "children" {
    const traced = kinds[type.kind].tracedEdges;
    if (typeof traced !== "function") return traced;
    return traced(type) ? "always" : "never";
}

function children<K extends DataKind>(
    type: DataType<K>,
    fields: StructFieldTypes,
    signatures: boolean,
): readonly DataType[] {
    return kinds[type.kind].children(type, fields, signatures);
}
