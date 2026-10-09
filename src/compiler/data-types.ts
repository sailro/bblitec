import type { DataType, HandleKind } from "./data-types/model.js";
import { isEngineScopedHandleKind } from "./data-types/handles.js";
import {
    EngineOwnerStorageRequired,
    isEngineOwnerStorageDeclaration,
} from "./engine-owner-storage.js";
import { DEFERRED_DOM_OBJECTS } from "./data-types/model.js";
import { ERROR_CLASS_FIELDS, ERROR_CONSTRUCTORS } from "./error-values.js";
import { functionSignatureSite } from "./function-storage-flow.js";
import {
    BUFFER_VIEW_KINDS,
    TYPED_ARRAY_KINDS,
} from "./data-types/typed-arrays.js";
import {
    dataTypeCppType,
    dataTypeKey,
    dataTypesEqual,
    isTaggedStorageWidening,
    passesByReferenceKind,
    containsDataKind,
    isUndefinedDataType,
    isOpaqueReference,
    isNativeStructuralView,
    sharesStorageKind,
    tracedEdgeCondition,
    recordTraceConditions,
    type DataTypeCppContext,
} from "./data-types/operations.js";
export type { DataType, TypedArrayKind } from "./data-types/model.js";
export {
    isHandleKind,
    handleCppType,
    resourceValueCppType,
} from "./data-types/handles.js";
export {
    TYPED_ARRAY_KINDS,
    BUFFER_VIEW_KINDS,
    isBinaryDataType,
    isNumericSequenceType,
    isTypedArrayType,
    typedArrayBytesPerElement,
    typedArrayConstructorName,
    typedArrayStem,
    typedArrayElement,
    typedArrayStoreExpression,
} from "./data-types/typed-arrays.js";
export {
    dataTypesEqual,
    passesByReferenceKind,
    isOpaqueReference,
    isNativeStructuralView,
    isUndefinedDataType,
    primitiveTraits,
    reseatsOnAssignment,
    sharesStorageKind,
    typeofTag,
} from "./data-types/operations.js";
import {
    emissionArray,
    EmissionMap,
    EmissionSet,
    EmissionTransaction,
    journaled,
} from "./emission-transaction.js";
import {
    NativeRecordStorageRequired,
    type NativeRecordStorageDemand,
} from "./native-record-storage.js";
import { AbsentRecordProperties } from "./absent-record-properties.js";
import { ReplayStorage } from "./replay-storage.js";
import {
    numericSlotRead,
    numericSlotStorage,
    withNumericSlotStorage,
    type NumericSlotKind,
} from "./numeric-slot-storage.js";
import {
    recordCopyObservation,
    type RecordObservationContext,
} from "./record-observations.js";
import {
    instantiatedRecord,
    isPlainRecord,
    isRecordUnion,
    layoutsCompatible,
    recordIdentity,
    type InstantiatedRecord,
    type RecordComponent,
    type RecordComponentKey,
    type RecordJoin,
} from "./record-components.js";
import ts from "typescript";
import { requireDeclarationAbsenceTag } from "./absence-tag-storage.js";
import { isPinnedSource } from "../pinned-program.js";
import { createHash } from "node:crypto";
import {
    cppIdentifier,
    doubleLiteral,
    stringLiteral,
} from "../cpp-literals.js";
import {
    declaredIn,
    declaredInDefaultLibrary,
    declaredInDomLibrary,
    declaredSymbol,
    isSymbolPropertyKey,
    libraryGlobal,
    resolvedSymbol,
    symbolFieldName,
} from "./symbols.js";
import {
    absentValueKind,
    isNullable,
    nullability,
    presentMembers,
    isTypeReference,
    type AbsentValueKind,
} from "./type-facts.js";
import {
    hasNoValueCompletion,
    nativeReturnTsType,
} from "./native-return-type.js";
import {
    hasUndefinedCompletion,
    hasNonThenableCompletion,
} from "./undefined-values.js";
import {
    CompletionStorageRequired,
    type CompletionProof,
} from "./completion-storage.js";
import {
    type ClassHierarchy,
    classBindingNames,
    classChain,
    classErrorBase,
    classInstanceProperties,
    isStaticMember,
} from "./class-members.js";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { propertyNameText, unwrapExpression } from "./syntax.js";
import type { DataPreamble, NativeDefinition } from "./source-units.js";
import { optionalPresentCpp, type Value } from "./types.js";
import { callTypeArguments } from "./type-arguments.js";
import {
    GenericFunctionStorageRequired,
    divergentGenericFunctionDemand,
    sameGenericFunctionSignature,
    sameTypeFrames,
    type GenericFunctionDemand,
} from "./generic-function-storage.js";
import {
    finiteArraySources,
    type FiniteArraySources,
} from "./finite-array-sources.js";

type Fail = (node: ts.Node, message: string) => never;

interface GenericFunctionField {
    name: string;
    type: DataType<"function">;
    demand: GenericFunctionDemand;
}

/** The suffix an accessor-backed field adds to its struct's identity key. */
function accessorKey(field: DataStructField): string {
    return field.accessor
        ? `:${field.accessor}${field.accessorReceiver ? ":receiver" : ""}`
        : "";
}

/** The callbacks an accessor-backed field stores, as the data walks see them. */
function accessorFunctionTypes(field: DataStructField): DataType[] {
    return [
        { kind: "function", parameters: [], result: field.type },
        ...(field.accessor === "get-set"
            ? [{ kind: "function" as const, parameters: [field.type] }]
            : []),
    ];
}

/**
 * The value a union member's tag property is declared as, when it is one
 * literal: a string, a number or a boolean. Each arm of a discriminated
 * union carries one such literal, and the checker's own narrowing is what
 * makes the tag decide the arm.
 */
function literalTagValue(
    checker: ts.TypeChecker,
    type: ts.Type,
): string | undefined {
    if ((type.flags & ts.TypeFlags.StringLiteral) !== 0) {
        return (type as ts.StringLiteralType).value;
    }
    if (
        (type.flags &
            (ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral)) !==
        0
    ) {
        return checker.typeToString(type);
    }
    return undefined;
}

/** The literals a tag property admits: one literal, or a union of them. */
function literalTagValues(
    checker: ts.TypeChecker,
    type: ts.Type,
): readonly string[] | undefined {
    const values = (type.isUnion() ? type.types : [type]).map((member) =>
        literalTagValue(checker, member),
    );
    return values.every((value) => value !== undefined) ? values : undefined;
}

/** The pinned type name each handle kind is declared as. */
const pinnedHandleTypes: Record<string, HandleKind> = {
    AssetContainer: "asset",
    AudioEngine: "audio-engine",
    AudioInputSource: "audio-source",
    EngineContext: "engine",
    DeviceLostRecoveryHandle: "device-recovery",
    EnvironmentTextures: "gpu-environment",
    ProceduralSkyEnvironment: "procedural-sky-environment",
    NodeInputHandle: "node-input",
    NodeMaterial: "material",
    PbrMaterialProps: "material",
    StandardMaterialProps: "material",
    TextData: "text-data",
    DefaultTextData: "text-data",
    TextRenderable: "text-renderable",
    TextLayer: "text-layer",
    TextRenderer: "text-renderer",
    GlyphRun: "text-run",
    PickingInfo: "picking-info",
    Mesh: "mesh",
    AnimationGroup: "animation-group",
    // A container's declared KHR_interactivity graphs and the runtimes
    // addToScene attaches for them.
    LoadedFlowGraph: "flow-graph",
    FgRuntime: "flow-graph-runtime",
    BillboardSpriteHandle: "billboard-sprite",
    BillboardSpriteSystem: "billboard-system",
    Camera: "camera",
    BankedFreeCamera: "camera",
    UtilityLayer: "utility-layer",
    PointerDrag: "pointer-drag",
    SceneContext: "scene",
    RenderTarget: "render-target",
    SceneNode: "scene-node",
    LightBase: "light",
    HemisphericLight: "light",
    DirectionalLight: "light",
    PointLight: "light",
    SpotLight: "light",
    ShadowGenerator: "shadow-generator",
    HierarchyInstancePool: "hierarchy-instance-pool",
    StorageBuffer: "storage-buffer",
    ComputeStorageTexture: "compute-storage-texture",
    ComputeTask: "compute-task",
    ComputeOneShot: "compute-one-shot",
    UniformBuffer: "uniform-buffer",
    ComputeUniformArena: "compute-uniform-arena",
    ComputeUniformWriter: "compute-uniform-writer",
    ComputeShader: "compute-shader",
    ComputeDispatch: "compute-dispatch",
    ComputeTextureResource: "compute-texture-resource",
    ComputeSampler: "compute-sampler",
    ExternalTexture: "external-texture",
    ComputeBindingDecl: "compute-binding-decl",
    ComputeBindingSet: "compute-binding-set",
    ComputeUniformLayout: "compute-uniform-layout",
    Material: "material",
    PhysicsWorld: "physics-world",
    PhysicsBody: "physics-body",
    PhysicsConstraint: "physics-constraint",
    PhysicsAggregate: "physics-aggregate",
    PhysicsViewer: "physics-viewer",
    PhysicsCharacterController: "physics-character-controller",
    PhysicsShape: "physics-shape",
    ShaderMaterial: "material",
    Sprite2DLayer: "sprite-layer",
    SpriteAtlas: "sprite-atlas",
    // A cloud is a SceneNode upstream like a Mesh is, and a container's
    // `_gaussianSplats` is the one place its type is read through the data
    // model rather than produced by an intrinsic.
    GaussianSplattingMesh: "splat-mesh",
    Texture2D: "texture",
    TransformNode: "transform-node",
    Skeleton: "skeleton",
    Bone: "bone",
    ObstacleHandle: "navigation-obstacle",
};

/**
 * A pinned engine value that owns a native record but is NOT part of the
 * plain-data model above.
 *
 * `HandleKind` is what a struct, a vector or a map may hold, and these are
 * deliberately outside it: `fromTsType` declines them, so a gizmo still
 * cannot travel inside data. What one of them does need is somewhere for a
 * single name to hold it -- the storage between `let g: T | null = null`
 * and the guarded assignment that fills it -- which is a narrower question
 * than whether data can carry the value.
 */
type OpaqueEngineKind =
    | "axis-drag-gizmo"
    | "axis-scale-gizmo"
    | "plane-drag-gizmo"
    | "plane-rotation-gizmo"
    | "position-gizmo"
    | "rotation-gizmo"
    | "scale-gizmo"
    | "bounding-box-gizmo"
    | "camera-gizmo"
    | "light-gizmo";

/**
 * The pinned type name and the native record behind each of them.
 *
 * Every row is a trivially copyable record declared unconditionally in
 * `runtime.hpp`, which is what lets one live in a `std::optional` without
 * the declaring scene having reached the family that builds it yet: the
 * declaration comes before the factory call it is waiting for.
 */
const opaqueEngineTypes: Record<
    string,
    { kind: OpaqueEngineKind; cppType: string }
> = {
    AxisDragGizmo: { kind: "axis-drag-gizmo", cppType: "bbl::EditGizmoHandle" },
    AxisScaleGizmo: {
        kind: "axis-scale-gizmo",
        cppType: "bbl::EditGizmoHandle",
    },
    PlaneDragGizmo: {
        kind: "plane-drag-gizmo",
        cppType: "bbl::EditGizmoHandle",
    },
    PlaneRotationGizmo: {
        kind: "plane-rotation-gizmo",
        cppType: "bbl::EditGizmoHandle",
    },
    PositionGizmo: {
        kind: "position-gizmo",
        cppType: "bbl::CompositeGizmoHandle",
    },
    RotationGizmo: {
        kind: "rotation-gizmo",
        cppType: "bbl::CompositeGizmoHandle",
    },
    ScaleGizmo: { kind: "scale-gizmo", cppType: "bbl::CompositeGizmoHandle" },
    BoundingBoxGizmo: {
        kind: "bounding-box-gizmo",
        cppType: "bbl::BoundingBoxGizmoHandle",
    },
    CameraGizmo: { kind: "camera-gizmo", cppType: "bbl::CameraGizmoHandle" },
    LightGizmo: { kind: "light-gizmo", cppType: "bbl::LightGizmoHandle" },
};

/**
 * Classify an opaque pinned engine value, gated on the pinned typings the
 * same way `pinnedHandleKind` is, so a scene's own `interface CameraGizmo`
 * is never mistaken for the engine one.
 */
export function opaqueEngineValue(
    type: ts.Type,
): { kind: OpaqueEngineKind; cppType: string } | undefined {
    const symbol =
        type.aliasSymbol && opaqueEngineTypes[type.aliasSymbol.name]
            ? type.aliasSymbol
            : type.symbol;
    const entry = symbol ? opaqueEngineTypes[symbol.name] : undefined;
    return entry && declaredIn(symbol, "babylon") ? entry : undefined;
}

/**
 * The element exposed by a native data-container `for...of` loop.
 * Maps expose a typed key/value entry rather than the all-number tuple used
 * for ordinary numeric tuple values.
 */
/**
 * What one for...of step binds: an element, a Map's `[key, value]`, or --
 * for `array.entries()`/`array.keys()` -- the element beside its index,
 * or the index alone. The index variants carry the native loop counter
 * they read, because the loop walks the array by index so an entry's
 * value is the element in place.
 */
export type DataIterationElement =
    | DataType
    | { kind: "map-entry"; key: DataType; value: DataType }
    | { kind: "set-entry"; element: DataType }
    | { kind: "array-entry"; element: DataType; indexCpp: string }
    | { kind: "array-index"; indexCpp: string };

export interface DataStructField {
    /** Property spelling in TypeScript/JSON. */
    sourceName: string;
    /** Identifier-safe spelling in generated C++. */
    name: string;
    type: DataType;
    /** The source property cannot be rebound after construction. */
    readOnly?: boolean;
    /** A discriminated-union field absent from at least one inactive arm. */
    defaultWhenMissing?: boolean;
    /** Which union tags actually own this field (wire serialization observes absence). */
    presentForTags?: Array<Array<{ discriminant: string; value: string }>>;
    /**
     * The source declared the property with `?`, so JavaScript can observe it
     * as absent rather than as null. `JSON.stringify` is the observer: it
     * omits an absent member and writes `null` for one that is present and
     * null, which is the whole difference between `sh?: number` and
     * `sh: number | null` once both are a `Nullable` field here.
     */
    optionalProperty?: boolean;
    /** An asserted empty object can lack this otherwise required property. */
    uncheckedProperty?: boolean;
    /**
     * A shared layout holds this field for the record types declaring it;
     * records of a type sharing the layout without it hold it absent.
     */
    sharedAbsent?: boolean;
    /**
     * A repository object literal (or a class that `implements` the type)
     * defines the property with `get`, and `set` when "get-set", or the
     * record is a view of an open record: the field is a `bbl::js::Accessor`
     * slot whose reads run the getter.
     */
    accessor?: StructFieldAccessor;
    /** The finite record type supplied as `this` when the slot is read. */
    accessorReceiver?: string;
    /** The source property declarations the slot stores, for absence-tag demands. */
    declarations?: readonly ts.Declaration[];
}

/** The accessors an accessor-backed record field holds. */
export type StructFieldAccessor = "get" | "get-set";

/**
 * Whether a field is one of its object's own keys: `own` always (a required
 * property), `stored` while its storage holds a value (a `?` property, absent
 * when empty), `nullable` while it holds a value and unknown when empty (a
 * `?` property that also admits `null`, whose empty storage is either), and
 * `ambiguous` when type shapes sharing the struct disagree.
 */
export type OwnPropertyPresence = "own" | "stored" | "nullable" | "ambiguous";

/**
 * The run-time tests of a key whose storage or record tags decide whether it
 * is own: `ownCpp` passes while it is. `holdsValueCpp`, set where an own key
 * may still hold an empty slot (own by its record's tags alone, as a union arm
 * declaring `x: T | undefined` is), passes while the slot holds a value;
 * without it, an own key's slot holds its value. `emptySlot` is set where the
 * slot alone decides: `absent` when `ownCpp` is exactly its engagement, so
 * the slot carries the presence wherever its value goes, and `ambiguous` when
 * an empty slot may be null or absent and `ownCpp` refuses on it.
 */
export interface OwnPresence {
    readonly ownCpp: string;
    readonly holdsValueCpp?: string;
    readonly emptySlot?: "absent" | "ambiguous";
}

