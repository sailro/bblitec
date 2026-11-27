import { StorageDemand } from "./storage-demand.js";
import { CompileError } from "./compile-error.js";
import type { StorageRequest } from "./replay-storage.js";
import ts from "typescript";
import {
    sameRecordJoin,
    type InstantiatedRecord,
    type RecordJoin,
} from "./record-components.js";
import type { DataType } from "./data-types/model.js";
import { dataTypeKey, dataTypesEqual } from "./data-types/operations.js";
import { declaredRecordName } from "./type-facts.js";

/** The source type and generic environment that produced a native record. */
export interface NativeRecordStorageDemand {
    identity: ts.Symbol | ts.Type | string;
    /** Stable identity when a generic source is mapped under concrete arguments. */
    instantiation?: InstantiatedRecord;
    type: ts.Type;
    node: ts.Node;
    frames: readonly ReadonlyMap<ts.Symbol, ts.Type>[];
    /** Mapped where the record is stored, its declared functions too (`fromStoredTsType`). */
    stored?: true;
    /** Mapped where `unknown` values are stored as JSON (`withDynamicJsonTypes`). */
    dynamicJsonStorage?: true;
    /** Every field must retain a receiver-aware accessor slot. */
    proxy?: true;
    /** An actual Proxy forwards the record's methods through another receiver. */
    proxyTarget?: true;
    /**
     * Records of this type are parsed documents the program reads as it:
     * every value of the type is stored as a document, which keeps the
     * object's own fields and identity.
     */
    document?: true;
    /**
     * Properties of this record type whose values documents share with
     * records of another type (`requireSharedValueViews`): each is stored as
     * a document while the record's own other fields stay native.
     */
    documentFields?: readonly string[];
    /** A plain fixed record stored as a homogeneous open scalar dictionary. */
    dictionary?: "string" | "number" | "boolean";
    /** An open scalar dictionary retains undefined-valued own entries through document views. */
    documentDictionary?: true;
    /** One retained record cannot change its dictionary value representation. */
    dictionaryConflict?: true;
    /** A structural interface retains the native owner whose checked type supplies it. */
    native?: {
        readonly type: ts.Type;
        readonly node: ts.Node;
        readonly storage: DataType;
    };
    /**
     * A record type whose records are this class's instances, which have
     * every property it declares: each is stored as the instance.
     */
    classView?: ts.ClassLikeDeclaration;
    /**
     * A record type that class instances and other objects (a literal, a
     * second class's instances) both produce, where a copy could be told
     * apart: each instance it holds is stored as that instance's one view,
     * whose properties read and write the instance (`instance_view`).
     */
    instanceViews?: true;
    /**
     * Distinct checked native owners cannot overwrite one structural demand:
     * the storage each demanded, and where.
     */
    nativeConflict?: readonly [RecordStorageSite, RecordStorageSite];
    /** A function can enter this callable record before any named property is installed. */
    bareCallable?: true;
    /**
     * Record types a record was stored as where a copy could be told apart:
     * each joins its source's record component (`record-components.ts`), so
     * one object keeps one identity under both. A join names its own
     * source, which replays merging demands of one struct keep.
     */
    joins?: readonly RecordJoin[];
    /**
     * Properties a record converted into this type defines with accessors (a
     * class getter, and setter): its struct holds each in an accessor slot.
     */
    accessors?: readonly RecordAccessorDemand[];
    /**
     * A union whose records hold fields only some members declare: its
     * struct stores every member's fields rather than their common view.
     */
    armFields?: true;
    /**
     * A closed record type an open string-keyed record is converted into:
     * it is a view of that record (one object), its slots its entries.
     */
    view?: true;
}

/** A storage a record type was demanded as, and the node that demanded it, for a conflict's refusal. */
export interface RecordStorageSite {
    readonly storage: string;
    readonly node: ts.Node;
}

/** The site of the native owner a record type views. */
export function nativeViewSite(
    native: NonNullable<NativeRecordStorageDemand["native"]>,
): RecordStorageSite {
    return { storage: dataTypeKey(native.storage), node: native.node };
}

/** The site of the class whose instances a record type views. */
export function classViewSite(
    declaration: ts.ClassLikeDeclaration,
): RecordStorageSite {
    return {
        storage: `class ${declaration.name?.text ?? "expression"}`,
        node: declaration,
    };
}

/** A scalar dictionary's storage as a conflict's refusal names it. */
export function dictionaryStorage(
    value: NonNullable<NativeRecordStorageDemand["dictionary"]>,
): string {
    return `dictionary of ${value}`;
}

/**
 * The non-object storage `demand` asks beside a view (a document, a
 * document dictionary, a scalar dictionary), demanded at its site.
 */
