import { CPP_ELEMENT, CPP_SCALAR } from "./cpp-types.js";
import ts from "typescript";

/** The represented shape of a pinned value, independent of its native owner. */
export type RecordShape =
    | {
          readonly kind:
              "number" | "boolean" | "string" | "void" | "object" | "buffer";
      }
    | {
          readonly kind: "native";
          readonly cpp: string;
          readonly nullable?: boolean;
          readonly fromString?: boolean;
      }
    | { readonly kind: "record"; readonly name: string }
    | { readonly kind: "array" | "set"; readonly element: RecordShape }
    | { readonly kind: "tuple"; readonly elements: readonly RecordShape[] }
    | {
          readonly kind: "map";
          readonly key: RecordShape;
          readonly value: RecordShape;
      }
    | { readonly kind: "weakmap"; readonly value: RecordShape }
    | { readonly kind: "weakset" }
    | { readonly kind: "typed"; readonly element: "f32" | "u32" | "i32" | "u8" }
    | {
          readonly kind: "function";
          readonly parameters: readonly RecordShape[];
          readonly result: RecordShape;
      }
    | { readonly kind: "optional"; readonly value: RecordShape }
    | { readonly kind: "variant"; readonly members: readonly RecordShape[] };

export const recordScalars = {
    number: { kind: "number" },
    boolean: { kind: "boolean" },
    string: { kind: "string" },
    void: { kind: "void" },
    object: { kind: "object" },
} as const satisfies Record<string, RecordShape>;

/** Literal unions such as true | false retain their primitive representation. */
export function primitiveRecordShape(
    types: readonly ts.Type[],
): RecordShape | undefined {
    if (!types.length) return undefined;
    if (types.every((type) => type.flags & ts.TypeFlags.NumberLike))
        return recordScalars.number;
    if (types.every((type) => type.flags & ts.TypeFlags.BooleanLike))
        return recordScalars.boolean;
    if (types.every((type) => type.flags & ts.TypeFlags.StringLike))
        return recordScalars.string;
    return undefined;
}

export const recordOf = (name: string): RecordShape => ({
    kind: "record",
    name,
});
export const arrayOf = (element: RecordShape): RecordShape => ({
    kind: "array",
    element,
});
export const tupleOf = (elements: readonly RecordShape[]): RecordShape => ({
    kind: "tuple",
    elements,
});

export function optionalOf(shape: RecordShape): RecordShape {
    return shape.kind === "optional"
        ? shape
        : { kind: "optional", value: shape };
}

export function stripOptional(shape: RecordShape): RecordShape {
    return shape.kind === "optional" ? shape.value : shape;
}

export function isRecordScalar(shape: RecordShape | undefined): boolean {
    return shape?.kind === "number" || shape?.kind === "boolean";
}

export const typedElementCpp = CPP_ELEMENT;

/** Native ownership choices; shape and absence rules are shared by every record lowerer. */
export interface RecordStorage {
    record(name: string): { readonly cpp: string; readonly reference: boolean };
    readonly object: string;
    readonly jsNamespace: string;
    tuple(elements: readonly string[]): string;
}

export class RecordRepresentation {
    constructor(private readonly storage: RecordStorage) {}

    public nullable(shape: RecordShape): boolean {
        return (
            shape.kind === "object" ||
            shape.kind === "function" ||
            (shape.kind === "native" && shape.nullable === true) ||
            (shape.kind === "record" &&
                this.storage.record(shape.name).reference)
        );
    }

    /** An optional handle has no additional storage wrapper. */
    public storedShape(shape: RecordShape): RecordShape {
        return shape.kind === "optional" && this.nullable(shape.value)
            ? shape.value
            : shape;
    }

    public cppType(shape: RecordShape): string {
        const js = this.storage.jsNamespace;
        switch (shape.kind) {
            case "number":
            case "boolean":
            case "string":
                return CPP_SCALAR[shape.kind];
            case "void":
                return "void";
            case "object":
                return this.storage.object;
            case "native":
                return shape.cpp;
            case "record":
                return this.storage.record(shape.name).cpp;
            case "buffer":
                return `${js}::ArrayBuffer`;
            case "array":
                return `${js}::Array<${this.cppType(shape.element)}>`;
            case "set":
                return `${js}::Set<${this.cppType(shape.element)}>`;
            case "tuple":
                return this.storage.tuple(
                    shape.elements.map((element) => this.cppType(element)),
                );
            case "map":
                return `${js}::Map<${this.cppType(shape.key)}, ${this.cppType(shape.value)}>`;
            case "weakmap":
                return `${js}::WeakMap<${this.cppType(shape.value)}>`;
            case "weakset":
                return `${js}::WeakMap<bool>`;
            case "typed":
                return `${js}::TypedArray<${typedElementCpp[shape.element]}>`;
            case "function":
                return `${js}::Callback<${this.cppType(shape.result)}(${shape.parameters.map((parameter) => this.cppType(parameter)).join(", ")})>`;
            case "optional":
                return this.nullable(shape.value)
                    ? this.cppType(shape.value)
                    : `${js}::Nullable<${this.cppType(shape.value)}>`;
            case "variant":
                return `std::variant<${shape.members.map((member) => this.cppType(member)).join(", ")}>`;
        }
    }

    public absent(shape: RecordShape): string | undefined {
        if (shape.kind === "optional")
            return this.nullable(shape.value)
                ? `${this.cppType(shape.value)}{}`
                : "std::nullopt";
        return this.nullable(shape) ? `${this.cppType(shape)}{}` : undefined;
    }

    public truthy(value: string, shape: RecordShape): string {
        return shape.kind === "boolean"
            ? value
            : `bbl::pinned::truthy(${value})`;
    }

    /** Read an optional whose presence was established by source control flow. */
    public present(value: string, shape: RecordShape): string {
        return shape.kind === "optional" && !this.nullable(shape.value)
            ? `bbl::pinned::present(${value})`
            : value;
    }
}
