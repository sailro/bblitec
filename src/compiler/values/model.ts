import type { ValueBase, ValueFields, ValueKind } from "../types.js";
import type { ValuePayloads } from "./payloads.js";
import {
    generationPayloadFields,
    type GenerationPayloadKey,
} from "./payloads.js";
import { valueMetadataFields } from "./metadata.js";

type PayloadKey = {
    [K in keyof ValuePayloads]: keyof ValuePayloads[K];
}[keyof ValuePayloads];
type PayloadValue<K extends keyof ValuePayloads> = {
    [P in K]: ValueBase & { kind: P } & ValuePayloads[P] &
        Partial<Record<Exclude<PayloadKey, keyof ValuePayloads[P]>, never>>;
}[K];

/**
 * The value kind determines which compile-time payload it may carry. A value
 * is compiler state a declined probe must restore, so its fields are written
 * in place only through `writable()`.
 */
export type Value<K extends ValueKind = ValueKind> = Readonly<
    | PayloadValue<Extract<K, keyof ValuePayloads>>
    | (ValueBase & { kind: Exclude<K, keyof ValuePayloads> } & Partial<
              Record<PayloadKey, never>
          >)
>;

const payloadFields = new Map<ValueKind, ReadonlySet<string>>(
    Object.entries({ ...valueMetadataFields, ...generationPayloadFields }).map(
        ([kind, fields]) => [kind as ValueKind, new Set<string>(fields)],
    ),
);
const allPayloadFields = new Set(
    [...payloadFields.values()].flatMap((fields) => [...fields]),
);

/** Reclassify transported metadata without carrying fields from another kind. */
export function valueForKind<K extends ValueKind>(
    kind: K,
    fields: ValueFields & Pick<Value, GenerationPayloadKey>,
): Value<K> {
    const allowed = payloadFields.get(kind);
    const metadata = Object.fromEntries(
        Object.entries(fields).filter(
            ([key]) =>
                key !== "kind" &&
                (!allPayloadFields.has(key) || allowed?.has(key)),
        ),
    );
    // The field registry validates this dynamic projection; cpp and kind are explicit.
    return { ...metadata, cpp: fields.cpp, kind } as Value<K>;
}

/** Restore transported facts after materializing a native data leaf. */
export function withNativeMetadata(
    value: Value,
    source: Value | undefined,
): Value {
    return valueForKind(value.kind, {
        ...nativeDataMetadata(source),
        ...value,
    });
}

/** The native test that an optional expression holds a value. */
export function optionalPresentCpp(cpp: string): string {
    return `${cpp}.has_value()`;
}

/**
 * The presence flag a maybe-absent value carries BESIDE its storage: a
 * search's found bit, a guarded element read's in-range test, or the
 * owner presence an optional chain threads through its reads. The storage
 * then holds a safe default, so the flag, not the storage, says whether
 * the value is there. Undefined when absence lives in the storage itself
 * ({@link presenceCpp} reads that too) or cannot occur. Presence only.
 */
export function presenceFlagCpp(value: Value): string | undefined {
    return value.optionalFoundCpp;
}

/**
 * Whether a nullable value is there, as a native test: its
 * {@link presenceFlagCpp}, else the engagement of its optional storage;
 * undefined for a value that cannot be absent. Presence only --
 * JavaScript truthiness of a present but falsy value is
 * `DataLowerer.truthinessCondition`'s.
 */
export function presenceCpp(value: Value): string | undefined {
    return (
        presenceFlagCpp(value) ??
        (value.dataType?.kind === "optional"
            ? optionalPresentCpp(value.cpp)
            : undefined)
    );
}

/**
 * The JavaScript truthiness a value states where it differs from its
 * presence: an object that is always truthy (`"true"`), or one whose
 * native spelling of "there" is not its presence flag. Undefined when the
 * value states none.
 */
export function statedTruthinessCpp(value: Value): string | undefined {
    return value.truthinessCpp;
}

/**
 * An OBJECT value's JavaScript truthiness: what it states, else its
 * presence flag, because a present object is truthy whatever it holds.
 * Undefined when the value states neither, which for an object that
 * cannot be absent means truthy. Never a primitive's truthiness: a
 * present `0`, `""` or `false` is falsy (`truthinessCondition`).
 */
export function objectTruthinessCpp(value: Value): string | undefined {
    return statedTruthinessCpp(value) ?? presenceFlagCpp(value);
}

/** Native data views retain shared metadata, without generation-only payloads. */
export function nativeDataMetadata(value: Value | undefined): ValueFields {
    if (!value) return { cpp: "" };
    const {
        kind,
        abruptCompletion,
        coroutineResult,
        promiseResult,
        promiseType,
        textFont,
        csgSolid,
        csg2Solid,
        executedUrl,
        animationGroupMask,
        ...metadata
    } = value;
    return metadata;
}
