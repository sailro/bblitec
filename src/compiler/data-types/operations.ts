import { containerKinds } from "./containers.js";
import type { DataKindOperations, DataTypeCppContext, StructFieldTypes } from "./contracts.js";
import type { DataKind, DataType } from "./model.js";
import { namedKinds } from "./named.js";
import { scalarKinds } from "./scalars.js";

export type { DataTypeCppContext } from "./contracts.js";

const kinds: DataKindOperations = { ...scalarKinds, ...containerKinds, ...namedKinds };

export function dataTypeCppType<K extends DataKind>(type: DataType<K>, context: DataTypeCppContext): string {
    return kinds[type.kind].cpp(type, context);
}

export function dataTypeKey<K extends DataKind>(type: DataType<K>): string {
    return kinds[type.kind].key(type, dataTypeKey);
}

export function dataTypesEqual<K extends DataKind>(left: DataType<K>, right: DataType<K>): boolean {
    return left.kind === right.kind && kinds[left.kind].equal(left, right, dataTypesEqual);
}

export function passesByReferenceKind(type: DataType): boolean {
    return kinds[type.kind].byReference;
}

/** Walk stored members, optionally including the types in a function signature. */
export function containsDataKind(
    type: DataType, target: DataKind, fields: StructFieldTypes,
    signatures: boolean, seen: Set<string>,
): boolean {
    if (type.kind === target) return true;
    if (type.kind === "struct") {
        if (seen.has(type.name)) return false;
        seen.add(type.name);
    }
    return children(type, fields, signatures).some(child =>
        containsDataKind(child, target, fields, signatures, seen));
}

function children<K extends DataKind>(type: DataType<K>, fields: StructFieldTypes, signatures: boolean): readonly DataType[] {
    return kinds[type.kind].children(type, fields, signatures);
}