export function documentStorageSite(
    demand: NativeRecordStorageDemand,
): RecordStorageSite | undefined {
    const storage = demand.document
        ? "document"
        : demand.documentDictionary
          ? "document dictionary"
          : demand.dictionary && dictionaryStorage(demand.dictionary);
    return storage ? { storage, node: demand.node } : undefined;
}

/**
 * The one native storage holding the owners of two views: their common
 * storage, or a DOM event target beside a retained element, which is one
 * of the targets it holds (`eventTargetCpp`). Undefined where none does.
 */
export function joinedNativeStorage(
    left: DataType,
    right: DataType,
): DataType | undefined {
    if (dataTypesEqual(left, right)) return left;
    const element = (type: DataType): boolean =>
        type.kind === "handle" && type.handle === "ui-element";
    return (left.kind === "event-target" && element(right)) ||
        (element(left) && right.kind === "event-target")
        ? { kind: "event-target" }
        : undefined;
}

/**
 * The two object views `previous` and `next` hold that no one object is:
 * two native owners no one storage holds, or a native owner and a class.
 */
function objectViewConflict(
    previous: NativeRecordStorageDemand | undefined,
    next: NativeRecordStorageDemand,
): readonly [RecordStorageSite, RecordStorageSite] | undefined {
    if (
        previous?.native &&
        next.native &&
        !joinedNativeStorage(previous.native.storage, next.native.storage)
    )
        return [nativeViewSite(previous.native), nativeViewSite(next.native)];
    const native = previous?.native ?? next.native;
    const classView = previous?.classView ?? next.classView;
    return native && classView
        ? [nativeViewSite(native), classViewSite(classView)]
        : undefined;
}

/** A property a converted record reads through a getter, and writes through a setter. */
export interface RecordAccessorDemand {
    readonly name: string;
    readonly setter: boolean;
    /** A property definition installs an own accessor, not a class prototype accessor. */
    readonly own?: true;
}

/** The demand flags a replay strengthens, never weakens. */
const RECORD_STORAGE_FLAGS = [
    "stored",
    "dynamicJsonStorage",
    "proxy",
    "proxyTarget",
    "document",
    "documentDictionary",
    "armFields",
    "view",
    "nativeConflict",
    "dictionaryConflict",
    "bareCallable",
    "instanceViews",
] as const;

/** The properties an anonymous record type's report name spells before it elides the rest. */
const NAMED_SHAPE_PROPERTIES = 6;

/** A record type's name for a report; an anonymous one is its shape's. */
function recordTypeName(type: ts.Type): string {
    const declared = declaredRecordName(type);
    if (declared) return declared;
    const names = type.getProperties().map((property) => property.name);
    return `{ ${names.slice(0, NAMED_SHAPE_PROPERTIES).join(", ")}${names.length > NAMED_SHAPE_PROPERTIES ? ", ..." : ""} }`;
}

/** What a record demand asks for, for reports: its record, flags, joins and accessors. */
export function describeRecordDemand(
    demand: NativeRecordStorageDemand,
): string {
    const asked = recordDemandAsks(demand);
    return `${recordTypeName(demand.type)}: ${asked.join(", ") || "shared"}`;
}

/**
 * What a record demand asks beyond sharing its records as one native
 * object each: none when the demand asks only that.
 */
export function recordDemandAsks(demand: NativeRecordStorageDemand): string[] {
    const asked: string[] = RECORD_STORAGE_FLAGS.filter((flag) => demand[flag]);
    if (demand.dictionary) asked.push(dictionaryStorage(demand.dictionary));
    if (demand.native) asked.push("native");
    if (demand.classView) asked.push("class view");
    for (const { source, target, kind } of demand.joins ?? [])
        asked.push(
            `${recordTypeName(source)} joins ${recordTypeName(target)}${kind === "value" ? "" : ` by ${kind}`}`,
        );
    if (demand.accessors?.length)
        asked.push(`${demand.accessors.length} accessor(s)`);
    if (demand.documentFields?.length)
        asked.push(`document field(s) ${demand.documentFields.join(", ")}`);
    return asked;
}

/**
 * Replays strengthen ownership and accumulate the joins, document fields
 * and accessors lowering met: `previous` merged with `next`, or undefined
 * when `next` demands nothing `previous` lacks. A document asks no
 * `stored`: its records map to JSON in either mode (`fromTsType`), so
 * the demands a document meets hold the same storage in any order.
 */
