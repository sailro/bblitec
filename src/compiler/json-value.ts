// Shared JSON-to-`Value` conversion for generation-time JSON inputs.
//
// Two lowerers turn a parsed JSON document into the compiler's
// tuple/record values: the compressed-NME decoder and the static fetch
// response. Their recursions are the same walk, but their outputs differ
// deliberately — numeric width and how much static metadata each value
// carries — so the shared converter takes those two policies as explicit
// inputs. A drift in either output is then a visible policy edit here,
// not an accident of two copies aging apart.
import ts from "typescript";

import type { Value } from "./types.js";

/** The two members both converter owners already expose. */
export interface JsonValueContext {
    cppString(value: string): string;
    fail(node: ts.Node, message: string): never;
}

/**
 * What deliberately differs between the two converters. Every member is
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

/** Convert one parsed JSON value under the caller's explicit policy. */
export function jsonToValue(
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
        if (
            policy.nonFiniteMessage !== undefined &&
            !Number.isFinite(json)
        ) {
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
    if (Array.isArray(json)) {
        return {
            kind: "tuple",
            cpp: "",
            tupleElements: json.map((element) =>
                jsonToValue(context, policy, element, node),
            ),
            ...(policy.staticMetadata ? { staticJson: json } : {}),
        };
    }
    if (typeof json === "object") {
        return {
            kind: "record",
            cpp: "",
            recordProperties: Object.fromEntries(
                Object.entries(json).map(([name, value]) => [
                    name,
                    jsonToValue(context, policy, value, node),
                ]),
            ),
            ...(policy.staticMetadata ? { staticJson: json } : {}),
        };
    }
    context.fail(node, policy.unsupportedMessage);
}
