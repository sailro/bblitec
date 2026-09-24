/**
 * Moves a value graph the pin built at generation into native records.
 *
 * The generation child executes the pin and walks the result by the record
 * model's own shapes (`transportGraph`), keeping JavaScript identity: an
 * object, array or map reached twice is one entry, so `runs` and `_runs`
 * stay one array and a run record's key stays the run it names. Typed
 * arrays travel as views over their `ArrayBuffer`s, which travel once as
 * bytes. The parent then spells the graph as the C++ that rebuilds it over
 * the emitted structs (`transportCpp`).
 *
 * This module carries no compiler dependency so the child can import it.
 */

/** A record-model shape, minus what cannot cross a process boundary. */
export type TransportShape =
    | {
          readonly kind:
              | "number"
              | "boolean"
              | "string"
              | "object"
              | "buffer"
              | "void"
              | "native";
          /** A native value that crosses as a string (a draw-group key). */
          readonly string?: true;
      }
    | { readonly kind: "record"; readonly name: string }
    | { readonly kind: "array" | "set"; readonly element: TransportShape }
    | { readonly kind: "tuple"; readonly length: number }
    | {
          readonly kind: "map";
          readonly key: TransportShape;
          readonly value: TransportShape;
      }
    | { readonly kind: "typed"; readonly element: "f32" | "u32" | "u8" }
    | { readonly kind: "optional"; readonly value: TransportShape }
    | { readonly kind: "variant"; readonly members: readonly TransportShape[] }
    | { readonly kind: "weakmap" | "weakset" | "function" };

export interface TransportRecord {
    readonly reference: boolean;
    readonly members: readonly (readonly [string, TransportShape])[];
}

export interface TransportSchema {
    readonly records: Readonly<Record<string, TransportRecord>>;
}

export type Transported =
    | number
    | string
    | boolean
    | null
    | { readonly number: "NaN" | "Infinity" | "-Infinity" }
    | { readonly ref: number }
    | { readonly value: Readonly<Record<string, Transported>> }
    | { readonly container: number }
    | {
          readonly typed: "f32" | "u32" | "u8";
          readonly buffer: number;
          readonly byteOffset: number;
          readonly length: number;
      }
    | { readonly tuple: readonly number[] }
    | { readonly variant: number; readonly of: Transported };

export interface TransportedRecord {
    readonly name: string;
    readonly fields: Readonly<Record<string, Transported>>;
}

export type TransportedContainer =
    | { readonly kind: "array" | "set"; readonly items: readonly Transported[] }
    | {
          readonly kind: "map";
          readonly entries: readonly (readonly [Transported, Transported])[];
      };

export interface TransportedGraph {
    readonly root: Transported;
    readonly records: readonly TransportedRecord[];
    readonly containers: readonly TransportedContainer[];
    /** Each buffer's bytes, base64. */
    readonly buffers: readonly string[];
}

const typedConstructors = {
    f32: Float32Array,
    u32: Uint32Array,
    u8: Uint8Array,
} as const;