export function mergeNativeRecordStorage(
    checker: ts.TypeChecker,
    previous: NativeRecordStorageDemand | undefined,
    next: NativeRecordStorageDemand,
): NativeRecordStorageDemand | undefined {
    const nativeConflict =
        previous?.nativeConflict ??
        next.nativeConflict ??
        objectViewConflict(previous, next);
    const dictionaryConflict =
        previous?.dictionaryConflict ||
        next.dictionaryConflict ||
        (previous?.dictionary !== undefined &&
            next.dictionary !== undefined &&
            previous.dictionary !== next.dictionary);
    const added = (next.joins ?? []).filter(
        (join) =>
            !(previous?.joins ?? []).some((known) =>
                sameRecordJoin(checker, known, join),
            ),
    );
    const joins = [...(previous?.joins ?? []), ...added];
    // Two classes' instances viewed as one record type are each a view.
    const instanceViews =
        previous?.instanceViews ||
        next.instanceViews ||
        (previous?.classView !== undefined &&
            next.classView !== undefined &&
            previous.classView !== next.classView);
    const document = previous?.document || next.document;
    // Two native owners one storage holds are viewed in it.
    const joinedStorage =
        previous?.native &&
        next.native &&
        joinedNativeStorage(previous.native.storage, next.native.storage);
    const native =
        previous?.native &&
        (joinedStorage &&
        !dataTypesEqual(joinedStorage, previous.native.storage)
            ? { ...previous.native, storage: joinedStorage }
            : previous.native);
    const accessors = new Map(
        (previous?.accessors ?? []).map((accessor) => [
            accessor.name,
            accessor,
        ]),
    );
    let changed =
        previous === undefined ||
        added.length > 0 ||
        (nativeConflict !== undefined && !previous?.nativeConflict) ||
        (dictionaryConflict && !previous?.dictionaryConflict) ||
        (next.dictionary !== undefined && previous?.dictionary === undefined) ||
        (next.native !== undefined && previous?.native === undefined) ||
        native !== previous?.native ||
        (next.classView !== undefined &&
            previous?.classView === undefined &&
            !instanceViews) ||
        (instanceViews && !previous?.instanceViews) ||
        RECORD_STORAGE_FLAGS.some(
            (flag) =>
                next[flag] &&
                !previous[flag] &&
                !(flag === "stored" && document),
        );
    const documentFields = new Set(previous?.documentFields);
    for (const name of next.documentFields ?? [])
        if (!documentFields.has(name)) {
            documentFields.add(name);
            changed = true;
        }
    for (const { name, setter, own } of next.accessors ?? []) {
        const known = accessors.get(name);
        if (
            known === undefined ||
            (setter && !known.setter) ||
            (!own && known.own)
        )
            changed = true;
        accessors.set(name, {
            name,
            setter: setter || known?.setter === true,
            ...(own && (!known || known.own) ? { own: true } : {}),
        });
    }
    if (!changed) return undefined;
    const merged: NativeRecordStorageDemand = {
        ...previous,
        ...next,
        ...(native ? { native } : {}),
        ...(previous?.classView ? { classView: previous.classView } : {}),
        ...(previous?.dictionary ? { dictionary: previous.dictionary } : {}),
        ...(nativeConflict ? { nativeConflict } : {}),
        ...(dictionaryConflict ? { dictionaryConflict: true } : {}),
        ...(joins.length ? { joins } : {}),
        ...(documentFields.size ? { documentFields: [...documentFields] } : {}),
        ...(accessors.size
            ? {
                  accessors: [...accessors.values()],
              }
            : {}),
    };
    if (document) delete merged.stored;
    if (instanceViews) {
        merged.instanceViews = true;
        delete merged.classView;
    }
    return merged;
}

/**
 * A demanded record no native object can hold (`predeclareOwnedRecord`):
 * the demand stands refused, and a statement demanding it again refuses.
 */
class NativeRecordDemandRefused extends StorageDemand {
    constructor(
        readonly demand: NativeRecordStorageDemand,
        readonly refusal: CompileError,
    ) {
        super(refusal.message);
    }

    get request(): StorageRequest {
        return {
            kind: "refused-record",
            demand: this.demand,
            refusal: this.refusal,
        };
    }
}

/**
 * Runs `work` for `demand`: a refusal it raises stands for the demand
 * (`NativeRecordDemandRefused`), so the replay drops it and a statement
 * demanding it again refuses instead of the whole compile.
 */
export function refusingRecordDemand<T>(
    demand: NativeRecordStorageDemand,
    work: () => T,
): T {
    try {
        return work();
    } catch (error) {
        if (error instanceof CompileError)
            throw new NativeRecordDemandRefused(demand, error);
        throw error;
    }
}

/** Re-emit earlier storage and aliases after a dynamic boundary demands ownership. */
export class NativeRecordStorageRequired extends StorageDemand {
    constructor(readonly demand: NativeRecordStorageDemand) {
        super("A native record requires shared object storage.");
    }

    get request(): StorageRequest {
        return { kind: "record", demand: this.demand };
    }
}

/** A demand storing record types' values as documents, and nothing else. */
export function isDocumentRecordDemand(
    error: unknown,
): error is NativeRecordStorageRequired {
    return (
        error instanceof NativeRecordStorageRequired &&
        error.requests.every(
            (request) =>
                request.kind === "record" && request.demand.document === true,
        )
    );
}
