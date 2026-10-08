import type { DataKind, DataType } from "./model.js";

export interface DataTypeCppContext {
    cppType(type: DataType): string;
    namedType(name: string): string;
    isReferenceStruct(name: string): boolean;
    enumSize(name: string): number;
    tableCppType(dimensions: number[]): string;
}

type DataTypeKey = (type: DataType) => string;
type DataTypeEquality = (left: DataType, right: DataType) => boolean;
export type StructFieldTypes = (name: string) => readonly DataType[];

/**
 * What JavaScript observes of a primitive whose native value is a class (a
 * BigInt, a symbol), which is a value: writing a copy of one rebinds it.
 */
export interface PrimitiveTraits {
    /** Its `typeof` answer. */
    readonly typeofTag: "bigint" | "symbol";
    /** Its truthiness, as a native condition over `cpp`. */
    truthyCpp(cpp: string): string;
    /** Its `String()` text. */
    stringCpp(cpp: string): string;
    /** Whether an implicit text conversion reads it; otherwise it throws a TypeError. */
    readonly implicitString: boolean;
}

/** Every data kind supplies the operations that depend on its payload. */
export type DataKindOperations<K extends DataKind = DataKind> = {
    [P in K]: {
        cpp(type: DataType<P>, context: DataTypeCppContext): string;
        key(type: DataType<P>, key: DataTypeKey): string;
        equal(
            left: DataType<P>,
            right: DataType<P>,
            equal: DataTypeEquality,
        ): boolean;
        children(
            type: DataType<P>,
            fields: StructFieldTypes,
            signatures: boolean,
        ): readonly DataType[];
        readonly byReference: boolean;
        /** Opaque Ref<T> leaf: copies retain identity, assignment reseats it, and get() exposes it. */
        readonly opaqueReference?: true;
        /**
         * A container or view whose native copies share one object's
         * storage, as JavaScript references do: a write through either is
         * seen by both, and assignment reseats the name.
         */
        readonly sharesStorage?: true;
        /**
         * Assignment to storage of this kind reseats the name as JavaScript
         * does: a primitive copies its value, a shared wrapper the identity
         * of the object it names; `children` when every member type does
         * (optional, union). A struct reseats as a reference record;
         * any other kind (a borrowed view) would copy instead.
         */
        readonly reseats?: true | "children";
        /** A primitive held in a native value class ({@link PrimitiveTraits}). */
        readonly primitive?: PrimitiveTraits;
        /**
         * Whether the native value can own an edge the cycle collector
         * traces (`bbl::js::gc_traceable`): always, never, through its
         * stored children, or decided by the payload.
         */
        readonly tracedEdges:
            "always" | "never" | "children" | ((type: DataType<P>) => string);
    };
};
