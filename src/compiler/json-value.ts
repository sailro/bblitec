import type { LoweringServices } from "./lowering-services.js";
// Shared JSON-to-`Value` conversion for generation-time JSON inputs.
//
// The compressed-NME decoder, the static fetch response and executed
// module constants turn a JSON value into the compiler's tuple/record
// values. Their recursions are the same walk, but their outputs differ
// deliberately — numeric width and how much static metadata each value
// carries — so the shared converter takes each policy as an explicit
// input. A drift in one output is then a visible policy edit, not an
// accident of copies aging apart.
import ts from "typescript";

import type { Value } from "./types.js";
import { undefinedValue } from "./values/model.js";

/** The two members every converter owner already exposes. */
interface JsonValueContext extends Pick<
    LoweringServices,
    "cppString" | "fail"
> {}

/**
 * What deliberately differs between the converters. Every member is
 * explicit so the owning module states its whole policy in one literal
 * beside the call, and a new consumer cannot inherit a default it did
 * not choose.
 */
export interface JsonValuePolicy {
    /**
     * The numeric-literal renderer: the compressed-NME lane stores
     * doubles (graph scalars feed pinned double arithmetic), the fetch
     * lane floats (its numbers land in the default float sinks).
     */
    numberLiteral(value: number): string;
    /** The C++ spelling of JSON null this consumer expects. */
    nullCpp: string;
    /**
     * Whether every produced value carries `staticJson` (plus the scalar
     * `dataType` and `staticBoolean` lanes): the compressed lane feeds
     * whole documents to further generation-known passes, the fetch lane
     * keeps only the per-kind static fields.
     */
    staticMetadata: boolean;
    /**
     * Refusal for a non-finite number, or undefined to accept — a
     * JSON.parse result cannot carry one, so the compressed lane omits
     * the check while the fetch lane keeps its historical guard.
     */
    nonFiniteMessage?: string;
    /** Refusal for a value JSON cannot represent. */
    unsupportedMessage: string;
}

/** What a part of a JSON value at a key path reads as, where not itself. */
type JsonLeafReader = (
    json: unknown,
    path: readonly (string | number)[],
) => Value | undefined;

/**
 * Convert one parsed JSON value under the caller's explicit policy. With
 * `leaf`, a part it reads as a value (by its key path) is that value, and
 * the arrays and objects holding one carry no `staticJson`.
 */
export function jsonToValue(
    context: JsonValueContext,
    policy: JsonValuePolicy,
    json: unknown,
    node: ts.Node,
    leaf?: JsonLeafReader,
): Value {
    return convertJson(context, policy, json, node, leaf, []).value;
}

function convertJson(
    context: JsonValueContext,
    policy: JsonValuePolicy,
    json: unknown,
    node: ts.Node,
    leaf: JsonLeafReader | undefined,
    path: readonly (string | number)[],
): { readonly value: Value; readonly read: boolean } {
    const read = leaf?.(json, path);
    if (read) return { value: read, read: true };
    if (Array.isArray(json)) {
        const elements = json.map((element, index) =>
            convertJson(context, policy, element, node, leaf, [...path, index]),
        );
        const held = !elements.some(({ read }) => read);
        return {
            value: {
                kind: "tuple",
                cpp: "",
                tupleElements: elements.map(({ value }) => value),
                ...(policy.staticMetadata && held ? { staticJson: json } : {}),
            },
            read: !held,
        };
    }
    if (typeof json === "object" && json !== null) {
        // A generation run's record may hold undefined members, which
        // read as undefined (`executeApplicationFunction`); JSON has none.
        const properties = Object.entries(json).map(
            ([name, value]) =>
                [
                    name,
                    value === undefined
                        ? { value: undefinedValue(), read: false }
                        : convertJson(context, policy, value, node, leaf, [
                              ...path,
                              name,
                          ]),
                ] as const,
        );
        const held = !properties.some(([, { read }]) => read);
        return {
            value: {
                kind: "record",
                cpp: "",
                recordProperties: Object.fromEntries(
                    properties.map(([name, { value }]) => [name, value]),
                ),
                ...(policy.staticMetadata && held ? { staticJson: json } : {}),
            },
            read: !held,
        };
    }
    return { value: scalarJsonValue(context, policy, json, node), read: false };
}

function scalarJsonValue(
    context: JsonValueContext,
    policy: JsonValuePolicy,
    json: unknown,
    node: ts.Node,
): Value {
    if (json === null) {
        return {
            kind: "json-null",
            cpp: policy.nullCpp,
            ...(policy.staticMetadata ? { staticJson: null } : {}),
        };
    }
    if (typeof json === "string") {
        return {
            kind: "string",
            cpp: context.cppString(json),
            staticString: json,
            ...(policy.staticMetadata ? { staticJson: json } : {}),
        };
    }
    if (typeof json === "number") {
        if (policy.nonFiniteMessage !== undefined && !Number.isFinite(json)) {
            context.fail(node, policy.nonFiniteMessage);
        }
        return {
            kind: "number",
            cpp: policy.numberLiteral(json),
            staticNumber: json,
            ...(policy.staticMetadata
                ? {
                      staticJson: json,
                      dataType: { kind: "number" as const },
                  }
                : {}),
        };
    }
    if (typeof json === "boolean") {
        return {
            kind: "boolean",
            cpp: json ? "true" : "false",
            ...(policy.staticMetadata
                ? {
                      staticBoolean: json,
                      staticJson: json,
                      dataType: { kind: "boolean" as const },
                  }
                : {}),
        };
    }
    context.fail(node, policy.unsupportedMessage);
}
