import type { ValueBase, ValueFields, ValueKind } from "../types.js";
import type { ValuePayloads } from "./payloads.js";
import { generationPayloadFields, type GenerationPayloadKey } from "./payloads.js";
import { valueMetadataFields } from "./metadata.js";

type PayloadKey = { [K in keyof ValuePayloads]: keyof ValuePayloads[K] }[keyof ValuePayloads];
type PayloadValue<K extends keyof ValuePayloads> = {
    [P in K]: ValueBase & { kind: P } & ValuePayloads[P] &
        Partial<Record<Exclude<PayloadKey, keyof ValuePayloads[P]>, never>>;
}[K];

/** The value kind determines which compile-time payload it may carry. */
export type Value<K extends ValueKind = ValueKind> =
    | PayloadValue<Extract<K, keyof ValuePayloads>>
    | (ValueBase & { kind: Exclude<K, keyof ValuePayloads> } & Partial<Record<PayloadKey, never>>);

const payloadFields = new Map<ValueKind, ReadonlySet<string>>(
    Object.entries({ ...valueMetadataFields, ...generationPayloadFields })
        .map(([kind, fields]) => [kind as ValueKind, new Set<string>(fields)]),
);
const allPayloadFields = new Set([...payloadFields.values()].flatMap(fields => [...fields]));

/** Reclassify transported metadata without carrying fields from another kind. */
export function valueForKind<K extends ValueKind>(kind: K, fields: ValueFields & Pick<Value, GenerationPayloadKey>): Value<K> {
    const allowed = payloadFields.get(kind);
    const metadata = Object.fromEntries(Object.entries(fields).filter(([key]) =>
        key !== "kind" && (!allPayloadFields.has(key) || allowed?.has(key))));
    // The field registry validates this dynamic projection; cpp and kind are explicit.
    return { ...metadata, cpp: fields.cpp, kind } as Value<K>;
}

/** Restore transported facts after materializing a native data leaf. */
export function withNativeMetadata(value: Value, source: Value | undefined): Value {
    return valueForKind(value.kind, { ...nativeDataMetadata(source), ...value });
}

/** Native data views retain shared metadata, without generation-only payloads. */
export function nativeDataMetadata(value: Value | undefined): ValueFields {
    if (!value) return { cpp: "" };
    const { kind, promiseResult, promiseType, textFont, csgSolid, csg2Solid,
        executedUrl, animationGroupMask, ...metadata } = value;
    return metadata;
}