export function propertyIsReadOnly(property: ts.Symbol): boolean {
    return (property.declarations ?? []).some(
        (declaration) =>
            (ts.isPropertySignature(declaration) ||
                ts.isPropertyDeclaration(declaration) ||
                ts.isParameter(declaration)) &&
            declaration.modifiers?.some(
                (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
            ),
    );
}

interface DataStructDefinition {
    name: string;
    fields: DataStructField[];
    /** One struct for a class hierarchy: it stores which class each object is. */
    classTag?: true;
    /**
     * A function object with properties (`(() => T) & { dispose(): void }`):
     * the record's own call, held beside its properties as `callMember`.
     */
    call?: DataType<"function">;
}

/** The member a callable record keeps its call in; it is not a property. */
export const callMember = "bbl_call";

/** The member a class hierarchy's shared struct keeps each object's class tag in. */
export const classTagMember = "bbl_class_tag";

/**
 * One local class with a demanded runtime representation.
 *
 * `type` is the instantiated class type the demand named, so a generic
 * class's fields resolve through `Workspace<Part>` rather than through the
 * declaration's own `P`.
 */
interface ClassStructBinding {
    declaration: ts.ClassLikeDeclaration;
    type: ts.Type;
}

interface DataEnumDefinition {
    name: string;
    members: string[];
}

interface DataTableDefinition {
    name: string;
    dimensions: number[];
    values: string;
}

const numberType: DataType = { kind: "number" };
/** The kinds whose storage is a BigInt (js_bigint.hpp). */
const BIGINT_KINDS: readonly DataType["kind"][] = [
    "bigint",
    "i64array",
    "u64array",
];
const booleanType: DataType = { kind: "boolean" };

/**
 * Classify an opaque pinned handle without materializing any data types.
 * Gated on the pinned typings, so a scene's own interface named `Mesh` is
 * never mistaken for the engine resource type.
 */
export function pinnedHandleKind(type: ts.Type): HandleKind | undefined {
    return pinnedHandle(type, false);
}

/** Effect analysis also reads the exact implementation files registered by the pin. */
export function pinnedSourceHandleKind(type: ts.Type): HandleKind | undefined {
    return pinnedHandle(type, true);
}

function pinnedHandle(
    type: ts.Type,
    includePinnedSource: boolean,
): HandleKind | undefined {
    const symbol =
        type.aliasSymbol && pinnedHandleTypes[type.aliasSymbol.name]
            ? type.aliasSymbol
            : type.symbol;
    const kind = symbol ? pinnedHandleTypes[symbol.name] : undefined;
    return kind &&
        (declaredIn(symbol, "babylon") ||
            (includePinnedSource &&
                symbol?.declarations?.some((declaration) =>
                    isPinnedSource(declaration.getSourceFile()),
                )))
        ? kind
        : undefined;
}

export function isPinnedType(type: ts.Type, names: readonly string[]): boolean {
    return [type.aliasSymbol, type.symbol].some(
        (symbol) =>
            symbol !== undefined &&
            names.includes(symbol.name) &&
            declaredIn(symbol, "babylon"),
    );
}

/**
 * The pin's scene-graph shape: a node owns `children: SceneNode[]` and a
 * `worldMatrix`. SceneNode and every camera interface carry both.
 */
function isSceneGraphNode(type: ts.Type): boolean {
    return (
        type.getProperty("children") !== undefined &&
        type.getProperty("worldMatrix") !== undefined
    );
}

/** Library objects held as opaque data values: [symbol, declaring library, data kind]. */
const LIBRARY_OBJECT_KINDS: readonly (readonly [
    string,
    "dom" | "default",
    (
        | "storage"
        | "file"
        | "blob"
        | "file-list"
        | "http-response"
        | "search-params"
        | "date"
        | "regexp"
        | "date-time-format"
        | "text-decoder"
        | "text-encoder"
        | "collator"
        | "number-format"
        | "plural-rules"
        | "list-format"
        | "i64array"
        | "u64array"
    ),
])[] = [
    ["Storage", "dom", "storage"],
    ["File", "dom", "file"],
    ["Blob", "dom", "blob"],
    ["FileList", "dom", "file-list"],
    ["Response", "dom", "http-response"],
    ["URLSearchParams", "dom", "search-params"],
    ["Date", "default", "date"],
    ["RegExp", "default", "regexp"],
    ["DateTimeFormat", "default", "date-time-format"],
    ["TextDecoder", "dom", "text-decoder"],
    ["TextEncoder", "dom", "text-encoder"],
    ["Collator", "default", "collator"],
    ["NumberFormat", "default", "number-format"],
    ["PluralRules", "default", "plural-rules"],
    ["ListFormat", "default", "list-format"],
    ["BigInt64Array", "default", "i64array"],
    ["BigUint64Array", "default", "u64array"],
];

/** A default-library binary class `instanceof` decides: ArrayBuffer, DataView, a view or typed array. */
function binaryLibraryClass(type: ts.Type): boolean {
    const name = type.symbol?.name;
    return (
        (type.flags & ts.TypeFlags.Object) !== 0 &&
        name !== undefined &&
        declaredInDefaultLibrary(type.symbol) &&
        (BUFFER_VIEW_KINDS.has(name) ||
            TYPED_ARRAY_KINDS.has(name) ||
            name === "ArrayBufferView" ||
            name === "SharedArrayBuffer")
    );
}

/** Web Audio and media identities are recognized from the DOM declarations. */
export function domAudioHandleKind(type: ts.Type): HandleKind | undefined {
    if (!type.symbol || !declaredInDomLibrary(type.symbol)) return undefined;
    switch (type.symbol.name) {
        case "MediaStream":
            return "media-stream";
        case "MediaStreamTrack":
            return "media-stream-track";
        case "AudioParam":
            return "audio-param";
        case "AudioBuffer":
            return "audio-buffer";
        case "AudioContext":
        case "BaseAudioContext":
        case "OfflineAudioContext":
            return "audio-context";
        case "AudioNode":
            return "audio-node";
    }
    return (type.getBaseTypes() ?? []).some(
        (base) => domAudioHandleKind(base) === "audio-node",
    )
        ? "audio-node"
        : undefined;
}

export function platformHandleKind(
    type: ts.Type,
):
    | "gamepad"
    | "gamepad-button"
    | "gpu-device"
    | "gpu-texture"
    | "custom-event"
    | "dom-event"
    | "video"
    | undefined {
    if (declaredIn(type.symbol, "dom", "webgpu")) {
        if (type.symbol.name === "GPUDevice") return "gpu-device";
        if (type.symbol.name === "GPUTexture") return "gpu-texture";
    }
    if (!type.symbol || !declaredInDomLibrary(type.symbol)) return undefined;
    if (type.symbol.name === "Gamepad") return "gamepad";
    if (type.symbol.name === "GamepadButton") return "gamepad-button";
    if (type.symbol.name === "CustomEvent") return "custom-event";
    // Only a generation-executed producer makes one (executed-video-function.ts).
    if (type.symbol.name === "HTMLVideoElement") return "video";
    if (["PointerEvent", "InputEvent"].includes(type.symbol.name))
        return "dom-event";
    return undefined;
}

export function borrowedPlatformEventKind(
    symbol: ts.Symbol | undefined,
): DataType<"borrowed-platform-event">["event"] | undefined {
    if (!symbol || !declaredInDomLibrary(symbol)) return undefined;
    // Extended events and DataTransfer borrow the checked dispatch payload.
    if (
        [
            "Event",
            "TransitionEvent",
            "DragEvent",
            "DataTransfer",
            "StorageEvent",
        ].includes(symbol.name)
    )
        return "event";
    if (symbol.name === "MouseEvent") return "mouse";
    if (symbol.name === "KeyboardEvent") return "keyboard";
    if (symbol.name === "ErrorEvent") return "error";
    if (symbol.name === "PromiseRejectionEvent") return "rejection";
    return undefined;
}

/** Preserve event provenance through inheritance and complete mapped views. */
function isDomEventType(
    checker: ts.TypeChecker,
    type: ts.Type,
    candidate = type,
    seen = new Set<ts.Type>(),
): boolean {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return (
        (candidate.symbol?.name === "Event" &&
            declaredInDomLibrary(candidate.symbol) &&
            checker.isTypeAssignableTo(type, candidate)) ||
        (candidate.isIntersection() &&
            candidate.types.some((member) =>
                isDomEventType(checker, type, member, seen),
            )) ||
        (candidate.getBaseTypes() ?? []).some((base) =>
            isDomEventType(checker, type, base, seen),
        ) ||
        (candidate.aliasTypeArguments ?? []).some((argument) =>
            isDomEventType(checker, type, argument, seen),
        )
    );
}

export function isDomElementType(symbol: ts.Symbol): boolean {
    return (
        declaredInDomLibrary(symbol) &&
        (symbol.name === "Element" ||
            /^(?:HTML|SVG)[A-Za-z0-9]*Element$/.test(symbol.name))
    );
}

/** Text nodes share retained node handles, but are never element interfaces. */
export function isDomTextType(symbol: ts.Symbol): boolean {
    return symbol.name === "Text" && declaredInDomLibrary(symbol);
}

/**
 * Whether a compiled value is a plain-data numeric tuple of `arity`.
 *
 * The data model gives an annotated `[number, number, number]` a
 * `bbl::js::Tuple<3>` rather than the compile-time tuple an in-place literal
 * produces, so every reader of a tuple-valued option has to recognise both.
 */
export function isDataTuple(
    value: { kind: string; dataType?: DataType },
    arity: number,
): boolean {
    return (
        value.kind === "data" &&
        ((value.dataType?.kind === "tuple" && value.dataType.arity === arity) ||
            (value.dataType?.kind === "table" &&
                value.dataType.dimensions.length === 1 &&
                value.dataType.dimensions[0] === arity))
    );
}

/**
 * Whether a native function parameter must alias its caller's JavaScript
 * object rather than copy its native representation.
 *
 * Primitive values, strings, optional primitive values, non-owning spans,
 * reference-backed structs, and tables already preserve their source
 * semantics by value. Mutable containers and value-backed structs do not.
 */
export function passesByReference(
    dataTypes: DataTypeRegistry,
    dataType: DataType,
): boolean {
    return (
        (dataType.kind === "struct" &&
            !dataTypes.isReferenceStruct(dataType.name)) ||
        passesByReferenceKind(dataType)
    );
}

/**
 * The `arity` components of a native tuple expression, as float expressions.
 *
 * `base` is indexed once per component, so a caller whose expression is not
 * free to repeat -- a call, or anything else with an effect -- binds it to a
 * local first and passes the local.
 */
export function tupleComponents(
    base: string,
    arity: number,
    precision: "float" | "double" = "float",
): string[] {
    return Array.from({ length: arity }, (_unused, index) =>
        precision === "float"
            ? `static_cast<float>(${base}[${index}])`
            : `${base}[${index}]`,
    );
}

/** Record types a shared layout can redirect: object types and their intersections. */
const RECORD_TYPE_FLAGS = ts.TypeFlags.Object | ts.TypeFlags.Intersection;

/** Stored callback fields and collection entries preserve function identity. */
function markIdentityFunctions(dataType: DataType): DataType {
    switch (dataType.kind) {
        case "product":
            return {
                kind: "product",
                elements: dataType.elements.map(markIdentityFunctions),
            };
        case "union":
            return {
                kind: "union",
                members: dataType.members.map(markIdentityFunctions),
            };
        case "function":
            return { ...dataType, identity: true };
        case "optional":
            return {
                ...dataType,
                inner: markIdentityFunctions(dataType.inner),
            };
        default:
            return dataType;
    }
}

function sanitizeIdentifier(name: string): string {
    return cppIdentifier(name);
}

/** A storage as the value it holds, whichever absent value tells apart. */
function withoutAbsenceTag(type: DataType | undefined): DataType | undefined {
    return type?.kind === "tagged" ? type.inner : type;
}

/**
 * A `?` property's presence: its storage is empty exactly when the property
 * is absent, unless the storage also holds a `null` the property admits.
 * Dynamic storage keeps `undefined` apart from `null`.
 */
function storedPresence(
    type: DataType,
    admitsNull: boolean,
): OwnPropertyPresence {
    // Tagged storage is undefined exactly when the property holds nothing.
    if (type.kind === "json" || type.kind === "tagged") return "stored";
    if (
        type.kind !== "optional" &&
        type.kind !== "struct" &&
        type.kind !== "function"
    )
        return "ambiguous";
    return admitsNull ? "nullable" : "stored";
}

/** The absent values a field's property types admit. */
function valueAbsence(types: readonly ts.Type[]): AbsentValueKind | undefined {
    const absent = types.map(nullability);
    return absentValueKind({
        null: absent.some((each) => each.null),
        undefined: absent.some((each) => each.undefined),
    });
}

/**
 * One field's own-key facts, as one type shape gives them and as its struct
 * holds them merged over every shape it stands for: whether the field is an
 * own key, whether it is within the union arms declaring it when its
 * record's tags decide that (`armPresence`), and what its empty slot holds.
 */
interface FieldPresence {
    readonly presence?: OwnPropertyPresence;
    readonly armPresence?: OwnPropertyPresence;
    /** What an empty native slot of the field holds as a JavaScript value. */
    readonly absence?: AbsentValueKind;
}

function fieldPresence(
    presence: OwnPropertyPresence | undefined,
    absence: AbsentValueKind | undefined,
    armPresence?: OwnPropertyPresence,
): FieldPresence {
    return {
        ...(presence ? { presence } : {}),
        ...(armPresence ? { armPresence } : {}),
        ...(absence ? { absence } : {}),
    };
}

/** The storage a field holds its values in: its present type, literal tags as strings. */
function fieldStorage(type: DataType): DataType {
    return type.kind === "optional"
        ? fieldStorage(type.inner)
        : type.kind === "enum"
          ? { kind: "string" }
          : type;
}

/** Whether field storage holds records, directly or in an array. */
function holdsRecordStorage(type: DataType): boolean {
    return (
        type.kind === "struct" ||
        ((type.kind === "vector" || type.kind === "span") &&
            holdsRecordStorage(fieldStorage(type.element)))
    );
}

/** One fact two shapes give: shapes that disagree leave `conflict`. */
function mergedFact<T>(
    previous: T | undefined,
    next: T | undefined,
    conflict: T,
): T | undefined {
    return previous === undefined || next === undefined || previous === next
        ? (next ?? previous)
        : conflict;
}

/** One field from a property every member of a union declares. */
function unionPresence(
    properties: readonly ts.Symbol[],
    types: readonly ts.Type[],
    mapped: DataType,
): OwnPropertyPresence {
    const optional = properties.map(
        (property) => (property.flags & ts.SymbolFlags.Optional) !== 0,
    );
    if (optional.every((flag) => !flag)) return "own";
    // A spread of `{ key: value } | {}` synthesizes `key?: undefined`
    // for the empty arm, reusing the populated arm's literal declaration.
    // It is an absent key, unlike an authored optional undefined field.
    const absentSpreadSlot = (index: number): boolean => {
        const declarations = properties[index]!.declarations;
        return (
            presentMembers(types[index]!).length === 0 &&
            valueAbsence([types[index]!]) === "undefined" &&
            declarations !== undefined &&
            declarations.length > 0 &&
            declarations.every(
                (declaration) =>
                    (ts.isPropertyAssignment(declaration) ||
                        ts.isShorthandPropertyAssignment(declaration)) &&
                    properties.some(
                        (property, other) =>
                            !optional[other] &&
                            valueAbsence([types[other]!]) === undefined &&
                            property.declarations?.includes(declaration),
                    ),
            )
        );
    };
    // A required property no empty value holds fills its slot, and an
    // optional one holding undefined is absent: the slot alone says whether
    // the key is own. An optional undefined-only property keeps its own
    // presence, which no slot of the required one's storage holds.
    if (
        optional.some((flag) => !flag) &&
        !optional.every((flag, index) =>
            flag
                ? presentMembers(types[index]!).length > 0 ||
                  absentSpreadSlot(index)
                : valueAbsence([types[index]!]) === undefined,
        )
    )
        return "ambiguous";
    return storedPresence(
        mapped,
        types.some((type) => nullability(type).null),
    );
}

/**
 * The C++ spelling of a class field. A private name's sigil is not an
 * identifier character, and the prefix keeps `#x` apart from a public `_x`
 * on the same class; readers find fields by their source name, so this is
 * the one place the spelling matters.
 */
function structFieldName(name: ts.MemberName): string {
    return ts.isPrivateIdentifier(name)
        ? `private_${name.text.slice(1)}`
        : name.text;
}

/**
 * Maps checker types onto native data types and owns the generated struct,
 * enum, and static-table definitions emitted ahead of `main`.
 */
export class DataTypeRegistry {
    private readonly structsByKey = new EmissionMap<
        string,
        DataStructDefinition
    >();
    private readonly structsByName = new EmissionMap<
        string,
        DataStructDefinition
    >();
    private readonly structNames = new EmissionSet<string>();
    private readonly enumsByKey = new EmissionMap<string, DataEnumDefinition>();
    private readonly enumsByName = new EmissionMap<
        string,
        DataEnumDefinition
    >();
    private readonly enumNames = new EmissionSet<string>();
    /** String-union enums that actually receive a runtime string value. */
    private readonly runtimeEnumParsers = new EmissionSet<string>();
    private readonly runtimeEnumSerializers = new EmissionSet<string>();
    /** Named data types that reached emitted C++ rather than a type probe. */
    private readonly emittedNamedTypes = new EmissionSet<string>();
    @journaled private accessor emittedJsonType = false;
    @journaled private accessor emittedFileType = false;
    @journaled private accessor emittedDeferredPlatformType = false;
    @journaled private accessor emittedWindowType = false;
    @journaled private accessor emittedResponseType = false;
    @journaled private accessor emittedBigIntType = false;
    @journaled private accessor emittedSymbolType = false;
    private readonly tables = new EmissionMap<ts.Node, DataTableDefinition>();
    private readonly tableNames = new EmissionSet<string>();
    /**
     * One-dimensional constant arrays, materialized so a runtime index
     * can reach them. The numeric tables above are doubles all the way
     * down and may nest; these are flat and hold any scalar element.
     */
    private readonly tagTables = new EmissionMap<
        ts.Node,
        {
            name: string;
            elementCppType: string;
            elements: string[];
            source: string;
            allocates: boolean;
        }
    >();
    /** @unjournaled Scoped recursion stack; each insertion is removed in finally. */
    private readonly structNamesInProgress = new Map<
        ts.Symbol | ts.Type | string,
        string
    >();
    private readonly structTypesByIdentity = new EmissionMap<
        ts.Symbol | ts.Type | string,
        DataType & { kind: "struct" }
    >();
    private readonly referenceStructNames = new EmissionSet<string>();
    private readonly substitutedStructIdentities = new EmissionMap<
        ts.Type,
        readonly { frames: GenericFunctionDemand["frames"]; key: string }[]
    >();
    @journaled private accessor nextSubstitutedStructIdentity = 0;
    private readonly genericFunctions = new EmissionMap<
        string,
        {
            family: string;
            signature: ts.Signature;
            declaration: ts.SignatureDeclaration;
            fields: GenericFunctionField[];
        }
    >();
    private readonly genericFunctionNames = new EmissionMap<string, string>();
    @journaled private accessor genericFunctionAncestors: readonly string[] =
        [];
    private readonly nativeRecordSources = new EmissionMap<
        string,
        NativeRecordStorageDemand
    >();
    /**
     * Local classes that reached a native data position, by the struct name
     * standing for them. The declaration is how a method call on a value read
     * back out of a container recovers what to inline.
     */
    private readonly classStructDeclarations = new EmissionMap<
        string,
        ClassStructBinding
    >();
    private readonly classStructNames = new EmissionMap<
        ts.Symbol | ts.Type | string,
        string
    >();
    /**
     * Whether the current mapping is inside a stored position.
     *
     * A local class is a compile-time record until something demands a value
     * of it in native data -- an array element, a map key or value, a set
     * member, a stored field, a callback parameter or result. Without that
     * demand a class maps to nothing and stays a record.
     */
    @journaled private accessor classDemanded = false;
    /**
     * What the class's type parameters stand for while one of its bodies is
     * being inlined. Empty outside a generic receiver.
     */
    @journaled private accessor activeTypeArguments:
        ReadonlyMap<ts.Symbol, ts.Type> | undefined;
    /**
     * What generic functions' type parameters stand for while their bodies
     * are inlined, innermost call last. A frame's binding may itself name an
     * enclosing frame's parameter (`g<U>` called on `f<T>`'s `T`), which the
     * lookup follows outward.
     */
    private readonly callTypeArguments: ReadonlyMap<ts.Symbol, ts.Type>[] =
        emissionArray([]);
    /** Every substitution in force as one struct-identity key, spelled when they change. */
    @journaled private accessor activeTypeArgumentKey = "";
    @journaled private accessor anonymousStructIndex = 0;
    @journaled private accessor anonymousEnumIndex = 0;
    /**
     * The structs `JSON.stringify` actually reaches, in the order the walk
     * found them. Nothing else emits a codec: a scene that serializes one
     * record does not carry a writer for every other record it declares.
     */
    private readonly jsonSerializedStructs = new EmissionMap<string, ts.Node>();
    private readonly jsonBoxedStructs = new EmissionMap<string, ts.Node>();
    /** Each field's own-key facts by `<struct>.<property>`, merged over every type shape the struct stands for. */
    private readonly fieldPresences = new EmissionMap<string, FieldPresence>();
    /** Lowered reads of a field's presence, checked again once every shape is known. */
    private readonly presenceReads = new EmissionMap<
        string,
        {
            structName: string;
            field: DataStructField;
            /** The read tested the record's tags. */
            arms: boolean;
            node: ts.Node;
        }
    >();
    private readonly jsonBoxedEnums = new EmissionSet<string>();
    private readonly jsonSerializedEnums = new EmissionSet<string>();
    /**
     * Closed `Record<Union, V>` values `JSON.stringify` reaches, by type
     * key: each is written by its own helper, keys in the union's order.
     */
    private readonly jsonEnumMaps = new EmissionMap<
        string,
        { name: string; type: DataType<"enummap"> }
    >();

    /** The writer of an enummap type `JSON.stringify` reaches, registered once. */
    public jsonEnumMapWriter(type: DataType<"enummap">): string {
        const key = dataTypeKey(type);
        const known = this.jsonEnumMaps.get(key);
        if (known) return known.name;
        const name = `json_write_${type.enumName}_map_${this.jsonEnumMaps.size}`;
        this.jsonEnumMaps.set(key, { name, type });
        return name;
    }

    /**
     * The first creation, per closed `Record` union, whose own keys
     * JavaScript orders apart from the union's order -- the order its
     * slots are laid out and written in.
     */
    private readonly enumMapKeyOrders = new EmissionMap<string, ts.Node>();

    /** Observes a closed Record created with `keys`, in creation order. */
    public observeEnumMapKeys(
        type: DataType<"enummap">,
        keys: readonly string[],
        node: ts.Node,
    ): void {
        if (this.enumMapKeyOrders.has(type.enumName)) return;
        const members = this.enumMembers(type.enumName);
        const own = Object.keys(
            Object.fromEntries(keys.map((key) => [key, true])),
        );
        if (
            own.length !== members.length ||
            own.some((key, index) => key !== members[index])
        )
            this.enumMapKeyOrders.set(type.enumName, node);
    }

    /** The statement writing `cpp` of `type` as JSON through `writer`. */
    public jsonWriteCpp(type: DataType, cpp: string): string {
        // EnumMap's native array does not carry the closed Record's key schema.
        // Preserve its generated writer through nullable storage as well.
        if (type.kind === "optional" && type.inner.kind === "enummap")
            return `{ const auto& json_optional = ${cpp}; if (json_optional.has_value()) { ${this.jsonWriteCpp(type.inner, "*json_optional")} } else { writer.null_value(); } }`;
        return type.kind === "enummap"
            ? `bblscene::${this.jsonEnumMapWriter(type)}(writer, ${cpp});`
            : `json_write(writer, ${cpp});`;
    }
    private readonly partialRecords = new EmissionSet<
        ts.Symbol | ts.Type | string
    >();
    /** The required properties asserted literals lack, by record identity. */
    private readonly lackedProperties = new EmissionMap<
        ts.Symbol | ts.Type | string,
        ReadonlySet<string>
    >();
    private readonly absentProperties = new AbsentRecordProperties(
        (node, message) => this.fail(node, message),
        (target, sources, property, node) =>
            this.retainConvertedRecordProperty(target, sources, property, node),
    );

    /** An observable extra property joins the concrete record layouts that carried it. */
    private retainConvertedRecordProperty(
        name: string,
        sources: readonly string[],
        property: string,
        node: ts.Node,
    ): void {
        const target = this.nativeRecordSources.get(name);
        if (!target || !this.joinableRecord(target, target.type)) return;
        const carried: NativeRecordStorageDemand[] = [];
        for (const name of sources) {
            const source = this.nativeRecordSources.get(name);
            if (
                !source ||
                !this.joinableRecord(source, source.type) ||
                !layoutsCompatible(this.checker, source.type, target.type)
            )
                return;
            carried.push(source);
        }
        if (
            !carried.some((source) => {
                const type = source.type;
                const shapes =
                    this.recordComponentOf(type)?.shapes ??
                    (type.isUnion() ? type.types : [type]);
                return shapes.some((shape) => shape.getProperty(property));
            })
        )
            return;
        const joins = carried.flatMap((source) =>
            this.joined(source.type, target.type)
                ? []
                : [
                      {
                          source: source.type,
                          target: target.type,
                          kind: "value" as const,
                      },
                  ],
        );
        if (joins.length)
            throw new NativeRecordStorageRequired({
                ...target,
                node,
                joins,
            });
    }

    public constructor(
        private readonly checker: ts.TypeChecker,
        private readonly fail: Fail,
        /** Which local classes extend which, for class-backed structs and dispatch. */
        public readonly classHierarchy: ClassHierarchy,
        private readonly asynchronous = false,
        /** The storage demands this compile replays with; read, never added to. */
        private readonly storage = new ReplayStorage(checker),
        /**
         * A discarded planning attempt's sink for record joins: lowering
         * goes on with a copy, so one attempt meets every join.
         */
        private readonly planJoin?: (demand: NativeRecordStorageDemand) => void,
    ) {}

    /** Demands a record join; a planning attempt goes on with a copy. */
    private requireJoin(demand: NativeRecordStorageDemand): void {
        if (!this.planJoin) throw new NativeRecordStorageRequired(demand);
        this.planJoin(demand);
    }

    /** A string literal union's identity across replays: its sorted members. */
    public enumLiterals(name: string): string {
        return this.enumMembers(name).join("|");
    }

    /** Whether arrays of the named literal union store its members as strings. */
    public storesEnumElementsAsStrings(name: string): boolean {
        return this.storage.stringElementUnions.has(this.enumLiterals(name));
    }

    /**
     * An array element as its array stores it: a literal union a demand
     * gave string storage (`stringElementUnions`) as a string, also as an
     * optional lane.
     */
    private arrayElementStorage(element: DataType): DataType {
        if (
            element.kind === "enum" &&
            this.storesEnumElementsAsStrings(element.name)
        )
            return { kind: "string" };
        if (element.kind === "optional") {
            const inner = this.arrayElementStorage(element.inner);
            return inner === element.inner ? element : { ...element, inner };
        }
        return element;
    }

    /** The numeric array kinds a demand retyped `declaration`'s `ArrayLike<number>` position for. */
    public numericSlotKinds(
        declaration: ts.Declaration,
    ): ReadonlySet<NumericSlotKind> | undefined {
        return this.storage.numericSlots.get(declaration);
    }

    /**
     * The storage of the value `expression` reads from a slot whose
     * `ArrayLike<number>` position (or elements) a demand retyped, if any.
     */
    public numericSlotReadStorage(
        expression: ts.Expression,
    ): DataType | undefined {
        const declaration = numericSlotRead(this.checker, expression);
        if (!declaration || !this.storage.numericSlots.has(declaration))
            return undefined;
        const type = this.checker.getTypeAtLocation(expression);
        const mapped = this.fromTsType(type, expression);
        return mapped && this.demandedNumericStorage(declaration, type, mapped);
    }

    /**
     * `mapped`, the storage `declaration` of `type` takes, with its
     * `ArrayLike<number>` position stored as the numeric arrays a demand
     * found there (`NumericSlotStorageRequired`).
     */
    public withDemandedNumericSlot(
        declaration: ts.Declaration | undefined,
        type: ts.Type,
        mapped: DataType,
    ): DataType {
        if (!declaration) return mapped;
        return (
            this.demandedNumericStorage(declaration, type, mapped) ??
            this.fail(
                declaration,
                "A demanded ArrayLike slot no longer maps to a numeric array position.",
            )
        );
    }

    /** {@link withDemandedNumericSlot}, undefined where the slot no longer lines up. */
    private demandedNumericStorage(
        declaration: ts.Declaration,
        type: ts.Type,
        mapped: DataType,
    ): DataType | undefined {
        const kinds = this.storage.numericSlots.get(declaration);
        return kinds
            ? withNumericSlotStorage(
                  this.checker,
                  type,
                  mapped,
                  numericSlotStorage(kinds),
              )
            : mapped;
    }

    /**
     * `type` as the storage of `declaration`: tagged when the program
     * observes which absent value it holds (`AbsenceTagStorageRequired`).
     * Dynamic documents and storage without an absent state already answer.
     */
    public absenceTaggedStorage(
        declaration: ts.Declaration | undefined,
        type: DataType,
    ): DataType {
        if (
            declaration === undefined ||
            !this.storage.absenceTags.has(declaration) ||
            type.kind === "json" ||
            type.kind === "tagged" ||
            this.slotPresentCpp(type, "slot") === undefined
        )
            return type;
        return { kind: "tagged", inner: type };
    }

    /**
     * The tagged storage of a source declaration whose value has `type`
     * (resolved at `site`), when the program observes which absent value it
     * holds ({@link absenceTaggedStorage}); undefined while one state answers.
     */
    public taggedDeclarationStorage(
        declaration: ts.Declaration,
        type: ts.Type,
        site: ts.Node,
    ): DataType<"tagged"> | undefined {
        if (!this.storage.absenceTags.has(declaration)) return undefined;
        const stored = this.fromStoredTsType(type, site);
        const storage =
            stored && this.absenceTaggedStorage(declaration, stored);
        return storage?.kind === "tagged" ? storage : undefined;
    }

    /** @unjournaled Immutable checked source inventory shared across emission replays. */
    private arraySources?: FiniteArraySources;

    /**
     * One walk over the repository's sources for the record facts that
     * decide struct layouts before anything is emitted:
     * - an asserted empty literal is a partial record, whose fields its
     *   declared view later fills;
     * - a property a repository object literal defines with an accessor --
     *   the literal's own declaration, and the property of its contextual
     *   type (`const batch: Batch = { get count() {...} }`, a factory
     *   returning `Batch`) -- or an interface property a class `implements`
     *   with one, is an accessor slot;
     * - a closed record asserted from an open string-keyed record
     *   (`Object.fromEntries(...) as Record<Union, V>`) is a view of it.
     */
    public registerRecordFacts(files: readonly ts.SourceFile[]): void {
        this.arraySources = finiteArraySources(this.checker, files);
        for (const file of files) {
            if (file.isDeclarationFile) continue;
            forEachAnalysisNode(file, (node) => {
                if (
                    ts.isGetAccessorDeclaration(node) ||
                    ts.isSetAccessorDeclaration(node)
                )
                    this.registerAccessor(node);
                else if (
                    ts.isAsExpression(node) ||
                    ts.isTypeAssertionExpression(node)
                ) {
                    this.registerAssertedRecord(node);
                    if (ts.isTypeReferenceNode(node.type))
                        this.namedAssertions.push(node);
                }
            });
        }
    }

    /**
     * @unjournaled Source facts gathered once before lowering: the
     * assertions to a named type, whose types resolve only when a phantom
     * brand needs them.
     */
    private readonly namedAssertions: (ts.AsExpression | ts.TypeAssertion)[] =
        [];
    /** @unjournaled The object type each phantom brand's assertions brand, from source alone. */
    private readonly brandSources = new Map<string, ts.Type | null>();

    /**
     * A phantom brand (`Readonly<{ readonly [brand]: true }>` over a
     * `declare const brand: unique symbol`): every property is keyed by a
     * symbol with no runtime value, so no object has one and the type adds
     * nothing to the object asserted to it. The key names its symbols.
     */
    private phantomBrandKey(type: ts.Type): string | undefined {
        const cached = this.phantomBrandKeys.get(type);
        if (cached !== undefined) return cached ?? undefined;
        const key = this.computePhantomBrandKey(type);
        this.phantomBrandKeys.set(type, key ?? null);
        return key;
    }

    /** @unjournaled Whether a checked type is a phantom brand, from source alone. */
    private readonly phantomBrandKeys = new WeakMap<ts.Type, string | null>();

    private computePhantomBrandKey(type: ts.Type): string | undefined {
        if (
            type.isUnionOrIntersection() ||
            type.getCallSignatures().length > 0 ||
            type.getConstructSignatures().length > 0 ||
            this.checker.getIndexInfosOfType(type).length > 0
        )
            return undefined;
        const properties = this.checker.getPropertiesOfType(type);
        if (properties.length === 0) return undefined;
        for (const property of properties) {
            const declaration = property.declarations?.[0];
            const name =
                declaration && ts.isPropertySignature(declaration)
                    ? declaration.name
                    : undefined;
            if (
                !name ||
                !ts.isComputedPropertyName(name) ||
                !ts.isIdentifier(name.expression)
            )
                return undefined;
            const key = resolvedSymbol(
                this.checker,
                name.expression,
            )?.valueDeclaration;
            if (
                !key ||
                !ts.isVariableDeclaration(key) ||
                key.initializer !== undefined ||
                key.getSourceFile().isDeclarationFile ||
                (ts.getCombinedModifierFlags(key) &
                    ts.ModifierFlags.Ambient) ===
                    0
            )
                return undefined;
        }
        return properties
            .map((property) => String(property.escapedName))
            .sort()
            .join(",");
    }

    /**
     * A phantom brand stores the one object type the program asserts to it
     * (`new Key() as unknown as Brand`): the brand is that object, so it
     * keeps that object's storage and identity. Assertions from another
     * brand value or from an unknown value (`unknown`, `object`, `{}`)
     * decide nothing; a brand asserted from several object types has no one
     * storage.
     */
    private brandStorage(type: ts.Type, node: ts.Node): DataType | undefined {
        const key = this.phantomBrandKey(type);
        if (key === undefined) return undefined;
        let source = this.brandSources.get(key);
        if (source === undefined) {
            const sources = new Set<ts.Symbol | ts.Type>();
            let first: ts.Type | undefined;
            for (const assertion of this.namedAssertions) {
                if (
                    this.phantomBrandKey(
                        this.checker.getTypeFromTypeNode(assertion.type),
                    ) !== key
                )
                    continue;
                const sourceType = this.checker.getNonNullableType(
                    this.checker.getTypeAtLocation(
                        unwrapExpression(assertion.expression),
                    ),
                );
                if (
                    (sourceType.flags &
                        (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) !==
                        0 ||
                    this.isNonNullConstraint(sourceType) ||
                    this.phantomBrandKey(sourceType) === key
                )
                    continue;
                first ??= sourceType;
                sources.add(sourceType.symbol ?? sourceType);
            }
            source = sources.size === 1 ? first! : null;
            this.brandSources.set(key, source);
        }
        // Without one asserted object type the brand keeps its record shape,
        // which no object can be stored as.
        return source ? this.fromStoredTsType(source, node) : undefined;
    }

    private registerAssertedRecord(
        node: ts.AsExpression | ts.TypeAssertion,
    ): void {
        // Only these shapes resolve types here: resolving every cast's
        // type ahead of emission would reorder the checker's unions.
        const source = unwrapExpression(node.expression);
        const literal = ts.isObjectLiteralExpression(source)
            ? source
            : undefined;
        const partial = literal?.properties.length === 0;
        if (
            !partial &&
            !this.spellsRecordType(node.type) &&
            !(
                literal &&
                ts.isTypeReferenceNode(node.type) &&
                !ts.isConstTypeReference(node.type)
            )
        )
            return;
        const type = this.checker.getTypeAtLocation(node);
        if (
            type.getCallSignatures().length ||
            type.getConstructSignatures().length ||
            type.symbol?.declarations?.some(ts.isClassLike) ||
            this.checker.getPropertiesOfType(type).length === 0
        )
            return;
        if (partial) {
            this.partialRecords.add(this.structIdentity(type));
            return;
        }
        if (literal) {
            this.registerLackedProperties(type, literal);
            return;
        }
        const sourceType = this.checker.getTypeAtLocation(source);
        if (
            this.checker.getIndexInfoOfType(sourceType, ts.IndexKind.String) &&
            this.checker.getPropertiesOfType(sourceType).length === 0 &&
            !this.checker.getIndexInfoOfType(type, ts.IndexKind.String)
        )
            this.recordViews.add(this.structIdentity(type));
    }

    /**
     * Whether a type spells a record type: `Record<K, V>`, one under
     * `Readonly`/`Partial`/`Required`, or an alias declared as one.
     */
    private spellsRecordType(node: ts.TypeNode, depth = 0): boolean {
        if (!ts.isTypeReferenceNode(node) || depth > 8) return false;
        const name = ts.isIdentifier(node.typeName)
            ? node.typeName.text
            : node.typeName.right.text;
        const [argument] = node.typeArguments ?? [];
        if (name === "Record") return true;
        if (["Readonly", "Partial", "Required"].includes(name) && argument)
            return this.spellsRecordType(argument, depth + 1);
        const symbol = resolvedSymbol(this.checker, node.typeName);
        const alias = symbol?.declarations?.find(ts.isTypeAliasDeclaration);
        return (
            alias !== undefined && this.spellsRecordType(alias.type, depth + 1)
        );
    }

    /**
     * An object literal asserted to a record type it lacks required
     * properties of (`{ depth } as Spec`): records of that type can lack
     * them, as an asserted empty object can lack every property.
     */
    private registerLackedProperties(
        type: ts.Type,
        literal: ts.ObjectLiteralExpression,
    ): void {
        const required = (property: ts.Symbol): boolean =>
            (property.flags & ts.SymbolFlags.Optional) === 0;
        const provided = new Set(
            this.checker
                .getPropertiesOfType(this.checker.getTypeAtLocation(literal))
                .filter(required)
                .map((property) => property.name),
        );
        const lacked = this.checker
            .getPropertiesOfType(type)
            .filter(
                (property) =>
                    required(property) && !provided.has(property.name),
            )
            .map((property) => property.name);
        if (!lacked.length) return;
        const identity = recordIdentity(this.checker, type);
        this.lackedProperties.set(
            identity,
            new Set([
                ...(this.lackedProperties.get(identity) ?? []),
                ...lacked,
            ]),
        );
    }

    /**
     * Records of the type can lack some property they declare required: an
     * asserted empty object lacks them all, an asserted literal those it
     * does not write.
     */
    public isPartialRecord(type: ts.Type): boolean {
        return (
            this.assertedEmpty(type) ||
            this.lackedProperties.has(recordIdentity(this.checker, type))
        );
    }

    /**
     * Whether an empty object was asserted to the type, which was registered
     * by its own identity before record components joined it with others.
     */
    private assertedEmpty(type: ts.Type): boolean {
        return (
            this.partialRecords.has(this.structIdentity(type)) ||
            this.partialRecords.has(recordIdentity(this.checker, type))
        );
    }

    /** Whether a record of the type can lack this property it declares required. */
    public mayLackProperty(type: ts.Type, name: string): boolean {
        return (
            this.assertedEmpty(type) ||
            this.lackedProperties
                .get(recordIdentity(this.checker, type))
                ?.has(name) === true
        );
    }

    /** Property declarations a getter, and a setter, define. */
    private readonly getterProperties = new EmissionSet<ts.Node>();
    private readonly setterProperties = new EmissionSet<ts.Node>();
    /**
     * Property declarations a class's prototype accessor stands for (an
     * `implements`ed or converted class getter): no own property of the
     * instance a struct slot holds.
     */
    private readonly prototypeAccessors = new EmissionSet<ts.Node>();
    /** Structs whose accessor slots may hold a class's prototype accessor. */
    private readonly prototypeAccessorStructs = new EmissionSet<string>();
    /** Closed records asserted from open string-keyed records, by struct identity. */
    private readonly recordViews = new EmissionSet<
        ts.Symbol | ts.Type | string
    >();
    private readonly proxyRecords = new EmissionSet<
        NativeRecordStorageDemand["identity"]
    >();
    private readonly proxyTargets = new EmissionSet<
        NativeRecordStorageDemand["identity"]
    >();
    /**
     * @unjournaled Set once before lowering: the record types a converted
     * record joins into one object, by record identity
     * (`record-components.ts`).
     */
    private recordComponents: ReadonlyMap<RecordComponentKey, RecordComponent> =
        new Map();
    /**
     * @unjournaled Set once before lowering: the joins earlier replays
     * demanded, by source type.
     */
    private demandedJoins: ReadonlyMap<ts.Type, readonly RecordJoin[]> =
        new Map();
    /**
     * Unions whose records hold fields only some members declare, by struct
     * identity: they store every member's fields, not their common view.
     */
    private readonly armFieldUnions = new EmissionSet<
        ts.Symbol | ts.Type | string
    >();
    /** Union layouts being resolved, so a member mapped through one maps once. */
    private readonly resolvingLayouts = new EmissionSet<ts.Type>();

    /**
     * Fix every record component's layout before any record is mapped, and
     * register the stronger demands replays carry (a proxy's accessor
     * slots, document storage, the joins lowering met).
     */
    public prepareRecordComponents(
        components: ReadonlyMap<RecordComponentKey, RecordComponent>,
        demands: Iterable<NativeRecordStorageDemand>,
    ): void {
        this.recordComponents = components;
        const joins = new Map<ts.Type, RecordJoin[]>();
        for (const demand of demands) {
            if (demand.dictionaryConflict)
                this.fail(
                    demand.node,
                    "A record has conflicting scalar dictionary storage demands.",
                );
            if (demand.nativeConflict)
                this.fail(
                    demand.node,
                    "A structural record has conflicting native object storage demands.",
                );
            if (demand.proxy)
                this.withRecordDemand(demand, () =>
                    this.proxyRecords.add(this.structIdentity(demand.type)),
                );
            if (demand.proxyTarget)
                this.withRecordDemand(demand, () =>
                    this.proxyTargets.add(this.structIdentity(demand.type)),
                );
            if (demand.armFields)
                this.withRecordDemand(demand, () =>
                    this.armFieldUnions.add(this.structIdentity(demand.type)),
                );
            if (demand.view)
                this.withRecordDemand(demand, () =>
                    this.recordViews.add(this.structIdentity(demand.type)),
                );
            if (demand.bareCallable)
                this.withRecordDemand(demand, () =>
                    this.partialRecords.add(this.structIdentity(demand.type)),
                );
            for (const { name, setter, own } of demand.accessors ?? [])
                for (const declaration of this.checker.getPropertyOfType(
                    demand.type,
                    name,
                )?.declarations ?? []) {
                    this.getterProperties.add(declaration);
                    if (!own) this.prototypeAccessors.add(declaration);
                    if (setter) this.setterProperties.add(declaration);
                }
            if (demand.document)
                this.withRecordDemand(demand, () =>
                    this.documentRecords.add(this.structIdentity(demand.type)),
                );
            if (demand.documentDictionary)
                this.withRecordDemand(demand, () =>
                    this.documentDictionaries.add(
                        this.structIdentity(demand.type),
                    ),
                );
            if (demand.dictionary)
                this.withRecordDemand(demand, () => {
                    const identity = this.structIdentity(demand.type);
                    const previous = this.recordDictionaries.get(identity);
                    if (previous && previous !== demand.dictionary)
                        this.fail(
                            demand.node,
                            "A record has conflicting scalar dictionary storage demands.",
                        );
                    this.recordDictionaries.set(identity, demand.dictionary!);
                });
            if (demand.native)
                this.withRecordDemand(demand, () => {
                    const type = demand.native!.storage;
                    if (
                        !type ||
                        !isNativeStructuralView(type) ||
                        demand.document ||
                        demand.documentDictionary ||
                        demand.dictionary
                    )
                        this.fail(
                            demand.node,
                            "A structural record has conflicting native object storage demands.",
                        );
                    const identity = this.structIdentity(demand.type);
                    const previous = this.recordNativeViews.get(identity);
                    if (previous && !dataTypesEqual(previous, type))
                        this.fail(
                            demand.node,
                            "A structural record has conflicting native object storage demands.",
                        );
                    this.recordNativeViews.set(identity, type);
                });
            for (const join of demand.joins ?? []) {
                const known = joins.get(join.source);
                if (known) known.push(join);
                else joins.set(join.source, [join]);
            }
        }
        this.demandedJoins = joins;
    }

    /**
     * Record types whose values are parsed documents the program reads as
     * them (`documentRecordDemand`), by record identity: each maps to
     * document storage.
     */
    private readonly documentRecords = new EmissionSet<
        ts.Symbol | ts.Type | string
    >();
    private readonly documentDictionaries = new EmissionSet<
        NativeRecordStorageDemand["identity"]
    >();
    private readonly recordDictionaries = new EmissionMap<
        NativeRecordStorageDemand["identity"],
        NonNullable<NativeRecordStorageDemand["dictionary"]>
    >();
    private readonly recordNativeViews = new EmissionMap<
        NativeRecordStorageDemand["identity"],
        DataType
    >();

    /** A structural annotation whose reached native owners demanded their concrete carrier. */
    public hasNativeRecordView(type: ts.Type): boolean {
        return this.recordNativeViews.has(
            this.structIdentity(
                this.checker.getNonNullableType(
                    this.resolveTypeParameter(type),
                ),
            ),
        );
    }

    /** A checked structural projection retains the represented native owner. */
    public nativeRecordViewDemand(
        name: string,
        actual: DataType,
        node: ts.Node,
    ): NativeRecordStorageDemand | undefined {
        const source = this.nativeRecordSources.get(name);
        if (
            !source ||
            this.isClassStruct(name) ||
            !isNativeStructuralView(actual) ||
            !ts.isExpression(node)
        )
            return undefined;
        const expression = unwrapExpression(node);
        const checked = this.checker.getNonNullableType(
            this.checker.getTypeAtLocation(node),
        );
        const mapped = this.fromStoredTsType(checked, expression);
        if (
            !mapped ||
            (!dataTypesEqual(mapped, actual) &&
                !(
                    actual.kind === "handle" &&
                    (mapped.kind === "struct" ||
                        (mapped.kind === "handle" &&
                            mapped.handle === actual.handle))
                )) ||
            !this.checker.isTypeAssignableTo(
                checked,
                this.checker.getNonNullableType(source.type),
            )
        )
            return undefined;
        return {
            ...source,
            native: { type: checked, node: expression, storage: actual },
        };
    }

    public dictionaryRecordDemand(
        name: string,
        value: DataType,
    ): NativeRecordStorageDemand | undefined {
        if (
            value.kind !== "string" &&
            value.kind !== "number" &&
            value.kind !== "boolean"
        )
            return undefined;
        const source = this.nativeRecordSources.get(name);
        const fields = this.structsByName.get(name)?.fields;
        if (
            !source ||
            !fields ||
            this.isClassStruct(name) ||
            fields.some((field) => {
                const type =
                    field.type.kind === "optional"
                        ? field.type.inner
                        : field.type;
                return (
                    field.accessor ||
                    (!dataTypesEqual(type, value) &&
                        !(type.kind === "enum" && value.kind === "string"))
                );
            })
        )
            return undefined;
        return { ...source, dictionary: value.kind };
    }

    /**
     * The demand that stores every record of struct `name` as a document,
     * for a parsed document reaching it: a plain-data record or synthetic
     * dictionary view (no stored functions or authored accessors), not a class.
     */
    public documentRecordDemand(
        name: string,
    ): NativeRecordStorageDemand | undefined {
        const source = this.nativeRecordSources.get(name);
        const fields = this.structsByName.get(name)?.fields;
        // A synthetic dictionary view has no source accessor to preserve.
        // Its document wrapper reads and writes the same backing entries.
        const dictionaryView =
            source !== undefined &&
            this.recordViews.has(this.structIdentity(source.type)) &&
            fields?.every(
                (field) =>
                    !field.accessorReceiver &&
                    !(field.declarations ?? []).some(
                        (declaration) =>
                            this.getterProperties.has(declaration) ||
                            this.setterProperties.has(declaration),
                    ),
            );
        if (
            !source ||
            !fields ||
            this.isClassStruct(name) ||
            fields.some(
                (field) =>
                    (field.accessor && !dictionaryView) ||
                    field.type.kind === "function",
            )
        )
            return undefined;
        return { ...source, document: true };
    }

    /** Scalar dictionary slots can share mutable storage with a document view. */
    public isScalarDocumentStorage(value: DataType): boolean {
        return value.kind === "optional" || value.kind === "tagged"
            ? this.isScalarDocumentStorage(value.inner)
            : value.kind === "union"
              ? value.members.every((member) =>
                    this.isScalarDocumentStorage(member),
                )
              : [
                    "string",
                    "number",
                    "boolean",
                    "enum",
                    "undefined",
                    "null",
                    "json",
                ].includes(value.kind);
    }

    /** A scalar dictionary stored through a writable document keeps own undefined entries. */
    public documentDictionaryDemand(
        type: ts.Type,
        node: ts.Node,
    ): NativeRecordStorageDemand | undefined {
        const concrete = this.checker.getNonNullableType(
            this.resolveTypeParameter(type),
        );
        if (
            !this.checker.getIndexInfoOfType(concrete, ts.IndexKind.String) ||
            this.documentDictionaries.has(this.structIdentity(concrete))
        )
            return undefined;
        const mapped = this.fromStoredTsType(concrete, node);
        if (
            mapped?.kind !== "map" ||
            !mapped.dictionary ||
            mapped.key.kind !== "string" ||
            mapped.value.kind === "json" ||
            !this.isScalarDocumentStorage(mapped.value)
        )
            return undefined;
        return {
            ...this.recordDemand(concrete, node),
            documentDictionary: true,
        };
    }

    /**
     * A use of a union's struct names a field only some members declare (a
     * literal `{ ok: false, reason }`, a read through a view) where the
     * union stores its members' common view: replays store every member's
     * fields, the arms its tags cannot tell apart told apart by those
     * fields' slots. Refuses with `message` otherwise.
     */
    public requireArmFields(
        structName: string,
        field: string,
        node: ts.Node,
        message: string,
    ): never {
        const source = this.nativeRecordSources.get(structName);
        const union = source?.type;
        if (source && !union?.isUnion()) {
            const expression =
                ts.isPropertyAccessExpression(node) ||
                ts.isElementAccessExpression(node)
                    ? node.expression
                    : ts.isSpreadAssignment(node)
                      ? node.expression
                      : ts.isExpression(node)
                        ? node
                        : ts.isObjectLiteralExpression(node.parent)
                          ? node.parent
                          : undefined;
            const actual =
                expression &&
                this.checker.getNonNullableType(
                    this.checker.getTypeAtLocation(expression),
                );
            const checked =
                actual &&
                (this.checker.getBaseConstraintOfType(actual) ?? actual);
            if (
                checked &&
                this.checker
                    .getPropertiesOfType(checked)
                    .some((property) => property.name === field) &&
                isPlainRecord(this.checker, checked) &&
                isPlainRecord(this.checker, source.type) &&
                !this.joined(source.type, checked) &&
                layoutsCompatible(this.checker, source.type, checked)
            )
                throw new NativeRecordStorageRequired({
                    ...source,
                    joins: [
                        {
                            source: source.type,
                            target: checked,
                            kind: "assertion",
                        },
                    ],
                });
        }
        if (
            !source ||
            !union?.isUnion() ||
            this.armFieldUnions.has(this.structIdentity(union)) ||
            !union.types.some((member) => member.getProperty(field))
        )
            this.fail(node, message);
        throw new NativeRecordStorageRequired({ ...source, armFields: true });
    }

    /**
     * An open string-keyed record converted into the closed record type of
     * the struct, whose fields would copy its entries: replays make the type
     * a view of the open record (`registerAssertedRecord`), one object.
     * Refuses with `message` otherwise.
     */
    public requireRecordView(
        structName: string,
        node: ts.Node,
        message: string,
    ): never {
        const source = this.nativeRecordSources.get(structName);
        if (!source || this.recordViews.has(this.structIdentity(source.type)))
            this.fail(node, message);
        throw new NativeRecordStorageRequired({ ...source, view: true });
    }

    /**
     * A record converted into the struct defines a property it stores as
     * data with accessors (a class getter, without an `implements` naming
     * the type): replays give the property an accessor slot.
     */
    public requireAccessorSlot(
        type: DataType<"struct">,
        name: string,
        setter: boolean,
        node: ts.Node,
        own?: "own",
    ): never {
        const source = this.nativeRecordSources.get(type.name);
        const declarations =
            source &&
            this.checker.getPropertyOfType(source.type, name)?.declarations;
        if (
            !source ||
            !declarations?.length ||
            declarations.some(
                (declaration) =>
                    this.getterProperties.has(declaration) &&
                    (!setter || this.setterProperties.has(declaration)),
            )
        )
            this.fail(
                node,
                `Property '${name}' is an accessor; the native record stores it as data.`,
            );
        throw new NativeRecordStorageRequired({
            ...source,
            accessors: [{ name, setter, ...(own ? { own: true } : {}) }],
        });
    }

    /** Whether two record types already share one record component. */
    private joined(left: ts.Type, right: ts.Type): boolean {
        const component = this.recordComponentOf(left);
        return (
            component !== undefined &&
            component === this.recordComponentOf(right)
        );
    }

    /**
     * Whether storage of a record type can hold a record lacking a field
     * the type declares: its component holds narrower records in it
     * (`RecordComponent.holdsNarrower`), so the field's own slot, not the
     * declaration, says whether a record holds it.
     */
    public mayHoldNarrower(type: ts.Type): boolean {
        return (
            this.recordComponentOf(type)?.holdsNarrower.has(
                this.instantiatedRecordOf(type) ??
                    recordIdentity(this.checker, type),
            ) === true
        );
    }

    /**
     * The component a record type's records share their layout with; a
     * generic record type's under the instantiation in force.
     */
    private recordComponentOf(type: ts.Type): RecordComponent | undefined {
        if (!this.recordComponents.size) return undefined;
        const instantiation = this.instantiatedRecordOf(type);
        return this.recordComponents.get(
            instantiation ?? recordIdentity(this.checker, type),
        );
    }

    /**
     * A generic record type naming type parameters the instantiations in
     * force substitute, as that one instantiation: its generic interface,
     * class or alias with each argument resolved (a generic argument as its
     * own instantiation). Undefined for a type no instantiation reaches,
     * and for one an argument of which does not resolve.
     */
    private instantiatedRecordOf(
        type: ts.Type,
    ): InstantiatedRecord | undefined {
        if (!this.mentionsSubstitution(type)) return undefined;
        const object = type as ts.ObjectType;
        const [generic, arguments_] =
            type.aliasSymbol && type.aliasTypeArguments?.length
                ? [type.aliasSymbol, type.aliasTypeArguments]
                : (object.objectFlags & ts.ObjectFlags.Reference) !== 0
                  ? [
                        (type as ts.TypeReference).target,
                        this.checker.getTypeArguments(type as ts.TypeReference),
                    ]
                  : [undefined, []];
        if (!generic) return undefined;
        const resolved = arguments_.map((argument) => {
            const concrete = this.resolveTypeParameter(argument);
            return this.mentionsSubstitution(concrete)
                ? this.instantiatedRecordOf(concrete)
                : concrete;
        });
        return resolved.every((argument) => argument !== undefined)
            ? instantiatedRecord(generic, resolved)
            : undefined;
    }

    /**
     * @unjournaled A pure function of the checked program and of the
     * components fixed before lowering: each component's `layoutUnion`
     * answer, by component key.
     */
    private readonly unionLayouts = new Map<string, ts.UnionType | null>();

    /**
     * The record union whose own layout a record type's component takes:
     * its one union, where that layout stores a field of every name the
     * component's shapes declare -- every arm's fields when literal tags
     * tell the arms apart (`unionArmTags`), else those every arm declares.
     * Otherwise the component's layout is the union of its shapes' fields
     * (`layoutProperties`), the unions' arms included.
     */
    private layoutUnion(
        type: ts.Type,
        node: ts.Node,
    ): ts.UnionType | undefined {
        const component = this.recordComponentOf(type);
        if (component?.unions.length !== 1) return undefined;
        let layout = this.unionLayouts.get(component.key);
        if (layout === undefined) {
            const union = component.unions[0]!;
            const arms = union.types.map((arm) =>
                this.checker.getPropertiesOfType(arm),
            );
            const tagged =
                this.unionArmTags(
                    union,
                    node,
                    this.armFieldUnions.has(this.structIdentity(union)),
                ) !== undefined;
            const held = new Set(
                arms
                    .flat()
                    .filter(
                        ({ name }) =>
                            tagged ||
                            arms.every((properties) =>
                                properties.some(
                                    (property) => property.name === name,
                                ),
                            ),
                    )
                    .map(({ name }) => name),
            );
            layout = component.shapes.every((shape) =>
                this.checker
                    .getPropertiesOfType(shape)
                    .every(({ name }) => held.has(name)),
            )
                ? union
                : null;
            this.unionLayouts.set(component.key, layout);
        }
        return layout ?? undefined;
    }

    /** Synthetic own-presence slots alone do not change a method's receiver. */
    public isProxyTarget(name: string): boolean {
        const source = this.nativeRecordSources.get(name);
        return (
            !!source &&
            this.withRecordDemand(source, () =>
                this.proxyTargets.has(this.structIdentity(source.type)),
            )
        );
    }

    /** A proxy and its target retain one field layout but distinct object identities. */
    public requireProxyRecord(type: DataType<"struct">, node: ts.Node): void {
        if (
            this.isProxyTarget(type.name) &&
            this.structFields(type.name, node, "accessors").every(
                (field) => field.accessorReceiver,
            )
        )
            return;
        const source = this.nativeRecordSources.get(type.name);
        if (!source)
            this.fail(
                node,
                "A Proxy target requires a retained source record layout.",
            );
        throw new NativeRecordStorageRequired({
            ...source,
            proxy: true,
            proxyTarget: true,
        });
    }

    private registerAccessor(
        node: ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
    ): void {
        if (!ts.isIdentifier(node.name) && !ts.isStringLiteral(node.name))
            return;
        const name = node.name.text;
        const properties = ts.isGetAccessorDeclaration(node)
            ? this.getterProperties
            : this.setterProperties;
        const noteImplemented = (type: ts.Type, prototype = false): void => {
            for (const member of type.isUnion() ? type.types : [type])
                for (const declaration of this.checker.getPropertyOfType(
                    member,
                    name,
                )?.declarations ?? []) {
                    properties.add(declaration);
                    if (prototype) this.prototypeAccessors.add(declaration);
                }
        };
        if (ts.isObjectLiteralExpression(node.parent)) {
            properties.add(node);
            const contextual = this.checker.getContextualType(node.parent);
            if (contextual) noteImplemented(contextual);
            return;
        }
        if (!ts.isClassLike(node.parent) || isStaticMember(node)) return;
        for (const clause of node.parent.heritageClauses ?? [])
            if (clause.token === ts.SyntaxKind.ImplementsKeyword)
                for (const implemented of clause.types)
                    noteImplemented(
                        this.checker.getTypeAtLocation(implemented),
                        true,
                    );
    }

    /**
     * Whether a write to this property can reach an accessor slot: a getter
     * or setter defines it, or it belongs to a record view.
     */
    public isAccessorProperty(property: ts.Symbol, owner: ts.Type): boolean {
        return (
            (property.declarations ?? []).some(
                (declaration) =>
                    this.getterProperties.has(declaration) ||
                    this.setterProperties.has(declaration),
            ) ||
            this.recordViews.has(
                this.structIdentity(this.checker.getNonNullableType(owner)),
            ) ||
            this.proxyRecords.has(
                this.structIdentity(this.checker.getNonNullableType(owner)),
            )
        );
    }

    /** Records whose accessor slots a run-time key selects, by struct name. */
    private readonly keyedSlots = new EmissionMap<
        string,
        { key: DataType<"enum">; node: ts.Node }
    >();

    /**
     * The member a run-time key of `key` selects a record's accessor slot
     * with, when every member names an accessor slot of one type: one
     * switch in the record, rather than one per keyed read or write.
     */
    public keyedSlotMember(
        structName: string,
        key: DataType<"enum">,
        node: ts.Node,
    ): string | undefined {
        const fields = this.enumMembers(key.name).map((member) =>
            this.structField(structName, member, node, "accessors"),
        );
        const [first] = fields;
        if (
            !first ||
            fields.some(
                (field) =>
                    !field.accessor || !dataTypesEqual(field.type, first.type),
            )
        )
            return undefined;
        const known = this.keyedSlots.get(structName);
        if (known && known.key.name !== key.name) return undefined;
        if (!known) this.keyedSlots.set(structName, { key, node });
        return "slot_at";
    }

    private renderKeyedSlot(definition: DataStructDefinition): string[] {
        const keyed = this.keyedSlots.get(definition.name);
        if (!keyed) return [];
        const members = this.enumMembers(keyed.key.name);
        const field = (member: string): DataStructField =>
            this.structField(definition.name, member, keyed.node, "accessors");
        return [
            `    ${this.structFieldCppType(field(members[0]!))}& slot_at(${this.cppType(keyed.key)} key) {`,
            "        switch (key) {",
            ...members.map(
                (member) =>
                    `        case ${this.enumMemberCpp(keyed.key, member, keyed.node)}: return ${field(member).name};`,
            ),
            "        }",
            '        throw std::out_of_range("Record key is not a member of its key union.");',
            "    }",
        ];
    }

    /** Whether a record type stores a field in an accessor slot. */
    public isAccessorRecordType(type: ts.Type): boolean {
        const record = this.checker.getNonNullableType(type);
        return (
            this.recordViews.has(this.structIdentity(record)) ||
            this.proxyRecords.has(this.structIdentity(record)) ||
            this.checker
                .getPropertiesOfType(record)
                .some((property) =>
                    (property.declarations ?? []).some(
                        (declaration) =>
                            this.getterProperties.has(declaration) ||
                            this.setterProperties.has(declaration),
                    ),
                )
        );
    }

    /** The accessors a struct field of this property holds, if any. */
    private propertyAccessor(
        property: ts.Symbol,
        view: boolean,
    ): StructFieldAccessor | undefined {
        if (view) return "get-set";
        const declarations = property.declarations ?? [];
        const get = declarations.some((declaration) =>
            this.getterProperties.has(declaration),
        );
        const set = declarations.some((declaration) =>
            this.setterProperties.has(declaration),
        );
        // A setter-only property maps as data; a record holding its setter
        // refuses where it is stored.
        if (!get) return undefined;
        return set ? "get-set" : "get";
    }

    /**
     * A field's native initializer from the value it stores: in an accessor
     * slot, the value is held inline. `{}` is the default value.
     */
    public structFieldInitializerCpp(
        field: DataStructField,
        cpp: string,
    ): string {
        if (!field.accessor) return cpp;
        const slot = this.structFieldCppType(field);
        return cpp === "{}" ? `${slot}{}` : `${slot}(${cpp})`;
    }

    /**
     * Marks object values stored behind another JavaScript object/container
     * as references. Copies of arrays, maps, sets, and record fields retain
     * the identity of their object-valued entries in JavaScript.
     */
    public markStoredObjectReferences(dataType: DataType): DataType {
        switch (dataType.kind) {
            case "promise":
                return dataType.result
                    ? {
                          kind: "promise",
                          result: this.markStoredObjectReferences(
                              dataType.result,
                          ),
                      }
                    : dataType;
            case "product":
                return {
                    kind: "product",
                    elements: dataType.elements.map((element) =>
                        this.markStoredObjectReferences(element),
                    ),
                };
            case "union":
                return {
                    kind: "union",
                    members: dataType.members.map((member) =>
                        this.markStoredObjectReferences(member),
                    ),
                };
            case "struct":
                if (
                    !this.referenceStructNames.has(dataType.name) &&
                    this.emittedNamedTypes.has(dataType.name)
                ) {
                    const demand = this.nativeRecordSources.get(dataType.name);
                    if (demand) throw new NativeRecordStorageRequired(demand);
                }
                this.referenceStructNames.add(dataType.name);
                return dataType;
            case "optional": {
                const inner = this.markStoredObjectReferences(dataType.inner);
                return inner.kind === "struct" &&
                    this.isReferenceStruct(inner.name)
                    ? inner
                    : { ...dataType, inner };
            }
            case "tagged":
                return {
                    kind: "tagged",
                    inner: this.markStoredObjectReferences(dataType.inner),
                };
            case "vector":
            case "span": {
                const element = this.markStoredObjectReferences(
                    dataType.element,
                );
                return {
                    kind: "vector",
                    element,
                };
            }
            case "enummap":
                return {
                    ...dataType,
                    element: this.markStoredObjectReferences(dataType.element),
                };
            case "iterator":
            case "arguments":
            case "set":
                return {
                    ...dataType,
                    element: this.markStoredObjectReferences(dataType.element),
                };
            case "map":
                return {
                    ...dataType,
                    key: this.markStoredObjectReferences(dataType.key),
                    value: this.markStoredObjectReferences(dataType.value),
                };
            default:
                return dataType;
        }
    }

    /** Engine table slots are identities only together with their owning engine. */
    public collectionKeyStorage(type: DataType, source?: ts.Type): DataType {
        if (source && type.kind !== "json" && type.kind !== "tagged") {
            const absent = nullability(this.resolveTypeParameter(source));
            if (absent.null && absent.undefined)
                return {
                    kind: "tagged",
                    inner: this.engineOwnedStorage(type),
                };
        }
        return this.engineOwnedStorage(type);
    }

    /** Resource slots retain their actual engine across storage boundaries. */
    public engineOwnedStorage(type: DataType): DataType {
        switch (type.kind) {
            case "handle":
                return isEngineScopedHandleKind(type.handle)
                    ? { ...type, ownedEngine: true }
                    : type;
            case "optional":
            case "tagged":
                return {
                    ...type,
                    inner: this.engineOwnedStorage(type.inner),
                };
            case "union":
                return {
                    ...type,
                    members: type.members.map((member) =>
                        this.engineOwnedStorage(member),
                    ),
                };
            default:
                return type;
        }
    }

    public requiresEngineParameterStorage(
        declaration: ts.ParameterDeclaration,
    ): boolean {
        return this.storage.engineOwners.has(declaration);
    }

    public requireEngineParameterStorage(
        declaration: ts.ParameterDeclaration | undefined,
    ): void {
        if (declaration && !this.requiresEngineParameterStorage(declaration))
            throw new EngineOwnerStorageRequired(declaration);
    }

    public requireEngineFieldStorage(
        field: DataStructField,
        node: ts.Node,
    ): void {
        if (dataTypesEqual(field.type, this.collectionKeyStorage(field.type)))
            return;
        for (const declaration of field.declarations ?? [])
            if (
                isEngineOwnerStorageDeclaration(declaration) &&
                !this.storage.engineOwners.has(declaration)
            )
                throw new EngineOwnerStorageRequired(declaration);
        this.fail(
            node,
            `Resource field '${field.sourceName}' requires represented engine owner storage.`,
        );
    }

    private engineFieldStorage(
        type: DataType,
        declarations: readonly ts.Declaration[] | undefined,
    ): DataType {
        return declarations?.some((declaration) =>
            this.storage.engineOwners.has(declaration),
        )
            ? this.collectionKeyStorage(type)
            : type;
    }

    /** Resolve ownership demands before any earlier initializer or alias is emitted. */
    public predeclareOwnedRecord(demand: NativeRecordStorageDemand): void {
        this.withRecordDemand(demand, () => {
            const type = this.withClassDemand(demand.stored === true, () =>
                this.fromTsType(demand.type, demand.node),
            );
            if (
                type?.kind === "map" &&
                type.dictionary &&
                (demand.documentDictionary
                    ? type.value.kind === "json"
                    : demand.dictionary)
            )
                return;
            if (demand.native && isNativeStructuralView(type)) return;
            // Another demand in this joined component may already require a document.
            if (
                type?.kind === "json" &&
                this.documentRecords.has(this.structIdentity(demand.type))
            )
                return;
            if (type?.kind !== "struct")
                this.fail(
                    demand.node,
                    "Demanded record no longer has a native object representation.",
                );
            this.markStoredObjectReferences(type);
        });
    }

    /** Map in the generic frames and storage mode a record was demanded in. */
    private withRecordDemand<T>(
        demand: NativeRecordStorageDemand,
        work: () => T,
    ): T {
        const apply = (index: number): T => {
            if (index < demand.frames.length) {
                return this.withTypeArguments(demand.frames[index], () =>
                    apply(index + 1),
                );
            }
            return work();
        };
        return this.withDynamicJsonTypes(
            demand.dynamicJsonStorage === true,
            () => apply(0),
        );
    }

    /** Map a checker type and retain its source for a later ownership demand. */
    public fromTsType(type: ts.Type, node: ts.Node): DataType | undefined {
        if (
            this.recordComponents.size &&
            (type.flags & RECORD_TYPE_FLAGS) !== 0
        ) {
            // A record of a component holding a union takes the union's layout.
            const layout = this.layoutUnion(type, node);
            if (
                layout &&
                layout !== type &&
                !this.resolvingLayouts.has(layout)
            ) {
                this.resolvingLayouts.add(layout);
                try {
                    const held = this.fromTsType(layout, node);
                    if (held?.kind === "struct")
                        this.requireUnionHolds(held, type, node);
                    return held;
                } finally {
                    this.resolvingLayouts.delete(layout);
                }
            }
        }
        const mapped = this.mapTsType(type, node);
        if (
            mapped?.kind === "struct" &&
            !this.nativeRecordSources.has(mapped.name)
        ) {
            this.nativeRecordSources.set(
                mapped.name,
                this.recordDemand(type, node),
            );
        }
        return mapped;
    }

    /**
     * A demand for records of `type` met at `node`, in the generic
     * environment and mapping mode lowering is in.
     */
    private recordDemand(
        type: ts.Type,
        node: ts.Node,
    ): NativeRecordStorageDemand {
        const instantiation = this.instantiatedRecordOf(type);
        return {
            identity: this.structIdentity(type),
            ...(instantiation ? { instantiation } : {}),
            type,
            node,
            frames: this.typeArgumentFrames().map((frame) => new Map(frame)),
            ...(this.classDemanded ? { stored: true as const } : {}),
            ...(this.dynamicJsonStorage
                ? { dynamicJsonStorage: true as const }
                : {}),
        };
    }

    /**
     * A record the program may still reach, stored as another record type.
     * JavaScript keeps one object under both types. A native copy is kept
     * only where nothing in the program can tell it from that object
     * (`recordCopyObservation`): records read out of a shared array
     * (`sharedArray`) never are, except for a call lending a copy to a
     * callee that only reads it (`lentForCall`); a copy handed to a call as
     * `argument` needs only the call's writes. The `stored` expression's own
     * and contextual types name the two records. Otherwise the two types join
     * one record component (`record-components.ts`) through a storage
     * replay, after which both map to one struct and no conversion is left;
     * types no one layout holds (`layoutsCompatible`; a union's layout,
     * `requireUnionHolds`), or still separate after their join, refuse,
     * naming the types.
     */
    public storeRecordAs(
        sourceType: DataType<"struct">,
        targetType: DataType<"struct">,
        node: ts.Node,
        observation: RecordObservationContext,
        {
            sharedArray = false,
            lentForCall = false,
            argument,
            stored,
        }: {
            sharedArray?: boolean;
            lentForCall?: boolean;
            argument?: ts.Node | undefined;
            stored?: ts.Expression | undefined;
        } = {},
    ): void {
        // The stored expression's own and contextual types name the stored
        // records (`storedRecordSource`).
        const expression =
            stored ??
            (argument && ts.isExpression(argument) ? argument : undefined);
        const source = this.storedRecordSource(
            sourceType,
            expression && this.checker.getTypeAtLocation(expression),
            expression,
        );
        const target = this.storedRecordSource(
            targetType,
            expression && this.checker.getContextualType(expression),
            expression,
        );
        const sourceFields = this.structFields(
            sourceType.name,
            node,
            "accessors",
        );
        const targetFields = this.structFields(
            targetType.name,
            node,
            "accessors",
        );
        // A nullable record type stores the records of its present type.
        const sourceRecord =
            source && this.checker.getNonNullableType(source.type);
        const targetRecord =
            target && this.checker.getNonNullableType(target.type);
        const union = targetRecord?.isUnion() === true;
        // A union view of a stored record always shares its layout.
        const observed =
            !source || !target
                ? "its record types have no checked source"
                : sharedArray
                  ? "the array holding them is one shared array"
                  : union && this.isReferenceStruct(sourceType.name)
                    ? "a union view shares its arm's storage"
                    : recordCopyObservation(
                          observation,
                          source.type,
                          target.type,
                          targetFields.map((field) => field.sourceName),
                          sourceFields.some(
                              (field) =>
                                  !targetFields.some(
                                      (candidate) =>
                                          candidate.sourceName ===
                                          field.sourceName,
                                  ),
                          ),
                          argument,
                      );
        // A copy lent to a callee that only reads it lives for the call.
        if (observed === undefined || lentForCall) return;
        this.requireSharedValueViews(sourceType, targetType);
        const sourceByName = new Map(
            sourceFields.map((field) => [field.sourceName, field]),
        );
        const callableFields = targetFields.flatMap((target) => {
            const source = sourceByName.get(target.sourceName);
            return source ? [{ source: source.type, target: target.type }] : [];
        });
        if (this.joinCallableRecordTypes(callableFields)) return;
        // A record type a generic call's instantiation does not reach is
        // one type under every instantiation.
        const joinable = (
            demand: NativeRecordStorageDemand,
            record: ts.Type,
        ): boolean =>
            this.joinableRecord(demand, record) &&
            !this.isClassStruct(
                demand === source ? sourceType.name : targetType.name,
            );
        // Each generic endpoint names its own instantiation in force.
        const instantiation = (
            demand: NativeRecordStorageDemand | undefined,
            record: ts.Type | undefined,
            name: string,
        ): InstantiatedRecord | undefined =>
            demand &&
            record &&
            !joinable(demand, record) &&
            (isPlainRecord(this.checker, record) ||
                isRecordUnion(this.checker, record)) &&
            !this.isClassStruct(name)
                ? this.withRecordDemand(demand, () =>
                      this.instantiatedRecordOf(record),
                  )
                : undefined;
        const sourceInstantiation = instantiation(
            source,
            sourceRecord,
            sourceType.name,
        );
        const targetInstantiation = instantiation(
            target,
            targetRecord,
            targetType.name,
        );
        const kind: RecordJoin["kind"] = sharedArray
            ? "element"
            : ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
              ? "assertion"
              : "value";
        // A join an earlier replay demanded that left the two apart refuses.
        const demanded =
            sourceRecord &&
            this.demandedJoins
                .get(sourceRecord)
                ?.some(
                    (join) =>
                        join.target === targetRecord &&
                        join.sourceInstantiation === sourceInstantiation &&
                        join.targetInstantiation === targetInstantiation &&
                        join.kind === kind,
                );
        const sourceComponent =
            sourceRecord &&
            this.recordComponents.get(
                sourceInstantiation ??
                    recordIdentity(this.checker, sourceRecord),
            );
        const targetComponent =
            targetRecord &&
            this.recordComponents.get(
                targetInstantiation ??
                    recordIdentity(this.checker, targetRecord),
            );
        if (
            source &&
            target &&
            sourceRecord &&
            targetRecord &&
            !demanded &&
            (sourceInstantiation || joinable(source, sourceRecord)) &&
            (targetInstantiation || joinable(target, targetRecord)) &&
            (!sourceComponent || sourceComponent !== targetComponent)
        ) {
            // A record stored as a union, or a union's record stored as
            // another record type, keeps its fields in the union's layout
            // (or in one the union shares with it); two unions, or two
            // records, take one layout of all their shapes.
            const sourceUnion = sourceRecord.isUnion();
            if (union !== sourceUnion)
                this.requireUnionHolds(
                    union ? targetType : sourceType,
                    union ? sourceRecord : targetRecord,
                    node,
                    true,
                );
            // Every property any arm declares takes one storage in the
            // joined layout, including those the union's own fields omit.
            if (
                sourceInstantiation || targetInstantiation
                    ? union !== sourceUnion ||
                      this.structLayoutsCompatible(sourceFields, targetFields)
                    : layoutsCompatible(
                          this.checker,
                          sourceRecord,
                          targetRecord,
                      )
            ) {
                this.requireJoin({
                    ...source,
                    type: sourceRecord,
                    joins: [
                        {
                            source: sourceRecord,
                            target: targetRecord,
                            ...(sourceInstantiation
                                ? { sourceInstantiation }
                                : {}),
                            ...(targetInstantiation
                                ? { targetInstantiation }
                                : {}),
                            kind,
                        },
                    ],
                });
                return;
            }
        }
        return this.fail(
            node,
            `A '${source ? this.checker.typeToString(source.type) : sourceType.name}' record stored as '${target ? this.checker.typeToString(target.type) : targetType.name}' would be a copy of the one object JavaScript keeps, and ${observed}; no shared layout holds both record types.`,
        );
    }

    /** Shared records and arrays retain nested records through one dictionary or document view. */
    public requireSharedValueViews(source: DataType, target: DataType): void {
        const seen = new Set<string>();
        const compare = (a: DataType, b: DataType): void => {
            const left = fieldStorage(a),
                right = fieldStorage(b);
            const key = `${this.typeKey(left)}:${this.typeKey(right)}`;
            if (seen.has(key) || dataTypesEqual(left, right)) return;
            seen.add(key);
            const project = (record: DataType, view: DataType): void => {
                if (record.kind !== "struct") return;
                const demand =
                    view.kind === "map" &&
                    view.dictionary &&
                    view.key.kind === "string"
                        ? this.dictionaryRecordDemand(record.name, view.value)
                        : view.kind === "json"
                          ? this.documentRecordDemand(record.name)
                          : undefined;
                if (demand) throw new NativeRecordStorageRequired(demand);
            };
            project(left, right);
            project(right, left);
            if (
                (left.kind === "vector" || left.kind === "span") &&
                (right.kind === "vector" || right.kind === "span")
            )
                compare(left.element, right.element);
            if (left.kind === "struct" && right.kind === "struct")
                fields(
                    this.structsByName.get(left.name)?.fields ?? [],
                    this.structsByName.get(right.name)?.fields ?? [],
                );
        };
        const fields = (
            left: readonly DataStructField[],
            right: readonly DataStructField[],
        ): void => {
            const sources = new Map(
                left.map((field) => [field.sourceName, field]),
            );
            for (const field of right) {
                const from = sources.get(field.sourceName);
                if (from) compare(from.type, field.type);
            }
        };
        compare(source, target);
    }

    /**
     * Whether one layout can store two structs' common fields, each in one
     * storage (`joinedStorage`; `?` and `| undefined` aside), records in
     * records of a component joined with them.
     */
    private structLayoutsCompatible(
        left: readonly DataStructField[],
        right: readonly DataStructField[],
    ): boolean {
        return right.every((field) => {
            const held = left.find(
                (candidate) => candidate.sourceName === field.sourceName,
            );
            if (!held) return true;
            const a = fieldStorage(held.type);
            const b = fieldStorage(field.type);
            return (
                (holdsRecordStorage(a) && holdsRecordStorage(b)) ||
                this.joinedStorage(a, b) !== undefined
            );
        });
    }

    /** Concrete callable slots share their record arguments before generic outer records are interned. */
    public joinCallableRecordTypes(
        pairs: readonly { source: DataType; target: DataType }[],
    ): boolean {
        const demands: NativeRecordStorageDemand[] = [];
        const held = (from: DataType, to: DataType): boolean => {
            if (dataTypesEqual(from, to)) return true;
            if (from.kind !== "struct" || to.kind !== "struct") return false;
            const source = this.nativeRecordSources.get(from.name);
            const target = this.nativeRecordSources.get(to.name);
            if (
                !source ||
                !target ||
                this.isClassStruct(from.name) ||
                this.isClassStruct(to.name)
            )
                return false;
            const sourceInstantiation = this.withRecordDemand(source, () =>
                this.instantiatedRecordOf(source.type),
            );
            const targetInstantiation = this.withRecordDemand(target, () =>
                this.instantiatedRecordOf(target.type),
            );
            const sourceComponent = this.recordComponents.get(
                sourceInstantiation ??
                    recordIdentity(this.checker, source.type),
            );
            const targetComponent = this.recordComponents.get(
                targetInstantiation ??
                    recordIdentity(this.checker, target.type),
            );
            if (
                (!sourceInstantiation &&
                    !this.joinableRecord(source, source.type)) ||
                (!targetInstantiation &&
                    !this.joinableRecord(target, target.type)) ||
                (sourceComponent && sourceComponent === targetComponent) ||
                !(sourceInstantiation || targetInstantiation
                    ? this.structLayoutsCompatible(
                          this.structFields(
                              from.name,
                              source.node,
                              "accessors",
                          ),
                          this.structFields(to.name, target.node, "accessors"),
                      )
                    : layoutsCompatible(this.checker, source.type, target.type))
            )
                return false;
            demands.push({
                ...source,
                joins: [
                    {
                        source: source.type,
                        target: target.type,
                        ...(sourceInstantiation ? { sourceInstantiation } : {}),
                        ...(targetInstantiation ? { targetInstantiation } : {}),
                        kind: "assertion",
                    },
                ],
            });
            return true;
        };
        for (const { source: a, target: b } of pairs) {
            if (dataTypesEqual(a, b)) continue;
            if (
                a.kind !== "function" ||
                b.kind !== "function" ||
                a.generic ||
                b.generic ||
                a.parameters.length !== b.parameters.length ||
                (a.result === undefined) !== (b.result === undefined) ||
                !dataTypesEqual(
                    {
                        ...a,
                        parameters: b.parameters,
                        ...(b.result ? { result: b.result } : {}),
                    },
                    b,
                )
            )
                return false;
            // The view's caller supplies arguments to the retained function;
            // the retained function supplies its result back through the view.
            if (
                !a.parameters.every((parameter, index) =>
                    held(b.parameters[index]!, parameter),
                ) ||
                (a.result && b.result && !held(a.result, b.result))
            )
                return false;
        }
        for (const demand of demands) this.requireJoin(demand);
        return demands.length > 0;
    }

    /**
     * Whether a record type can join a record component: a plain record or
     * a union of them that no generic instantiation in force reaches, so it
     * is one type under every instantiation.
     */
    private joinableRecord(
        demand: NativeRecordStorageDemand,
        record: ts.Type,
    ): boolean {
        return (
            (!demand.frames.length ||
                !this.withRecordDemand(demand, () =>
                    this.mentionsSubstitution(record),
                )) &&
            (isPlainRecord(this.checker, record) ||
                isRecordUnion(this.checker, record))
        );
    }

    /**
     * The checked source of a stored struct: `actual` -- the type the
     * stored expression has or is stored as -- when it maps to the struct
     * and can join a component, else the registered one (the first type
     * mapped to the struct, which records of another type with the same
     * layout share).
     */
    private storedRecordSource(
        dataType: DataType<"struct">,
        actual: ts.Type | undefined,
        node: ts.Expression | undefined,
    ): NativeRecordStorageDemand | undefined {
        const registered = this.nativeRecordSources.get(dataType.name);
        const record = actual && this.checker.getNonNullableType(actual);
        if (
            !record ||
            !node ||
            (registered &&
                this.checker.getNonNullableType(registered.type) === record)
        )
            return registered;
        const candidate = this.recordDemand(record, node);
        if (!this.joinableRecord(candidate, record)) return registered;
        const mapped = this.fromTsType(record, node);
        return mapped?.kind === "struct" && mapped.name === dataType.name
            ? candidate
            : registered;
    }

    /**
     * The one storage two record types sharing a layout store a property
     * in: the same storage, a string for a string and its literal tags, a
     * number array for a numeric tuple and a number array, an array for a
     * readonly view and an array of the same elements; undefined when no
     * one storage holds both.
     */
    private joinedStorage(
        left: DataType,
        right: DataType,
    ): DataType | undefined {
        if (dataTypesEqual(left, right)) return left;
        if (
            left.kind === "function" &&
            right.kind === "function" &&
            !left.generic &&
            !right.generic &&
            left.result &&
            right.result &&
            dataTypesEqual({ ...left, result: right.result }, right)
        ) {
            if (isTaggedStorageWidening(right.result, left.result)) return left;
            if (isTaggedStorageWidening(left.result, right.result))
                return right;
        }
        if (
            (left.kind === "string" || left.kind === "enum") &&
            (right.kind === "string" || right.kind === "enum")
        )
            return { kind: "string" };
        const array = (type: DataType): DataType | undefined =>
            type.kind === "vector" || type.kind === "span"
                ? type.element
                : type.kind === "tuple"
                  ? { kind: "number" }
                  : undefined;
        const leftElement = array(left);
        const rightElement = array(right);
        return leftElement &&
            rightElement &&
            dataTypesEqual(leftElement, rightElement) &&
            (left.kind !== "tuple" || right.kind !== "tuple")
            ? { kind: "vector", element: leftElement }
            : undefined;
    }

    /**
     * A record taking a union's layout keeps every field it declares, in
     * storage holding its own (`joinedStorage`; `?` and `| undefined`
     * aside). `beforeJoin`, a field the union's layout lacks is one the
     * joined layout adds (`layoutUnion`), and records a field holds are
     * joined with the union's (`record-components.ts`).
     */
    private requireUnionHolds(
        union: DataType<"struct">,
        member: ts.Type,
        node: ts.Node,
        beforeJoin = false,
    ): void {
        const fields = this.structFields(union.name, node, "accessors");
        for (const property of this.structProperties(member)) {
            const field = fields.find(
                (candidate) => candidate.sourceName === property.name,
            );
            if (!field && beforeJoin) continue;
            const declaration =
                property.valueDeclaration ?? property.declarations?.[0];
            const propertyType = this.checker.getTypeOfSymbolAtLocation(
                property,
                declaration ?? node,
            );
            // A stored function maps as a layout stores it; the joined
            // layout decides whether one storage holds both signatures.
            const callable = this.checker.getNonNullableType(propertyType);
            if (callable.getCallSignatures().length > 0 && beforeJoin) continue;
            // A property only null or undefined is the field's empty state.
            if (
                (field?.type.kind === "optional" ||
                    field?.type.kind === "undefined") &&
                presentMembers(propertyType).length === 0
            )
                continue;
            const own =
                field &&
                (callable.getCallSignatures().length > 0
                    ? this.fromFunctionType(callable, declaration ?? node)
                    : this.fromRecordFieldType(
                          propertyType,
                          declaration ?? node,
                          property,
                      ));
            const held = field && fieldStorage(field.type);
            const joined =
                held &&
                own &&
                this.joinedStorage(
                    fieldStorage(markIdentityFunctions(own)),
                    held,
                );
            if (
                held &&
                own &&
                beforeJoin &&
                holdsRecordStorage(held) &&
                holdsRecordStorage(fieldStorage(own))
            )
                continue;
            if (!held || !joined || !dataTypesEqual(joined, held))
                this.fail(
                    node,
                    `A retained record union requires one shared layout preserving its original fields and storage kinds: '${this.checker.typeToString(member)}' records stored as '${union.name}' would lose '${property.name}'.`,
                );
        }
    }

    /**
     * A spread copying a field the source's records may lack (its static
     * type can hold narrower records, `mayHoldNarrower`, or an asserted
     * literal lacks it) into a field its new object requires, or one the new
     * object's type does not store: the new object's type joins the source's
     * record component, so the copy holds the field as the source does.
     */
    public joinSpreadTarget(
        sourceType: DataType<"struct">,
        targetType: DataType<"struct">,
    ): void {
        const source = this.nativeRecordSources.get(sourceType.name);
        const target = this.nativeRecordSources.get(targetType.name);
        if (
            !source ||
            !target ||
            target.frames.length > 0 ||
            !isPlainRecord(this.checker, target.type) ||
            this.joined(source.type, target.type)
        )
            return;
        this.requireJoin({
            ...source,
            joins: [
                { source: source.type, target: target.type, kind: "spread" },
            ],
        });
    }

    /** Why records of the type a literal is checked against take another type's layout. */
    public sharedLayoutNote(node: ts.Node): string {
        if (!this.recordComponents.size || !ts.isExpression(node)) return "";
        const type =
            this.checker.getContextualType(node) ??
            this.checker.getTypeAtLocation(node);
        const component = this.recordComponentOf(type);
        return component
            ? ` '${this.checker.typeToString(type)}' records share the '${this.checker.typeToString(this.layoutUnion(type, node) ?? component.named)}' layout, since a record converted between their types stays one object.`
            : "";
    }

    /** A checked object can use its declared layout only when no source field is lost or widened. */
    public fromCheckedObjectInitializer(
        initializer: ts.Expression,
    ): DataType | undefined {
        while (ts.isParenthesizedExpression(initializer))
            initializer = initializer.expression;
        if (
            !ts.isSatisfiesExpression(initializer) ||
            !ts.isObjectLiteralExpression(
                unwrapExpression(initializer.expression),
            )
        )
            return undefined;
        const target = this.fromTsType(
            this.checker.getTypeFromTypeNode(initializer.type),
            initializer.type,
        );
        if (target?.kind !== "struct") return undefined;
        const properties = this.checker.getPropertiesOfType(
            this.checker.getTypeAtLocation(initializer.expression),
        );
        const fields = this.structFields(target.name, initializer);
        if (properties.length !== fields.length) return undefined;
        for (const field of fields) {
            const property = properties.find(
                ({ name }) => name === field.sourceName,
            );
            if (!property) return undefined;
            const node =
                property.valueDeclaration ??
                property.declarations?.[0] ??
                initializer;
            const actual = this.fromTsType(
                this.checker.getTypeOfSymbolAtLocation(property, node),
                node,
            );
            if (
                !actual ||
                !dataTypesEqual(markIdentityFunctions(actual), field.type)
            )
                return undefined;
        }
        return this.markStoredObjectReferences(target);
    }

    private mapTsType(type: ts.Type, node: ts.Node): DataType | undefined {
        const readonlyTarget =
            type.aliasSymbol?.name === "Readonly" &&
            declaredInDefaultLibrary(type.aliasSymbol)
                ? type.aliasTypeArguments?.[0]
                : undefined;
        if (
            readonlyTarget &&
            this.proxyRecords.has(this.structIdentity(readonlyTarget))
        )
            return this.fromTsType(readonlyTarget, node);
        const module = type.getSymbol()?.declarations?.find(ts.isSourceFile);
        if (module)
            return { kind: "module-namespace", module: module.fileName };
        if (!type.isUnion() || !isNullable(type)) {
            return this.fromNonNullableType(type, node);
        }
        const absent = { ...nullability(type) };
        // Flow narrowing distributes an unconstrained T into `T & undefined`
        // (or null). A concrete instantiation can make that arm impossible.
        for (const [kind, absence] of [
            ["null", this.checker.getNullType()],
            ["undefined", this.checker.getUndefinedType()],
            ["void", this.checker.getVoidType()],
        ] as const) {
            absent[kind] &&= type.types.some(
                (member) =>
                    nullability(member)[kind] &&
                    (!member.isIntersection() ||
                        member.types.every((part) => {
                            const concrete = this.resolveTypeParameter(part);
                            return (
                                concrete === part ||
                                this.checker.isTypeAssignableTo(
                                    absence,
                                    concrete,
                                )
                            );
                        })),
            );
        }
        // A lone member maps as itself, which also registers it as its own
        // record source; the checker's NonNullable<T> intersection would map
        // through the intersection arm of `fromNonNullableType` instead.
        // Beside several present members, `void` marks a result nobody is
        // meant to read, which names no storage.
        const present = presentMembers(type);
        const inner =
            present.length === 1
                ? this.fromTsType(present[0]!, node)
                : absent.void
                  ? undefined
                  : this.fromNonNullableType(
                        this.checker.getNonNullableType(type),
                        node,
                    );
        // One optional flag cannot distinguish the two JavaScript absence values.
        // Primitive dynamic storage carries both tags and keeps ordinary scalar sinks.
        if (
            inner &&
            absent.null &&
            absent.undefined &&
            ["number", "boolean", "string", "enum"].includes(inner.kind)
        )
            return { kind: "json" };
        return inner && (absent.null || absent.undefined || absent.void)
            ? this.nullableType(inner, !absent.null)
            : inner;
    }

    /** Nullable objects retain identity; callbacks also carry their own absent state. */
    public nullableType(inner: DataType, undefinedOnly = false): DataType {
        // A nullable object selects an existing identity. Inline optional
        // storage would copy its fields across parameters and coalescing.
        if (inner.kind === "struct")
            return this.markStoredObjectReferences(inner);
        return inner.kind === "optional" ||
            inner.kind === "tagged" ||
            inner.kind === "json" ||
            inner.kind === "function"
            ? inner
            : {
                  kind: "optional",
                  inner,
                  ...(undefinedOnly ? { undefinedOnly: true } : {}),
              };
    }

    /** The absent spelling of a nullable type: an empty optional, or the null reference of a shared object. */
    public absentValue(type: DataType): string {
        const cpp = this.cppType(type);
        const optional =
            type.kind === "optional" &&
            !(
                type.inner.kind === "struct" &&
                this.isReferenceStruct(type.inner.name)
            );
        return optional ? `${cpp}{std::nullopt}` : `${cpp}{}`;
    }

    /** `value` carried as the nullable `type`: wrapped for an optional, as itself for a shared object. */
    public presentValue(type: DataType, value: string): string {
        return type.kind === "optional"
            ? `${this.cppType(type)}{${value}}`
            : value;
    }

    /**
     * The test that the slot `cpp` of `type` holds a value rather than its
     * absent state (an empty optional, an undefined document, a null shared
     * object or function); undefined for storage with no absent state.
     */
    public slotPresentCpp(type: DataType, cpp: string): string | undefined {
        if (type.kind === "optional") return optionalPresentCpp(cpp);
        if (type.kind === "tagged") return `${cpp}.defined()`;
        if (type.kind === "json") return `!${cpp}.is_undefined()`;
        return type.kind === "function" ||
            (type.kind === "struct" && this.isReferenceStruct(type.name))
            ? `static_cast<bool>(${cpp})`
            : undefined;
    }

    public requireFromTsType(
        type: ts.Type,
        node: ts.Node,
        role: string,
    ): DataType {
        const mapped = this.fromTsType(type, node);
        if (!mapped) {
            this.fail(
                node,
                `${role} type '${this.checker.typeToString(type)}' is outside the supported native-data subset.`,
            );
        }
        return mapped;
    }

    /** A checked recursive boundary may retain a dynamic parsed value. Call sinks
     * still require JSON storage; this does not erase arbitrary native objects. */
    public dynamicJsonType(type: ts.Type): DataType<"json"> | undefined {
        const substituted = this.substituteTypeParameter(type);
        if (substituted) return this.dynamicJsonType(substituted);
        if ((type.flags & ts.TypeFlags.Unknown) !== 0) return { kind: "json" };
        if (
            (this.checker.getNonNullableType(type).flags &
                ts.TypeFlags.NonPrimitive) !==
            0
        )
            return { kind: "json" };
        const element = this.checker.isArrayType(type)
            ? this.checker.getIndexTypeOfType(type, ts.IndexKind.Number)
            : this.checker.getIndexTypeOfType(type, ts.IndexKind.String);
        return element && (element.flags & ts.TypeFlags.Unknown) !== 0
            ? { kind: "json" }
            : undefined;
    }

    @journaled private accessor dynamicJsonStorage = false;
    public get hasDynamicJsonStorage(): boolean {
        return this.dynamicJsonStorage;
    }

    public withDynamicJsonTypes<T>(enabled: boolean, work: () => T): T {
        const previous = this.dynamicJsonStorage;
        this.dynamicJsonStorage ||= enabled;
        try {
            return work();
        } finally {
            this.dynamicJsonStorage = previous;
        }
    }

    /**
     * `undefined`, `null` and an empty object literal: values a parsed
     * document holds, which have no typed storage of their own.
     */
    private holdsOnlyDynamicValues(type: ts.Type): boolean {
        return (type.isUnion() ? type.types : [type]).every(
            (member) =>
                (member.flags &
                    (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !==
                    0 ||
                ((member.flags & ts.TypeFlags.Object) !== 0 &&
                    ((member as ts.ObjectType).objectFlags &
                        ts.ObjectFlags.ObjectLiteral) !==
                        0 &&
                    this.isNonNullConstraint(member)),
        );
    }

    /** `{}` or `object`: the checker's spelling of a non-null constraint, which adds no members of its own. */
    private isNonNullConstraint(type: ts.Type): boolean {
        if ((type.flags & ts.TypeFlags.NonPrimitive) !== 0) return true;
        return (
            (type.flags & ts.TypeFlags.Object) !== 0 &&
            ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Anonymous) !==
                0 &&
            this.checker.getPropertiesOfType(type).length === 0 &&
            type.getCallSignatures().length === 0 &&
            type.getConstructSignatures().length === 0 &&
            this.checker.getIndexInfosOfType(type).length === 0
        );
    }

    /** Full property views keep the pinned owner's identity and storage. */
    private nativeHandleKind(
        type: ts.Type,
        seen?: Set<ts.Type>,
    ): HandleKind | undefined {
        const concrete = this.resolveTypeParameter(type);
        const direct = pinnedHandleKind(concrete);
        if (direct) return direct;
        const sources = concrete.isIntersection()
            ? concrete.types
            : (concrete.flags & ts.TypeFlags.Object) !== 0 &&
                ((concrete as ts.ObjectType).objectFlags &
                    ts.ObjectFlags.Mapped) !==
                    0
              ? (concrete.aliasTypeArguments ?? [])
              : [];
        if (sources.length === 0) return undefined;
        const visited = seen ?? new Set<ts.Type>();
        if (visited.has(concrete)) return undefined;
        visited.add(concrete);
        for (const source of sources) {
            const owner = this.resolveTypeParameter(source);
            const kind = this.nativeHandleKind(owner, visited);
            if (!kind) continue;
            const fields = this.checker.getPropertiesOfType(concrete);
            const owned = this.checker.getPropertiesOfType(owner);
            if (
                concrete.getCallSignatures().length ||
                concrete.getConstructSignatures().length ||
                this.checker.getIndexInfosOfType(concrete).length ||
                fields.length !== owned.length ||
                !fields.every((field) => {
                    const original = owner.getProperty(field.name);
                    return (
                        original !== undefined &&
                        (field.flags & ts.SymbolFlags.Optional) ===
                            (original.flags & ts.SymbolFlags.Optional) &&
                        this.checker.getTypeOfSymbol(field) ===
                            this.checker.getTypeOfSymbol(original)
                    );
                })
            )
                continue;
            return kind;
        }
        return undefined;
    }

    private fromNonNullableType(
        type: ts.Type,
        node: ts.Node,
    ): DataType | undefined {
        const substituted = this.substituteTypeParameter(type);
        if (substituted) {
            return this.fromTsType(substituted, node);
        }
        if (
            this.dynamicJsonStorage &&
            (type.flags & ts.TypeFlags.Unknown) !== 0
        )
            return { kind: "json" };
        if (
            (type.flags &
                (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) !==
            0
        ) {
            return numberType;
        }
        if (
            (type.flags &
                (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !==
            0
        ) {
            return booleanType;
        }
        if ((type.flags & ts.TypeFlags.StringLike) !== 0) {
            return { kind: "string" };
        }
        if ((type.flags & ts.TypeFlags.ESSymbolLike) !== 0)
            return { kind: "symbol" };
        if ((type.flags & ts.TypeFlags.BigIntLike) !== 0)
            return { kind: "bigint" };
        if ((type.flags & ts.TypeFlags.Union) !== 0) {
            const members = (type as ts.UnionType).types;
            if (
                members.length === 2 &&
                members.some(
                    (member) => member.flags === ts.TypeFlags.Number,
                ) &&
                members.some(
                    (member) => pinnedHandleKind(member) === "text-run",
                )
            )
                return { kind: "handle", handle: "text-run-ref" };
            return this.fromUnionType(type as ts.UnionType, node);
        }
        if ((type.flags & ts.TypeFlags.Intersection) !== 0) {
            const handle = this.nativeHandleKind(type);
            if (handle) return { kind: "handle", handle };
            // `S & {}` is NonNullable<S>, the checker's type for a parameter
            // narrowed past null: map `S` under the active substitution.
            const constrained = (type as ts.IntersectionType).types.filter(
                (member) => !this.isNonNullConstraint(member),
            );
            if (constrained.length === 1) {
                const concrete = this.resolveTypeParameter(constrained[0]!);
                if (
                    concrete !== constrained[0] &&
                    (concrete.flags & ts.TypeFlags.TypeParameter) === 0
                )
                    return this.fromTsType(
                        this.checker.getNonNullableType(concrete),
                        node,
                    );
                return this.fromTsType(constrained[0]!, node);
            }
            // A primitive intersected with object types (a branded
            // `string & { readonly brand: unique symbol }`) holds only
            // values of that primitive: the object members are phantom.
            const primitives = constrained.filter(
                (member) =>
                    (member.flags &
                        (ts.TypeFlags.StringLike |
                            ts.TypeFlags.NumberLike |
                            ts.TypeFlags.BooleanLike)) !==
                    0,
            );
            if (
                primitives.length === 1 &&
                constrained.every(
                    (member) =>
                        member === primitives[0] ||
                        (member.flags & ts.TypeFlags.Object) !== 0,
                )
            )
                return this.fromTsType(primitives[0]!, node);
            return (
                this.fromCallableRecordType(type, node) ??
                this.fromStructType(type, node)
            );
        }
        if ((type.flags & ts.TypeFlags.Object) === 0) {
            return undefined;
        }
        // These demands also precede the Record/index-signature shortcuts.
        const identity = this.structIdentity(type);
        if (this.documentRecords.has(identity)) return { kind: "json" };
        if (this.documentDictionaries.has(identity))
            return {
                kind: "map",
                dictionary: true,
                key: { kind: "string" },
                value: { kind: "json" },
            };
        const brand = this.brandStorage(type, node);
        if (brand) return brand;
        if (
            type.symbol &&
            ERROR_CONSTRUCTORS.has(type.symbol.name) &&
            declaredInDefaultLibrary(type.symbol)
        )
            return { kind: "error" };
        const libraryObject = LIBRARY_OBJECT_KINDS.find(
            ([name, library]) =>
                type.symbol?.name === name &&
                (library === "dom"
                    ? declaredInDomLibrary(type.symbol)
                    : declaredInDefaultLibrary(type.symbol)),
        );
        if (libraryObject) return { kind: libraryObject[2] };
        // A tagged template's frozen strings array; its `raw` array is
        // found from its identity (`bbl::js::template_raw`).
        if (
            type.symbol?.name === "TemplateStringsArray" &&
            declaredInDefaultLibrary(type.symbol)
        )
            return { kind: "vector", element: { kind: "string" } };
        const deferredObject =
            declaredInDomLibrary(type.symbol) &&
            DEFERRED_DOM_OBJECTS.find((name) => name === type.symbol.name);
        if (deferredObject)
            return { kind: "deferred-platform-object", name: deferredObject };
        if (
            type.symbol?.name === "ReadableStream" &&
            declaredInDomLibrary(type.symbol)
        ) {
            // Only byte streams have an owned deferred boundary. Unconstrained or
            // differently typed streams must not share their native identity.
            if (!isTypeReference(type)) return undefined;
            const arguments_ = this.checker.getTypeArguments(type);
            const chunk = arguments_[0];
            if (
                arguments_.length !== 1 ||
                !chunk ||
                (chunk.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !==
                    0 ||
                this.fromTsType(chunk, node)?.kind !== "u8array"
            )
                return undefined;
            return {
                kind: "deferred-platform-object",
                name: "ReadableByteStream",
            };
        }
        if (declaredIn(type.symbol, "dom", "webgpu")) {
            if (type.symbol?.name === "GPUAdapterInfo")
                return { kind: "gpu-adapter-info" };
            if (type.symbol?.name === "GPU") return { kind: "gpu" };
            if (type.symbol?.name === "GPUAdapter")
                return { kind: "gpu-adapter" };
        }
        // Every name below is the library's own type only when the library
        // declares it: a program's `interface DataView` is its own record.
        const library = declaredInDefaultLibrary(type.symbol);
        // A SharedArrayBuffer is the same storage branded shared.
        if (
            library &&
            (type.symbol.name === "ArrayBuffer" ||
                type.symbol.name === "SharedArrayBuffer")
        ) {
            return { kind: "arraybuffer" };
        }
        if (library && type.symbol.name === "DataView") {
            return { kind: "dataview" };
        }
        if (
            type.symbol?.name === "ArrayBufferView" &&
            declaredInDefaultLibrary(type.symbol)
        ) {
            return { kind: "bufferview" };
        }
        const platformHandle = platformHandleKind(type);
        if (
            ["EventTarget", "Window", "Document"].includes(
                type.symbol?.name ?? "",
            ) &&
            declaredInDomLibrary(type.symbol)
        )
            return { kind: "event-target" };
        if (platformHandle) return { kind: "handle", handle: platformHandle };
        const borrowedEvent = borrowedPlatformEventKind(type.symbol);
        if (borrowedEvent) {
            return {
                kind: "borrowed-platform-event",
                event: borrowedEvent,
            };
        }
        if (
            library &&
            (type.symbol.name === "RegExpExecArray" ||
                type.symbol.name === "RegExpMatchArray")
        ) {
            return {
                kind: "vector",
                element: { kind: "string" },
            };
        }
        // Web Audio buffers are opaque context-owned resources. They are safe
        // to retain in ordinary JS containers (sound caches are the common
        // case), but their PCM storage stays behind the audio PAL.
        const audioHandle = domAudioHandleKind(type);
        if (audioHandle) return { kind: "handle", handle: audioHandle };
        if (
            isPinnedType(type, [
                "CsgSolid",
                "Csg2Solid",
                "Font",
                "AnimationManager",
                "NodeParticleSet",
                "RenderTask",
                "MaterialPlugin",
                "SpriteRenderer",
            ])
        ) {
            // These interfaces carry compiler-owned identity, not plain-data
            // storage: audio context/buses, geometry, font, animation or particle plans.
            return undefined;
        }
        if (
            type.symbol &&
            (isDomElementType(type.symbol) || isDomTextType(type.symbol))
        ) {
            return { kind: "handle", handle: "ui-element" };
        }
        if (
            type.symbol?.name === "OffscreenCanvas" &&
            declaredInDomLibrary(type.symbol)
        ) {
            return { kind: "handle", handle: "offscreen-canvas" };
        }
        if (
            type.symbol?.name === "MutationObserver" &&
            declaredInDomLibrary(type.symbol)
        ) {
            return { kind: "handle", handle: "worker-mutation-observer" };
        }
        if (
            type.symbol?.name === "MediaQueryList" &&
            declaredInDomLibrary(type.symbol)
        ) {
            return { kind: "handle", handle: "worker-media-query" };
        }
        if (
            type.symbol &&
            (type.symbol.declarations ?? []).some(ts.isClassLike)
        ) {
            if (declaredIn(type.symbol, "babylon")) {
                return undefined;
            }
            // Reached local classes keep their methods and identity in the
            // class lowerer. Treating their public fields as an anonymous
            // struct would erase both at a parameter or field boundary, so a
            // class only takes a runtime representation where a native data
            // position demands one.
            return this.fromLocalClassType(type, node);
        }
        const recordMap = this.fromRecordType(type, node);
        if (recordMap) {
            return recordMap;
        }
        const typedArray = library
            ? TYPED_ARRAY_KINDS.get(type.symbol.name)
            : undefined;
        if (typedArray) {
            return { kind: typedArray };
        }
        if (isPinnedType(type, ["Mat4"])) {
            // The reached native matrix producers own F32 storage. Keep the pin's
            // opaque, numerically indexed interface through parameters and returns;
            // ordinary data sinks still refuse incompatible F64 producers.
            return { kind: "f32array" };
        }
        const pinnedHandle = this.nativeHandleKind(type);
        if (pinnedHandle) return { kind: "handle", handle: pinnedHandle };
        if (
            type.symbol &&
            declaredIn(type.symbol, "babylon") &&
            isSceneGraphNode(type)
        ) {
            // A pinned scene-graph entity outside the handle table (Camera's
            // subtypes) is an engine value the compiler models by kind, not plain
            // data; its `children: SceneNode[]` member must not turn it into a
            // struct now that SceneNode itself has a handle.
            return undefined;
        }
        const objectType = type as ts.ObjectType;
        if ((objectType.objectFlags & ts.ObjectFlags.Reference) !== 0) {
            const reference = type as ts.TypeReference;
            const target = reference.target;
            if (library && type.symbol.name === "Promise") {
                const [argument] = this.checker.getTypeArguments(reference);
                if (!argument) return undefined;
                const resolvedType = this.resolveTypeParameter(argument);
                if (this.asynchronous) {
                    if (
                        (resolvedType.flags &
                            (ts.TypeFlags.Void |
                                ts.TypeFlags.Undefined |
                                ts.TypeFlags.Never)) !==
                        0
                    )
                        return { kind: "promise" };
                    const result = this.fromPromiseResultType(
                        resolvedType,
                        node,
                    );
                    return result
                        ? {
                              kind: "promise",
                              result: this.markStoredObjectReferences(result),
                          }
                        : undefined;
                }
                // Reached async work executes synchronously in the native lowering.
                // A promise retained in a data container therefore stores its
                // resolved value, preserving cache/get/set behavior without adding a
                // second scheduler or a host Promise object.
                return (resolvedType.flags & ts.TypeFlags.Void) !== 0
                    ? { kind: "boolean" }
                    : this.fromTsType(resolvedType, node);
            }
            if ((target.objectFlags & ts.ObjectFlags.Tuple) !== 0) {
                return this.fromTupleType(reference, node);
            }
            const symbolName = library ? type.symbol.name : undefined;
            // Iterable describes a protocol, not a record with a callable iterator
            // field. Reached helpers specialize to their actual collection storage.
            if (symbolName === "Iterable") return undefined;
            if (
                symbolName &&
                [
                    "MapIterator",
                    "SetIterator",
                    "IterableIterator",
                    "IteratorObject",
                    "Iterator",
                    "Generator",
                    "AsyncGenerator",
                    "AsyncIterableIterator",
                    "AsyncIterator",
                ].includes(symbolName)
            ) {
                const [elementType] = this.checker.getTypeArguments(reference);
                const element = elementType
                    ? this.fromStoredTsType(elementType, node)
                    : undefined;
                return element
                    ? {
                          kind: "iterator",
                          element,
                          ...(symbolName === "SetIterator" ||
                          symbolName === "MapIterator"
                              ? { traced: true }
                              : {}),
                          ...(symbolName.startsWith("Async")
                              ? { asynchronous: true }
                              : {}),
                      }
                    : undefined;
            }
            if (symbolName === "ArrayLike") {
                const [elementType] = this.checker.getTypeArguments(reference);
                if (!elementType) return undefined;
                const element = this.fromStoredTsType(elementType, node);
                return element ? { kind: "span", element } : undefined;
            }
            if (symbolName === "Array" || symbolName === "ReadonlyArray") {
                const [elementType] = this.checker.getTypeArguments(reference);
                if (!elementType) {
                    return undefined;
                }
                if ((elementType.flags & ts.TypeFlags.Unknown) !== 0) {
                    const finite = this.finiteArrayType(node);
                    if (finite) return finite;
                }
                const mapped = this.fromStoredTsType(elementType, node);
                if (!mapped) {
                    return undefined;
                }
                const element = this.arrayElementStorage(mapped);
                // Replacing an element and mutating the object stored in an
                // element are separate permissions: even ReadonlyArray keeps
                // object identity for its values. Functions carry identity too,
                // because indexOf/includes compare the stored function object.
                const storedElement = markIdentityFunctions(
                    this.markStoredObjectReferences(element),
                );
                return symbolName === "Array"
                    ? { kind: "vector", element: storedElement }
                    : { kind: "span", element: storedElement };
            }
            // Erased object and DOM keys carry native weak identity tokens.
            // Other concrete weak collections retain the Map/Set adaptation.
            if (
                symbolName === "Map" ||
                symbolName === "ReadonlyMap" ||
                symbolName === "WeakMap"
            ) {
                const [keyType, valueType] =
                    this.checker.getTypeArguments(reference);
                if (!keyType || !valueType) return undefined;
                const key = this.fromStoredTsType(keyType, node);
                const value: DataType | undefined =
                    symbolName === "WeakMap" &&
                    (valueType.flags & ts.TypeFlags.NonPrimitive) !== 0
                        ? { kind: "json" }
                        : this.fromStoredTsType(valueType, node);
                if (
                    symbolName === "WeakMap" &&
                    value &&
                    ((keyType.flags & ts.TypeFlags.NonPrimitive) !== 0 ||
                        key?.kind === "event-target")
                )
                    return {
                        kind: "map",
                        weak: true,
                        key: { kind: "weak-key" },
                        value: this.markStoredObjectReferences(value),
                    };
                if (!key || !value) return undefined;
                return {
                    kind: "map",
                    key: markIdentityFunctions(
                        this.collectionKeyStorage(
                            this.markStoredObjectReferences(key),
                            keyType,
                        ),
                    ),
                    value: this.markStoredObjectReferences(value),
                };
            }
            if (symbolName === "WeakRef") {
                const [targetType] = this.checker.getTypeArguments(reference);
                if (!targetType) return undefined;
                const target = this.fromStoredTsType(targetType, node);
                return target
                    ? {
                          kind: "weak-ref",
                          target: this.markStoredObjectReferences(target),
                      }
                    : undefined;
            }
            if (
                symbolName === "Set" ||
                symbolName === "ReadonlySet" ||
                symbolName === "WeakSet"
            ) {
                const [elementType] = this.checker.getTypeArguments(reference);
                if (!elementType) return undefined;
                const element = this.fromStoredTsType(elementType, node);
                if (
                    symbolName === "WeakSet" &&
                    element?.kind === "borrowed-platform-event"
                )
                    return {
                        kind: "set",
                        weak: true,
                        element: {
                            kind: "handle",
                            handle: "dom-event-identity",
                        },
                    };
                return element
                    ? {
                          kind: "set",
                          ...(symbolName === "WeakSet"
                              ? { weak: true as const }
                              : {}),
                          element: markIdentityFunctions(
                              this.collectionKeyStorage(
                                  this.markStoredObjectReferences(element),
                                  elementType,
                              ),
                          ),
                      }
                    : undefined;
            }
        }
        // After the symbol-named lookups above, which cost less than an index
        // signature query and never describe a dictionary.
        const dictionary = this.fromIndexSignatureType(type, node);
        // An open index signature is not a closed record of its named fields.
        // Leave an unrepresented entry type on the source-specialized path.
        if (dictionary !== undefined) return dictionary ?? undefined;
        const callable = this.fromCallableRecordType(type, node);
        if (callable) return callable;
        const functionType = this.fromFunctionType(type, node);
        if (functionType) return functionType;
        if (type.getConstructSignatures().length > 0) {
            return undefined;
        }
        return this.fromStructType(type, node);
    }

    /** @unjournaled Scoped recursion guard, emptied by finally after each query. */
    private readonly finiteArraysInProgress = new Set<ts.Node>();

    /** Unknown arrays acquire only layouts proven by their source writes. */
    private finiteArrayType(node: ts.Node): DataType<"vector"> | undefined {
        const sources = this.arraySources;
        const writes = sources?.elements(node);
        if (
            !sources ||
            !writes?.length ||
            this.finiteArraysInProgress.has(node)
        )
            return undefined;
        this.finiteArraysInProgress.add(node);
        try {
            const elements: DataType[] = [];
            const mapped = (
                expression: ts.Expression,
            ): DataType | undefined => {
                const spread = ts.isSpreadElement(expression);
                const value = spread ? expression.expression : expression;
                const source = this.checker.getTypeAtLocation(value);
                const type = spread
                    ? this.checker.getIndexTypeOfType(
                          source,
                          ts.IndexKind.Number,
                      )
                    : source;
                return type
                    ? this.fromStoredTsType(
                          this.checker.getBaseTypeOfLiteralType(type),
                          value,
                      )
                    : undefined;
            };
            for (const write of writes) {
                const calls = sources.argumentsCalls(write);
                if (calls !== undefined) {
                    if (!calls.length) return undefined;
                    for (const call of calls) {
                        const lanes = call.arguments.map(mapped);
                        if (lanes.some((lane) => !lane)) return undefined;
                        const concrete = lanes.filter(
                            (lane): lane is DataType => lane !== undefined,
                        );
                        elements.push({
                            kind: "arguments",
                            element: this.ownedArrayType(concrete).element,
                        });
                    }
                } else {
                    const element = mapped(write);
                    if (!element) return undefined;
                    elements.push(element);
                }
            }
            return this.ownedArrayType(elements);
        } finally {
            this.finiteArraysInProgress.delete(node);
        }
    }

    /** Stored callbacks retain record arguments; ArrayLike parameters remain borrowed views. */
    private ownFunctionRecord(type: DataType): DataType {
        switch (type.kind) {
            case "struct":
                return this.markStoredObjectReferences(type);
            case "optional": {
                const inner = this.ownFunctionRecord(type.inner);
                return inner.kind === "struct" ? inner : { ...type, inner };
            }
            case "tagged":
                return { ...type, inner: this.ownFunctionRecord(type.inner) };
            case "union":
                return {
                    ...type,
                    members: type.members.map((member) =>
                        this.ownFunctionRecord(member),
                    ),
                };
            default:
                return type;
        }
    }

    /** Require proof at the source contract so replay checks every producer. */
    public requireFunctionCompletion(
        type: DataType<"function">,
        proof: CompletionProof,
    ): void {
        if (!type.signatureSite) return;
        const known = this.storage.completions.get(type.signatureSite);
        if (known !== "undefined" && known !== proof)
            throw new CompletionStorageRequired(type.signatureSite, proof);
    }

    public connectFunctionCompletion(
        from: DataType<"function">,
        to: DataType<"function">,
    ): void {
        const forward =
            from.signatureSite &&
            this.storage.completions.get(from.signatureSite);
        const backward =
            to.signatureSite && this.storage.completions.get(to.signatureSite);
        if (forward) this.requireFunctionCompletion(to, forward);
        if (backward) this.requireFunctionCompletion(from, backward);
    }

    private functionCompletion(
        signature: ts.Signature,
        declaration = signature.declaration,
    ): Pick<
        DataType<"function">,
        | "signatureSite"
        | "undefinedCompletion"
        | "awaitedUndefinedCompletion"
        | "nonThenableCompletion"
    > {
        const signatureSite = functionSignatureSite(signature);
        const demanded =
            signatureSite && this.storage.completions.get(signatureSite);
        const synchronous = hasUndefinedCompletion(this.checker, declaration);
        return {
            ...(signatureSite ? { signatureSite } : {}),
            ...(synchronous || demanded === "undefined"
                ? { undefinedCompletion: true as const }
                : {}),
            ...(synchronous ||
            demanded === "undefined" ||
            hasUndefinedCompletion(this.checker, declaration, true)
                ? { awaitedUndefinedCompletion: true as const }
                : {}),
            ...(synchronous ||
            (hasNoValueCompletion(
                this.checker.getReturnTypeOfSignature(signature),
            ) &&
                hasNonThenableCompletion(this.checker, declaration)) ||
            demanded
                ? { nonThenableCompletion: true as const }
                : {}),
        };
    }

    /** A stored JavaScript function with a fully native data signature. */
    private fromFunctionType(
        type: ts.Type,
        node: ts.Node,
        storedClassField = false,
        parameterOverrides?: readonly (ts.Type | undefined)[],
        resultOverride?: ts.Signature,
        restArguments?: readonly ts.Type[],
    ): DataType | undefined {
        const signatures = type.getCallSignatures();
        if (signatures.length !== 1) return undefined;
        const signature = signatures[0]!;
        for (const origin of [node, signature.declaration]) {
            let owner: ts.Node | undefined = origin;
            while (owner && !ts.isSourceFile(owner)) {
                if (
                    !storedClassField &&
                    ts.isPropertyDeclaration(owner) &&
                    ts.isClassLike(owner.parent) &&
                    this.checker.getTypeAtLocation(owner).getCallSignatures()
                        .length > 0
                ) {
                    // Class callback fields use the class lowerer's method-like binding,
                    // including `this`; they are not ordinary stored struct slots.
                    return undefined;
                }
                owner = owner.parent;
            }
        }
        if (
            signature.typeParameters?.some(
                (parameter) => !this.substituteTypeParameter(parameter),
            ) ||
            (!parameterOverrides &&
                signature
                    .getParameters()
                    .some(
                        (parameter) =>
                            (this.checker.getTypeOfSymbol(parameter).flags &
                                ts.TypeFlags.Unknown) !==
                                0 || this.isUnknownRestParameter(parameter),
                    ))
        ) {
            const generic = this.classDemanded
                ? this.fromGenericFunction(signature, node)
                : undefined;
            return (
                generic && {
                    ...generic,
                    ...this.functionCompletion(signature),
                }
            );
        }
        const erasedParameters: number[] = [];
        const optionalParameters: number[] = [];
        let restParameter: number | undefined;
        const parameters = signature
            .getParameters()
            .flatMap((parameter, index) => {
                const declaration =
                    parameter.valueDeclaration ?? parameter.declarations?.[0];
                const declaredType = this.checker.getTypeOfSymbolAtLocation(
                    parameter,
                    declaration ?? node,
                );
                const override = parameterOverrides?.[index];
                const declaredCallable =
                    this.checker.getNonNullableType(declaredType);
                const declaredSignature =
                    declaredCallable.getCallSignatures()[0];
                const actualSignature = override
                    ? this.checker
                          .getNonNullableType(override)
                          .getCallSignatures()[0]
                    : undefined;
                const parameterType =
                    declaredCallable.getCallSignatures().length &&
                    !actualSignature
                        ? declaredType
                        : (override ?? declaredType);
                if (
                    (parameterType.flags &
                        (ts.TypeFlags.Never | ts.TypeFlags.Void)) !==
                    0
                ) {
                    erasedParameters.push(index);
                    return [];
                }
                // A default initializer makes its parameter optional to callers; the
                // function's own body supplies the default for an absent argument.
                const defaulted =
                    declaration !== undefined &&
                    ts.isParameter(declaration) &&
                    declaration.initializer !== undefined &&
                    !nullability(declaredType).undefined;
                if (nullability(declaredType).undefined || defaulted)
                    optionalParameters.push(index - erasedParameters.length);
                const mapped =
                    restArguments && this.isUnknownRestParameter(parameter)
                        ? this.storedRestArray(
                              restArguments,
                              declaration ?? node,
                          )
                        : actualSignature &&
                            declaredCallable.getCallSignatures().length === 1
                          ? this.fromFunctionType(
                                declaredCallable,
                                declaration ?? node,
                                false,
                                undefined,
                                (this.checker.getReturnTypeOfSignature(
                                    actualSignature,
                                ).flags &
                                    ts.TypeFlags.Never) !==
                                    0 &&
                                    declaredSignature &&
                                    (this.checker.getReturnTypeOfSignature(
                                        declaredSignature,
                                    ).flags &
                                        ts.TypeFlags.Void) !==
                                        0
                                    ? undefined
                                    : actualSignature,
                            )
                          : ((this.dynamicJsonStorage
                                ? this.dynamicJsonType(parameterType)
                                : undefined) ??
                            this.fromStoredTsType(
                                parameterType,
                                declaration ?? node,
                            ) ??
                            // An `unknown` parameter passed `undefined`, `null`
                            // or `{}`, values without storage of their own,
                            // holds them as the dynamic value it can be.
                            (override &&
                            (declaredType.flags & ts.TypeFlags.Unknown) !== 0 &&
                            this.holdsOnlyDynamicValues(override)
                                ? { kind: "json" as const }
                                : undefined));
                if (
                    declaration &&
                    ts.isParameter(declaration) &&
                    declaration.dotDotDotToken
                ) {
                    if (mapped?.kind !== "vector") return [undefined];
                    restParameter = index - erasedParameters.length;
                }
                // A function passed through another stored function remains the same
                // JavaScript function object. Carry its identity across that native
                // call boundary so an eventual Array/Map/Set comparison can observe it.
                if (!mapped) return [undefined];
                const owned = markIdentityFunctions(
                    this.ownFunctionRecord(
                        this.ownReadonlyArray(mapped, parameterType),
                    ),
                );
                const retained =
                    declaration &&
                    ts.isParameter(declaration) &&
                    this.requiresEngineParameterStorage(declaration)
                        ? this.collectionKeyStorage(owned)
                        : owned;
                return [
                    this.absenceTaggedStorage(
                        declaration,
                        defaulted
                            ? this.nullableType(retained, true)
                            : retained,
                    ),
                ];
            });
        if (parameters.some((parameter) => parameter === undefined)) {
            return undefined;
        }
        const signatureResult = this.resolveTypeParameter(
            this.checker.getReturnTypeOfSignature(resultOverride ?? signature),
        );
        const resultType =
            this.asynchronous && !hasNoValueCompletion(signatureResult)
                ? signatureResult
                : nativeReturnTsType(
                      this.checker,
                      signatureResult,
                      signature.declaration,
                  );
        const mappedResult = resultType
            ? ((this.dynamicJsonStorage
                  ? this.dynamicJsonType(resultType)
                  : undefined) ??
              this.fromStoredTsType(resultType, node) ??
              // A concrete null result uses the same payload as a required
              // null-only record field; it is still a returned value.
              ((resultType.flags & ts.TypeFlags.Null) !== 0
                  ? { kind: "null" as const }
                  : undefined))
            : undefined;
        const returnedAbsence = resultType && nullability(resultType);
        const result = mappedResult
            ? returnedAbsence?.null &&
              returnedAbsence.undefined &&
              mappedResult.kind !== "tagged" &&
              mappedResult.kind !== "json" &&
              this.slotPresentCpp(mappedResult, "slot") !== undefined
                ? {
                      kind: "tagged" as const,
                      inner: this.ownReturnedArray(mappedResult),
                  }
                : this.ownReturnedArray(mappedResult)
            : undefined;
        if (resultType && !result) {
            return undefined;
        }
        const mapped: DataType<"function"> = {
            kind: "function",
            ...this.functionCompletion(
                signature,
                (resultOverride ?? signature).declaration,
            ),
            ...(restParameter === undefined ? {} : { restParameter }),
            parameters: (parameters as DataType[]).map((parameter) =>
                this.returnsArray(result)
                    ? this.ownReturnedArray(parameter)
                    : parameter,
            ),
            ...(result ? { result } : {}),
            ...(erasedParameters.length > 0 ? { erasedParameters } : {}),
            ...(optionalParameters.length > 0 ? { optionalParameters } : {}),
        };
        // Parameter declarations connect a stored signature to the body's
        // demands for nullish tags or a resource's engine owner.
        const sites = signature
            .getParameters()
            .filter((_, index) => !erasedParameters.includes(index))
            .map((parameter, index) => {
                const declaration =
                    parameter.valueDeclaration ?? parameter.declarations?.[0];
                if (!declaration || !ts.isParameter(declaration)) return "";
                const absent = nullability(
                    this.checker.getTypeOfSymbolAtLocation(
                        parameter,
                        declaration,
                    ),
                );
                const stored = parameters[index]!;
                if (
                    (!absent.null ||
                        (!absent.undefined && !declaration.initializer)) &&
                    dataTypesEqual(stored, this.collectionKeyStorage(stored))
                )
                    return "";
                const site = `${declaration.getSourceFile().fileName}:${declaration.pos}`;
                this.parameterSites.set(site, declaration);
                return site;
            });
        return sites.some((site) => site !== "")
            ? { ...mapped, parameterSites: sites }
            : mapped;
    }

    /**
     * @unjournaled Declarations are program facts; the sites function types
     * name them by survive every replay.
     */
    private readonly parameterSites = new Map<
        string,
        ts.ParameterDeclaration
    >();

    /**
     * The source parameter declaration behind native parameter `index` of a
     * signature this registry mapped (`parameterSites`).
     */
    public signatureParameterDeclaration(
        type: DataType<"function">,
        index: number,
    ): ts.ParameterDeclaration | undefined {
        const site = type.parameterSites?.[index];
        return site ? this.parameterSites.get(site) : undefined;
    }

    private fromGenericFunction(
        signature: ts.Signature,
        node: ts.Node,
    ): DataType<"function"> | undefined {
        const declaration = signature.declaration;
        if (!declaration || ts.isJSDocSignature(declaration)) return undefined;
        const family = this.storage.genericFunctions.family(
            this.checker,
            signature,
            this.typeArgumentFrames(),
        );
        const existing = this.genericFunctionNames.get(family);
        if (existing)
            return { kind: "function", parameters: [], generic: existing };
        const name = this.uniqueName(
            `GenericFunction${++this.anonymousStructIndex}`,
            this.structNames,
        );
        this.genericFunctionNames.set(family, name);
        this.referenceStructNames.add(name);
        const fields: GenericFunctionField[] = [];
        this.genericFunctions.set(name, {
            family,
            signature,
            declaration,
            fields,
        });
        for (const demand of this.storage.genericFunctions.get(family)) {
            const type = this.withGenericFunctionArguments(
                declaration,
                demand,
                () =>
                    // An optional method's declared type also admits undefined.
                    this.fromFunctionType(
                        this.checker.getNonNullableType(
                            this.checker.getTypeAtLocation(declaration),
                        ),
                        node,
                        false,
                        demand.parameters,
                        undefined,
                        demand.restArguments,
                    ),
            );
            if (type?.kind !== "function" || type.generic)
                this.fail(
                    node,
                    "Stored generic function instantiation requires a fully represented native signature.",
                );
            fields.push({
                name: `call_${fields.length}`,
                type: { ...type, identity: true },
                demand,
            });
        }
        this.registerStructDefinition(`generic:${family}`, {
            name,
            fields: fields.map((field) => ({
                sourceName: field.name,
                name: field.name,
                type: field.type,
            })),
        });
        return { kind: "function", parameters: [], generic: name };
    }

    public genericFunctionFields(
        name: string,
    ): readonly GenericFunctionField[] {
        return this.genericFunctions.get(name)!.fields;
    }

    private isUnknownRestParameter(parameter: ts.Symbol): boolean {
        const declaration =
            parameter.valueDeclaration ?? parameter.declarations?.[0];
        if (
            !declaration ||
            !ts.isParameter(declaration) ||
            !declaration.dotDotDotToken
        )
            return false;
        const element = this.checker.getIndexTypeOfType(
            this.checker.getTypeOfSymbol(parameter),
            ts.IndexKind.Number,
        );
        return (
            element !== undefined &&
            (element.flags & ts.TypeFlags.Unknown) !== 0
        );
    }

    /** Pack reached rest arguments with ordinary owned array storage. */
    private storedRestArray(
        arguments_: readonly ts.Type[],
        node: ts.Node,
    ): DataType | undefined {
        const elements: DataType[] = [];
        for (const argument of arguments_) {
            const element = this.fromStoredTsType(argument, node);
            if (!element) return undefined;
            elements.push(markIdentityFunctions(element));
        }
        return this.ownedArrayType(elements);
    }

    /** Concrete value lanes share the existing tuple union and object ownership rules. */
    public ownedArrayType(elements: DataType[]): DataType<"vector"> {
        if (!elements.length)
            return { kind: "vector", element: { kind: "undefined" } };
        const storage = this.tupleStorage(elements);
        return storage.kind === "tuple"
            ? { kind: "vector", element: { kind: "number" } }
            : storage;
    }

    /** Bind an implementation's parameters by position, independent of its interface's symbols. */
    public withGenericFunctionArguments<T>(
        declaration: ts.SignatureDeclaration,
        demand: GenericFunctionDemand,
        work: () => T,
    ): T {
        const arguments_ = new Map<ts.Symbol, ts.Type>();
        declaration.typeParameters?.forEach((parameter, index) => {
            const argument = demand.arguments[index];
            if (argument)
                arguments_.set(
                    this.checker.getTypeAtLocation(parameter).symbol,
                    argument,
                );
        });
        const frames = [...demand.frames, arguments_];
        const apply = (index: number): T =>
            index === frames.length
                ? work()
                : this.withTypeArguments(frames[index], () => apply(index + 1));
        const previous = this.genericFunctionAncestors;
        this.genericFunctionAncestors = [...demand.ancestors, demand.family];
        try {
            return this.withDynamicJsonTypes(
                demand.dynamicJsonStorage === true,
                () => apply(0),
            );
        } finally {
            this.genericFunctionAncestors = previous;
        }
    }

    /**
     * The stored signature a call of generic function storage reaches.
     * `holdsError` says whether an argument names a binding whose value is
     * a native Error, which instantiates an `unknown` parameter with the
     * library Error type.
     */
    public genericFunctionCall(
        name: string,
        call: ts.CallExpression,
        holdsError: (argument: ts.Identifier) => boolean,
    ): { name: string; type: DataType<"function"> } {
        const generic = this.genericFunctions.get(name)!;
        const declaration = generic.declaration;
        const substitution = callTypeArguments(
            this.checker,
            call,
            declaration,
            this.fail,
        );
        const arguments_ = (generic.signature.typeParameters ?? []).map(
            (parameter) => {
                return this.resolveTypeParameter(
                    substitution!.get(parameter.symbol)!,
                );
            },
        );
        const parameters = generic.signature
            .getParameters()
            .map((parameter, index) => {
                const declared = this.checker.getTypeOfSymbol(parameter);
                if (
                    this.dynamicJsonStorage &&
                    (declared.flags & ts.TypeFlags.Unknown) !== 0
                )
                    return declared;
                if (
                    (declared.flags & ts.TypeFlags.Unknown) === 0 &&
                    !this.checker
                        .getNonNullableType(declared)
                        .getCallSignatures().length
                )
                    return undefined;
                const argument = call.arguments[index];
                if (!argument) {
                    if ((declared.flags & ts.TypeFlags.Unknown) !== 0)
                        this.fail(
                            call,
                            "Stored unknown parameters require a represented argument.",
                        );
                    return undefined;
                }
                return (
                    this.caughtErrorType(argument, holdsError) ??
                    this.storage.genericFunctions.expressionType(
                        this.checker,
                        argument,
                    )
                );
            });
        const restIndex = generic.signature
            .getParameters()
            .findIndex((parameter) => this.isUnknownRestParameter(parameter));
        const restArguments =
            restIndex < 0
                ? undefined
                : [
                      ...new Set(
                          call.arguments.slice(restIndex).map((argument) => {
                              const type =
                                  this.storage.genericFunctions.expressionType(
                                      this.checker,
                                      ts.isSpreadElement(argument)
                                          ? argument.expression
                                          : argument,
                                  );
                              const element = ts.isSpreadElement(argument)
                                  ? this.checker.getIndexTypeOfType(
                                        type,
                                        ts.IndexKind.Number,
                                    )
                                  : type;
                              if (!element)
                                  this.fail(
                                      argument,
                                      "Stored rest spread requires an array with represented elements.",
                                  );
                              return this.checker.getBaseTypeOfLiteralType(
                                  element,
                              );
                          }),
                      ),
                  ];
        const dynamicJsonStorage =
            this.dynamicJsonStorage ||
            parameters.some(
                (parameter, index) =>
                    parameter !== undefined &&
                    (this.checker.getTypeOfSymbol(
                        generic.signature.getParameters()[index]!,
                    ).flags &
                        ts.TypeFlags.Unknown) !==
                        0 &&
                    this.dynamicJsonType(parameter) !== undefined,
            );
        if (dynamicJsonStorage)
            generic.signature.getParameters().forEach((parameter, index) => {
                const declared = this.checker.getTypeOfSymbol(parameter);
                if ((declared.flags & ts.TypeFlags.Unknown) !== 0)
                    parameters[index] = declared;
            });
        const demand: GenericFunctionDemand = {
            family: generic.family,
            ...(dynamicJsonStorage ? { dynamicJsonStorage: true } : {}),
            arguments: arguments_,
            parameters,
            ...(restArguments ? { restArguments } : {}),
            frames: this.typeArgumentFrames(),
            ancestors: this.genericFunctionAncestors,
            site: call,
        };
        return this.representedGenericFunctionField(generic, demand);
    }

    /**
     * The signature of a stored generic function an operation calls with
     * values it supplies (a promise rejection handed to `catch(handler)`):
     * each unknown or callable parameter takes its value's type, as a
     * source call's argument types do. A generic signature with type
     * parameters has no types to infer here.
     */
    public genericFunctionValueCall(
        name: string,
        supplied: readonly (ts.Type | undefined)[],
        node: ts.Node,
    ): { name: string; type: DataType<"function"> } {
        const generic = this.genericFunctions.get(name)!;
        if (generic.signature.typeParameters?.length)
            this.fail(
                node,
                "Stored generic callbacks require a source call with concrete type arguments.",
            );
        const parameters = generic.signature
            .getParameters()
            .map((parameter, index) => {
                const declared = this.checker.getTypeOfSymbol(parameter);
                if (
                    (declared.flags & ts.TypeFlags.Unknown) === 0 &&
                    !this.checker
                        .getNonNullableType(declared)
                        .getCallSignatures().length
                )
                    return undefined;
                return (
                    supplied[index] ??
                    this.fail(
                        node,
                        "A stored generic callback requires a represented type for each value an operation supplies.",
                    )
                );
            });
        const demand: GenericFunctionDemand = {
            family: generic.family,
            arguments: [],
            parameters,
            frames: this.typeArgumentFrames(),
            ancestors: this.genericFunctionAncestors,
            site: node,
        };
        return this.representedGenericFunctionField(generic, demand);
    }

    /**
     * The field holding `demand`'s signature, or the storage demand that
     * replays emission with it. A site whose types change identity at every
     * replay would never reach a represented field, so it refuses instead.
     */
    private representedGenericFunctionField(
        generic: { family: string; fields: readonly GenericFunctionField[] },
        demand: GenericFunctionDemand,
    ): GenericFunctionField {
        const field = generic.fields.find((field) =>
            sameGenericFunctionSignature(field.demand, demand),
        );
        if (field) return field;
        if (
            divergentGenericFunctionDemand(
                this.checker,
                generic.fields.map((field) => field.demand),
                demand,
            )
        )
            this.fail(
                demand.site,
                "Stored generic function instantiation does not converge: this call's argument types change identity at every emission.",
            );
        if (this.genericFunctionAncestors.includes(generic.family))
            this.fail(
                demand.site,
                "Recursive stored generic functions require an already represented signature.",
            );
        throw new GenericFunctionStorageRequired(demand);
    }

    /** The checker type of a value an operation supplies, where its storage names one. */
    public suppliedValueType(value: Value, node: ts.Node): ts.Type | undefined {
        const kind = value.dataType?.kind ?? value.kind;
        if (kind === "number") return this.checker.getNumberType();
        if (kind === "string") return this.checker.getStringType();
        if (kind === "boolean") return this.checker.getBooleanType();
        if (kind !== "error") return undefined;
        const error = this.checker
            .getSymbolsInScope(node, ts.SymbolFlags.Interface)
            .find(
                (symbol) =>
                    symbol.name === "Error" && declaredInDefaultLibrary(symbol),
            );
        return error && this.checker.getDeclaredTypeOfSymbol(error);
    }

    /**
     * A binding typed `unknown` whose value is the native Error a `catch`
     * received (the catch binding, or a `const` it was copied to): an
     * argument naming one instantiates a stored function's parameter with
     * the library Error type.
     */
    private caughtErrorType(
        argument: ts.Expression,
        holdsError: (argument: ts.Identifier) => boolean,
    ): ts.Type | undefined {
        const name = unwrapExpression(argument);
        if (
            !ts.isIdentifier(name) ||
            (this.checker.getTypeAtLocation(name).flags &
                ts.TypeFlags.Unknown) ===
                0 ||
            !holdsError(name)
        )
            return undefined;
        const error = this.checker
            .getSymbolsInScope(name, ts.SymbolFlags.Interface)
            .find(
                (symbol) =>
                    symbol.name === "Error" && declaredInDefaultLibrary(symbol),
            );
        return error && this.checker.getDeclaredTypeOfSymbol(error);
    }

    private fromUnionType(
        type: ts.UnionType,
        node: ts.Node,
    ): DataType | undefined {
        // Record-union document demands precede their specialized native layouts.
        if (
            this.documentRecords.size !== 0 &&
            this.documentRecords.has(this.structIdentity(type))
        )
            return this.fromStructType(type, node);
        const members = type.types;
        const handles = members.map((member) => this.nativeHandleKind(member));
        if (handles.every((kind) => kind === "mesh" || kind === "scene-node"))
            return { kind: "handle", handle: "scene-node" };
        if (
            members.every(
                (member) =>
                    (member.flags &
                        (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) !==
                    0,
            )
        ) {
            return numberType;
        }
        if (
            members.every(
                (member) =>
                    (member.flags &
                        (ts.TypeFlags.Boolean |
                            ts.TypeFlags.BooleanLiteral)) !==
                    0,
            )
        ) {
            return booleanType;
        }
        if (
            members.every(
                (member) => (member.flags & ts.TypeFlags.StringLiteral) !== 0,
            )
        ) {
            return this.registerEnum(
                type,
                members.map((member) => (member as ts.StringLiteralType).value),
            );
        }
        const tuple = this.fromTupleUnion(type, node);
        if (tuple) return tuple;
        const signature = this.fromOneSignatureUnion(type, node);
        if (signature) return signature;
        const settled = this.fromValueOrPromiseUnion(type, node);
        if (settled) return settled;
        // Tuple alternatives with different lengths still share array storage.
        // Ask the checker for their indexed element union instead of treating
        // length and the array methods as fields of a common record.
        if (
            members.every(
                (member) =>
                    this.checker.isTupleType(member) ||
                    this.checker.isArrayType(member) ||
                    (declaredInDefaultLibrary(member.symbol) &&
                        member.symbol?.name === "ReadonlyArray"),
            )
        ) {
            if (this.arrayUnionsInProgress.has(type)) return undefined;
            this.arrayUnionsInProgress.add(type);
            try {
                const indexed = this.checker.getIndexTypeOfType(
                    type,
                    ts.IndexKind.Number,
                );
                const element = indexed && this.fromStoredTsType(indexed, node);
                return element
                    ? {
                          kind: "vector",
                          element: markIdentityFunctions(
                              this.markStoredObjectReferences(
                                  this.arrayElementStorage(element),
                              ),
                          ),
                      }
                    : undefined;
            } finally {
                this.arrayUnionsInProgress.delete(type);
            }
        }
        // Opaque handles and library binary classes retain their alternatives;
        // a common-field record would discard their owners and identities.
        if (
            handles.every((kind) => kind !== undefined) ||
            type.types.every(binaryLibraryClass)
        )
            return this.fromMixedUnion(type, node);
        // A record union whose component stores shapes its own layout does
        // not hold takes the component's layout (`layoutUnion`).
        if (this.recordComponentOf(type) && !this.layoutUnion(type, node))
            return this.fromStructType(type, node);
        // A tagged union whose arm field cannot map has no representation: the
        // common-field struct would hide that field and refuse at the literal
        // that spells it, far from the cause.
        const object = members.every(
            (member) => (member.flags & ts.TypeFlags.Object) !== 0,
        )
            ? this.mapRecursiveStruct(type, type.aliasSymbol?.name, (name) => {
                  const discriminated = this.fromDiscriminatedObjectUnion(
                      type,
                      node,
                      name,
                      this.armFieldUnions.has(this.structIdentity(type)),
                  );
                  return discriminated !== undefined
                      ? discriminated
                      : (this.fromCommonObjectUnion(type, node, name) ??
                            this.fromPropertyObjectUnion(type, node, name));
              })
            : undefined;
        if (object === null) return undefined;
        return object ?? this.fromMixedUnion(type, node);
    }

    /**
     * Plain functions of one native signature declared apart (`methods[key]`
     * over methods of one shape) are one function storage: every member
     * stores as that signature.
     */
    private fromOneSignatureUnion(
        type: ts.UnionType,
        node: ts.Node,
    ): DataType<"function"> | undefined {
        if (
            !type.types.every(
                (member) =>
                    member.getCallSignatures().length > 0 &&
                    this.checker.getPropertiesOfType(member).length === 0,
            )
        )
            return undefined;
        const [first, ...rest] = type.types.map((member) =>
            this.fromTsType(member, node),
        );
        return first?.kind === "function" &&
            rest.every(
                (member) =>
                    member?.kind === "function" &&
                    dataTypesEqual(member, first),
            )
            ? first
            : undefined;
    }

    /**
     * `T | Promise<T>` (a result that may settle later) holds either the
     * value or the promise, as one union of the two: awaiting it adopts the
     * promise arm or resolves the value arm. Where a promise is stored as
     * its value, both arms are that value.
     */
    private fromValueOrPromiseUnion(
        type: ts.UnionType,
        node: ts.Node,
    ): DataType | undefined {
        const promises = type.types.filter(
            (member): member is ts.TypeReference =>
                member.symbol?.name === "Promise" &&
                declaredInDefaultLibrary(member.symbol) &&
                isTypeReference(member),
        );
        const promise = promises[0];
        if (!promise || promises.length > 1) return undefined;
        const [argument] = this.checker.getTypeArguments(promise);
        if (!argument) return undefined;
        const settled = argument.isUnion() ? argument.types : [argument];
        const values = type.types.filter((member) => member !== promise);
        // Two spellings of one object literal type are distinct checker types.
        const same = (left: ts.Type, right: ts.Type): boolean =>
            left === right ||
            (this.checker.isTypeAssignableTo(left, right) &&
                this.checker.isTypeAssignableTo(right, left));
        if (
            values.length !== settled.length ||
            !values.every((member) =>
                settled.some((candidate) => same(member, candidate)),
            )
        )
            return undefined;
        const value = this.fromTsType(argument, node);
        const promised = this.fromTsType(promise, node);
        if (!value || !promised) return undefined;
        // Outside an asynchronous realm a promise is stored as its value.
        if (dataTypesEqual(promised, value)) return value;
        return promised.kind === "promise" &&
            promised.result &&
            dataTypesEqual(promised.result, value)
            ? { kind: "union", members: [value, promised] }
            : undefined;
    }

    private readonly arrayUnionsInProgress = new EmissionSet<ts.Type>();

    /** Fixed tuple alternatives share lanes where their stored representations agree. */
    private fromTupleUnion(
        type: ts.UnionType,
        node: ts.Node,
    ): DataType | undefined {
        if (!type.types.every((member) => this.checker.isTupleType(member)))
            return undefined;
        const tuples = type.types.map((member) => member as ts.TypeReference);
        if (
            tuples.some((tuple) =>
                (tuple.target as ts.TupleType).elementFlags.some(
                    (flag) =>
                        (flag &
                            (ts.ElementFlags.Optional |
                                ts.ElementFlags.Rest |
                                ts.ElementFlags.Variadic)) !==
                        0,
                ),
            )
        )
            return undefined;
        const lanes = tuples.map((tuple) =>
            this.checker.getTypeArguments(tuple),
        );
        if (
            !lanes[0]?.length ||
            lanes.some((lane) => lane.length !== lanes[0]!.length)
        )
            return undefined;
        const elements: DataType[] = [];
        for (let index = 0; index < lanes[0].length; index++) {
            const candidates = lanes.map((lane) =>
                this.fromStoredTsType(lane[index]!, node),
            );
            const first = candidates[0];
            if (!first) return undefined;
            if (
                candidates.every(
                    (candidate) =>
                        candidate && dataTypesEqual(candidate, first),
                )
            )
                elements.push(first);
            else if (
                candidates.every(
                    (candidate) =>
                        candidate?.kind === "string" ||
                        candidate?.kind === "enum",
                )
            )
                elements.push({ kind: "string" });
            else return undefined;
        }
        return this.tupleStorage(elements);
    }

    /** Mixed scalar/object alternatives retain their own representation and identity. */
    private readonly mixedUnionsInProgress = new EmissionSet<ts.Type>();

    private fromMixedUnion(
        type: ts.UnionType,
        node: ts.Node,
    ): DataType | undefined {
        if (
            !type.types.some(
                (member) =>
                    (member.flags &
                        (ts.TypeFlags.StringLike |
                            ts.TypeFlags.NumberLike |
                            ts.TypeFlags.BooleanLike)) !==
                    0,
            ) &&
            !type.types.every(binaryLibraryClass) &&
            !type.types.every(
                (member) => this.nativeHandleKind(member) !== undefined,
            )
        )
            return undefined;
        if (this.mixedUnionsInProgress.has(type)) return undefined;
        this.mixedUnionsInProgress.add(type);
        try {
            const members: DataType[] = [];
            for (const source of type.types) {
                const mapped =
                    (source.flags & ts.TypeFlags.StringLike) !== 0
                        ? { kind: "string" as const }
                        : this.fromTsType(source, node);
                if (!mapped) return undefined;
                const retained = this.markStoredObjectReferences(mapped);
                if (!members.some((member) => dataTypesEqual(member, retained)))
                    members.push(retained);
            }
            members.sort((left, right) =>
                this.typeKey(left).localeCompare(this.typeKey(right)),
            );
            return members.length === 1
                ? members[0]
                : { kind: "union", members };
        } finally {
            this.mixedUnionsInProgress.delete(type);
        }
    }

    /**
     * TypeScript exposes only the fields shared by a non-discriminated object
     * union. Store precisely that common structural view so an expression such
     * as `cities[0] ?? fallbackTile` does not force the fallback into the
     * richer City representation when both arms are subsequently used as
     * `{x, y}`.
     */
    private fromCommonObjectUnion(
        type: ts.UnionType,
        node: ts.Node,
        name: string,
    ): DataType | undefined {
        if (
            type.types.length < 2 ||
            type.types.some(
                (member) => (member.flags & ts.TypeFlags.Object) === 0,
            )
        ) {
            return undefined;
        }
        const propertiesByMember = type.types.map((member) =>
            this.checker.getPropertiesOfType(member),
        );
        const common = propertiesByMember[0]!.filter((property) =>
            propertiesByMember
                .slice(1)
                .every((properties) =>
                    properties.some(({ name }) => name === property.name),
                ),
        );
        if (common.length === 0) return undefined;

        const fields: DataStructField[] = [];
        const presences: FieldPresence[] = [];
        for (const property of common) {
            const memberProperties = propertiesByMember.map((properties) =>
                properties.find(({ name }) => name === property.name)!,
            );
            const memberTypes = memberProperties.map((memberProperty) =>
                this.checker.getTypeOfSymbolAtLocation(
                    memberProperty,
                    memberProperty.valueDeclaration ??
                        memberProperty.declarations?.[0] ??
                        node,
                ),
            );
            const candidates = memberTypes.map((memberType, index) =>
                this.fromRecordFieldType(
                    memberType,
                    node,
                    memberProperties[index],
                ),
            );
            let first = candidates[0];
            if (
                !first ||
                candidates.some(
                    (candidate) =>
                        !candidate ||
                        !dataTypesEqual(candidate, candidates[0]!),
                )
            ) {
                const shared = type.getProperty(property.name);
                first = shared
                    ? this.fromRecordFieldType(
                          this.checker.getTypeOfSymbolAtLocation(shared, node),
                          node,
                          shared,
                      )
                    : undefined;
                if (!first) return undefined;
            }
            const optional = memberProperties.some(
                (member) => (member.flags & ts.SymbolFlags.Optional) !== 0,
            );
            const stored = markIdentityFunctions(
                this.markStoredObjectReferences(first),
            );
            fields.push({
                sourceName: property.name,
                name: sanitizeIdentifier(property.name),
                type: stored,
                declarations: memberProperties.flatMap(
                    (member) => member.declarations ?? [],
                ),
                ...(optional ? { optionalProperty: true } : {}),
                ...(optional && stored.kind !== "optional"
                    ? { defaultWhenMissing: true }
                    : {}),
                ...(propertiesByMember.every((properties) =>
                    propertyIsReadOnly(
                        properties.find(({ name }) => name === property.name)!,
                    ),
                )
                    ? { readOnly: true }
                    : {}),
            });
            presences.push(
                fieldPresence(
                    unionPresence(memberProperties, memberTypes, first),
                    valueAbsence(memberTypes),
                ),
            );
        }

        return this.internMappedStruct(name, fields, presences);
    }

    /** Required, non-null payloads use their existing empty storage for an absent union key. */
    private fromPropertyObjectUnion(
        type: ts.UnionType,
        node: ts.Node,
        name: string,
    ): DataType | undefined {
        if (
            type.types.some(
                (member) =>
                    // Class instances retain their nominal owner; their fields
                    // alone cannot represent instanceof or private brands.
                    member.symbol?.declarations?.some(ts.isClassLike) ||
                    member.getCallSignatures().length > 0 ||
                    member.getConstructSignatures().length > 0 ||
                    this.checker.getIndexInfosOfType(member).length > 0,
            )
        )
            return undefined;
        const properties = type.types.map((member) =>
            this.checker.getPropertiesOfType(member),
        );
        if (properties.some((members) => members.length === 0))
            return undefined;
        const byName = new Map<string, ts.Symbol[]>();
        for (const members of properties) {
            for (const member of members) {
                const group = byName.get(member.name);
                if (group) group.push(member);
                else byName.set(member.name, [member]);
            }
        }
        const fields: DataStructField[] = [];
        const presences: FieldPresence[] = [];
        for (const [propertyName, members] of byName) {
            const memberTypes = members.map((member) =>
                this.checker.getTypeOfSymbolAtLocation(
                    member,
                    member.valueDeclaration ?? member.declarations?.[0] ?? node,
                ),
            );
            const absent = members.length < properties.length;
            // An empty payload cannot also stand for a present null/undefined key.
            if (
                absent &&
                (members.some(
                    (member) => (member.flags & ts.SymbolFlags.Optional) !== 0,
                ) ||
                    memberTypes.some((member) => {
                        const absence = nullability(member);
                        return (
                            absence.null || absence.undefined || absence.void
                        );
                    }))
            )
                return undefined;
            const mapped = memberTypes.map((member, index) =>
                this.fromRecordFieldType(member, node, members[index]),
            );
            const first = mapped[0];
            if (
                !first ||
                mapped.some(
                    (member) => !member || !dataTypesEqual(member, first),
                )
            )
                return undefined;
            const stored = markIdentityFunctions(
                this.markStoredObjectReferences(first),
            );
            const fieldType = absent ? this.nullableType(stored, true) : stored;
            fields.push({
                sourceName: propertyName,
                name: sanitizeIdentifier(propertyName),
                type: fieldType,
                declarations: members.flatMap(
                    (member) => member.declarations ?? [],
                ),
                ...(absent
                    ? { optionalProperty: true, defaultWhenMissing: true }
                    : {}),
                ...(!absent && members.every(propertyIsReadOnly)
                    ? { readOnly: true }
                    : {}),
            });
            presences.push(
                fieldPresence(
                    absent
                        ? "stored"
                        : unionPresence(members, memberTypes, first),
                    valueAbsence(memberTypes),
                ),
            );
        }
        return this.internMappedStruct(name, fields, presences);
    }

    /**
     * How literal tags tell a union's object arms apart: `distinguish(index,
     * others, exclude)` gives the tag alternatives, each a conjunction of
     * tag literals, selecting arm `index` among `others` (`exclude` names a
     * tag not to use); undefined when a tag tells no arm apart from another,
     * unless the union stores every member's fields (`armFields`): then the
     * arms no tag tells apart form one group, told apart by their fields.
     */
    private unionArmTags(
        type: ts.UnionType,
        node: ts.Node,
        armFields = false,
    ):
        | {
              readonly propertiesByMember: readonly (readonly ts.Symbol[])[];
              readonly distinguish: (
                  index: number,
                  others: number[],
                  exclude?: string,
              ) => DataStructField["presentForTags"];
              /** The group an arm shares with the arms no tag tells it apart from. */
              readonly root: (index: number) => number;
              /** The arms of `among` outside the group of arm `index`. */
              readonly outside: (
                  index: number,
                  among: readonly number[],
              ) => number[];
              /** Some arms share a group (`armFields` only). */
              readonly grouped: boolean;
          }
        | undefined {
        if (
            type.types.length < 2 ||
            type.types.some(
                (member) => (member.flags & ts.TypeFlags.Object) === 0,
            )
        ) {
            return undefined;
        }
        const propertiesByMember = type.types.map((member) =>
            this.checker.getPropertiesOfType(member),
        );
        const tags = propertiesByMember.map(
            (properties) =>
                new Map(
                    properties.flatMap((property) => {
                        const declaration =
                            property.valueDeclaration ??
                            property.declarations?.[0] ??
                            node;
                        const values = literalTagValues(
                            this.checker,
                            this.checker.getTypeOfSymbolAtLocation(
                                property,
                                declaration,
                            ),
                        );
                        return values === undefined
                            ? []
                            : [[property.name, values] as const];
                    }),
                ),
        );
        // Several tags may distinguish an arm: a boolean success flag can group
        // multiple failures, whose reason then selects the remaining payload.
        // An arm's tag may admit several literals; it distinguishes the arms
        // whose literals are disjoint from them. Single literals are preferred.
        const distinguish = (
            index: number,
            others: number[],
            exclude?: string,
        ):
            | Array<Array<{ discriminant: string; value: string }>>
            | undefined => {
            const conditions: Array<{
                discriminant: string;
                values: readonly string[];
            }> = [];
            let remaining = others;
            while (remaining.length > 0) {
                const candidates = [...tags[index]!]
                    .filter(([name]) => name !== exclude)
                    .map(([name, values]) => ({
                        discriminant: name,
                        values,
                        covered: remaining.filter((other) => {
                            const otherValues = tags[other]!.get(name);
                            return (
                                otherValues !== undefined &&
                                !otherValues.some((value) =>
                                    values.includes(value),
                                )
                            );
                        }),
                    }))
                    .filter((candidate) => candidate.covered.length > 0)
                    .sort(
                        (left, right) =>
                            Number(left.values.length > 1) -
                                Number(right.values.length > 1) ||
                            right.covered.length - left.covered.length,
                    );
                const selected = candidates[0];
                if (!selected) return undefined;
                conditions.push(selected);
                remaining = remaining.filter(
                    (other) => !selected.covered.includes(other),
                );
            }
            // Every combination of the selected tags' literals is one
            // alternative the arm may hold.
            return conditions.reduce<
                Array<Array<{ discriminant: string; value: string }>>
            >(
                (alternatives, { discriminant, values }) =>
                    alternatives.flatMap((alternative) =>
                        values.map((value) => [
                            ...alternative,
                            { discriminant, value },
                        ]),
                    ),
                [[]],
            );
        };
        const indices = type.types.map((_member, index) => index);
        // Arms no tag tells apart form one group. A union whose records hold
        // every member's fields (`armFields`) tells the members of a group
        // apart by the slots of the fields only some of them declare; other
        // unions need every arm told apart by its tags.
        const group = indices.map((index) => index);
        const root = (index: number): number =>
            group[index] === index ? index : root(group[index]!);
        for (const index of indices)
            for (const other of indices.slice(index + 1))
                if (
                    !distinguish(index, [other]) ||
                    !distinguish(other, [index])
                )
                    group[root(other)] = root(index);
        const outside = (index: number, among: readonly number[]): number[] =>
            among.filter((other) => root(other) !== root(index));
        const grouped = indices.some(
            (index) => outside(index, indices).length < indices.length - 1,
        );
        if (
            (grouped && !armFields) ||
            indices.some(
                (index) => !distinguish(index, outside(index, indices)),
            )
        )
            return undefined;
        return { propertiesByMember, distinguish, root, outside, grouped };
    }

    /**
     * A closed object union as one native struct: the tag is an enum and fields
     * which exist only in one arm receive an inert default in the other arms.
     * TypeScript's discriminant narrowing guarantees those inactive fields are
     * never observed by valid source code.
     */
    /** `null` when the union is tagged but an arm's field has no representation. */
    private fromDiscriminatedObjectUnion(
        type: ts.UnionType,
        node: ts.Node,
        name: string,
        armFields: boolean,
    ): DataType | undefined | null {
        const arms = this.unionArmTags(type, node, armFields);
        if (!arms) return undefined;
        const { propertiesByMember, distinguish, root, outside, grouped } =
            arms;
        const indices = type.types.map((_member, index) => index);
        const propertyNames: string[] = [];
        for (const properties of propertiesByMember) {
            for (const property of properties) {
                if (!propertyNames.includes(property.name)) {
                    propertyNames.push(property.name);
                }
            }
        }
        const fields: DataStructField[] = [];
        const presences: FieldPresence[] = [];
        for (const propertyName of propertyNames) {
            const memberProperties = propertiesByMember.flatMap(
                (properties) => {
                    const property = properties.find(
                        ({ name: candidate }) => candidate === propertyName,
                    );
                    return property ? [property] : [];
                },
            );
            const propertyTypes = propertiesByMember.flatMap((properties) => {
                const property = properties.find(
                    ({ name: candidate }) => candidate === propertyName,
                );
                if (!property) return [];
                const declaration =
                    property.valueDeclaration ?? property.declarations?.[0];
                return [
                    this.checker.getTypeOfSymbolAtLocation(
                        property,
                        declaration ?? node,
                    ),
                ];
            });
            const declaring = indices.filter((index) =>
                propertiesByMember[index]!.some(
                    (property) => property.name === propertyName,
                ),
            );
            const absent = indices.filter(
                (index) => !declaring.includes(index),
            );
            // A declaring arm's group mates lacking the field tell it apart
            // by its slot: an empty one is absent, so no declaring arm may
            // hold null there, nor a required arm undefined.
            const bySlot = declaring.some((index) =>
                absent.some((other) => root(other) === root(index)),
            );
            if (
                bySlot &&
                propertyTypes.some((propertyType, index) => {
                    const empty = nullability(propertyType);
                    return (
                        empty.null ||
                        ((memberProperties[index]!.flags &
                            ts.SymbolFlags.Optional) ===
                            0 &&
                            (empty.undefined || empty.void))
                    );
                })
            )
                return undefined;
            // The tags tell a declaring arm apart from the arms lacking the
            // field outside its group; an arm no tag restricts leaves the
            // slot alone to decide.
            const tagConditions = declaring.map((index) => {
                const conditions = distinguish(
                    index,
                    outside(index, absent),
                    propertyName,
                );
                if (!conditions)
                    throw new Error(
                        "A union field must be distinguished by another tag.",
                    );
                return conditions;
            });
            const presentForTags = tagConditions.some((alternatives) =>
                alternatives.some((alternative) => alternative.length === 0),
            )
                ? undefined
                : tagConditions.flat();
            let mapped: DataType | undefined;
            const literalStrings = propertyTypes.flatMap((propertyType) =>
                propertyType.isUnion() ? propertyType.types : [propertyType],
            );
            if (
                literalStrings.every(
                    (propertyType) =>
                        (propertyType.flags & ts.TypeFlags.StringLiteral) !== 0,
                )
            ) {
                // Arms told apart by their fields may share tag literals.
                mapped = this.registerEnum(type, [
                    ...new Set(
                        literalStrings.map(
                            (propertyType) =>
                                (propertyType as ts.StringLiteralType).value,
                        ),
                    ),
                ]);
            } else {
                const candidates = propertyTypes.map((propertyType, index) =>
                    this.fromRecordFieldType(
                        propertyType,
                        node,
                        memberProperties[index],
                    ),
                );
                const first = candidates[0];
                if (
                    !first ||
                    candidates.some(
                        (candidate) =>
                            !candidate || !dataTypesEqual(candidate, first),
                    )
                ) {
                    // A shared property may vary between arms, for example null in
                    // one record and a string in another. Ask the checker for that
                    // property's union instead of choosing one arm's representation.
                    const sharedProperty = type.getProperty(propertyName);
                    mapped = sharedProperty
                        ? this.fromRecordFieldType(
                              this.checker.getTypeOfSymbolAtLocation(
                                  sharedProperty,
                                  node,
                              ),
                              node,
                          )
                        : undefined;
                    // A field only some arms declare has no checker-wide
                    // property union. Its plain-record payloads can still
                    // share one layout, preserving each payload's identity.
                    if (
                        !mapped &&
                        armFields &&
                        first?.kind === "struct" &&
                        candidates.every(
                            (candidate) => candidate?.kind === "struct",
                        )
                    ) {
                        const records = propertyTypes.map((propertyType) =>
                            this.checker.getNonNullableType(propertyType),
                        );
                        const source = records[0]!;
                        const demand = this.recordDemand(source, node);
                        if (
                            records.every(
                                (record) =>
                                    this.joinableRecord(demand, record) &&
                                    layoutsCompatible(
                                        this.checker,
                                        source,
                                        record,
                                    ),
                            )
                        ) {
                            const joins = records
                                .slice(1)
                                .filter(
                                    (target) =>
                                        !this.joined(source, target) &&
                                        !this.demandedJoins
                                            .get(source)
                                            ?.some(
                                                (join) =>
                                                    join.target === target,
                                            ),
                                )
                                .map((target): RecordJoin => ({
                                    source,
                                    target,
                                    kind: "value",
                                }));
                            if (joins.length) {
                                this.requireJoin({ ...demand, joins });
                                // A planning attempt may finish with a copy;
                                // emission replays with the shared layout.
                                mapped = first;
                            }
                        }
                    }
                    // Grouped arms fall back to the members' common view.
                    if (!mapped) return grouped ? undefined : null;
                } else {
                    mapped = first;
                }
            }
            if (bySlot) mapped = this.nullableType(mapped, true);
            fields.push({
                sourceName: propertyName,
                name: sanitizeIdentifier(propertyName),
                declarations: memberProperties.flatMap(
                    (member) => member.declarations ?? [],
                ),
                type: markIdentityFunctions(
                    this.markStoredObjectReferences(mapped),
                ),
                ...(bySlot ||
                memberProperties.some(
                    (property) =>
                        (property.flags & ts.SymbolFlags.Optional) !== 0,
                )
                    ? {
                          optionalProperty: true,
                          ...(mapped.kind !== "optional"
                              ? { defaultWhenMissing: true }
                              : {}),
                      }
                    : {}),
                ...(memberProperties.length === type.types.length &&
                memberProperties.every(propertyIsReadOnly)
                    ? { readOnly: true }
                    : {}),
                ...(absent.length
                    ? {
                          defaultWhenMissing: true,
                          ...(presentForTags ? { presentForTags } : {}),
                      }
                    : {}),
            });
            // A field some arms lack is an own key by tag, which no
            // presence read decides; its presence within those arms is
            // kept apart for reads that test the tags. A field group mates
            // lack is own while its slot holds a value.
            const presence = bySlot
                ? storedPresence(fields.at(-1)!.type, false)
                : unionPresence(
                      memberProperties,
                      propertyTypes,
                      fields.at(-1)!.type,
                  );
            const tagged = presentForTags !== undefined;
            presences.push(
                fieldPresence(
                    tagged ? "ambiguous" : presence,
                    valueAbsence(propertyTypes),
                    tagged ? presence : undefined,
                ),
            );
        }
        return this.internMappedStruct(name, fields, presences);
    }

    private fromTupleType(
        reference: ts.TypeReference,
        node: ts.Node,
    ): DataType | undefined {
        if (
            (reference.target as ts.TupleType).elementFlags.some(
                (flag) =>
                    (flag &
                        (ts.ElementFlags.Rest | ts.ElementFlags.Variadic)) !==
                    0,
            )
        )
            return undefined;
        const elements = this.checker.getTypeArguments(reference);
        if (elements.length === 0) {
            return undefined;
        }
        // The shared element layout can represent fields such as null in one
        // arm even when that arm has no useful standalone record storage.
        if (
            elements.every(
                (element) =>
                    (this.resolveTypeParameter(element).flags &
                        ts.TypeFlags.Object) !==
                    0,
            )
        ) {
            const indexed = this.checker.getIndexTypeOfType(
                reference,
                ts.IndexKind.Number,
            );
            const element = indexed && this.fromTsType(indexed, node);
            if (element?.kind === "struct")
                return {
                    kind: "vector",
                    element: this.markStoredObjectReferences(element),
                };
        }
        const mapped = elements.map((element) =>
            this.fromStoredTsType(element, node),
        );
        if (mapped.some((element) => !element)) {
            return undefined;
        }
        const complete = mapped as DataType[];
        return this.tupleStorage(complete);
    }

    public tupleStorage(elements: DataType[]): DataType<"vector" | "tuple"> {
        if (
            elements.length > 0 &&
            elements.every(
                (element) =>
                    element.kind === "string" || element.kind === "enum",
            )
        )
            return { kind: "vector", element: { kind: "string" } };
        if (elements.every((element) => element.kind === "number")) {
            return {
                kind: "tuple",
                arity: elements.length,
            };
        }
        // Tuples share array identity. Heterogeneous lanes use a nullable union
        // so dynamic writes, resizing and missing elements use ordinary array
        // operations instead of separate fixed-product mutation paths.
        const first = elements[0]!;
        if (elements.every((element) => dataTypesEqual(element, first))) {
            return {
                kind: "vector",
                element: this.markStoredObjectReferences(first),
            };
        }
        const members: DataType[] = [];
        const append = (type: DataType): void => {
            if (type.kind === "optional" || type.kind === "tagged")
                append(type.inner);
            else if (type.kind === "union") type.members.forEach(append);
            else if (type.kind === "enum") append({ kind: "string" });
            else if (!members.some((member) => dataTypesEqual(member, type)))
                members.push(type);
        };
        elements
            .map((element) => this.markStoredObjectReferences(element))
            .forEach(append);
        // An erased lane already stores every primitive and both absent
        // values. Wrapping it in an optional union would lose those tags.
        if (members.some((member) => member.kind === "json"))
            return { kind: "vector", element: { kind: "json" } };
        const tagged = elements.some((type) => type.kind === "tagged");
        const undefinedOnly =
            !tagged &&
            elements.every(
                (element) =>
                    element.kind !== "optional" || element.undefinedOnly,
            )
                ? true
                : undefined;
        const element: DataType = {
            kind: "optional",
            ...(undefinedOnly ? { undefinedOnly } : {}),
            inner:
                members.length === 1 ? members[0]! : { kind: "union", members },
        };
        return {
            kind: "vector",
            element: tagged ? { kind: "tagged", inner: element } : element,
        };
    }

    private fromStructType(
        type: ts.Type,
        node: ts.Node,
        call?: DataType<"function">,
    ): DataType | undefined {
        const identity = this.structIdentity(type);
        const native = this.recordNativeViews.get(identity);
        if (native) {
            if (
                this.documentRecords.has(identity) ||
                this.recordDictionaries.has(identity)
            )
                this.fail(
                    node,
                    "A structural record has conflicting native object storage demands.",
                );
            return native;
        }
        if (this.documentRecords.has(identity)) return { kind: "json" };
        const dictionary = this.recordDictionaries.get(identity);
        if (dictionary)
            return {
                kind: "map",
                dictionary: true,
                key: { kind: "string" },
                value: { kind: dictionary },
            };
        const declaredName = (named: ts.Type): string | undefined =>
            named.aliasSymbol?.name ??
            (named.symbol &&
            named.symbol.name !== "__type" &&
            named.symbol.name !== "__object"
                ? named.symbol.name
                : undefined);
        // A record component's struct takes its widest member's name, and
        // stores the functions any named member declares.
        const component = this.recordComponentOf(type);
        const preferredName = declaredName(component?.named ?? type);
        const storesFunctions =
            preferredName !== undefined ||
            this.classDemanded ||
            component?.members.some(
                (member) => declaredName(member) !== undefined,
            ) === true;
        return (
            this.mapRecursiveStruct(type, preferredName, (name) =>
                this.fromStructTypeInner(
                    type,
                    node,
                    name,
                    storesFunctions,
                    call,
                ),
            ) ?? undefined
        );
    }

    /** Recursive fields resolve to one provisional identity; declined layouts leave no stored types. */
    private mapRecursiveStruct(
        type: ts.Type,
        preferredName: string | undefined,
        build: (name: string) => DataType | undefined | null,
    ): DataType | undefined | null {
        const identity = this.structIdentity(type);
        const completed = this.structTypesByIdentity.get(identity);
        if (completed) {
            return completed;
        }
        const activeName = this.structNamesInProgress.get(identity);
        if (activeName) {
            this.referenceStructNames.add(activeName);
            return { kind: "struct", name: activeName };
        }
        return new EmissionTransaction().run(
            () => {
                const name = this.uniqueName(
                    preferredName
                        ? sanitizeIdentifier(preferredName)
                        : `Record${++this.anonymousStructIndex}`,
                    this.structNames,
                );
                this.structNamesInProgress.set(identity, name);
                try {
                    const mapped = build(name);
                    if (mapped?.kind === "struct")
                        this.structTypesByIdentity.set(identity, mapped);
                    return mapped;
                } finally {
                    this.structNamesInProgress.delete(identity);
                }
            },
            (mapped) => mapped?.kind === "struct",
        );
    }

    /**
     * Runs `map` with a generic receiver's instantiation in force.
     *
     * Everything inlined under one `this` sees the same substitution, which
     * is what makes a generic class's method body resolve `P` the way the
     * construction site spelled it.
     */
    public setActiveTypeArguments(
        substitution: ReadonlyMap<ts.Symbol, ts.Type> | undefined,
    ): void {
        this.activeTypeArguments = substitution;
        this.activeTypeArgumentFrameKey = substitution
            ? this.frameKey(substitution)
            : undefined;
        this.refreshTypeArgumentKey();
    }

    /** Runs `work` with a generic call's instantiation in force above the receiver's. */
    public withTypeArguments<T>(
        substitution: ReadonlyMap<ts.Symbol, ts.Type> | undefined,
        work: () => T,
    ): T {
        if (!substitution) {
            return work();
        }
        this.callTypeArguments.push(substitution);
        this.callTypeArgumentKeys.push(this.frameKey(substitution));
        this.refreshTypeArgumentKey();
        try {
            return work();
        } finally {
            this.callTypeArguments.pop();
            this.callTypeArgumentKeys.pop();
            this.refreshTypeArgumentKey();
        }
    }

    /** Snapshot the lexical generic environment for a returned callable. */
    public captureTypeArguments(): ReadonlyMap<ts.Symbol, ts.Type> | undefined {
        const frames = this.typeArgumentFrames();
        if (frames.length === 0) return undefined;
        return new EmissionMap(frames.flatMap((frame) => [...frame]));
    }

    /** Every substitution in force, the receiver's beneath the calls'. */
    private typeArgumentFrames(): readonly ReadonlyMap<ts.Symbol, ts.Type>[] {
        return [
            ...(this.activeTypeArguments ? [this.activeTypeArguments] : []),
            ...this.callTypeArguments,
        ];
    }

    /** One frame's share of the struct-identity key, spelled once when the frame is pushed. */
    private frameKey(frame: ReadonlyMap<ts.Symbol, ts.Type>): string {
        return [...frame.values()]
            .map((argument) => this.checker.typeToString(argument))
            .join(",");
    }

    /** The receiver frame's key, and the call frames' keys beside their stack. */
    @journaled private accessor activeTypeArgumentFrameKey: string | undefined;
    private readonly callTypeArgumentKeys: string[] = emissionArray([]);

    /**
     * The struct-identity key folds every instantiation in force in, and it
     * is the same string for the whole window a substitution is in force --
     * so it is joined when the frames change rather than per cache lookup.
     */
    private refreshTypeArgumentKey(): void {
        this.activeTypeArgumentKey = [
            ...(this.activeTypeArgumentFrameKey === undefined
                ? []
                : [this.activeTypeArgumentFrameKey]),
            ...this.callTypeArgumentKeys,
        ].join(";");
    }

    /** The active substitution, so a receiver can carry it. */
    public typeArgumentsOf(
        declaration: ts.ClassLikeDeclaration,
        type: ts.Type,
    ): ReadonlyMap<ts.Symbol, ts.Type> | undefined {
        const parameters = declaration.typeParameters;
        if (!parameters || parameters.length === 0) {
            return undefined;
        }
        const objectType = type as ts.ObjectType;
        const supplied =
            (objectType.objectFlags & ts.ObjectFlags.Reference) !== 0
                ? this.checker.getTypeArguments(type as ts.TypeReference)
                : [];
        const substitution = new EmissionMap<ts.Symbol, ts.Type>();
        parameters.forEach((parameter, index) => {
            const argument = supplied[index];
            const symbol = this.checker.getTypeAtLocation(parameter).symbol;
            if (argument && symbol) {
                substitution.set(symbol, argument);
            }
        });
        return substitution.size > 0 ? substitution : undefined;
    }

    /** The type a type parameter stands for here, when one is in force. */
    private substituteTypeParameter(type: ts.Type): ts.Type | undefined {
        if ((type.flags & ts.TypeFlags.TypeParameter) === 0 || !type.symbol) {
            return undefined;
        }
        const frames = this.typeArgumentFrames();
        for (let index = frames.length - 1; index >= 0; index -= 1) {
            const argument = frames[index]!.get(type.symbol);
            if (argument !== undefined) {
                return argument === type ? undefined : argument;
            }
        }
        return undefined;
    }

    /** A type with every type parameter in force replaced by its argument. */
    public resolveTypeParameter(type: ts.Type): ts.Type {
        const seen = new Set<ts.Type>();
        while (!seen.has(type)) {
            seen.add(type);
            const next = this.substituteTypeParameter(type);
            if (!next) break;
            type = next;
        }
        return type;
    }

    /**
     * Whether a type still mentions a parameter the active substitution
     * replaces, so two instantiations of one generic declaration cannot
     * share a cached struct.
     *
     * The walk covers every place a parameter can hide inside one type: a
     * union or intersection constituent, a reference's own type arguments,
     * callable signatures, and the members of an anonymous or instantiated
     * object -- an inline `{ part: P; distance: number }` is spelled identically under two
     * instantiations and would otherwise read back the first one's struct.
     * `seen` closes the recursion on self-referential shapes, and every
     * branch is a disjunction over a set, so no answer depends on order.
     */
    private mentionsSubstitution(
        type: ts.Type,
        seen: Set<ts.Type> = new EmissionSet(),
    ): boolean {
        if (this.typeArgumentFrames().length === 0 || seen.has(type)) {
            return false;
        }
        seen.add(type);
        if (this.substituteTypeParameter(type)) {
            return true;
        }
        const constituents =
            (type.flags & (ts.TypeFlags.Union | ts.TypeFlags.Intersection)) !==
            0
                ? (type as ts.UnionOrIntersectionType).types
                : [];
        if (
            constituents.some((member) =>
                this.mentionsSubstitution(member, seen),
            )
        ) {
            return true;
        }
        const objectType = type as ts.ObjectType;
        if ((type.flags & ts.TypeFlags.Object) === 0) {
            return false;
        }
        if (
            (objectType.objectFlags & ts.ObjectFlags.Reference) !== 0 &&
            this.checker
                .getTypeArguments(type as ts.TypeReference)
                .some((argument) => this.mentionsSubstitution(argument, seen))
        ) {
            return true;
        }
        if (
            type
                .getCallSignatures()
                .some(
                    (signature) =>
                        signature
                            .getParameters()
                            .some((parameter) =>
                                this.mentionsSubstitution(
                                    this.checker.getTypeOfSymbol(parameter),
                                    seen,
                                ),
                            ) ||
                        this.mentionsSubstitution(
                            signature.getReturnType(),
                            seen,
                        ),
                )
        ) {
            return true;
        }
        // A named interface or class declares its members against its own
        // parameters, which the reference arguments above already answer for.
        // What is left is the object whose members ARE the type: an anonymous
        // literal, or an instantiation of one.
        if (
            (objectType.objectFlags &
                (ts.ObjectFlags.Anonymous | ts.ObjectFlags.Instantiated)) ===
            0
        ) {
            return false;
        }
        return this.checker
            .getPropertiesOfType(type)
            .some((property) =>
                this.mentionsSubstitution(
                    this.checker.getTypeOfSymbol(property),
                    seen,
                ),
            );
    }

    private structIdentity(type: ts.Type): ts.Symbol | ts.Type | string {
        // A generic alias inside its own body still names the same checker
        // type under different substitutions; resolve that distinction first.
        if (this.mentionsSubstitution(type)) {
            // An instantiation a record joined is its component's struct.
            const instantiation = this.instantiatedRecordOf(type);
            const component =
                instantiation && this.recordComponents.get(instantiation);
            if (component) return component.key;
            const frames = this.typeArgumentFrames();
            const identities = this.substitutedStructIdentities.get(type) ?? [];
            const existing = identities.find((identity) =>
                sameTypeFrames(identity.frames, frames),
            );
            if (existing) return existing.key;
            const key = `substituted:${this.nextSubstitutedStructIdentity++}`;
            this.substitutedStructIdentities.set(type, [
                ...identities,
                {
                    frames: frames.map((frame) => new Map(frame)),
                    key,
                },
            ]);
            return key;
        }
        // A name several checker types share keys each by the type
        // (`recordIdentity`): `Record<ClosedKeys, T>` and `Record<string, U>`
        // expose different property sets. The members of a record component
        // are one struct.
        const own = recordIdentity(this.checker, type);
        return this.recordComponents.get(own)?.key ?? own;
    }

    /**
     * Storage for a binding whose type admits only `undefined` (`void`,
     * `undefined`, a type parameter instantiated as either): it holds
     * nothing but its state of having been assigned.
     */
    public undefinedOnlyStorage(type: ts.Type): DataType | undefined {
        const resolved = this.resolveTypeParameter(type);
        const members = resolved.isUnion() ? resolved.types : [resolved];
        return members.every(
            (member) =>
                (member.flags &
                    (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !==
                0,
        )
            ? { kind: "undefined" }
            : undefined;
    }

    /** Required undefined fields own a key independently of their payload. */
    private fromRecordFieldType(
        type: ts.Type,
        node: ts.Node,
        property?: ts.Symbol,
    ): DataType | undefined {
        const resolved = this.resolveTypeParameter(type);
        const members = resolved.isUnion() ? resolved.types : [resolved];
        // A required null-only field has storage before its record joins
        // another shape; the joined layout can then hold its null value.
        if (members.every((member) => (member.flags & ts.TypeFlags.Null) !== 0))
            return { kind: "null" };
        if (
            !members.every(
                (member) =>
                    (member.flags &
                        (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !==
                    0,
            )
        ) {
            const mapped = this.fromTsType(type, node);
            return mapped && property?.declarations?.length === 1
                ? this.absenceTaggedStorage(property.declarations[0], mapped)
                : mapped;
        }
        if (property && (property.flags & ts.SymbolFlags.Optional) !== 0)
            return this.nullableType({ kind: "undefined" }, true);
        return { kind: "undefined" };
    }

    /**
     * The own keys an object literal creates, in JavaScript's order: integer
     * keys ascending, then the others as written, a spread inserting its
     * source's keys where it stands and a later key keeping the position of
     * the one it overwrites. TypeScript orders a spread's synthesized type
     * otherwise. Undefined for a type no object literal declares, or one
     * with a computed key.
     */
    private objectLiteralKeyOrder(type: ts.Type): string[] | undefined {
        const literal = type.symbol?.declarations?.[0];
        if (!literal || !ts.isObjectLiteralExpression(literal))
            return undefined;
        const keys: string[] = [];
        for (const property of literal.properties) {
            const names = ts.isSpreadAssignment(property)
                ? (() => {
                      const source = this.checker.getNonNullableType(
                          this.checker.getTypeAtLocation(property.expression),
                      );
                      return (
                          this.objectLiteralKeyOrder(source) ??
                          this.checker
                              .getPropertiesOfType(source)
                              .map((symbol) => symbol.name)
                      );
                  })()
                : property.name && propertyNameText(property.name);
            if (names === undefined) return undefined;
            keys.push(...(typeof names === "string" ? [names] : names));
        }
        // An object of these keys orders them as JavaScript does.
        return Object.keys(
            Object.fromEntries(keys.map((key) => [key, undefined])),
        );
    }

    /** Intersection constraints keep their refinements without hiding concrete generic fields. */
    private structProperties(type: ts.Type): readonly ts.Symbol[] {
        const declared = this.checker.getPropertiesOfType(type);
        // A literal's fields follow the order its own keys are created in.
        const order = this.objectLiteralKeyOrder(type);
        const positions = new Map(order?.map((key, index) => [key, index]));
        const at = (symbol: ts.Symbol): number =>
            positions.get(symbol.name) ?? positions.size;
        const properties = order
            ? [...declared].sort((left, right) => at(left) - at(right))
            : declared;
        if (!type.isIntersection()) return properties;
        const byName = new Map(
            properties.map((property) => [property.name, property]),
        );
        for (const member of type.types) {
            const concrete = this.resolveTypeParameter(member);
            for (const property of concrete.isIntersection()
                ? this.structProperties(concrete)
                : this.checker.getPropertiesOfType(concrete))
                if (!byName.has(property.name))
                    byName.set(property.name, property);
        }
        return [...byName.values()];
    }

    /**
     * The properties a record type's struct holds, each with every
     * declaration of it the struct stores: the type's own, or, for a member
     * of a record component, the union of its shapes' properties (its
     * members', a record union's arms') in the widest shape's order, a
     * property some shape lacks held absent in that shape's records.
     */
    private layoutProperties(type: ts.Type): {
        readonly shapes: number;
        readonly properties: ReadonlyMap<
            string,
            readonly { readonly owner: ts.Type; readonly symbol: ts.Symbol }[]
        >;
    } {
        const shapes = this.recordComponentOf(type)?.shapes ?? [type];
        const properties = new Map<
            string,
            { owner: ts.Type; symbol: ts.Symbol }[]
        >();
        for (const owner of shapes)
            for (const symbol of this.structProperties(owner)) {
                const declared = properties.get(symbol.name);
                if (declared) declared.push({ owner, symbol });
                else properties.set(symbol.name, [{ owner, symbol }]);
            }
        return { shapes: shapes.length, properties };
    }

    /**
     * The storage a record union stores its property `name` in, where it
     * holds the storage of every shape declaring it (`values`): numeric
     * tuples of several lengths in a number array, a value and null in a
     * nullable slot. Undefined when no union of `unions` declares it in
     * every arm or holds them all.
     */
    private unionFieldStorage(
        unions: readonly ts.UnionType[],
        name: string,
        values: readonly { type: ts.Type; mapped: DataType | undefined }[],
        node: ts.Node,
    ): DataType | undefined {
        const storage = (type: DataType): DataType =>
            type.kind === "optional" ? storage(type.inner) : type;
        for (const union of unions) {
            const property = union.getProperty(name);
            const mapped =
                property &&
                this.fromRecordFieldType(
                    this.checker.getTypeOfSymbolAtLocation(property, node),
                    node,
                    property,
                );
            if (!mapped) continue;
            const held = storage(mapped);
            if (
                values.every(({ type, mapped: own }) => {
                    if (!own || own.kind === "undefined")
                        return presentMembers(type).length === 0;
                    const joined = this.joinedStorage(storage(own), held);
                    return joined !== undefined && dataTypesEqual(joined, held);
                })
            )
                return mapped;
        }
        return undefined;
    }

    private fromStructTypeInner(
        type: ts.Type,
        node: ts.Node,
        provisionalName: string,
        allowStoredFunctions: boolean,
        call?: DataType<"function">,
    ): DataType | undefined {
        if (isDomEventType(this.checker, type)) return undefined;
        const component = this.recordComponentOf(type);
        const layout = this.layoutProperties(type);
        if (layout.properties.size === 0) {
            return undefined;
        }
        const fields: DataStructField[] = [];
        const presences: FieldPresence[] = [];
        // An asserted empty object is filled through its views later.
        const partial = this.assertedEmpty(type);
        const view = this.recordViews.has(this.structIdentity(type));
        const proxy = this.proxyRecords.has(this.structIdentity(type));
        const valueOf = (
            property: ts.Symbol,
        ): {
            type: ts.Type;
            mapped: DataType | undefined;
            callable: boolean;
        } => {
            const declaration =
                property.valueDeclaration ?? property.declarations?.[0];
            const propertyType = this.checker.getTypeOfSymbolAtLocation(
                property,
                declaration ?? node,
            );
            const callableType = this.checker.getNonNullableType(propertyType);
            // A callable record (a function with properties) is a record.
            const callable =
                callableType.getCallSignatures().length > 0 &&
                !this.isCallableRecordType(callableType);
            const mapped = callable
                ? allowStoredFunctions &&
                  declaration !== undefined &&
                  (ts.isPropertySignature(declaration) ||
                      ts.isMethodSignature(declaration) ||
                      ts.isMethodDeclaration(declaration) ||
                      (this.classDemanded &&
                          (ts.isPropertyAssignment(declaration) ||
                              ts.isShorthandPropertyAssignment(declaration))))
                    ? this.fromFunctionType(callableType, declaration ?? node)
                    : undefined
                : // A record's own field inherits the position the record is in
                  // rather than demanding one: an interface written to carry a
                  // scene's singletons -- a tool context holding the workspace, the
                  // mouse and the dragger -- is a compile-time record, and giving
                  // each of those a runtime object because a field names them would
                  // turn every one of them into a shared allocation nothing shares.
                  // Its tagged absence is the layout's, decided below.
                  withoutAbsenceTag(
                      this.fromRecordFieldType(
                          propertyType,
                          declaration ?? node,
                          property,
                      ),
                  );
            return {
                type: propertyType,
                callable,
                mapped:
                    mapped &&
                    this.withDemandedNumericSlot(
                        declaration,
                        propertyType,
                        mapped,
                    ),
            };
        };
        for (const [name, declared] of layout.properties) {
            const property = declared[0]!.symbol;
            const values = declared.map(({ symbol }) => valueOf(symbol));
            // A function an object literal declares is stored only in a
            // stored position (`fromStoredTsType`); elsewhere a component
            // member declaring its signature stores it for every member.
            const storing = ({
                mapped,
                callable,
            }: {
                mapped: DataType | undefined;
                callable: boolean;
            }): boolean => mapped !== undefined || !callable;
            // A shape declaring the property only null or undefined holds
            // it in the empty state of the storage the others give it.
            const nullish = ({
                type,
                mapped,
            }: (typeof values)[number]): boolean =>
                (mapped === undefined ||
                    mapped.kind === "undefined" ||
                    mapped.kind === "null") &&
                presentMembers(type).length === 0;
            const valued = values.filter(
                (value) => storing(value) && !nullish(value),
            );
            const empty = (value: (typeof values)[number]): boolean =>
                valued.length > 0 && nullish(value);
            const mappedValue = (valued[0] ?? values.find(storing))?.mapped;
            if (!mappedValue) {
                return undefined;
            }
            // One layout stores the property once: every member declaring it
            // must store it one way (`joinedStorage`) -- or, where they are
            // arms of a record union the component holds, the way that
            // union stores it (`unionFieldStorage`).
            const storage = (mapped: DataType): DataType =>
                mapped.kind === "optional" ? mapped.inner : mapped;
            let stored: DataType = storage(mappedValue);
            let unionField: DataType | undefined;
            for (const [index, value] of values.entries()) {
                if (!storing(value) || empty(value)) continue;
                const { mapped } = value;
                const next =
                    mapped && this.joinedStorage(stored, storage(mapped));
                if (next) {
                    stored = next;
                    continue;
                }
                if (mapped)
                    this.requireSharedValueViews(stored, storage(mapped));
                unionField = this.unionFieldStorage(
                    component?.unions ?? [],
                    name,
                    values.filter(storing),
                    node,
                );
                if (!unionField)
                    this.fail(
                        node,
                        `Record types '${this.checker.typeToString(declared[0]!.owner)}' and '${this.checker.typeToString(declared[index]!.owner)}' hold one object (a record of one is stored as the other), but no one layout stores their property '${name}' both ways.`,
                    );
                stored = storage(unionField);
                break;
            }
            // Records of a member not declaring it hold it absent.
            const absent = declared.length < layout.shapes;
            const unchecked =
                partial ||
                absent ||
                declared.some(({ owner }) => this.mayLackProperty(owner, name));
            const optional =
                unchecked ||
                declared.some(
                    ({ symbol }) =>
                        (symbol.flags & ts.SymbolFlags.Optional) !== 0,
                );
            // Members storing it with and without an empty state store it
            // with one.
            const nullable = values.find(
                ({ mapped }) => mapped?.kind === "optional",
            )?.mapped;
            const joined: DataType =
                unionField ??
                (declared.length === 1
                    ? mappedValue
                    : nullable && dataTypesEqual(storage(nullable), stored)
                      ? nullable
                      : nullable || values.some(empty)
                        ? this.nullableType(stored)
                        : stored);
            const declarations = declared.flatMap(
                ({ symbol }) => symbol.declarations ?? [],
            );
            // A property whose tuples a number array may grow stores arrays.
            const growable: DataType =
                joined.kind === "tuple" &&
                declarations.some((declaration) =>
                    this.storage.tupleArraySlots.has(declaration),
                )
                    ? { kind: "vector", element: { kind: "number" } }
                    : joined;
            const untagged: DataType = this.markStoredObjectReferences(
                markIdentityFunctions(
                    optional
                        ? this.nullableType(
                              growable,
                              growable.kind === "undefined",
                          )
                        : growable,
                ),
            );
            // One layout stores the property once: tagged when a program
            // tells its absent values apart through any member declaring it.
            const taggedDeclaration = declarations.find((declaration) =>
                this.storage.absenceTags.has(declaration),
            );
            const mapped = this.absenceTaggedStorage(
                taggedDeclaration,
                untagged,
            );
            const accessor = this.propertyAccessor(property, view || proxy);
            if (
                declared.some(
                    ({ symbol }) =>
                        this.propertyAccessor(symbol, view || proxy) !==
                        accessor,
                )
            )
                this.fail(
                    node,
                    `Property '${name}' is an accessor in one of the record types sharing '${provisionalName}' but not another.`,
                );
            fields.push({
                sourceName: name,
                name: sanitizeIdentifier(
                    isSymbolPropertyKey(name) ? symbolFieldName(name) : name,
                ),
                type: mapped,
                declarations,
                ...(accessor ? { accessor } : {}),
                ...(proxy ? { accessorReceiver: provisionalName } : {}),
                ...(declared.every(({ symbol }) => propertyIsReadOnly(symbol))
                    ? { readOnly: true }
                    : {}),
                ...(optional ? { optionalProperty: true } : {}),
                ...(unchecked ? { uncheckedProperty: true } : {}),
                ...(absent ? { sharedAbsent: true } : {}),
                ...(optional && mapped.kind !== "optional"
                    ? { defaultWhenMissing: true }
                    : {}),
            });
            presences.push(
                fieldPresence(
                    optional && (!accessor || proxy)
                        ? storedPresence(
                              mapped,
                              values.some(
                                  (value) => nullability(value.type).null,
                              ),
                          )
                        : // A view's `?` slot reads an entry its open record
                          // may lack; the slot does not say whether it has it.
                          optional && view
                          ? "ambiguous"
                          : "own",
                    valueAbsence(values.map((value) => value.type)),
                ),
            );
        }
        // A component's members are one object under several types, and a
        // function object is one object wherever it is passed.
        if (partial || proxy || component || call) {
            this.referenceStructNames.add(provisionalName);
        }
        if (
            fields.some((field) =>
                this.carriesBorrowedPlatformEvent(field.type),
            )
        ) {
            // A synchronous callback observes one JavaScript payload object. Making
            // the whole record reference-backed ensures a handler's field mutation
            // is visible to the dispatcher after the call.
            this.referenceStructNames.add(provisionalName);
        }
        const mapped = this.internMappedStruct(
            provisionalName,
            fields,
            presences,
            call,
        );
        if (
            [...layout.properties.values()].some((declared) =>
                declared.some(({ symbol }) =>
                    (symbol.declarations ?? []).some((declaration) =>
                        this.prototypeAccessors.has(declaration),
                    ),
                ),
            )
        )
            this.prototypeAccessorStructs.add(mapped.name);
        return mapped;
    }

    /**
     * Whether a struct's accessor slots may hold a class's prototype
     * accessor, which is no own property; other slots (a view's entries, an
     * object literal's accessors, values held as data) are own and
     * enumerable.
     */
    public holdsPrototypeAccessors(name: string): boolean {
        return this.prototypeAccessorStructs.has(name);
    }

    private internMappedStruct(
        provisionalName: string,
        fields: DataStructField[],
        presences: readonly FieldPresence[],
        call?: DataType<"function">,
    ): DataType<"struct"> {
        fields = fields.map((field) => ({
            ...field,
            type: this.engineFieldStorage(field.type, field.declarations),
        }));
        // A union's stored element and a callback's declared result share an
        // object when their field layouts agree, regardless of mapping path.
        const key = fields
            .map(
                (field) =>
                    `${field.sourceName}:${field.name}:${this.typeKey(field.type)}:${field.defaultWhenMissing ? "default" : "required"}:${field.readOnly ? "readonly" : "mutable"}:${field.optionalProperty ? "optional" : "present"}:${field.sharedAbsent ? "shared" : field.uncheckedProperty ? "unchecked" : "checked"}:${JSON.stringify(field.presentForTags)}${accessorKey(field)}`,
            )
            .join(",")
            .concat(call ? `;call:${this.typeKey(call)}` : "");
        const existing = this.structsByKey.get(key);
        const name =
            existing && !this.referenceStructNames.has(provisionalName)
                ? existing.name
                : provisionalName;
        this.recordFieldPresences(name, fields, presences);
        if (name === provisionalName)
            this.registerStructDefinition(key, {
                name,
                fields,
                ...(call ? { call } : {}),
            });
        return { kind: "struct", name };
    }

    /**
     * A function object with properties: one call signature beside named
     * properties (`(() => T) & { onResize?: ... }`, an interface declaring
     * both). Its record stores the properties and, apart, its call.
     */
    private isCallableRecordType(type: ts.Type): boolean {
        return (
            type.getCallSignatures().length === 1 &&
            type.getConstructSignatures().length === 0 &&
            this.checker.getPropertiesOfType(type).length > 0
        );
    }

    private fromCallableRecordType(
        type: ts.Type,
        node: ts.Node,
    ): DataType | undefined {
        if (!this.isCallableRecordType(type)) return undefined;
        const signature = this.fromFunctionType(type, node);
        if (signature?.kind !== "function" || signature.generic)
            return undefined;
        // The call is the function object itself: it keeps that identity.
        const call: DataType<"function"> = {
            ...signature,
            identity: true,
            ...(signature.result
                ? { result: this.markStoredObjectReferences(signature.result) }
                : {}),
        };
        const record = this.fromStructType(type, node, call);
        return record?.kind === "struct" && this.structCall(record.name)
            ? record
            : undefined;
    }

    /** The call a callable record holds (`fromCallableRecordType`). */
    public structCall(name: string): DataType<"function"> | undefined {
        return this.structsByName.get(name)?.call;
    }

    /** A callable starts with its original call identity and no installed named properties. */
    public callableRecordDemand(
        name: string,
    ): NativeRecordStorageDemand | undefined {
        const source = this.nativeRecordSources.get(name);
        if (!source || !this.structCall(name)) return undefined;
        const demand: NativeRecordStorageDemand = {
            ...source,
            stored: true,
            bareCallable: true,
            proxy: true,
        };
        if (
            !this.withRecordDemand(source, () =>
                this.assertedEmpty(source.type),
            ) ||
            this.structFields(name, source.node, "accessors").some(
                (field) => !field.accessorReceiver,
            )
        )
            throw new NativeRecordStorageRequired(demand);
        return demand;
    }

    /** Remap a callable's canonical source in the generic environment that demanded it. */
    public fromCallableRecordDemand(
        demand: NativeRecordStorageDemand,
    ): DataType<"struct"> | undefined {
        return this.withRecordDemand(demand, () => {
            const mapped = this.fromStoredTsType(demand.type, demand.node);
            return mapped?.kind === "struct" && this.structCall(mapped.name)
                ? mapped
                : undefined;
        });
    }

    /**
     * Merges the own-key facts a type shape gives each field into what its
     * struct already holds: shapes that disagree (`f?: T` beside
     * `f: T | undefined`) leave the field ambiguous, and an empty slot that
     * holds `null` for one shape and `undefined` for another `either`.
     */
    private recordFieldPresences(
        structName: string,
        fields: readonly DataStructField[],
        presences: readonly FieldPresence[],
    ): void {
        fields.forEach((field, index) => {
            const next = presences[index];
            if (!next) return;
            const key = `${structName}.${field.sourceName}`;
            const previous = this.fieldPresences.get(key);
            // A shape whose field is own and never empty fills the slot a
            // shape storing it optionally reads presence from.
            const filled = (fact: FieldPresence | undefined): boolean =>
                fact?.presence === "own" && fact.absence === undefined;
            const presence =
                (filled(previous) && next.presence === "stored") ||
                (filled(next) && previous?.presence === "stored")
                    ? "stored"
                    : mergedFact(
                          previous?.presence,
                          next.presence,
                          "ambiguous",
                      );
            this.fieldPresences.set(
                key,
                fieldPresence(
                    presence,
                    mergedFact(previous?.absence, next.absence, "either"),
                    mergedFact(
                        previous?.armPresence,
                        next.armPresence,
                        "ambiguous",
                    ),
                ),
            );
        });
    }

    /**
     * A field's own-key presence; within the union arms declaring it for
     * `arms`. A field no type shape recorded (a class field, an owned
     * result) answers from its own declaration.
     */
    public ownPropertyPresence(
        structName: string,
        field: DataStructField,
        arms = false,
    ): OwnPropertyPresence {
        const recorded = this.fieldPresences.get(
            `${structName}.${field.sourceName}`,
        );
        return (
            (arms ? recorded?.armPresence : recorded?.presence) ??
            (field.optionalProperty || field.uncheckedProperty
                ? storedPresence(field.type, false)
                : "own")
        );
    }

    /**
     * Whether every field of a struct is always an own key of its records:
     * neither its storage nor the record's tags (`ownPresence`) decide it.
     */
    public ownKeysDecided(structName: string, node: ts.Node): boolean {
        return this.structFields(structName, node, "accessors").every(
            (field) =>
                !this.presenceByTags(structName, field) &&
                this.ownPropertyPresence(structName, field) === "own",
        );
    }

    /** An own field written undefined needs presence separate from its payload. */
    public requireOwnUndefinedField(
        structName: string,
        field: DataStructField,
        source: ts.Type,
        node: ts.Node,
    ): void {
        const resolved = this.resolveTypeParameter(source);
        if (
            !field.optionalProperty ||
            (!nullability(resolved).undefined &&
                (resolved.flags & ts.TypeFlags.Void) === 0)
        )
            return;
        let payload = field.type;
        while (payload.kind === "optional" || payload.kind === "tagged")
            payload = payload.inner;
        if (
            !field.accessorReceiver &&
            (payload.kind === "struct" ||
                payload.kind === "function" ||
                payload.kind === "handle" ||
                isOpaqueReference(payload) ||
                sharesStorageKind(payload))
        ) {
            const demand = this.nativeRecordSources.get(structName);
            if (
                demand &&
                !this.isClassStruct(structName) &&
                !demand.type.isUnion()
            )
                throw new NativeRecordStorageRequired({
                    ...demand,
                    proxy: true,
                });
            this.refuseAmbiguousPresence(field, node);
        }
        if (
            field.accessorReceiver ||
            field.type.kind !== "optional" ||
            !["number", "string", "boolean", "enum"].includes(
                field.type.inner.kind,
            )
        )
            return;
        const demand = this.documentRecordDemand(structName);
        if (demand && !demand.type.isUnion())
            throw new NativeRecordStorageRequired(demand);
        this.refuseAmbiguousPresence(field, node);
    }

    /**
     * The run-time presence of `field` as an own key of the struct
     * `ownerCpp` names (read through `access`), or undefined when it always
     * is one. A nullable field's empty storage refuses at run time; an
     * ambiguous field refuses here, and the read is checked again once every
     * shape is known.
     */
    public ownPresence(
        structName: string,
        field: DataStructField,
        ownerCpp: string,
        access: "->" | ".",
        node: ts.Node,
    ): OwnPresence | undefined {
        // A payload can be undefined while its property is still present.
        // A document records those states independently of the payload slot.
        if (
            field.optionalProperty &&
            !field.accessorReceiver &&
            (field.type.kind === "json" || field.type.kind === "tagged")
        ) {
            const demand = this.documentRecordDemand(structName);
            if (demand && !demand.type.isUnion())
                throw new NativeRecordStorageRequired(demand);
            this.refuseAmbiguousPresence(field, node);
        }
        // A field only some union arms declare is own when the record's
        // tags select one of them, and then as those arms declare it.
        const tags = this.tagPresenceCpp(structName, field, ownerCpp, access);
        const arms = tags !== undefined;
        const presence = this.ownPropertyPresence(structName, field, arms);
        if (presence === "ambiguous") this.refuseAmbiguousPresence(field, node);
        if (arms || presence !== "own")
            this.presenceReads.set(`${structName}.${field.sourceName}`, {
                structName,
                field,
                arms,
                node,
            });
        const slot = `${ownerCpp}${access}${field.name}`;
        if (presence === "own") {
            if (tags === undefined) return undefined;
            const holdsValueCpp = this.slotPresentCpp(field.type, slot);
            return {
                ownCpp: tags,
                ...(holdsValueCpp ? { holdsValueCpp } : {}),
            };
        }
        const held = field.accessorReceiver
            ? `${slot}.has_own()`
            : presence === "nullable"
              ? `bbl::js::held_own_property(${slot}, ${stringLiteral(field.sourceName)})`
              : this.slotPresentCpp(field.type, slot);
        if (held === undefined)
            return this.fail(
                node,
                `Own-property presence of '${field.sourceName}' is not represented: its storage has no absent state.`,
            );
        if (tags !== undefined) return { ownCpp: `(${tags}) && ${held}` };
        return {
            ownCpp: held,
            ...(presence === "nullable" && !field.accessorReceiver
                ? { emptySlot: "ambiguous" as const }
                : field.accessorReceiver
                  ? {}
                  : { emptySlot: "absent" as const }),
        };
    }

    /** Whether the record's tags decide whether `field` is an own key. */
    private presenceByTags(
        structName: string,
        field: DataStructField,
    ): boolean {
        return (
            this.structsByName.has(structName) &&
            field.presentForTags !== undefined &&
            !field.accessor
        );
    }

    /**
     * The run-time test that a record's tags select a union arm declaring
     * `field`, read beside it; undefined for a field every arm declares.
     */
    private tagPresenceCpp(
        structName: string,
        field: DataStructField,
        ownerCpp: string,
        access: "->" | ".",
    ): string | undefined {
        const definition = this.structsByName.get(structName);
        const alternatives = field.presentForTags;
        if (
            !definition ||
            !alternatives ||
            !this.presenceByTags(structName, field)
        )
            return undefined;
        return this.tagConditionCpp(
            definition,
            alternatives,
            (tag) => `${ownerCpp}${access}${tag.name}`,
            "bblscene::",
        );
    }

    /** Tag alternatives as C++: any alternative, each a conjunction of tag literals. */
    private tagConditionCpp(
        definition: DataStructDefinition,
        alternatives: NonNullable<DataStructField["presentForTags"]>,
        member: (tag: DataStructField) => string,
        namespace: string,
    ): string {
        return alternatives
            .map(
                (alternative) =>
                    `(${alternative
                        .map(({ discriminant, value }) => {
                            const tag = definition.fields.find(
                                (candidate) =>
                                    candidate.sourceName === discriminant,
                            )!;
                            const literal =
                                tag.type.kind === "enum"
                                    ? `${namespace}${tag.type.name}::${this.enumMemberIdentifier(this.enumsByName.get(tag.type.name)!, value)}`
                                    : tag.type.kind === "string"
                                      ? JSON.stringify(value)
                                      : value;
                            return `${member(tag)} == ${literal}`;
                        })
                        .join(" && ")})`,
            )
            .join(" || ");
    }

    private refuseAmbiguousPresence(
        field: DataStructField,
        node: ts.Node,
    ): never {
        return this.fail(
            node,
            `Own-property presence of '${field.sourceName}' is not represented: the type shapes sharing its storage disagree on whether it is an own property.`,
        );
    }

    /** A presence read stays sound only if no later shape made its field ambiguous. */
    private checkFieldPresenceReads(): void {
        for (const read of this.presenceReads.values())
            if (
                this.ownPropertyPresence(
                    read.structName,
                    read.field,
                    read.arms,
                ) === "ambiguous"
            )
                this.refuseAmbiguousPresence(read.field, read.node);
    }

    public isReferenceStruct(name: string): boolean {
        return this.referenceStructNames.has(name);
    }

    /**
     * Maps a local class demanded by a native data position onto the reference
     * struct that stands for one of its instances.
     *
     * The representation is the one shared objects already have here: a
     * `bbl::js::Ref<XData>`, marked reference-valued the moment the name is
     * minted rather than when a container happens to store it, so identity,
     * null, `includes`, `indexOf`, `Set` membership and `Map` keys all use Ref
     * identity whatever order the demands arrive in.
     *
     * The struct's fields are not read here: `defineClassStructFields` fills
     * them from the class's own property declarations when the class lowerer
     * first constructs one, which is also where a field that turns out to hold
     * a compile-time value is hoisted out of the layout.
     */
    private fromLocalClassType(
        type: ts.Type,
        node: ts.Node,
    ): DataType | undefined {
        const declaration = (type.symbol?.declarations ?? []).find(
            ts.isClassLike,
        );
        if (!declaration) {
            return undefined;
        }
        const identity = this.structIdentity(type);
        const existing = this.classStructNames.get(identity);
        if (existing) {
            return { kind: "struct", name: existing };
        }
        // Demand mints the representation; it does not scope it. Once one
        // position stores a class, every mention of it is that same shared
        // object -- otherwise a field typed `Part | null` beside an array of
        // `Part` would be a different thing from the array's elements.
        if (!this.classDemanded) {
            return undefined;
        }
        this.rejectUnsupportedRuntimeClass(declaration, node);
        if (this.classHierarchy.inHierarchy(declaration)) {
            return this.fromClassHierarchy(declaration, node);
        }
        const name = this.uniqueName(
            sanitizeIdentifier(
                classBindingNames(declaration)[0]?.text ?? "Instance",
            ),
            this.structNames,
        );
        this.classStructNames.set(identity, name);
        this.classStructDeclarations.set(name, { declaration, type });
        this.referenceStructNames.add(name);
        const { fields, presences } = this.classStructFields(declaration, type);
        this.recordFieldPresences(name, fields, presences);
        this.registerStructDefinition(`class#${name}`, { name, fields });
        return { kind: "struct", name };
    }

    /**
     * Mints the one reference struct every class of a hierarchy shares.
     *
     * A value typed as a base class can be an instance of any class under
     * it, so the classes cannot each have a layout of their own: one struct,
     * named after the root, holds the fields every class of the hierarchy
     * declares, and a tag records which class an object is. A field two
     * sibling classes both declare shares its slot, since one object is only
     * ever one of them; a field an override restates is the base's slot.
     */
    private fromClassHierarchy(
        declaration: ts.ClassLikeDeclaration,
        node: ts.Node,
    ): DataType {
        const root = this.classHierarchy.root(declaration);
        const classes = this.classHierarchy.hierarchyClasses(root);
        const typeOf = (member: ts.ClassLikeDeclaration): ts.Type => {
            const symbol = member.name
                ? declaredSymbol(this.checker, member.name)
                : undefined;
            if (!symbol || member.typeParameters?.length) {
                this.fail(
                    node,
                    `Class '${member.name?.text ?? "?"}' of the hierarchy under ` +
                        `'${root.name?.text ?? "?"}' is ${symbol ? "generic" : "unnamed"}; ` +
                        "a stored instance of a hierarchy needs one layout per class.",
                );
            }
            return this.checker.getDeclaredTypeOfSymbol(symbol);
        };
        const name = this.uniqueName(
            sanitizeIdentifier(root.name?.text ?? "Instance"),
            this.structNames,
        );
        const types = classes.map(typeOf);
        for (const type of types) {
            this.classStructNames.set(this.structIdentity(type), name);
        }
        this.classStructDeclarations.set(name, {
            declaration: root,
            type: types[0]!,
        });
        this.referenceStructNames.add(name);
        const fields: DataStructField[] = [];
        const layouts = classes.map((member, index) =>
            this.classStructFields(member, types[index]!),
        );
        const declarationsByField = new Map<string, ts.Declaration[]>();
        for (const layout of layouts)
            for (const field of layout.fields) {
                const declarations =
                    declarationsByField.get(field.sourceName) ?? [];
                for (const declaration of field.declarations ?? [])
                    if (!declarations.includes(declaration))
                        declarations.push(declaration);
                declarationsByField.set(field.sourceName, declarations);
            }
        classes.forEach((member, index) => {
            const declared = layouts[index]!;
            for (const field of declared.fields) {
                field.declarations =
                    declarationsByField.get(field.sourceName) ?? [];
                field.type = this.engineFieldStorage(
                    field.type,
                    field.declarations,
                );
            }
            this.recordFieldPresences(
                name,
                declared.fields,
                declared.presences,
            );
            for (const field of declared.fields) {
                if (field.name === classTagMember) {
                    this.fail(
                        node,
                        `Field '${field.sourceName}' of class '${member.name?.text ?? "?"}' ` +
                            "collides with the class tag the hierarchy's struct stores.",
                    );
                }
                const existing = fields.find(
                    (candidate) => candidate.sourceName === field.sourceName,
                );
                if (!existing) {
                    fields.push(field);
                    continue;
                }
                if (this.typeKey(existing.type) !== this.typeKey(field.type)) {
                    this.fail(
                        node,
                        `Field '${field.sourceName}' has a different native type in ` +
                            `class '${member.name?.text ?? "?"}' than elsewhere in the ` +
                            `hierarchy under '${root.name?.text ?? "?"}', so one shared ` +
                            "struct cannot store it.",
                    );
                }
                if (existing.readOnly && !field.readOnly) {
                    delete existing.readOnly;
                }
            }
        });
        this.registerStructDefinition(`class#${name}`, {
            name,
            fields,
            classTag: true,
        });
        return { kind: "struct", name };
    }

    /** Whether a class-backed struct stands for a hierarchy and stores a class tag. */
    public classStructTagged(name: string): boolean {
        return this.structsByKey.get(`class#${name}`)?.classTag === true;
    }

    /**
     * Which of a class's properties the shared object stores.
     *
     * A property is stored when its declared type -- resolved through the
     * instantiated class type, so `Workspace<Part>` answers with `Part` and
     * not with `P` -- maps into the plain-data model. Copyable resource handles
     * are slots too: a runtime collection of class instances must preserve
     * which camera, mesh, material, or other resource belongs to each instance
     * just as it preserves its numbers.
     *
     * The layout is settled the moment the struct exists, before any
     * construction: a method inlined on an instance read out of a container
     * must name the same slots whatever order the walk reached things in.
     */
    private classStructFields(
        declaration: ts.ClassLikeDeclaration,
        type: ts.Type,
    ): { fields: DataStructField[]; presences: FieldPresence[] } {
        const table = this.classHierarchy.table(declaration);
        const errorBase = classErrorBase(table);
        const fields: DataStructField[] = table.errorBase
            ? ERROR_CLASS_FIELDS.map((field) => ({ ...field }))
            : [];
        const presences: FieldPresence[] = fields.map(() => ({}));
        const fieldsByName = new Map(
            fields.map((field) => [field.sourceName, field]),
        );
        for (const member of classInstanceProperties(declaration)) {
            if (!ts.isMemberName(member.name)) {
                this.fail(
                    member,
                    "Computed class field names are outside the supported subset.",
                );
            }
            const nativeName = sanitizeIdentifier(structFieldName(member.name));
            if (errorBase && nativeName === "bbl_error")
                this.fail(
                    member,
                    "A class field collides with the internal Error payload slot.",
                );
            const property = this.classPropertySymbol(type, member.name);
            const propertyType = property
                ? this.checker.getTypeOfSymbolAtLocation(property, member.name)
                : this.checker.getTypeAtLocation(member.name);
            const declared =
                this.fromFunctionType(
                    this.checker.getNonNullableType(propertyType),
                    member.name,
                    true,
                ) ?? this.fromClassFieldType(propertyType, member.name);
            const mapped =
                declared &&
                this.withDemandedNumericSlot(member, propertyType, declared);
            if (
                !mapped &&
                this.checker
                    .getNonNullableType(propertyType)
                    .getCallSignatures().length > 0
            ) {
                this.fail(
                    member,
                    `Field '${member.name.text}' of shared class ` +
                        `'${declaration.name?.text ?? "?"}' requires a callback with a native data signature.`,
                );
            }
            if (!mapped) {
                continue;
            }
            const sourceName = member.name.text;
            const inheritedErrorField = fieldsByName.get(sourceName);
            if (inheritedErrorField) {
                if (
                    this.typeKey(inheritedErrorField.type) !==
                    this.typeKey(mapped)
                )
                    this.fail(
                        member,
                        `Error field '${sourceName}' requires its inherited native type.`,
                    );
                continue;
            }
            const field: DataStructField = {
                sourceName: member.name.text,
                name: nativeName,
                declarations: [member],
                type: this.engineFieldStorage(
                    this.markStoredObjectReferences(
                        markIdentityFunctions(mapped),
                    ),
                    [member],
                ),
                ...(member.modifiers?.some(
                    (modifier) =>
                        modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
                )
                    ? { readOnly: true }
                    : {}),
            };
            fields.push(field);
            presences.push(
                fieldPresence(undefined, valueAbsence([propertyType])),
            );
            fieldsByName.set(sourceName, field);
        }
        return { fields, presences };
    }

    /**
     * The shapes that cannot be one concrete `Ref<XData>`: a class whose
     * `extends` names something other than a local class, and a class no
     * instance can have -- abstract with no concrete class under it.
     */
    private rejectUnsupportedRuntimeClass(
        declaration: ts.ClassLikeDeclaration,
        node: ts.Node,
    ): void {
        const className = declaration.name?.text ?? "?";
        for (const link of classChain(this.classHierarchy.table(declaration))) {
            if (link.unsupportedHeritage) {
                this.fail(
                    node,
                    `Class '${link.declaration.name?.text ?? "?"}' extends '${link.unsupportedHeritage.expression.getText()}', ` +
                        "which is not a local class; a stored instance needs a local hierarchy.",
                );
            }
        }
        if (this.classHierarchy.concreteClasses(declaration).length === 0) {
            this.fail(
                node,
                `Abstract class '${className}' has no concrete class under it, so no ` +
                    "instance can be stored.",
            );
        }
    }

    /**
     * A class property's type as an instantiated class sees it.
     *
     * `new Workspace<Part>()` must resolve `_parts: P[]` to `Part[]`; asking
     * the checker at the declaration would answer with the type parameter,
     * which maps to nothing and would leave the field unbound.
     */
    public classFieldDataType(
        type: ts.Type,
        name: ts.MemberName,
    ): DataType | undefined {
        const property = this.classPropertySymbol(type, name);
        if (!property) {
            return undefined;
        }
        const stored = this.existingClassStruct(type);
        const field =
            stored &&
            this.structsByName
                .get(stored)
                ?.fields.find(
                    (candidate) => candidate.sourceName === name.text,
                );
        if (field) return field.type;
        const fieldType = this.checker.getTypeOfSymbolAtLocation(
            property,
            name,
        );
        const declared = this.fromClassFieldType(fieldType, name);
        const mapped =
            declared &&
            this.withDemandedNumericSlot(
                property.valueDeclaration,
                fieldType,
                declared,
            );
        // A class outlives the constructor expression that initializes it.
        // In particular, `readonly T[]` is readonly through the field but it is
        // still an owned JavaScript Array.  Keeping the ordinary parameter/view
        // representation (`Span<const T>`) here would leave the field pointing
        // into a temporary such as `items.map(...)` after construction returns.
        return mapped
            ? this.engineFieldStorage(
                  this.markStoredObjectReferences(mapped),
                  property.declarations,
              )
            : undefined;
    }

    /** The class one class-backed struct name stands for. */
    public classStruct(name: string): ClassStructBinding | undefined {
        return this.classStructDeclarations.get(name);
    }

    /**
     * The struct a class type has already taken, without demanding one.
     *
     * Construction asks this rather than mapping the type: a class becomes a
     * shared object because something stored it, so a class nothing stores
     * keeps the compile-time record the subset started with.
     */
    public existingClassStruct(type: ts.Type): string | undefined {
        return this.classStructNames.get(this.structIdentity(type));
    }

    /** Whether a struct name stands for a local class rather than a record. */
    public isClassStruct(name: string): boolean {
        return this.classStructDeclarations.has(name);
    }

    /**
     * The stored slot one SOURCE property name maps to, when the layout kept
     * it.
     *
     * The registry owns the spelling: it mints the slot through the same
     * identifier sanitizer every other struct field goes through, so nothing
     * outside has to re-derive it and then diverge from it.
     */
    public classStructField(
        name: string,
        property: string,
    ): DataStructField | undefined {
        return this.classStructLayout(name).find(
            (candidate) => candidate.sourceName === property,
        );
    }

    /**
     * Every stored field of a class-backed struct, in layout order, paired
     * with the source property each one came from.
     *
     * Settled when the struct is minted, so a construction reads it rather
     * than deciding it.
     */
    public classStructLayout(name: string): readonly DataStructField[] {
        return this.structsByKey.get(`class#${name}`)?.fields ?? [];
    }

    /**
     * Runs `map` with class demand set to `demanded`.
     *
     * One save/restore for both directions: a stored position raises the
     * demand, and a class's own field mapping drops it to zero so the demand
     * does not cross into a class-backed struct's layout.
     */
    private withClassDemand<T>(demanded: boolean, map: () => T): T {
        const saved = this.classDemanded;
        this.classDemanded = demanded;
        try {
            return map();
        } finally {
            this.classDemanded = saved;
        }
    }

    /** Owned Promise settlements may observe a proven void completion as undefined. */
    public fromPromiseResultType(
        type: ts.Type,
        node: ts.Node,
    ): DataType | undefined {
        const resolved = this.resolveTypeParameter(type);
        const absent = nullability(resolved);
        if (!absent.void) {
            const mapped = this.fromStoredTsType(resolved, node);
            return mapped &&
                absent.null &&
                absent.undefined &&
                mapped.kind !== "json" &&
                mapped.kind !== "tagged"
                ? undefined
                : mapped;
        }
        const present = presentMembers(resolved);
        if (present.length === 0)
            return absent.null ? { kind: "json" } : { kind: "undefined" };
        const mapped = present.map((member) =>
            this.fromStoredTsType(member, node),
        );
        if (mapped.some((member) => member === undefined)) return undefined;
        const first = mapped[0]!;
        const primitive = mapped.every(
            (member) =>
                member &&
                ["number", "boolean", "string", "enum"].includes(member.kind),
        );
        if (
            primitive &&
            (absent.null ||
                mapped.some((member) => !dataTypesEqual(first, member!)))
        )
            return { kind: "json" };
        if (
            absent.null ||
            mapped.some((member) => !dataTypesEqual(first, member!))
        )
            return undefined;
        return this.nullableType(first, true);
    }

    /** `fromTsType` in a stored position. */
    public fromStoredTsType(
        type: ts.Type,
        node: ts.Node,
    ): DataType | undefined {
        const mapped = this.withClassDemand(true, () =>
            this.fromTsType(type, node),
        );
        const absent = nullability(this.resolveTypeParameter(type));
        return mapped?.kind === "struct" && absent.null && absent.undefined
            ? {
                  kind: "tagged",
                  inner: this.markStoredObjectReferences(mapped),
              }
            : mapped;
    }

    public returnsArray(type: DataType | undefined): boolean {
        const inner = type?.kind === "optional" ? type.inner : type;
        return inner?.kind === "vector" || inner?.kind === "span";
    }

    /** Returned arrays retain their backing storage, including readonly arrays. */
    public ownReturnedArray(type: DataType): DataType {
        const inner = type.kind === "optional" ? type.inner : type;
        return inner.kind === "span"
            ? this.markStoredObjectReferences(type)
            : type;
    }

    /**
     * A readonly Array is still a JavaScript object. A parameter's callee
     * can retain it in a record, callback or another container without
     * returning an array directly, and a rebound binding holds whichever
     * array was assigned last. ArrayLike remains a borrowed view: it does
     * not promise an Array owner.
     */
    public ownReadonlyArray(type: DataType, sourceType: ts.Type): DataType {
        const inner = type.kind === "optional" ? type.inner : type;
        if (inner.kind !== "span") return type;
        const concrete = this.checker.getNonNullableType(
            this.resolveTypeParameter(sourceType),
        );
        return concrete.symbol?.name === "ReadonlyArray"
            ? this.ownReturnedArray(type)
            : type;
    }

    /** Shared returns can own local classes whose fields all have native storage. */
    public fromSharedReturnType(
        type: ts.Type,
        node: ts.Node,
    ): DataType | undefined {
        const concrete = this.checker.getNonNullableType(type);
        const mapped = this.fromTsType(type, node);
        if (mapped) {
            const stored = this.ownReturnedArray(mapped);
            const owned =
                stored.kind === "promise" && stored.result
                    ? {
                          ...stored,
                          result: this.engineOwnedStorage(stored.result),
                      }
                    : this.engineOwnedStorage(stored);
            const absent = nullability(this.resolveTypeParameter(type));
            return !dataTypesEqual(stored, owned) &&
                owned.kind !== "tagged" &&
                absent.null &&
                absent.undefined
                ? { kind: "tagged", inner: owned }
                : owned;
        }
        const symbol = concrete.symbol;
        const declaration = symbol?.declarations?.find(ts.isClassLike);
        if (
            !symbol ||
            !declaration ||
            declaredIn(symbol, "babylon") ||
            (ts.getCombinedModifierFlags(declaration) &
                ts.ModifierFlags.Abstract) !==
                0 ||
            declaration.heritageClauses?.some(
                (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
            )
        )
            return undefined;
        for (const member of classInstanceProperties(declaration)) {
            if (!ts.isMemberName(member.name)) return undefined;
            const property = this.classPropertySymbol(concrete, member.name);
            const fieldType = property
                ? this.checker.getTypeOfSymbolAtLocation(property, member.name)
                : this.checker.getTypeAtLocation(member.name);
            const field = this.fromClassFieldType(fieldType, member.name);
            if (!field || this.carriesFunction(field)) return undefined;
        }
        return this.fromStoredTsType(type, node);
    }

    /**
     * The property `name` declares on `type`, read from the instantiated
     * type's own member list: a type parameter answers as its argument, and
     * a private name is found by its spelling, which the property table
     * escapes.
     */
    private classPropertySymbol(
        type: ts.Type,
        name: ts.MemberName,
    ): ts.Symbol | undefined {
        return type
            .getProperties()
            .find((property) => property.name === name.text);
    }

    /**
     * `fromTsType` for a class's own stored field.
     *
     * The demand does not cross into a class-backed struct: a field whose type
     * is itself a local class would need that class to have a layout before
     * this one does, and a per-instance reference to another instance is not
     * part of the reached subset. Such a field is hoisted instead, and the
     * hoist has to prove itself uniform across every construction.
     */
    public fromClassFieldType(
        type: ts.Type,
        node: ts.Node,
    ): DataType | undefined {
        return this.withClassDemand(false, () => this.fromTsType(type, node));
    }

    /**
     * Recognizes `Record<Union, T>` where the key is a string-literal
     * union, and lowers it to a fixed slot per union member.
     *
     * The check is on the `Record` alias itself, so an interface that
     * happens to declare the same property names stays the struct it
     * already was.
     */
    /**
     * An object type whose string index signature types every member --
     * `{ [id: string]: number }`, or an interface declaring named entries
     * of that same type beside the signature -- is a dictionary: a
     * string-keyed map whose declared members are ordinary entries.
     * (`Record<string, T>` arrives through the alias above.) A present but
     * unrepresented signature returns null, preventing closed-record fallback.
     */
    private fromIndexSignatureType(
        type: ts.Type,
        node: ts.Node,
    ): DataType | null | undefined {
        if ((type.flags & ts.TypeFlags.Object) === 0) {
            return undefined;
        }
        const stringIndex = this.checker.getIndexInfoOfType(
            type,
            ts.IndexKind.String,
        );
        const index =
            stringIndex ??
            this.checker.getIndexInfoOfType(type, ts.IndexKind.Number);
        if (!index) return undefined;
        // An array-like view (`{ [index: number]: number; length: number }`)
        // writes through whatever numeric array it is handed.
        if (
            !stringIndex &&
            (index.type.flags & ts.TypeFlags.Number) !== 0 &&
            this.checker
                .getPropertiesOfType(type)
                .every(
                    (property) =>
                        property.name === "length" &&
                        (this.checker.getTypeOfSymbol(property).flags &
                            ts.TypeFlags.Number) !==
                            0,
                )
        ) {
            return { kind: "numberindex" };
        }
        const uniform = this.checker
            .getPropertiesOfType(type)
            .every((property) =>
                this.checker.isTypeAssignableTo(
                    this.checker.getTypeOfSymbol(property),
                    index.type,
                ),
            );
        if (!uniform) return null;
        const value = this.fromStoredTsType(index.type, node);
        return value
            ? {
                  kind: "map",
                  key: { kind: stringIndex ? "string" : "number" },
                  dictionary: true,
                  value: this.markStoredObjectReferences(value),
              }
            : null;
    }

    private fromRecordType(type: ts.Type, node: ts.Node): DataType | undefined {
        // `readonly` restricts writes in the type system only: a read-only
        // record is the record it wraps, one object and one representation.
        // One asserted from an open dictionary stays that dictionary's view.
        const readonlyTarget =
            type.aliasSymbol?.name === "Readonly" &&
            declaredInDefaultLibrary(type.aliasSymbol)
                ? type.aliasTypeArguments?.[0]
                : undefined;
        if (readonlyTarget && !this.recordViews.has(this.structIdentity(type)))
            return this.fromRecordType(readonlyTarget, node);
        const directRecordAlias =
            type.aliasSymbol?.name === "Record" &&
            declaredInDefaultLibrary(type.aliasSymbol);
        const namedRecordAlias = (type.aliasSymbol?.declarations ?? []).some(
            (declaration) =>
                ts.isTypeAliasDeclaration(declaration) &&
                ts.isTypeReferenceNode(declaration.type) &&
                ts.isIdentifier(declaration.type.typeName) &&
                libraryGlobal(this.checker, declaration.type.typeName) ===
                    "Record",
        );
        if (!directRecordAlias && !namedRecordAlias) {
            return undefined;
        }
        const [keyType, valueType] = type.aliasTypeArguments ?? [];
        if (!keyType || !valueType) {
            const stringValue = this.checker.getIndexTypeOfType(
                type,
                ts.IndexKind.String,
            );
            const numberValue = stringValue
                ? undefined
                : this.checker.getIndexTypeOfType(type, ts.IndexKind.Number);
            const indexedValue = stringValue ?? numberValue;
            if (!indexedValue) return undefined;
            const element = this.fromStoredTsType(indexedValue, node);
            if (!element) return undefined;
            return {
                kind: "map",
                key: stringValue ? { kind: "string" } : { kind: "number" },
                dictionary: true,
                value: this.markStoredObjectReferences(element),
            };
        }
        const key = this.fromStoredTsType(keyType, node);
        const element = this.fromStoredTsType(valueType, node);
        if (!element) {
            return undefined;
        }
        if (key?.kind === "string" || key?.kind === "number") {
            return {
                kind: "map",
                key: this.markStoredObjectReferences(key),
                dictionary: true,
                value: this.markStoredObjectReferences(element),
            };
        }
        if (key?.kind !== "enum") {
            return undefined;
        }
        // Asserted from `{}`, a closed record lacks each entry until it is
        // written, which a dictionary keeps apart from a stored value.
        if (this.isPartialRecord(type))
            return {
                kind: "map",
                key: { kind: "string" },
                dictionary: true,
                value: this.markStoredObjectReferences(element),
            };
        return {
            kind: "enummap",
            enumName: key.name,
            element: this.markStoredObjectReferences(element),
        };
    }

    /**
     * The union's members in tag order, which is the order the slots of
     * a `Record` keyed by it are laid out in.
     */
    public enumMembers(name: string): string[] {
        const definition = this.enumsByName.get(name);
        return definition ? [...definition.members] : [];
    }

    private registerEnum(type: ts.UnionType, literals: string[]): DataType {
        const sorted = [...literals].sort();
        const key = sorted.join("|");
        const existing = this.enumsByKey.get(key);
        if (existing) {
            return {
                kind: "enum",
                name: existing.name,
            };
        }
        const preferredName = type.aliasSymbol?.name;
        const name = this.uniqueName(
            preferredName
                ? sanitizeIdentifier(preferredName)
                : `Enum${++this.anonymousEnumIndex}`,
            this.enumNames,
        );
        const definition = { name, members: sorted };
        this.enumsByKey.set(key, definition);
        this.enumsByName.set(name, definition);
        return { kind: "enum", name };
    }

    /**
     * Resolves a string literal against an enum data type, failing when the
     * literal is not a member.
     */
    public enumMemberCpp(
        dataType: DataType & { kind: "enum" },
        literal: string,
        node: ts.Node,
    ): string {
        const definition = this.enumsByName.get(dataType.name);
        if (!definition || !definition.members.includes(literal)) {
            this.fail(
                node,
                `'${literal}' is not a member of ${dataType.name}.`,
            );
        }
        this.emittedNamedTypes.add(dataType.name);
        return `bblscene::${dataType.name}::${this.enumMemberIdentifier(definition, literal)}`;
    }

    /** A C++ identifier for one member, disambiguating punctuation aliases. */
    private enumMemberIdentifier(
        definition: DataEnumDefinition,
        literal: string,
    ): string {
        const occurrences = new EmissionMap<string, number>();
        for (const member of definition.members) {
            const base = sanitizeIdentifier(member) || "empty";
            const occurrence = (occurrences.get(base) ?? 0) + 1;
            occurrences.set(base, occurrence);
            if (member === literal) {
                return occurrence === 1 ? base : `${base}_${occurrence}`;
            }
        }
        throw new Error(`Unknown enum member '${literal}'.`);
    }

    /**
     * Converts a runtime string that TypeScript control flow narrowed to a
     * string-literal union. The parser is emitted only for enums that reach
     * this bridge, keeping ordinary literal-only enums zero-cost.
     */
    public enumFromStringCpp(
        dataType: DataType & { kind: "enum" },
        cpp: string,
        node: ts.Node,
    ): string {
        return this.enumBridgeCpp(dataType, cpp, node, "from_string");
    }

    /** Collection queries may miss the represented literal domain without throwing. */
    public enumFindStringCpp(
        dataType: DataType<"enum">,
        cpp: string,
        node: ts.Node,
    ): string {
        return this.enumBridgeCpp(dataType, cpp, node, "find_string");
    }

    /** Converts a runtime string-literal union back to its JavaScript text. */
    public enumToStringCpp(
        dataType: DataType & { kind: "enum" },
        cpp: string,
        node: ts.Node,
    ): string {
        return this.enumBridgeCpp(dataType, cpp, node, "to_string");
    }

    /**
     * One direction of the runtime string bridge: the call, and the record
     * that its parser or serializer is emitted for this enum.
     */
    private enumBridgeCpp(
        dataType: DataType & { kind: "enum" },
        cpp: string,
        node: ts.Node,
        bridge: "from_string" | "find_string" | "to_string",
    ): string {
        const definition = this.enumsByName.get(dataType.name);
        if (!definition) {
            this.fail(node, `Unknown enum '${dataType.name}'.`);
        }
        this.emittedNamedTypes.add(dataType.name);
        (bridge !== "to_string"
            ? this.runtimeEnumParsers
            : this.runtimeEnumSerializers
        ).add(dataType.name);
        return `bblscene::${dataType.name}_${bridge}(${cpp})`;
    }

    /**
     * A struct's field types, or an empty list when the struct is not
     * registered. Unlike `structFields` this asks a question rather
     * than asserting an answer, so it needs no node to blame.
     */
    public structFieldTypes(name: string): DataType[] {
        const definition = this.structsByName.get(name);
        return [
            ...(definition?.fields ?? []).flatMap((field) =>
                field.accessor ? accessorFunctionTypes(field) : [field.type],
            ),
            ...(definition?.call ? [definition.call] : []),
        ];
    }

    private registerStructDefinition(
        key: string,
        definition: DataStructDefinition,
    ): void {
        this.structsByKey.set(key, definition);
        this.structsByName.set(definition.name, definition);
    }

    /** An owned result's field layout, without changing how its source type specializes elsewhere. */
    public ownedRecordType(
        fields: readonly Omit<DataStructField, "name">[],
    ): DataType<"struct"> {
        const stored = fields.map((field) => ({
            ...field,
            name: sanitizeIdentifier(field.sourceName),
            type: this.engineFieldStorage(
                this.markStoredObjectReferences(field.type),
                field.declarations,
            ),
        }));
        const key = `owned-result:${stored
            .map(
                (field) =>
                    `${field.sourceName}:${this.typeKey(field.type)}:${field.readOnly ? "readonly" : "mutable"}:${field.defaultWhenMissing ? "default" : "required"}:${field.optionalProperty ? "optional" : "present"}:${JSON.stringify(field.presentForTags)}${accessorKey(field)}`,
            )
            .join(",")}`;
        const existing = this.structsByKey.get(key);
        if (existing) return { kind: "struct", name: existing.name };
        const name = this.uniqueName(
            `Record${++this.anonymousStructIndex}`,
            this.structNames,
        );
        this.registerStructDefinition(key, { name, fields: stored });
        this.referenceStructNames.add(name);
        return { kind: "struct", name };
    }

    /** Whether a data shape contains a stored native closure. */
    public carriesFunction(
        type: DataType,
        seen = new EmissionSet<string>(),
    ): boolean {
        return containsDataKind(
            type,
            "function",
            (name) => this.structFieldTypes(name),
            false,
            seen,
        );
    }

    /** Iterator frames cannot currently describe every suspended local edge to the cycle collector. */
    public carriesOpaqueIterator(type: DataType): boolean {
        return containsDataKind(
            type,
            "iterator",
            (name) => this.structFieldTypes(name),
            false,
            new Set(),
            (candidate) => candidate.kind === "iterator" && !candidate.traced,
        );
    }

    /**
     * Whether a value of this shape physically contains a borrowed event.
     *
     * Function signatures deliberately stop the walk: a stored handler may
     * accept an event-bearing payload without itself containing a live event.
     */
    public carriesBorrowedPlatformEvent(
        type: DataType,
        seen = new EmissionSet<string>(),
    ): boolean {
        return containsDataKind(
            type,
            "borrowed-platform-event",
            (name) => this.structFieldTypes(name),
            false,
            seen,
        );
    }

    /** Whether a value physically retains an engine beside a resource handle. */
    public carriesOwnedEngine(type: DataType): boolean {
        return containsDataKind(
            type,
            "handle",
            (name) => this.structFieldTypes(name),
            false,
            new Set(),
            (candidate) =>
                candidate.kind === "handle" && candidate.ownedEngine === true,
        );
    }

    /** Whether a plain-data shape owns an engine/PAL resource handle. */
    public carriesHandle(
        type: DataType,
        seen = new EmissionSet<string>(),
    ): boolean {
        return containsDataKind(
            type,
            "handle",
            (name) => this.structFieldTypes(name),
            true,
            seen,
        );
    }

    /**
     * A struct's fields. A use that reads or writes every field as stored
     * data refuses an accessor-backed one; the uses that run accessors pass
     * `"accessors"`.
     */
    public structFields(
        name: string,
        node: ts.Node,
        accessors?: "accessors",
    ): DataStructField[] {
        const definition = this.structsByName.get(name);
        if (!definition) {
            this.fail(node, `Unknown generated struct '${name}'.`);
        }
        if (!accessors) {
            const accessor = definition.fields.find((field) => field.accessor);
            if (accessor) this.failAccessorField(accessor, node);
        }
        return definition.fields;
    }

    /**
     * The field storing source property `property` of a struct, if any; an
     * accessor-backed one too (the caller tests `accessor`).
     */
    public findStructField(
        name: string,
        property: string,
        node: ts.Node,
    ): DataStructField | undefined {
        return this.structFields(name, node, "accessors").find(
            (field) => field.sourceName === property,
        );
    }

    /** One struct field; an accessor-backed one only for a use that runs accessors. */
    public structField(
        name: string,
        field: string,
        node: ts.Node,
        accessors?: "accessors",
    ): DataStructField {
        const found = this.structFields(name, node, "accessors").find(
            (candidate) =>
                candidate.sourceName === field || candidate.name === field,
        );
        if (!found)
            this.requireArmFields(
                name,
                field,
                node,
                `Struct ${name} has no field '${field}'.`,
            );
        if (found.accessor && !accessors) this.failAccessorField(found, node);
        return found;
    }

    /**
     * Whether `structName`'s records provably lack `property`, so a read of
     * it is `undefined`: no record type the struct stands for declares it.
     * Class instances, proxies and views of open records keep their own
     * lookup.
     */
    public absentRecordProperty(
        structName: string,
        property: string,
        node: ts.Node,
    ): boolean {
        if (!this.lacksRecordProperty(structName, property)) return false;
        this.absentProperties.read(structName, property, node);
        return true;
    }

    /**
     * Whether no record type `structName` stands for declares `property`.
     * Unlike a read, deleting it needs no check against conversions: the
     * JavaScript object lacks it afterwards either way.
     */
    public lacksRecordProperty(structName: string, property: string): boolean {
        const definition = this.structsByName.get(structName);
        if (
            !definition ||
            this.isClassStruct(structName) ||
            !AbsentRecordProperties.omittable(property) ||
            definition.fields.some(
                (field) =>
                    field.sourceName === property || field.name === property,
            )
        )
            return false;
        const source = this.nativeRecordSources.get(structName);
        if (!source) return true;
        if (
            this.recordViews.has(source.identity) ||
            this.proxyRecords.has(source.identity)
        )
            return false;
        // Union layouts can start with common fields only. A declared arm
        // field needs layout replay instead of an assumed absent value.
        return !this.withRecordDemand(source, () =>
            this.recordSourceShapes(source).some((shape) =>
                shape.getProperty(property),
            ),
        );
    }

    private recordSourceShapes(source: NativeRecordStorageDemand): ts.Type[] {
        const shapes = this.recordComponentOf(source.type)?.shapes ?? [
            source.type,
        ];
        return shapes.flatMap((shape) =>
            shape.isUnion() ? shape.types : [shape],
        );
    }

    /** Membership cannot treat a declared property omitted by a common union layout as absent. */
    public requireStoredRecordProperties(
        structName: string,
        node: ts.Node,
        property?: string,
    ): void {
        const source = this.nativeRecordSources.get(structName);
        if (!source || this.isClassStruct(structName)) return;
        this.withRecordDemand(source, () => {
            if (property !== undefined) {
                if (
                    this.recordSourceShapes(source).some((shape) =>
                        this.checker
                            .getPropertiesOfType(shape)
                            .some((declared) => declared.name === property),
                    )
                )
                    this.requireArmFields(
                        structName,
                        property,
                        node,
                        `Own-property membership requires represented field '${property}'.`,
                    );
                return;
            }
            const fields = this.structFields(structName, node, "accessors");
            const stored = new Set(fields.map((field) => field.sourceName));
            for (const shape of this.recordSourceShapes(source)) {
                for (const declared of this.checker.getPropertiesOfType(
                    shape,
                )) {
                    if (!stored.has(declared.name))
                        this.requireArmFields(
                            structName,
                            declared.name,
                            node,
                            `Own-property membership requires represented field '${declared.name}'.`,
                        );
                }
            }
        });
    }

    /**
     * A record converted into `target` storage, carrying `extra` properties
     * beyond its fields; a struct source also passes on what was carried
     * into it.
     */
    public noteRecordConversion(
        target: DataType<"struct">,
        extra: readonly string[],
        source?: DataType<"struct">,
    ): void {
        if (source?.name === target.name) return;
        this.absentProperties.noteConversion(target.name, extra, source?.name);
    }

    private failAccessorField(field: DataStructField, node: ts.Node): never {
        return this.fail(
            node,
            `Property '${field.sourceName}' is an accessor; this use reads and writes stored record fields only.`,
        );
    }

    /** The native slot type of a struct field: its value, or the accessor pair that produces it. */
    public structFieldCppType(field: DataStructField): string {
        const value = this.cppType(field.type);
        if (field.accessorReceiver)
            return `bbl::js::ReceiverAccessor<${value}, bblscene::${field.accessorReceiver}>`;
        return field.accessor ? `bbl::js::Accessor<${value}>` : value;
    }

    /**
     * The native expression naming a generated constant table. A table whose
     * construction allocates is a function-local static behind an accessor,
     * since a namespace-scope initializer that throws terminates the process.
     */
    private tableReference(name: string, allocates: boolean): string {
        return allocates ? `bblscene::${name}()` : `bblscene::${name}`;
    }

    /** Whether constructing a constant of this element type can allocate. */
    public constantAllocates(element: DataType): boolean {
        return !["number", "boolean", "enum"].includes(element.kind);
    }

    /**
     * Materializes a uniform static numeric table (nested readonly array
     * literals with numeric leaves) as a generated constant. Returns the
     * table's native reference and dimensions.
     */
    public registerTable(
        declaration: ts.Node,
        preferredName: string,
        literal: ts.ArrayLiteralExpression,
        compileLeaf: (expression: ts.Expression) => number,
    ): { reference: string; dimensions: number[] } {
        const existing = this.tables.get(declaration);
        if (existing) {
            return {
                reference: this.tableReference(existing.name, true),
                dimensions: existing.dimensions,
            };
        }
        const dimensions = this.tableDimensions(literal, compileLeaf);
        const name = this.uniqueName(
            sanitizeIdentifier(preferredName),
            this.tableNames,
        );
        const values = this.renderTableValues(literal, dimensions, compileLeaf);
        this.tables.set(declaration, {
            name,
            dimensions,
            values,
        });
        return { reference: this.tableReference(name, true), dimensions };
    }

    /**
     * Materializes a one-dimensional constant array as a generated
     * constant, so an index computed at runtime can read it. Keyed by the
     * array's declaration, so every use site shares one constant. Returns
     * the constant's native reference.
     */
    public registerConstantArray(
        declaration: ts.Node,
        preferredName: string,
        elementCppType: string,
        elements: string[],
        allocates: boolean,
        source: ts.Node = declaration,
    ): string {
        const existing = this.tagTables.get(declaration);
        if (existing) {
            return this.tableReference(existing.name, existing.allocates);
        }
        const name = this.uniqueName(
            sanitizeIdentifier(preferredName),
            this.tableNames,
        );
        this.tagTables.set(declaration, {
            name,
            elementCppType,
            elements,
            source: source.getSourceFile().fileName,
            allocates,
        });
        return this.tableReference(name, allocates);
    }

    private readonly sharedConstantArrays = new EmissionMap<string, string>();

    public registerSharedConstantArray(
        preferredName: string,
        elementCppType: string,
        elements: string[],
        allocates: boolean,
        source: ts.Node,
    ): string {
        const key = createHash("sha256")
            .update(JSON.stringify([elementCppType, elements]))
            .digest("hex");
        const existing = this.sharedConstantArrays.get(key);
        if (existing !== undefined) return existing;
        const reference = this.registerConstantArray(
            ts.factory.createNumericLiteral("0"),
            preferredName,
            elementCppType,
            elements,
            allocates,
            source,
        );
        this.sharedConstantArrays.set(key, reference);
        return reference;
    }

    private tableDimensions(
        literal: ts.ArrayLiteralExpression,
        compileLeaf: (expression: ts.Expression) => number,
    ): number[] {
        if (literal.elements.length === 0) {
            this.fail(
                literal,
                "Static tables require non-empty array literals.",
            );
        }
        const first = literal.elements[0]!;
        if (ts.isArrayLiteralExpression(first)) {
            const inner = this.tableDimensions(first, compileLeaf);
            for (const element of literal.elements) {
                if (!ts.isArrayLiteralExpression(element)) {
                    this.fail(
                        element,
                        "Static tables require uniform nesting.",
                    );
                }
                const elementDims = this.tableDimensions(element, compileLeaf);
                if (elementDims.join(",") !== inner.join(",")) {
                    this.fail(
                        element,
                        "Static tables require uniform dimensions.",
                    );
                }
            }
            return [literal.elements.length, ...inner];
        }
        for (const element of literal.elements) {
            compileLeaf(element);
        }
        return [literal.elements.length];
    }

    private renderTableValues(
        literal: ts.ArrayLiteralExpression,
        dimensions: number[],
        compileLeaf: (expression: ts.Expression) => number,
    ): string {
        // The innermost numeric row is a JavaScript tuple and every outer level
        // is a std::array aggregate. Preserve the aggregate's double braces while
        // constructing the row through Tuple's initializer-list constructor.
        if (dimensions.length === 1) {
            return `{${literal.elements
                .map((element) => doubleLiteral(compileLeaf(element)))
                .join(", ")}}`;
        }
        return `{{${literal.elements
            .map((element) =>
                this.renderTableValues(
                    element as ts.ArrayLiteralExpression,
                    dimensions.slice(1),
                    compileLeaf,
                ),
            )
            .join(", ")}}}`;
    }

    public tableCppType(dimensions: number[]): string {
        let cpp = `bbl::js::Tuple<${dimensions.at(-1)!}>`;
        for (let index = dimensions.length - 2; index >= 0; index -= 1) {
            cpp = `std::array<${cpp}, ${dimensions[index]}>`;
        }
        return cpp;
    }

    public cppType(dataType: DataType): string {
        if (["file", "blob", "file-list"].includes(dataType.kind))
            this.emittedFileType = true;
        if (dataType.kind === "json") this.emittedJsonType = true;
        if (BIGINT_KINDS.includes(dataType.kind)) this.emittedBigIntType = true;
        if (dataType.kind === "symbol") this.emittedSymbolType = true;
        if (dataType.kind === "http-response") this.emittedResponseType = true;
        if (dataType.kind === "deferred-platform-object")
            this.emittedDeferredPlatformType = true;
        if (this.isWindowType(dataType)) this.emittedWindowType = true;
        return dataTypeCppType(dataType, this.cppContext);
    }

    private isWindowType(type: DataType): boolean {
        return (
            type.kind === "handle" &&
            (type.handle === "worker-media-query" ||
                type.handle === "worker-mutation-observer")
        );
    }

    public usesWindowStorage(): boolean {
        return (
            this.emittedWindowType ||
            this.usesNamedKind("handle", (type) => this.isWindowType(type))
        );
    }

    public usesResponseStorage(): boolean {
        return this.emittedResponseType || this.usesNamedKind("http-response");
    }

    public usesDeferredPlatformStorage(): boolean {
        return (
            this.emittedDeferredPlatformType ||
            this.usesNamedKind("deferred-platform-object")
        );
    }

    /** JSON storage can occur in a defaulted field with no JSON expression. */
    public usesJsonStorage(): boolean {
        return this.emittedJsonType || this.usesNamedKind("json");
    }

    /** BigInt and Symbol storage, like JSON's, can occur with no expression of the family. */
    public usesBigIntStorage(): boolean {
        return this.emittedBigIntType || this.usesNamedKind(BIGINT_KINDS);
    }

    public usesSymbolStorage(): boolean {
        return this.emittedSymbolType || this.usesNamedKind("symbol");
    }

    public usesFileStorage(): boolean {
        return (
            this.emittedFileType ||
            this.usesNamedKind(["file", "blob", "file-list"])
        );
    }

    private usesNamedKind(
        kind: DataType["kind"] | readonly DataType["kind"][],
        matches?: (type: DataType) => boolean,
    ): boolean {
        const seen = new Set<string>();
        return [...this.emittedNamedTypes].some(
            (name) =>
                this.structsByName.has(name) &&
                containsDataKind(
                    { kind: "struct", name },
                    kind,
                    (record) => this.structFieldTypes(record),
                    true,
                    seen,
                    matches,
                ),
        );
    }

    /** @unjournaled Closures over this registry; never written. */
    private readonly cppContext: DataTypeCppContext = {
        cppType: (type) => this.cppType(type),
        namedType: (name) => {
            this.emittedNamedTypes.add(name);
            return `bblscene::${name}`;
        },
        isReferenceStruct: (name) => this.isReferenceStruct(name),
        enumSize: (name) => this.enumMembers(name).length,
        tableCppType: (dimensions) => this.tableCppType(dimensions),
    };

    private typeKey(dataType: DataType): string {
        return dataTypeKey(dataType);
    }

    private uniqueName(preferred: string, used: Set<string>): string {
        let name = preferred;
        let suffix = 1;
        while (
            used.has(name) ||
            this.structNames.has(name) ||
            this.enumNames.has(name) ||
            this.tableNames.has(name)
        ) {
            name = `${preferred}${++suffix}`;
        }
        used.add(name);
        return name;
    }

    /**
     * Registers every generated record `JSON.stringify` reaches through this
     * value, so the codec emission below writes exactly those and no others.
     *
     * A record that reaches itself has no finite document -- JavaScript
     * throws on the circular structure at run time -- and a walk that
     * emitted a codec for it would recurse until the stack ended. Refuse the
     * cycle by name instead, at the call site that asked for it.
     */
    public markJsonSerialized(dataType: DataType, node: ts.Node): void {
        const path: string[] = [];
        // `direct`: the writer names this value's own type (the stringified
        // value, a record field, a closed Record's slot); `directInner`:
        // an optional's present value is written that way too.
        const visit = (
            current: DataType,
            direct = false,
            directInner = false,
        ): void => {
            switch (current.kind) {
                case "enum":
                    this.enumToStringCpp(current, "value", node);
                    this.jsonSerializedEnums.add(current.name);
                    return;
                case "struct": {
                    if (path.includes(current.name)) {
                        this.fail(
                            node,
                            `JSON.stringify reaches a cycle through '${[...path, current.name].join(" -> ")}'; ` +
                                "a self-referential record has no JSON document.",
                        );
                    }
                    if (this.jsonSerializedStructs.has(current.name)) {
                        return;
                    }
                    this.jsonSerializedStructs.set(current.name, node);
                    path.push(current.name);
                    for (const field of this.structFields(
                        current.name,
                        node,
                        "accessors",
                    )) {
                        // JSON.stringify writes what a getter returns. A
                        // getter that may return undefined decides at run
                        // time whether the key is written at all.
                        if (
                            field.accessor &&
                            !field.accessorReceiver &&
                            field.type.kind === "optional"
                        )
                            this.fail(
                                node,
                                `JSON.stringify of accessor property '${field.sourceName}' requires a getter that always returns a value.`,
                            );
                        if (
                            field.optionalProperty &&
                            !field.accessor &&
                            !isUndefinedDataType(field.type)
                        )
                            this.ownPresence(
                                current.name,
                                field,
                                "value",
                                ".",
                                node,
                            );
                        if (field.accessorReceiver)
                            this.definedFieldValueCpp(
                                current.name,
                                field,
                                "member",
                            );
                        visit(
                            field.type,
                            true,
                            field.optionalProperty === true,
                        );
                    }
                    path.pop();
                    return;
                }
                case "optional":
                    visit(current.inner, directInner);
                    return;
                case "union":
                    current.members.forEach((member) => visit(member));
                    return;
                case "enummap":
                    // Written by its own helper, which only a writer naming
                    // the type calls.
                    if (!direct)
                        this.fail(
                            node,
                            "JSON.stringify writes a closed Record where the stringified value, a record field or another closed Record holds it.",
                        );
                    this.enumToStringCpp(
                        { kind: "enum", name: current.enumName },
                        "value",
                        node,
                    );
                    this.jsonEnumMapWriter(current);
                    visit(
                        current.element,
                        true,
                        current.element.kind === "optional" &&
                            current.element.undefinedOnly === true,
                    );
                    return;
                case "vector":
                case "span":
                    visit(current.element);
                    return;
                case "map":
                    if (!current.dictionary)
                        this.fail(
                            node,
                            "JSON.stringify does not serialize a Map value; only dictionary storage is represented.",
                        );
                    if (
                        current.key.kind !== "string" &&
                        current.key.kind !== "number"
                    ) {
                        this.fail(
                            node,
                            "JSON.stringify writes a record's keys as strings, so a map " +
                                "reaching it needs string or number keys.",
                        );
                    }
                    visit(current.value);
                    return;
                case "number":
                case "boolean":
                case "string":
                case "tuple":
                case "json":
                case "undefined":
                case "null":
                    return;
                default:
                    this.fail(
                        node,
                        `JSON.stringify does not serialize a '${current.kind}' value.`,
                    );
            }
        };
        visit(dataType, true);
    }

    /** One conversion contract for dynamic sinks and reflected native fields. */
    public jsonValueCpp(
        type: DataType,
        cpp: string,
        node: ts.Node,
    ): string | undefined {
        if (isUndefinedDataType(type))
            return `(static_cast<void>(${cpp}), bbl::js::JsonValue{})`;
        if (type.kind === "null")
            return `(static_cast<void>(${cpp}), bbl::js::JsonValue::null_value())`;
        if (type.kind === "tagged") {
            const present = this.jsonPresentValueCpp(
                type.inner,
                "value.value()",
                node,
            );
            return present === undefined
                ? undefined
                : `([](const auto& value) { return value.defined() ? ${present} : bbl::js::JsonValue{}; })(${cpp})`;
        }
        if (type.kind === "enum") {
            this.enumToStringCpp(type, cpp, node);
            this.jsonBoxedEnums.add(type.name);
            return `bblscene::json_value(${cpp})`;
        }
        if (type.kind === "struct") this.markJsonBoxed(type, node);
        else if (type.kind === "vector") {
            if (this.jsonValueCpp(type.element, "value", node) === undefined)
                return undefined;
        } else if (type.kind === "optional") {
            if (
                !type.undefinedOnly ||
                this.jsonValueCpp(type.inner, "value", node) === undefined
            )
                return undefined;
        } else if (type.kind === "union") {
            if (
                type.members.some(
                    (member) =>
                        this.jsonValueCpp(member, "value", node) === undefined,
                )
            )
                return undefined;
        } else if (type.kind === "map") {
            if (
                !type.dictionary ||
                type.key.kind !== "string" ||
                this.jsonValueCpp(type.value, "value", node) === undefined
            )
                return undefined;
        } else if (
            ![
                "json",
                "string",
                "number",
                "boolean",
                "tuple",
                "undefined",
                "error",
            ].includes(type.kind)
        )
            return undefined;
        return `bbl::js::json_value(${cpp})`;
    }

    /** A defined slot's empty native storage is null, never undefined. */
    private jsonPresentValueCpp(
        type: DataType,
        cpp: string,
        node: ts.Node,
    ): string | undefined {
        if (type.kind !== "optional") return this.jsonValueCpp(type, cpp, node);
        return this.jsonValueCpp(type.inner, "value", node) === undefined
            ? undefined
            : `bbl::js::json_value_or_null(${cpp})`;
    }

    /** Reflected fields use their declared absence, including replayed tags. */
    private jsonFieldValueCpp(
        structName: string,
        field: DataStructField,
        cpp: string,
        node: ts.Node,
    ): string | undefined {
        if (field.type.kind === "optional" && !field.type.undefinedOnly) {
            const absence =
                this.fieldPresences.get(`${structName}.${field.sourceName}`)
                    ?.absence ??
                valueAbsence(
                    (field.declarations ?? []).map((declaration) =>
                        this.checker.getTypeAtLocation(declaration),
                    ),
                );
            if (absence === "null")
                return this.jsonPresentValueCpp(field.type, cpp, node);
            if (
                absence === "undefined" ||
                (absence === undefined &&
                    field.optionalProperty &&
                    (field.declarations?.length ?? 0) > 0)
            )
                return this.jsonValueCpp(
                    { ...field.type, undefinedOnly: true },
                    cpp,
                    node,
                );
            if (absence === "either")
                for (const declaration of field.declarations ?? [])
                    requireDeclarationAbsenceTag(
                        this.storage.absenceTags,
                        declaration,
                    );
        }
        return this.jsonValueCpp(field.type, cpp, node);
    }

    /** Native object views retain the original reference and read its live fields. */
    public markJsonBoxed(type: DataType<"struct">, node: ts.Node): void {
        if (!this.isReferenceStruct(type.name)) {
            const demand = this.nativeRecordSources.get(type.name);
            if (demand) throw new NativeRecordStorageRequired(demand);
            this.fail(
                node,
                "Dynamic object storage requires an owned reference.",
            );
        }
        const source = this.classStruct(type.name);
        if (
            source &&
            classErrorBase(this.classHierarchy.table(source.declaration))
        )
            this.fail(
                node,
                "Authored Error reflection requires represented property descriptors.",
            );
        if (this.jsonBoxedStructs.has(type.name)) return;
        const stored = this.classStructLayout(type.name);
        if (source)
            for (const member of classInstanceProperties(source.declaration)) {
                const name = ts.isPrivateIdentifier(member.name)
                    ? member.name.text
                    : ts.isObjectBindingPattern(member.name) ||
                        ts.isArrayBindingPattern(member.name)
                      ? undefined
                      : propertyNameText(member.name);
                if (
                    name === undefined ||
                    !stored.some((field) => field.sourceName === name)
                )
                    this.fail(
                        node,
                        `Dynamic class storage requires a represented field '${name ?? member.name.getText()}'.`,
                    );
            }
        this.jsonBoxedStructs.set(type.name, node);
        this.cppType(type);
        for (const field of this.structFields(type.name, node, "accessors")) {
            // The view lists a field among its own keys while it is one.
            this.ownPresence(type.name, field, "value", "->", node);
            if (
                this.jsonFieldValueCpp(type.name, field, "value", node) ===
                undefined
            )
                this.fail(
                    node,
                    `Dynamic object field '${field.sourceName}' has no retained value view for ${field.type.kind}.`,
                );
        }
    }

    private renderJsonObjectViews(used: ReadonlySet<string>): string[] {
        const names = [...this.jsonBoxedStructs.keys()].filter((name) =>
            used.has(name),
        );
        const lines = names.flatMap((name) => [
            `inline bbl::js::JsonValue json_value_property(const ${name}& value, std::string_view key);`,
            `inline bbl::js::Array<std::string> json_value_keys(const ${name}& value);`,
        ]);
        for (const name of names) {
            const fields = this.structsByName.get(name)!.fields;
            const node = this.jsonBoxedStructs.get(name)!;
            const presences = fields.map((field) =>
                this.ownPresence(name, field, "value", "->", node),
            );
            lines.push(
                `inline bbl::js::JsonValue json_value_property(const ${name}&${fields.length ? " value" : ""}, std::string_view${fields.length ? " key" : ""}) {`,
            );
            fields.forEach((field, index) => {
                const property = `value->${field.name}${field.accessor ? ".get()" : ""}`;
                const cpp = this.jsonFieldValueCpp(
                    name,
                    field,
                    property,
                    node,
                )!;
                // An absent shared object reads undefined, not its null, and
                // a nullable field's empty storage refuses to guess.
                const presence = presences[index];
                const read =
                    presence &&
                    (field.type.kind === "struct" ||
                        presence.emptySlot === "ambiguous")
                        ? `${presence.ownCpp} ? ${cpp} : bbl::js::JsonValue{}`
                        : cpp;
                lines.push(
                    `    if (key == ${stringLiteral(field.sourceName)}) return ${read};`,
                );
            });
            lines.push("    return {};", "}");
            if (presences.every((presence) => presence === undefined))
                lines.push(
                    `inline bbl::js::Array<std::string> json_value_keys([[maybe_unused]] const ${name}& value) {`,
                    `    return {${fields.map((field) => stringLiteral(field.sourceName)).join(", ")}};`,
                    "}",
                    "",
                );
            else
                lines.push(
                    `inline bbl::js::Array<std::string> json_value_keys(const ${name}& value) {`,
                    "    bbl::js::Array<std::string> keys;",
                    ...fields.map((field, index) => {
                        const push = `keys.push_back(${stringLiteral(field.sourceName)});`;
                        const presence = presences[index];
                        return presence
                            ? `    if (${presence.ownCpp}) ${push}`
                            : `    ${push}`;
                    }),
                    "    return keys;",
                    "}",
                    "",
                );
        }
        return lines;
    }

    /**
     * The `json_write` overloads for the reached records, emitted beside the
     * structs themselves so ADL finds them from the generic writer. The
     * declarations come first, so a record that names another one -- in
     * either order -- resolves.
     */
    private renderJsonCodecs(used: ReadonlySet<string>): string[] {
        const names = [...this.jsonSerializedStructs.keys()].filter((name) =>
            used.has(name),
        );
        // A closed Record's writer is emitted where every record it holds is.
        const structsOf = (type: DataType): string[] =>
            type.kind === "struct"
                ? [type.name]
                : type.kind === "optional"
                  ? structsOf(type.inner)
                  : type.kind === "vector" ||
                      type.kind === "span" ||
                      type.kind === "enummap"
                    ? structsOf(type.element)
                    : type.kind === "union"
                      ? type.members.flatMap(structsOf)
                      : type.kind === "map"
                        ? structsOf(type.value)
                        : [];
        const maps = [...this.jsonEnumMaps.values()].filter(({ type }) =>
            structsOf(type).every((name) => names.includes(name)),
        );
        if (names.length === 0 && maps.length === 0) {
            return [];
        }
        const structName = (name: string): string =>
            `${name}${this.isReferenceStruct(name) ? "Data" : ""}`;
        const lines: string[] = names.map(
            (name) =>
                `inline void json_write(bbl::js::JsonWriter& writer, const ${structName(name)}& value);`,
        );
        for (const { name, type } of maps)
            lines.push(
                `inline void ${name}(bbl::js::JsonWriter& writer, const ${this.cppType(type)}& value);`,
            );
        lines.push("");
        for (const { name, type } of maps) {
            const created = this.enumMapKeyOrders.get(type.enumName);
            if (created)
                this.fail(
                    created,
                    "JSON.stringify writes a closed Record's keys in its union's order; this record creates them in another order.",
                );
            lines.push(
                `inline void ${name}(bbl::js::JsonWriter& writer, const ${this.cppType(type)}& value) {`,
                "    writer.begin_object();",
            );
            this.enumMembers(type.enumName).forEach((member, slot) => {
                const key = stringLiteral(member);
                const element = type.element;
                if (element.kind === "optional" && element.undefinedOnly)
                    lines.push(
                        `    if (${optionalPresentCpp(`value[${slot}]`)}) {`,
                        `        writer.key(${key});`,
                        `        ${this.jsonWriteCpp(element.inner, `*value[${slot}]`)}`,
                        "    }",
                    );
                else
                    lines.push(
                        `    writer.key(${key});`,
                        `    ${this.jsonWriteCpp(element, `value[${slot}]`)}`,
                    );
            });
            lines.push("    writer.end_object();", "}", "");
        }
        for (const name of names) {
            const definition = this.structsByName.get(name);
            lines.push(
                `inline void json_write(bbl::js::JsonWriter& writer, const ${structName(name)}& value) {`,
                "    writer.begin_object();",
            );
            const fields = definition?.fields ?? [];
            // JSON snapshots own keys before it reads any of their values.
            const snapshottedKeys = new Map(
                fields.flatMap((field, index) =>
                    !isSymbolPropertyKey(field.sourceName) &&
                    (field.accessorReceiver ||
                        (field.optionalProperty &&
                            !field.accessor &&
                            !isUndefinedDataType(field.type)))
                        ? [[field, `json_own_${index}`] as const]
                        : [],
                ),
            );
            for (const [field, key] of snapshottedKeys) {
                const own = field.accessorReceiver
                    ? `value.${field.name}.has_own()`
                    : (this.ownPresence(
                          name,
                          field,
                          "value",
                          ".",
                          this.jsonSerializedStructs.get(name)!,
                      )?.ownCpp ?? "true");
                lines.push(`    const bool ${key} = ${own};`);
            }
            const fieldLines = (field: DataStructField): string[] => {
                // JSON writes string-keyed properties only.
                if (isSymbolPropertyKey(field.sourceName)) return [];
                const keySnapshot = snapshottedKeys.get(field);
                if (keySnapshot) {
                    const defined = this.definedFieldValueCpp(
                        name,
                        field,
                        "member",
                    );
                    const write = isUndefinedDataType(field.type)
                        ? ["        static_cast<void>(member);"]
                        : [
                              `        writer.key(${stringLiteral(field.sourceName)});`,
                              `        ${this.jsonWriteCpp(field.type, "member")}`,
                          ];
                    return [
                        `    if (${keySnapshot}) {`,
                        `        const auto member = value.${field.name}${field.accessor ? ".get()" : ""};`,
                        ...(defined === undefined
                            ? write
                            : [
                                  `        if (${defined}) {`,
                                  ...write.map((line) => `    ${line}`),
                                  "        }",
                              ]),
                        "    }",
                    ];
                }
                if (isUndefinedDataType(field.type))
                    return [
                        `    static_cast<void>(value.${field.name}${field.accessor ? ".get()" : ""});`,
                    ];
                const key = stringLiteral(field.sourceName);
                if (
                    field.optionalProperty &&
                    field.type.kind === "struct" &&
                    this.isReferenceStruct(field.type.name)
                ) {
                    const slot = `value.${field.name}`;
                    const present =
                        this.ownPresence(
                            name,
                            field,
                            "value",
                            ".",
                            this.jsonSerializedStructs.get(name)!,
                        )?.ownCpp ?? "true";
                    return [
                        `    if (${present}) {`,
                        `        writer.key(${key});`,
                        `        json_write(writer, ${slot});`,
                        "    }",
                    ];
                }
                // An `f?: T` property is JavaScript's `undefined` when it is not
                // set, and `JSON.stringify` drops such a member outright. An
                // `f: T | null` one is present, so its key is written with `null`.
                const omittable =
                    field.optionalProperty === true &&
                    field.type.kind === "optional" &&
                    !(
                        field.type.inner.kind === "struct" &&
                        this.isReferenceStruct(field.type.inner.name)
                    );
                // A member whose value is undefined is dropped too, so an own
                // `f: T | undefined` field writes its key only while it holds
                // a value; an `f: T | null` one writes null.
                const definedCpp = omittable
                    ? undefined
                    : this.definedFieldValueCpp(name, field, "member");
                const written = omittable
                    ? [
                          `    if (${optionalPresentCpp(`value.${field.name}`)}) {`,
                          `        writer.key(${key});`,
                          `        ${this.jsonWriteCpp(field.type.kind === "optional" ? field.type.inner : field.type, `*value.${field.name}`)}`,
                          "    }",
                      ]
                    : definedCpp !== undefined
                      ? [
                            "    {",
                            `        const auto& member = value.${field.name}${field.accessor ? ".get()" : ""};`,
                            `        if (${definedCpp}) {`,
                            `            writer.key(${key});`,
                            `            ${this.jsonWriteCpp(field.type, "member")}`,
                            "        }",
                            "    }",
                        ]
                      : [
                            `    writer.key(${key});`,
                            `    ${this.jsonWriteCpp(field.type, `value.${field.name}${field.accessor ? ".get()" : ""}`)}`,
                        ];
                // A field only some union arms declare is written for them.
                return field.presentForTags && definition
                    ? [
                          `    if (${this.tagConditionCpp(definition, field.presentForTags, (tag) => `value.${tag.name}`, "")}) {`,
                          ...written.map((line) => `    ${line}`),
                          "    }",
                      ]
                    : written;
            };
            for (const field of definition?.fields ?? [])
                lines.push(...fieldLines(field));
            lines.push("    writer.end_object();", "}", "");
        }
        return lines;
    }

    /**
     * The test that a non-`?` field's value `cpp` is not JavaScript's
     * undefined, which `JSON.stringify` omits; undefined when the field
     * never holds undefined. A field whose empty slot may be null or
     * undefined refuses.
     */
    private definedFieldValueCpp(
        structName: string,
        field: DataStructField,
        cpp: string,
    ): string | undefined {
        const present = this.slotPresentCpp(field.type, cpp);
        if (present === undefined) return undefined;
        // A document keeps undefined apart from null.
        if (field.type.kind === "json" || field.type.kind === "tagged")
            return present;
        if (field.optionalProperty && !field.accessorReceiver) {
            const presence = this.ownPropertyPresence(
                structName,
                field,
                this.presenceByTags(structName, field),
            );
            if (presence === "stored") return present;
            if (presence === "nullable")
                return `bbl::js::held_own_property(${cpp}, ${stringLiteral(field.sourceName)})`;
        }
        const absence =
            this.fieldPresences.get(`${structName}.${field.sourceName}`)
                ?.absence ??
            (field.accessorReceiver
                ? valueAbsence(
                      (field.declarations ?? []).map((declaration) =>
                          this.checker.getTypeAtLocation(declaration),
                      ),
                  )
                : undefined);
        if (absence === "either")
            this.fail(
                this.jsonSerializedStructs.get(structName)!,
                `JSON.stringify cannot tell whether an empty '${field.sourceName}' holds undefined (omitted) or null (written); its type admits both.`,
            );
        return absence === "undefined" ||
            (absence === undefined &&
                field.optionalProperty &&
                field.accessorReceiver)
            ? present
            : undefined;
    }

    /**
     * Renders the generated enum, struct, and table definitions in
     * dependency order inside `namespace bblscene`.
     */
    public renderPreamble(structuredClone = false): DataPreamble {
        this.checkFieldPresenceReads();
        this.absentProperties.check();
        const used = this.reachableNamedTypes();
        if (
            used.structs.size === 0 &&
            used.enums.size === 0 &&
            this.tables.size === 0 &&
            this.tagTables.size === 0
        ) {
            return { standalone: "", shared: "", definitions: [] };
        }
        const lines: (string | (NativeDefinition & { declaration: string }))[] =
            ["namespace bblscene {", ""];
        for (const definition of this.enumsByKey.values()) {
            if (!used.enums.has(definition.name)) {
                continue;
            }
            lines.push(
                `enum class ${definition.name} {`,
                ...definition.members.map(
                    (member) =>
                        `    ${this.enumMemberIdentifier(definition, member)},`,
                ),
                "};",
                "",
            );
            if (
                structuredClone ||
                this.runtimeEnumParsers.has(definition.name)
            ) {
                lines.push(
                    `inline bbl::js::Nullable<${definition.name}> ${definition.name}_find_string(const std::string& value) {`,
                    ...definition.members.map(
                        (member) =>
                            `    if (value == ${JSON.stringify(member)}) return ${definition.name}::${this.enumMemberIdentifier(definition, member)};`,
                    ),
                    "    return {};",
                    "}",
                    `inline ${definition.name} ${definition.name}_from_string(const std::string& value) {`,
                    `    if (const auto found = ${definition.name}_find_string(value)) return *found;`,
                    `    throw std::runtime_error("Invalid ${definition.name} value: " + value);`,
                    "}",
                    "",
                );
            }
            if (
                structuredClone ||
                this.runtimeEnumSerializers.has(definition.name)
            ) {
                lines.push(
                    `inline std::string ${definition.name}_to_string(${definition.name} value) {`,
                    ...definition.members.map(
                        (member) =>
                            `    if (value == ${definition.name}::${this.enumMemberIdentifier(definition, member)}) return ${JSON.stringify(member)};`,
                    ),
                    `    throw std::runtime_error("Invalid ${definition.name} enum value.");`,
                    "}",
                    "",
                );
            }
            if (this.jsonBoxedEnums.has(definition.name)) {
                lines.push(
                    `inline bbl::js::JsonValue json_value(${definition.name} value) { return bbl::js::json_value(${definition.name}_to_string(value)); }`,
                    "",
                );
            }
            if (this.jsonSerializedEnums.has(definition.name)) {
                lines.push(
                    `inline void json_write(bbl::js::JsonWriter& writer, ${definition.name} value) { bbl::js::json_write(writer, ${definition.name}_to_string(value)); }`,
                    "",
                );
            }
            if (structuredClone) {
                lines.push(
                    `inline std::string clone_enum_value(${definition.name} value) { return ${definition.name}_to_string(value); }`,
                    `inline void clone_enum_value(${definition.name}& value, const std::string& text) { value = ${definition.name}_from_string(text); }`,
                    "",
                );
            }
        }
        const emitted = new EmissionSet<string>();
        const structs = [...this.structsByName.values()].filter((definition) =>
            used.structs.has(definition.name),
        );
        for (const name of this.referenceStructNames) {
            if (!used.structs.has(name)) {
                continue;
            }
            lines.push(
                `struct ${name}Data;`,
                `using ${name} = bbl::js::Ref<${name}Data>;`,
                "",
            );
        }
        const fieldTypes = (name: string): DataType[] =>
            this.structFieldTypes(name);
        const traceConditions = recordTraceConditions(
            this.structsByName.keys(),
            fieldTypes,
        );
        const emitStruct = (definition: DataStructDefinition): void => {
            if (emitted.has(definition.name)) {
                return;
            }
            emitted.add(definition.name);
            for (const field of [
                ...definition.fields,
                ...(definition.call ? [{ type: definition.call }] : []),
            ]) {
                for (const dependency of this.structDependencies(field.type)) {
                    const nested = structs.find(
                        (candidate) => candidate.name === dependency,
                    );
                    if (nested) {
                        emitStruct(nested);
                    }
                }
            }
            const cloneFields: DataStructField[] = [];
            const cloneCompleted = new Set<DataStructField>();
            const clonePending = new Set<DataStructField>();
            const visitCloneField = (field: DataStructField): void => {
                if (cloneCompleted.has(field)) return;
                if (clonePending.has(field))
                    throw new Error(
                        "Cyclic union field presence is not supported by structured clone.",
                    );
                clonePending.add(field);
                for (const condition of field.presentForTags?.flat() ?? [])
                    visitCloneField(
                        definition.fields.find(
                            (candidate) =>
                                candidate.sourceName === condition.discriminant,
                        )!,
                    );
                cloneFields.push(field);
                cloneCompleted.add(field);
                clonePending.delete(field);
            };
            if (structuredClone) definition.fields.forEach(visitCloneField);
            const traceCondition = traceConditions.get(definition.name)!;
            const traceFields = definition.fields.map((field) => ({
                field,
                condition: field.accessor
                    ? true
                    : tracedEdgeCondition(field.type, (name) =>
                          traceConditions.get(name)!,
                      ),
            }));
            lines.push(
                `struct ${definition.name}${this.isReferenceStruct(definition.name) ? "Data" : ""} {`,
                // Scalar members are value-initialized, so a record built
                // field by field never exposes an indeterminate value. Class
                // members keep their own construction: some (a borrowed
                // event view) have no default constructor to name.
                ...definition.fields.map(
                    (field) =>
                        `    ${this.structFieldCppType(field)} ${field.name}${
                            !field.accessor &&
                            (field.type.kind === "number" ||
                                field.type.kind === "boolean" ||
                                field.type.kind === "enum" ||
                                field.type.kind === "numberindex")
                                ? "{}"
                                : ""
                        };`,
                ),
                ...(definition.classTag
                    ? [`    int ${classTagMember}{};`]
                    : []),
                ...(definition.call
                    ? [`    ${this.cppType(definition.call)} ${callMember};`]
                    : []),
                ...this.renderKeyedSlot(definition),
                ...(definition.fields.some((field) => field.accessorReceiver)
                    ? [
                          `    void bind_accessors(const ${definition.name}& receiver) {`,
                          ...definition.fields
                              .filter((field) => field.accessorReceiver)
                              .map(
                                  (field) =>
                                      `        ${field.name}.bind_receiver(receiver);`,
                              ),
                          "    }",
                      ]
                    : []),
                // Only a record that can own a traced edge joins cycle
                // collection, and it visits only the fields that can.
                ...(traceCondition === false
                    ? []
                    : [
                          ...(typeof traceCondition === "string"
                              ? [
                                    `    template <typename = void> requires (${traceCondition})`,
                                ]
                              : []),
                          `    friend void gc_trace_edges(const ${definition.name}${this.isReferenceStruct(definition.name) ? "Data" : ""}& record, const bbl::js::TraceVisitor& visitor) {`,
                          ...traceFields
                              .filter((entry) => entry.condition !== false)
                              .map(
                                  ({ field, condition }) =>
                                      `        ${typeof condition === "string" ? `if constexpr (${condition}) ` : ""}visitor(record.${field.name});`,
                              ),
                          ...(definition.call
                              ? [`        visitor(record.${callMember});`]
                              : []),
                          "    }",
                      ]),
                ...(structuredClone
                    ? [
                          "",
                          ...["const ", ""].flatMap((qualifier) => [
                              `    template <typename Visitor> friend void clone_fields(${qualifier}${definition.name}${this.isReferenceStruct(definition.name) ? "Data" : ""}& record, Visitor&& visitor) {`,
                              ...cloneFields.map((field) => {
                                  if (field.presentForTags) {
                                      const condition = this.tagConditionCpp(
                                          definition,
                                          field.presentForTags,
                                          (tag) => `record.${tag.name}`,
                                          "",
                                      );
                                      return `        visitor.when(${stringLiteral(field.sourceName)}, record.${field.name}, ${condition});`;
                                  }
                                  return `        visitor(${stringLiteral(field.sourceName)}, record.${field.name}${field.defaultWhenMissing ? ", true" : ""});`;
                              }),
                              "    }",
                          ]),
                      ]
                    : []),
                "};",
                "",
            );
        };
        for (const definition of structs) {
            emitStruct(definition);
        }
        const emitTable = (
            source: string,
            type: string,
            name: string,
            initializer: string,
            allocates: boolean,
        ): void => {
            lines.push(
                allocates
                    ? {
                          source,
                          declaration: `const ${type}& ${name}();`,
                          definition: `const ${type}& ${name}() {\n    static const ${type} value${initializer};\n    return value;\n}`,
                      }
                    : {
                          source,
                          declaration: `extern const ${type} ${name};`,
                          definition: `const ${type} ${name}${initializer};`,
                      },
                "",
            );
        };
        for (const [node, table] of this.tables) {
            emitTable(
                node.getSourceFile().fileName,
                this.tableCppType(table.dimensions),
                table.name,
                ` = ${table.values}`,
                true,
            );
        }
        for (const table of this.tagTables.values()) {
            emitTable(
                table.source,
                `std::array<${table.elementCppType}, ${table.elements.length}>`,
                table.name,
                `{${table.elements.join(", ")}}`,
                table.allocates,
            );
        }
        lines.push(...this.renderJsonCodecs(used.structs));
        lines.push(...this.renderJsonObjectViews(used.structs));
        lines.push("}  // namespace bblscene");
        return {
            standalone: lines
                .map((line) =>
                    typeof line === "string"
                        ? line
                        : `inline ${line.definition}`,
                )
                .join("\n"),
            shared: lines
                .map((line) =>
                    typeof line === "string" ? line : line.declaration,
                )
                .join("\n"),
            definitions: lines.flatMap((line) =>
                typeof line === "string"
                    ? []
                    : [{ source: line.source, definition: line.definition }],
            ),
        };
    }

    private reachableNamedTypes(): {
        structs: Set<string>;
        enums: Set<string>;
    } {
        const structs = new EmissionSet<string>();
        const enums = new EmissionSet<string>();
        const visit = (dataType: DataType): void => {
            switch (dataType.kind) {
                case "union":
                    dataType.members.forEach(visit);
                    return;
                case "product":
                    dataType.elements.forEach(visit);
                    return;
                case "struct": {
                    if (structs.has(dataType.name)) {
                        return;
                    }
                    structs.add(dataType.name);
                    const definition = this.structsByName.get(dataType.name);
                    for (const field of definition?.fields ?? []) {
                        visit(field.type);
                    }
                    return;
                }
                case "enum":
                    enums.add(dataType.name);
                    return;
                case "optional":
                    visit(dataType.inner);
                    return;
                case "vector":
                case "set":
                case "iterator":
                case "span":
                    visit(dataType.element);
                    return;
                case "map":
                    visit(dataType.key);
                    visit(dataType.value);
                    return;
                case "function":
                    if (dataType.generic)
                        visit({ kind: "struct", name: dataType.generic });
                    for (const parameter of dataType.parameters)
                        visit(parameter);
                    if (dataType.result) visit(dataType.result);
                    return;
                case "enummap":
                    enums.add(dataType.enumName);
                    visit(dataType.element);
                    return;
                default:
                    return;
            }
        };
        for (const name of this.emittedNamedTypes) {
            const struct = this.structsByName.get(name);
            if (struct) {
                visit({ kind: "struct", name });
            } else {
                enums.add(name);
            }
        }
        for (const name of this.runtimeEnumParsers) {
            enums.add(name);
        }
        for (const name of this.runtimeEnumSerializers) {
            enums.add(name);
        }
        return { structs, enums };
    }

    private structDependencies(dataType: DataType): string[] {
        switch (dataType.kind) {
            case "union":
                return dataType.members.flatMap((member) =>
                    this.structDependencies(member),
                );
            case "product":
                return dataType.elements.flatMap((element) =>
                    this.structDependencies(element),
                );
            case "struct":
                return this.isReferenceStruct(dataType.name)
                    ? []
                    : [dataType.name];
            case "optional":
                return this.structDependencies(dataType.inner);
            case "vector":
            case "span":
                return this.structDependencies(dataType.element);
            case "function":
                return [
                    ...dataType.parameters.flatMap((parameter) =>
                        this.structDependencies(parameter),
                    ),
                    ...(dataType.result
                        ? this.structDependencies(dataType.result)
                        : []),
                ];
            default:
                return [];
        }
    }
}

export { doubleLiteral };
