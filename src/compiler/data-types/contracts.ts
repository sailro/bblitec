import type { DataKind, DataType } from "./model.js";

export interface DataTypeCppContext {
    cppType(type: DataType): string;
    namedType(name: string): string;
    isReferenceStruct(name: string): boolean;
    enumSize(name: string): number;
    tableCppType(dimensions: number[]): string;
}

export type DataTypeKey = (type: DataType) => string;
export type DataTypeEquality = (left: DataType, right: DataType) => boolean;
export type StructFieldTypes = (name: string) => readonly DataType[];

/** Every data kind supplies the operations that depend on its payload. */
export type DataKindOperations<K extends DataKind = DataKind> = {
    [P in K]: {
        cpp(type: DataType<P>, context: DataTypeCppContext): string;
        key(type: DataType<P>, key: DataTypeKey): string;
        equal(left: DataType<P>, right: DataType<P>, equal: DataTypeEquality): boolean;
        children(type: DataType<P>, fields: StructFieldTypes, signatures: boolean): readonly DataType[];
        readonly byReference: boolean;
    };
};