/** Walk `root` by `shape`, keeping identity. Runs in the generation child. */
export function transportGraph(
    root: unknown,
    shape: TransportShape,
    schema: TransportSchema,
): TransportedGraph {
    const records: TransportedRecord[] = [];
    const containers: TransportedContainer[] = [];
    const buffers: ArrayBufferLike[] = [];
    const ids = new Map<object, number>();
    const fail = (message: string): never => {
        throw new Error(`Pinned value transport: ${message}`);
    };
    const buffer = (value: ArrayBufferLike): number => {
        let id = buffers.indexOf(value);
        if (id < 0) id = buffers.push(value) - 1;
        return id;
    };
    const walk = (value: unknown, current: TransportShape): Transported => {
        switch (current.kind) {
            case "number":
                if (typeof value !== "number")
                    return fail(`expected a number, found ${typeof value}`);
                if (Number.isNaN(value)) return { number: "NaN" };
                if (value === Infinity) return { number: "Infinity" };
                if (value === -Infinity) return { number: "-Infinity" };
                return value;
            case "boolean":
                if (typeof value !== "boolean")
                    return fail("expected a boolean");
                return value;
            case "string":
                if (typeof value !== "string") return fail("expected a string");
                return value;
            case "native":
                if (current.string && typeof value === "string") return value;
                if (current.string)
                    return fail("a native key crossed as a non-string");
                return null;
            case "void":
                return null;
            case "optional":
                return value === null || value === undefined
                    ? null
                    : walk(value, current.value);
            case "tuple":
                if (!Array.isArray(value) || value.length !== current.length)
                    return fail("expected a numeric tuple");
                return {
                    tuple: value.map((element: unknown) => {
                        if (
                            typeof element !== "number" ||
                            !Number.isFinite(element)
                        )
                            return fail("tuple element is not a finite number");
                        return element;
                    }),
                };
            case "typed": {
                const constructor = typedConstructors[current.element];
                if (!(value instanceof constructor))
                    return fail(`expected a ${constructor.name}`);
                return {
                    typed: current.element,
                    buffer: buffer(value.buffer),
                    byteOffset: value.byteOffset,
                    length: value.length,
                };
            }
            case "variant": {
                const index = current.members.findIndex((member) =>
                    member.kind === "number"
                        ? typeof value === "number"
                        : member.kind === "string"
                          ? typeof value === "string"
                          : member.kind === "boolean"
                            ? typeof value === "boolean"
                            : typeof value === "object" && value !== null,
                );
                if (index < 0) return fail("no variant member matches");
                return {
                    variant: index,
                    of: walk(value, current.members[index]!),
                };
            }
            case "record": {
                if (typeof value !== "object" || value === null)
                    return fail(`expected ${current.name}`);
                const record =
                    schema.records[current.name] ??
                    fail(`unknown record ${current.name}`);
                const fields = (): Record<string, Transported> =>
                    Object.fromEntries(
                        record.members.map(([name, member]) => [
                            name,
                            walk(
                                (value as Record<string, unknown>)[name],
                                member,
                            ),
                        ]),
                    );
                if (!record.reference) return { value: fields() };
                const known = ids.get(value);
                if (known !== undefined) return { ref: known };
                const id = records.length;
                ids.set(value, id);
                records.push({ name: current.name, fields: {} });
                records[id] = { name: current.name, fields: fields() };
                return { ref: id };
            }
            case "array":
            case "set":
            case "map": {
                if (typeof value !== "object" || value === null)
                    return fail(`expected a ${current.kind}`);
                const known = ids.get(value);
                if (known !== undefined) return { container: known };
                const id = containers.length;
                ids.set(value, id);
                containers.push({ kind: "array", items: [] });
                if (current.kind === "map") {
                    if (!(value instanceof Map)) return fail("expected a Map");
                    containers[id] = {
                        kind: "map",
                        entries: [...value].map(
                            ([key, entry]) =>
                                [
                                    walk(key, current.key),
                                    walk(entry, current.value),
                                ] as const,
                        ),
                    };
                } else {
                    const items =
                        current.kind === "set"
                            ? value instanceof Set
                                ? [...value]
                                : fail("expected a Set")
                            : Array.isArray(value)
                              ? value
                              : fail("expected an Array");
                    containers[id] = {
                        kind: current.kind,
                        items: items.map((item: unknown) =>
                            walk(item, current.element),
                        ),
                    };
                }
                return { container: id };
            }
            case "object":
            case "buffer":
            case "weakmap":
            case "weakset":
            case "function":
                return fail(`a ${current.kind} does not cross from generation`);
        }
    };
    const transported = walk(root, shape);
    return {
        root: transported,
        records,
        containers,
        buffers: buffers.map((bytes) => Buffer.from(bytes).toString("base64")),
    };
}
