import type { DataType, HandleKind } from "./data-types/model.js";
import {
    DEFERRED_DOM_OBJECTS,
    DEFERRED_INTL_OBJECTS,
} from "./data-types/model.js";
import { ERROR_CLASS_FIELDS, ERROR_CONSTRUCTORS } from "./error-values.js";
import {
    BUFFER_VIEW_KINDS,
    TYPED_ARRAY_KINDS,
} from "./data-types/typed-arrays.js";
import {
    dataTypeCppType,
    dataTypeKey,
    dataTypesEqual,
    passesByReferenceKind,
    containsDataKind,
    isUndefinedDataType,
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
    isTypedArrayType,
    typedArrayStem,
    typedArrayElement,
    typedArrayStoreExpression,
} from "./data-types/typed-arrays.js";
export {
    dataTypesEqual,
    passesByReferenceKind,
    isOpaqueReference,
    isUndefinedDataType,
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
import ts from "typescript";
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
    libraryGlobal,
    resolvedSymbol,
} from "./symbols.js";
import {
    isNullable,
    nullability,
    presentMembers,
    isTypeReference,
} from "./type-facts.js";
import { nativeReturnTsType } from "./native-return-type.js";
import { hasUndefinedCompletion } from "./undefined-values.js";
import {
    type ClassHierarchy,
    classChain,
    classErrorBase,
    classInstanceProperties,
    isStaticMember,
} from "./class-members.js";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { propertyNameText, unwrapExpression } from "./syntax.js";
import type { DataPreamble, NativeDefinition } from "./source-units.js";
import { optionalPresentCpp } from "./types.js";
import { callTypeArguments } from "./type-arguments.js";
import {
    GenericFunctionStorageRequired,
    GenericFunctionStorage,
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
     * A repository object literal (or a class that `implements` the type)
     * defines the property with `get`, and `set` when "get-set", or the
     * record is a view of an open record: the field is a `bbl::js::Accessor`
     * slot whose reads run the getter.
     */
    accessor?: StructFieldAccessor;
    /** The finite record type supplied as `this` when the slot is read. */
    accessorReceiver?: string;
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
}

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
    declaration: ts.ClassDeclaration;
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
        | "date-time-format"
        | "text-decoder"
        | "text-encoder"
        | "collator"
    ),
])[] = [
    ["Storage", "dom", "storage"],
    ["File", "dom", "file"],
    ["Blob", "dom", "blob"],
    ["FileList", "dom", "file-list"],
    ["Response", "dom", "http-response"],
    ["URLSearchParams", "dom", "search-params"],
    ["Date", "default", "date"],
    ["DateTimeFormat", "default", "date-time-format"],
    ["TextDecoder", "dom", "text-decoder"],
    ["TextEncoder", "dom", "text-encoder"],
    ["Collator", "default", "collator"],
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
            name === "ArrayBufferView")
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

/**
 * A `?` property's presence: its storage is empty exactly when the property
 * is absent, unless the storage also holds a `null` the property admits.
 * Dynamic storage keeps `undefined` apart from `null`.
 */
function storedPresence(
    type: DataType,
    admitsNull: boolean,
): OwnPropertyPresence {
    if (type.kind === "json") return "stored";
    if (
        type.kind !== "optional" &&
        type.kind !== "struct" &&
        type.kind !== "function"
    )
        return "ambiguous";
    return admitsNull ? "nullable" : "stored";
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
    if (!optional.every(Boolean)) return "ambiguous";
    return storedPresence(
        mapped,
        types.some((type) => nullability(type).null),
    );
}

/** A presence key is `<struct>.<property>`; struct names hold no dot. */
function splitPresenceKey(key: string): [string, string] {
    const dot = key.indexOf(".");
    return [key.slice(0, dot), key.slice(dot + 1)];
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
    /** Each field's own-key presence, merged over every type shape the struct stands for. */
    private readonly fieldPresence = new EmissionMap<
        string,
        OwnPropertyPresence
    >();
    /** Lowered reads of a field's presence, checked again once every shape is known. */
    private readonly fieldPresenceReads = new EmissionMap<string, ts.Node>();
    private readonly jsonBoxedEnums = new EmissionSet<string>();
    private readonly jsonSerializedEnums = new EmissionSet<string>();
    private readonly partialRecords = new EmissionSet<
        ts.Symbol | ts.Type | string
    >();

    public constructor(
        private readonly checker: ts.TypeChecker,
        private readonly fail: Fail,
        /** Which local classes extend which, for class-backed structs and dispatch. */
        public readonly classHierarchy: ClassHierarchy,
        private readonly asynchronous = false,
        private readonly genericFunctionDemands = new GenericFunctionStorage(),
    ) {}

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
                )
                    this.registerAssertedRecord(node);
            });
        }
    }

    private registerAssertedRecord(
        node: ts.AsExpression | ts.TypeAssertion,
    ): void {
        // Only the two shapes resolve types here: resolving every cast's
        // type ahead of emission would reorder the checker's unions.
        const source = unwrapExpression(node.expression);
        const partial =
            ts.isObjectLiteralExpression(source) &&
            source.properties.length === 0;
        if (!partial && !this.spellsRecordType(node.type)) return;
        const type = this.checker.getTypeAtLocation(node);
        if (
            type.getCallSignatures().length ||
            type.getConstructSignatures().length ||
            type.symbol?.declarations?.some(ts.isClassDeclaration) ||
            this.checker.getPropertiesOfType(type).length === 0
        )
            return;
        if (partial) {
            this.partialRecords.add(this.structIdentity(type));
            return;
        }
        if (ts.isObjectLiteralExpression(source)) return;
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

    public isPartialRecord(type: ts.Type): boolean {
        return this.partialRecords.has(this.structIdentity(type));
    }

    /** Property declarations a getter, and a setter, define. */
    private readonly getterProperties = new EmissionSet<ts.Node>();
    private readonly setterProperties = new EmissionSet<ts.Node>();
    /** Closed records asserted from open string-keyed records, by struct identity. */
    private readonly recordViews = new EmissionSet<
        ts.Symbol | ts.Type | string
    >();
    private readonly proxyRecords = new EmissionSet<
        NativeRecordStorageDemand["identity"]
    >();
    private readonly unionRecordLayouts = new EmissionMap<
        NativeRecordStorageDemand["identity"],
        ts.UnionType
    >();

    /** Register stronger layout demands before any nested record is mapped. */
    public prepareRecordLayouts(
        demands: Iterable<NativeRecordStorageDemand>,
    ): void {
        for (const demand of demands)
            this.withRecordDemand(demand, () => {
                if (demand.unionStorage)
                    this.unionRecordLayouts.set(
                        this.structIdentity(demand.type),
                        demand.unionStorage,
                    );
                if (demand.proxy)
                    this.proxyRecords.add(this.structIdentity(demand.type));
            });
    }

    /** A proxy and its target retain one field layout but distinct object identities. */
    public requireProxyRecord(type: DataType<"struct">, node: ts.Node): void {
        if (
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
        throw new NativeRecordStorageRequired({ ...source, proxy: true });
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
        const noteImplemented = (type: ts.Type): void => {
            for (const member of type.isUnion() ? type.types : [type])
                for (const declaration of this.checker.getPropertyOfType(
                    member,
                    name,
                )?.declarations ?? [])
                    properties.add(declaration);
        };
        if (ts.isObjectLiteralExpression(node.parent)) {
            properties.add(node);
            const contextual = this.checker.getContextualType(node.parent);
            if (contextual) noteImplemented(contextual);
            return;
        }
        if (!ts.isClassDeclaration(node.parent) || isStaticMember(node)) return;
        for (const clause of node.parent.heritageClauses ?? [])
            if (clause.token === ts.SyntaxKind.ImplementsKeyword)
                for (const implemented of clause.types)
                    noteImplemented(
                        this.checker.getTypeAtLocation(implemented),
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

    /** Resolve ownership demands before any earlier initializer or alias is emitted. */
    public predeclareOwnedRecord(demand: NativeRecordStorageDemand): void {
        this.withRecordDemand(demand, () => {
            const type = this.fromTsType(demand.type, demand.node);
            if (type?.kind !== "struct")
                this.fail(
                    demand.node,
                    "Demanded record no longer has a native object representation.",
                );
            this.markStoredObjectReferences(type);
        });
    }

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
        return apply(0);
    }

    /** Map a checker type and retain its source for a later ownership demand. */
    public fromTsType(type: ts.Type, node: ts.Node): DataType | undefined {
        if (
            this.unionRecordLayouts.size &&
            (type.flags & ts.TypeFlags.Object) !== 0
        ) {
            const layout = this.unionRecordLayouts.get(
                this.structIdentity(type),
            );
            if (layout) return this.fromTsType(layout, node);
        }
        const mapped = this.mapTsType(type, node);
        if (
            mapped?.kind === "struct" &&
            !this.nativeRecordSources.has(mapped.name)
        ) {
            this.nativeRecordSources.set(mapped.name, {
                identity: this.structIdentity(type),
                type,
                node,
                frames: this.typeArgumentFrames().map(
                    (frame) => new Map(frame),
                ),
            });
        }
        return mapped;
    }

    /** A union view must share the arm's original storage, including its fields. */
    public requireRecordUnionStorage(
        sourceType: DataType<"struct">,
        targetType: DataType<"struct">,
        node: ts.Node,
    ): void {
        const target = this.nativeRecordSources.get(targetType.name);
        if (!target?.type.isUnion()) return;
        const source = this.nativeRecordSources.get(sourceType.name);
        if (source?.type.isUnion())
            this.fail(
                node,
                "A retained record has conflicting union storage layouts.",
            );
        const fields = this.structFields(targetType.name, node, "accessors");
        if (
            source &&
            !source.frames.length &&
            !target.frames.length &&
            (source.type.flags & ts.TypeFlags.Object) !== 0 &&
            this.structFields(sourceType.name, node, "accessors").every(
                (field) => {
                    const target = fields.find(
                        (target) => target.sourceName === field.sourceName,
                    );
                    return (
                        target &&
                        !field.accessor &&
                        !target.accessor &&
                        this.sharedUnionFieldStorage(field.type, target.type)
                    );
                },
            )
        )
            throw new NativeRecordStorageRequired({
                ...source,
                unionStorage: target.type,
            });
        this.fail(
            node,
            "A retained record union requires one shared layout preserving its original fields and storage kinds.",
        );
    }

    private sharedUnionFieldStorage(
        source: DataType,
        target: DataType,
    ): boolean {
        if (dataTypesEqual(source, target)) return true;
        if (
            (source.kind === "string" || source.kind === "enum") &&
            (target.kind === "string" || target.kind === "enum")
        )
            return true;
        if (source.kind === "tuple" && target.kind === "vector")
            return target.element.kind === "number";
        if (
            (source.kind === "span" || source.kind === "vector") &&
            target.kind === "vector"
        )
            return dataTypesEqual(source.element, target.element);
        if (source.kind === "optional" && target.kind === "optional")
            return this.sharedUnionFieldStorage(source.inner, target.inner);
        return false;
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
        if (
            (type.flags &
                (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) !==
            0
        ) {
            return { kind: "string" };
        }
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
            return this.fromStructType(type, node);
        }
        if ((type.flags & ts.TypeFlags.Object) === 0) {
            return undefined;
        }
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
        const deferredObject =
            (declaredInDomLibrary(type.symbol) &&
                DEFERRED_DOM_OBJECTS.find(
                    (name) => name === type.symbol.name,
                )) ||
            (declaredIn(type.symbol, "default-lib") &&
                DEFERRED_INTL_OBJECTS.find(
                    (name) => name === type.symbol.name,
                ));
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
            if (type.symbol?.name === "GPUAdapter")
                return { kind: "gpu-adapter" };
        }
        // Every name below is the library's own type only when the library
        // declares it: a program's `interface DataView` is its own record.
        const library = declaredInDefaultLibrary(type.symbol);
        if (library && type.symbol.name === "ArrayBuffer") {
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
            (type.symbol.declarations ?? []).some(ts.isClassDeclaration)
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
        const pinnedHandle = pinnedHandleKind(type);
        if (pinnedHandle) {
            return { kind: "handle", handle: pinnedHandle };
        }
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
                    const result = this.fromStoredTsType(resolvedType, node);
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
                          ...(symbolName === "SetIterator"
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
                const element = this.fromStoredTsType(elementType, node);
                if (!element) {
                    return undefined;
                }
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
                const value = this.fromStoredTsType(valueType, node);
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
                        this.markStoredObjectReferences(key),
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
                        element: {
                            kind: "handle",
                            handle: "dom-event-identity",
                        },
                    };
                return element
                    ? {
                          kind: "set",
                          element: markIdentityFunctions(
                              this.markStoredObjectReferences(element),
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
            return this.classDemanded
                ? this.fromGenericFunction(signature, node)
                : undefined;
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
                if (nullability(declaredType).undefined)
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
                            ));
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
                return mapped
                    ? [
                          markIdentityFunctions(
                              this.ownReadonlyArrayParameter(
                                  mapped,
                                  parameterType,
                              ),
                          ),
                      ]
                    : [undefined];
            });
        if (parameters.some((parameter) => parameter === undefined)) {
            return undefined;
        }
        const signatureResult = this.resolveTypeParameter(
            this.checker.getReturnTypeOfSignature(resultOverride ?? signature),
        );
        const resultType =
            this.asynchronous &&
            (signatureResult.flags &
                (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) ===
                0
                ? signatureResult
                : nativeReturnTsType(
                      this.checker,
                      signatureResult,
                      signature.declaration,
                  );
        const mappedResult = resultType
            ? ((this.dynamicJsonStorage
                  ? this.dynamicJsonType(resultType)
                  : undefined) ?? this.fromStoredTsType(resultType, node))
            : undefined;
        const result = mappedResult
            ? this.ownReturnedArray(mappedResult)
            : undefined;
        if (resultType && !result) {
            return undefined;
        }
        return {
            kind: "function",
            ...(restParameter === undefined ? {} : { restParameter }),
            parameters: (parameters as DataType[]).map((parameter) =>
                this.returnsArray(result)
                    ? this.ownReturnedArray(parameter)
                    : parameter,
            ),
            ...(result ? { result } : {}),
            ...(resultOverride &&
            hasUndefinedCompletion(this.checker, resultOverride.declaration)
                ? { undefinedCompletion: true as const }
                : {}),
            ...(erasedParameters.length > 0 ? { erasedParameters } : {}),
            ...(optionalParameters.length > 0 ? { optionalParameters } : {}),
        };
    }

    private fromGenericFunction(
        signature: ts.Signature,
        node: ts.Node,
    ): DataType<"function"> | undefined {
        const declaration = signature.declaration;
        if (!declaration || ts.isJSDocSignature(declaration)) return undefined;
        const family = this.genericFunctionDemands.family(
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
        for (const demand of this.genericFunctionDemands.get(family)) {
            const type = this.withGenericFunctionArguments(
                declaration,
                demand,
                () =>
                    this.fromFunctionType(
                        this.checker.getTypeAtLocation(declaration),
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

    public genericFunctionCall(
        name: string,
        call: ts.CallExpression,
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
                return this.checker.getTypeAtLocation(argument);
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
                              const type = this.checker.getTypeAtLocation(
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
        };
        const field = generic.fields.find((field) =>
            sameGenericFunctionSignature(field.demand, demand),
        );
        if (field) return field;
        if (this.genericFunctionAncestors.includes(generic.family))
            this.fail(
                call,
                "Recursive stored generic functions require an already represented signature.",
            );
        throw new GenericFunctionStorageRequired(demand, call);
    }

    private fromUnionType(
        type: ts.UnionType,
        node: ts.Node,
    ): DataType | undefined {
        const members = type.types;
        const handles = members.map(pinnedHandleKind);
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
                              this.markStoredObjectReferences(element),
                          ),
                      }
                    : undefined;
            } finally {
                this.arrayUnionsInProgress.delete(type);
            }
        }
        // Library binary classes keep their own storage, which `instanceof`
        // selects; a common-field record would drop `buffer` and the elements.
        if (type.types.every(binaryLibraryClass))
            return this.fromMixedUnion(type, node);
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
            !type.types.every(binaryLibraryClass)
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
        const presences: OwnPropertyPresence[] = [];
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
            const stored = this.markStoredObjectReferences(first);
            fields.push({
                sourceName: property.name,
                name: sanitizeIdentifier(property.name),
                type: stored,
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
            presences.push(unionPresence(memberProperties, memberTypes, first));
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
                    member.symbol?.declarations?.some(ts.isClassDeclaration) ||
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
        const presences: OwnPropertyPresence[] = [];
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
            const stored = this.markStoredObjectReferences(first);
            const fieldType = absent ? this.nullableType(stored, true) : stored;
            fields.push({
                sourceName: propertyName,
                name: sanitizeIdentifier(propertyName),
                type: fieldType,
                ...(absent
                    ? { optionalProperty: true, defaultWhenMissing: true }
                    : {}),
                ...(!absent && members.every(propertyIsReadOnly)
                    ? { readOnly: true }
                    : {}),
            });
            presences.push(
                absent ? "stored" : unionPresence(members, memberTypes, first),
            );
        }
        return this.internMappedStruct(name, fields, presences);
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
    ): DataType | undefined | null {
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
                        const value = literalTagValue(
                            this.checker,
                            this.checker.getTypeOfSymbolAtLocation(
                                property,
                                declaration,
                            ),
                        );
                        return value === undefined
                            ? []
                            : [[property.name, value] as const];
                    }),
                ),
        );
        // Several tags may distinguish an arm: a boolean success flag can group
        // multiple failures, whose reason then selects the remaining payload.
        const distinguish = (
            index: number,
            others: number[],
            exclude?: string,
        ) => {
            const conditions: Array<{ discriminant: string; value: string }> =
                [];
            let remaining = others;
            while (remaining.length > 0) {
                const candidates = [...tags[index]!]
                    .filter(([name]) => name !== exclude)
                    .map(([name, value]) => ({
                        discriminant: name,
                        value,
                        covered: remaining.filter(
                            (other) =>
                                tags[other]!.has(name) &&
                                tags[other]!.get(name) !== value,
                        ),
                    }))
                    .sort(
                        (left, right) =>
                            right.covered.length - left.covered.length,
                    );
                const selected = candidates[0];
                if (!selected?.covered.length) return undefined;
                conditions.push({
                    discriminant: selected.discriminant,
                    value: selected.value,
                });
                remaining = remaining.filter(
                    (other) => !selected.covered.includes(other),
                );
            }
            return conditions;
        };
        const indices = type.types.map((_member, index) => index);
        if (
            indices.some(
                (index) =>
                    !distinguish(
                        index,
                        indices.filter((other) => other !== index),
                    ),
            )
        )
            return undefined;

        const propertyNames: string[] = [];
        for (const properties of propertiesByMember) {
            for (const property of properties) {
                if (!propertyNames.includes(property.name)) {
                    propertyNames.push(property.name);
                }
            }
        }
        const fields: DataStructField[] = [];
        const presences: OwnPropertyPresence[] = [];
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
                mapped = this.registerEnum(
                    type,
                    literalStrings.map(
                        (propertyType) =>
                            (propertyType as ts.StringLiteralType).value,
                    ),
                );
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
                    if (!mapped) return null;
                } else {
                    mapped = first;
                }
            }
            fields.push({
                sourceName: propertyName,
                name: sanitizeIdentifier(propertyName),
                type: this.markStoredObjectReferences(mapped),
                ...(memberProperties.some(
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
                ...(propertyTypes.length < type.types.length
                    ? {
                          defaultWhenMissing: true,
                          presentForTags: indices.flatMap((index) => {
                              if (
                                  !propertiesByMember[index]!.some(
                                      (property) =>
                                          property.name === propertyName,
                                  )
                              )
                                  return [];
                              const absent = indices.filter(
                                  (other) =>
                                      !propertiesByMember[other]!.some(
                                          (property) =>
                                              property.name === propertyName,
                                      ),
                              );
                              const conditions = distinguish(
                                  index,
                                  absent,
                                  propertyName,
                              );
                              if (!conditions)
                                  throw new Error(
                                      "A union field must be distinguished by another tag.",
                                  );
                              return [conditions];
                          }),
                      }
                    : {}),
            });
            // A field some arms lack is an own key by tag, which no
            // presence read decides.
            presences.push(
                propertyTypes.length < type.types.length
                    ? "ambiguous"
                    : unionPresence(
                          memberProperties,
                          propertyTypes,
                          fields.at(-1)!.type,
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
            if (type.kind === "optional") append(type.inner);
            else if (type.kind === "union") type.members.forEach(append);
            else if (type.kind === "enum") append({ kind: "string" });
            else if (!members.some((member) => dataTypesEqual(member, type)))
                members.push(type);
        };
        elements
            .map((element) => this.markStoredObjectReferences(element))
            .forEach(append);
        const undefinedOnly = elements.every(
            (element) => element.kind !== "optional" || element.undefinedOnly,
        )
            ? true
            : undefined;
        return {
            kind: "vector",
            element: {
                kind: "optional",
                ...(undefinedOnly ? { undefinedOnly } : {}),
                inner:
                    members.length === 1
                        ? members[0]!
                        : { kind: "union", members },
            },
        };
    }

    private fromStructType(type: ts.Type, node: ts.Node): DataType | undefined {
        const preferredName =
            type.aliasSymbol?.name ??
            (type.symbol &&
            type.symbol.name !== "__type" &&
            type.symbol.name !== "__object"
                ? type.symbol.name
                : undefined);
        return (
            this.mapRecursiveStruct(type, preferredName, (name) =>
                this.fromStructTypeInner(
                    type,
                    node,
                    name,
                    preferredName !== undefined || this.classDemanded,
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
        declaration: ts.ClassDeclaration,
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

    private resolveTypeParameter(type: ts.Type): ts.Type {
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
        // A generic alias symbol names the factory, not one instantiation.
        // `Record<ClosedKeys, T>` and `Record<string, U>` therefore share the
        // global `Record` symbol while exposing different property sets. Key
        // instantiated aliases by the checker type itself so one mapping
        // cannot poison the next; non-generic aliases and named interfaces
        // retain their stable symbol identity.
        if (type.aliasSymbol && (type.aliasTypeArguments?.length ?? 0) > 0) {
            return type;
        }
        // The same collision exists one level down, where a generic interface
        // or class is instantiated rather than aliased: `WorkspaceRaycastHit<P>`
        // and `WorkspaceRaycastHit<Part>` are two types sharing one declaration
        // symbol, and keying both by that symbol hands the second whatever the
        // first resolved to.
        const objectType = type as ts.ObjectType;
        if (
            (objectType.objectFlags & ts.ObjectFlags.Reference) !== 0 &&
            this.checker.getTypeArguments(type as ts.TypeReference).length > 0
        ) {
            return type;
        }
        // And the same collision again where there is no name to share at all:
        // an inline `{ part: P; distance: number }` is written once, so every
        // instantiation of it carries that one type literal's symbol while the
        // checker mints a type per instantiation. The instantiated type is its
        // own identity; an anonymous object that was never instantiated is the
        // one shape its symbol names, and keeps it.
        if (
            (objectType.objectFlags &
                (ts.ObjectFlags.Anonymous | ts.ObjectFlags.Instantiated)) ===
            (ts.ObjectFlags.Anonymous | ts.ObjectFlags.Instantiated)
        ) {
            return type;
        }
        return type.aliasSymbol ?? type.symbol ?? type;
    }

    /** Required undefined fields own a key independently of their payload. */
    private fromRecordFieldType(
        type: ts.Type,
        node: ts.Node,
        property?: ts.Symbol,
    ): DataType | undefined {
        const resolved = this.resolveTypeParameter(type);
        const members = resolved.isUnion() ? resolved.types : [resolved];
        if (
            !members.every(
                (member) =>
                    (member.flags &
                        (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !==
                    0,
            )
        )
            return this.fromTsType(type, node);
        if (property && (property.flags & ts.SymbolFlags.Optional) !== 0)
            return this.nullableType({ kind: "undefined" }, true);
        return { kind: "undefined" };
    }

    /** Intersection constraints keep their refinements without hiding concrete generic fields. */
    private structProperties(type: ts.Type): readonly ts.Symbol[] {
        const properties = this.checker.getPropertiesOfType(type);
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

    private fromStructTypeInner(
        type: ts.Type,
        node: ts.Node,
        provisionalName: string,
        allowStoredFunctions: boolean,
    ): DataType | undefined {
        if (isDomEventType(this.checker, type)) return undefined;
        const properties = this.structProperties(type);
        if (properties.length === 0) {
            return undefined;
        }
        const fields: DataStructField[] = [];
        const presences: OwnPropertyPresence[] = [];
        const partial = this.isPartialRecord(type);
        const view = this.recordViews.has(this.structIdentity(type));
        const proxy = this.proxyRecords.has(this.structIdentity(type));
        for (const property of properties) {
            const declaration =
                property.valueDeclaration ?? property.declarations?.[0];
            const propertyType = this.checker.getTypeOfSymbolAtLocation(
                property,
                declaration ?? node,
            );
            const callableType = this.checker.getNonNullableType(propertyType);
            const mappedValue =
                callableType.getCallSignatures().length > 0
                    ? allowStoredFunctions &&
                      declaration !== undefined &&
                      (ts.isPropertySignature(declaration) ||
                          ts.isMethodSignature(declaration) ||
                          ts.isMethodDeclaration(declaration) ||
                          (this.classDemanded &&
                              (ts.isPropertyAssignment(declaration) ||
                                  ts.isShorthandPropertyAssignment(
                                      declaration,
                                  ))))
                        ? this.fromFunctionType(
                              callableType,
                              declaration ?? node,
                          )
                        : undefined
                    : // A record's own field inherits the position the record is in
                      // rather than demanding one: an interface written to carry a
                      // scene's singletons -- a tool context holding the workspace, the
                      // mouse and the dragger -- is a compile-time record, and giving
                      // each of those a runtime object because a field names them would
                      // turn every one of them into a shared allocation nothing shares.
                      this.fromRecordFieldType(
                          propertyType,
                          declaration ?? node,
                          property,
                      );
            if (!mappedValue) {
                return undefined;
            }
            const optional =
                partial || (property.flags & ts.SymbolFlags.Optional) !== 0;
            const mapped: DataType = this.markStoredObjectReferences(
                markIdentityFunctions(
                    optional
                        ? this.nullableType(
                              mappedValue,
                              mappedValue.kind === "undefined",
                          )
                        : mappedValue,
                ),
            );
            const accessor = this.propertyAccessor(property, view || proxy);
            fields.push({
                sourceName: property.name,
                name: sanitizeIdentifier(property.name),
                type: mapped,
                ...(accessor ? { accessor } : {}),
                ...(proxy ? { accessorReceiver: provisionalName } : {}),
                ...(propertyIsReadOnly(property) ? { readOnly: true } : {}),
                ...(optional ? { optionalProperty: true } : {}),
                ...(partial ? { uncheckedProperty: true } : {}),
                ...(optional && mapped.kind !== "optional"
                    ? { defaultWhenMissing: true }
                    : {}),
            });
            presences.push(
                optional && (!accessor || proxy)
                    ? storedPresence(mapped, nullability(propertyType).null)
                    : "own",
            );
        }
        if (partial || proxy) {
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
        return this.internMappedStruct(provisionalName, fields, presences);
    }

    private internMappedStruct(
        provisionalName: string,
        fields: DataStructField[],
        presences: OwnPropertyPresence[],
    ): DataType<"struct"> {
        // A union's stored element and a callback's declared result share an
        // object when their field layouts agree, regardless of mapping path.
        const key = fields
            .map(
                (field) =>
                    `${field.sourceName}:${field.name}:${this.typeKey(field.type)}:${field.defaultWhenMissing ? "default" : "required"}:${field.readOnly ? "readonly" : "mutable"}:${field.optionalProperty ? "optional" : "present"}:${field.uncheckedProperty ? "unchecked" : "checked"}:${JSON.stringify(field.presentForTags)}${accessorKey(field)}`,
            )
            .join(",");
        const existing = this.structsByKey.get(key);
        const name =
            existing && !this.referenceStructNames.has(provisionalName)
                ? existing.name
                : provisionalName;
        this.recordFieldPresence(name, fields, presences);
        if (name === provisionalName)
            this.registerStructDefinition(key, { name, fields });
        return { kind: "struct", name };
    }

    /**
     * Merges the own-key presence a type shape gives each field into what
     * its struct already holds: shapes that disagree (`f?: T` beside
     * `f: T | undefined`) leave the field ambiguous.
     */
    private recordFieldPresence(
        structName: string,
        fields: readonly DataStructField[],
        presences: readonly OwnPropertyPresence[],
    ): void {
        fields.forEach((field, index) => {
            const key = `${structName}.${field.sourceName}`;
            const presence = presences[index]!;
            const previous = this.fieldPresence.get(key);
            this.fieldPresence.set(
                key,
                previous === undefined || previous === presence
                    ? presence
                    : "ambiguous",
            );
        });
    }

    /**
     * A field's own-key presence. A field no type shape recorded (a class
     * field, an owned result) answers from its own declaration.
     */
    public ownPropertyPresence(
        structName: string,
        field: DataStructField,
    ): OwnPropertyPresence {
        return (
            this.fieldPresence.get(`${structName}.${field.sourceName}`) ??
            (field.optionalProperty || field.uncheckedProperty
                ? storedPresence(field.type, false)
                : "own")
        );
    }

    /**
     * The run-time test that `field` is an own key of the struct `slot`
     * stores it in, or undefined when it always is. A nullable field's empty
     * storage refuses at run time; an ambiguous field refuses here, and the
     * read is checked again once every shape is known.
     */
    public ownPropertyPresentCpp(
        structName: string,
        field: DataStructField,
        slot: string,
        node: ts.Node,
    ): string | undefined {
        const presence = this.ownPropertyPresence(structName, field);
        if (presence === "ambiguous") this.refuseAmbiguousPresence(field, node);
        if (presence === "own") return undefined;
        this.fieldPresenceReads.set(`${structName}.${field.sourceName}`, node);
        const stored = field.accessorReceiver ? `${slot}.has_own()` : slot;
        if (presence === "nullable")
            return `bbl::js::held_own_property(${stored}, ${stringLiteral(field.sourceName)})`;
        if (field.accessorReceiver) return stored;
        return field.type.kind === "optional"
            ? optionalPresentCpp(slot)
            : field.type.kind === "json"
              ? `!${slot}.is_undefined()`
              : `static_cast<bool>(${slot})`;
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
        for (const [key, node] of this.fieldPresenceReads) {
            if (this.fieldPresence.get(key) !== "ambiguous") continue;
            const [structName, sourceName] = splitPresenceKey(key);
            const field = this.structsByName
                .get(structName)
                ?.fields.find(
                    (candidate) => candidate.sourceName === sourceName,
                );
            if (field) this.refuseAmbiguousPresence(field, node);
        }
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
            ts.isClassDeclaration,
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
            sanitizeIdentifier(declaration.name?.text ?? "Instance"),
            this.structNames,
        );
        this.classStructNames.set(identity, name);
        this.classStructDeclarations.set(name, { declaration, type });
        this.referenceStructNames.add(name);
        this.registerStructDefinition(`class#${name}`, {
            name,
            fields: this.classStructFields(declaration, type),
        });
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
        declaration: ts.ClassDeclaration,
        node: ts.Node,
    ): DataType {
        const root = this.classHierarchy.root(declaration);
        const classes = this.classHierarchy.hierarchyClasses(root);
        const typeOf = (member: ts.ClassDeclaration): ts.Type => {
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
        classes.forEach((member, index) => {
            for (const field of this.classStructFields(member, types[index]!)) {
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
        declaration: ts.ClassDeclaration,
        type: ts.Type,
    ): DataStructField[] {
        const table = this.classHierarchy.table(declaration);
        const errorBase = classErrorBase(table);
        const fields: DataStructField[] = table.errorBase
            ? ERROR_CLASS_FIELDS.map((field) => ({ ...field }))
            : [];
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
            const mapped =
                this.fromFunctionType(
                    this.checker.getNonNullableType(propertyType),
                    member.name,
                    true,
                ) ?? this.fromClassFieldType(propertyType, member.name);
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
                type: this.markStoredObjectReferences(
                    markIdentityFunctions(mapped),
                ),
                ...(member.modifiers?.some(
                    (modifier) =>
                        modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
                )
                    ? { readOnly: true }
                    : {}),
            };
            fields.push(field);
            fieldsByName.set(sourceName, field);
        }
        return fields;
    }

    /**
     * The shapes that cannot be one concrete `Ref<XData>`: a class whose
     * `extends` names something other than a local class, and a class no
     * instance can have -- abstract with no concrete class under it.
     */
    private rejectUnsupportedRuntimeClass(
        declaration: ts.ClassDeclaration,
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
        const mapped = this.fromClassFieldType(
            this.checker.getTypeOfSymbolAtLocation(property, name),
            name,
        );
        // A class outlives the constructor expression that initializes it.
        // In particular, `readonly T[]` is readonly through the field but it is
        // still an owned JavaScript Array.  Keeping the ordinary parameter/view
        // representation (`Span<const T>`) here would leave the field pointing
        // into a temporary such as `items.map(...)` after construction returns.
        return mapped ? this.markStoredObjectReferences(mapped) : undefined;
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

    /** `fromTsType` in a stored position. */
    public fromStoredTsType(
        type: ts.Type,
        node: ts.Node,
    ): DataType | undefined {
        return this.withClassDemand(true, () => this.fromTsType(type, node));
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
     * A readonly Array parameter is still a JavaScript object. Its callee
     * can retain it in a record, callback or another container without
     * returning an array directly. ArrayLike remains a borrowed view: it
     * does not promise an Array owner.
     */
    public ownReadonlyArrayParameter(
        type: DataType,
        sourceType: ts.Type,
    ): DataType {
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
        const resource = isPinnedType(concrete, [
            "PbrMaterialProps",
            "StandardMaterialProps",
        ])
            ? "material"
            : isPinnedType(concrete, ["AssetContainer"])
              ? "asset"
              : undefined;
        if (resource) {
            const handle: DataType = { kind: "handle", handle: resource };
            return concrete === type
                ? handle
                : { kind: "optional", inner: handle };
        }
        const mapped = this.fromTsType(type, node);
        if (mapped) return this.ownReturnedArray(mapped);
        if (
            (concrete.flags & ts.TypeFlags.Object) !== 0 &&
            ((concrete as ts.ObjectType).objectFlags &
                ts.ObjectFlags.Reference) !==
                0 &&
            (concrete.symbol?.name === "Array" ||
                concrete.symbol?.name === "ReadonlyArray") &&
            declaredInDefaultLibrary(concrete.symbol)
        ) {
            const [element] = this.checker.getTypeArguments(
                concrete as ts.TypeReference,
            );
            if (
                element &&
                isPinnedType(element, [
                    "PbrMaterialProps",
                    "StandardMaterialProps",
                    "AssetContainer",
                ])
            ) {
                const stored = this.fromSharedReturnType(element, node);
                if (stored) {
                    const array: DataType = { kind: "vector", element: stored };
                    return concrete === type
                        ? array
                        : { kind: "optional", inner: array };
                }
            }
        }
        const symbol = concrete.symbol;
        const declaration = symbol?.declarations?.find(ts.isClassDeclaration);
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
        if (
            !stringIndex &&
            (index.type.flags & ts.TypeFlags.Number) !== 0 &&
            this.checker.getPropertiesOfType(type).length === 0
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
        return (definition?.fields ?? []).flatMap((field) =>
            field.accessor ? accessorFunctionTypes(field) : [field.type],
        );
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
            type: this.markStoredObjectReferences(field.type),
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

    /** The shared structural view of two record types, if one is non-empty. */
    public commonStruct(
        left: Extract<DataType, { kind: "struct" }>,
        right: Extract<DataType, { kind: "struct" }>,
    ): Extract<DataType, { kind: "struct" }> | undefined {
        if (dataTypesEqual(left, right)) return left;
        const fieldsFor = (name: string): DataStructField[] =>
            this.structsByName.get(name)?.fields ?? [];
        const rightFields = new EmissionMap(
            fieldsFor(right.name).map((field) => [field.sourceName, field]),
        );
        const fields = fieldsFor(left.name).filter((field) => {
            const candidate = rightFields.get(field.sourceName);
            return (
                candidate &&
                dataTypesEqual(candidate.type, field.type) &&
                candidate.accessor === field.accessor
            );
        });
        if (fields.length === 0) return undefined;
        const key = fields
            .map(
                (field) =>
                    `${field.sourceName}:${field.name}:${this.typeKey(field.type)}:required${accessorKey(field)}`,
            )
            .join(",");
        const existing = this.structsByKey.get(key);
        if (existing) return { kind: "struct", name: existing.name };
        const name = this.uniqueName(
            `Record${++this.anonymousStructIndex}`,
            this.structNames,
        );
        this.registerStructDefinition(key, {
            name,
            fields: fields.map(
                ({ sourceName, name: fieldName, type, accessor }) => ({
                    sourceName,
                    name: fieldName,
                    type,
                    ...(accessor ? { accessor } : {}),
                }),
            ),
        });
        return { kind: "struct", name };
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
        if (!found) {
            this.fail(node, `Struct ${name} has no field '${field}'.`);
        }
        if (found.accessor && !accessors) this.failAccessorField(found, node);
        return found;
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
        const visit = (current: DataType): void => {
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
                        if (field.accessor && field.type.kind === "optional")
                            this.fail(
                                node,
                                `JSON.stringify of accessor property '${field.sourceName}' requires a getter that always returns a value.`,
                            );
                        if (
                            field.optionalProperty &&
                            field.type.kind === "struct" &&
                            this.isReferenceStruct(field.type.name)
                        )
                            this.ownPropertyPresentCpp(
                                current.name,
                                field,
                                "value",
                                node,
                            );
                        visit(field.type);
                    }
                    path.pop();
                    return;
                }
                case "optional":
                    visit(current.inner);
                    return;
                case "union":
                    current.members.forEach(visit);
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
                    return;
                default:
                    this.fail(
                        node,
                        `JSON.stringify does not serialize a '${current.kind}' value.`,
                    );
            }
        };
        visit(dataType);
    }

    /** One conversion contract for dynamic sinks and reflected native fields. */
    public jsonValueCpp(
        type: DataType,
        cpp: string,
        node: ts.Node,
    ): string | undefined {
        if (isUndefinedDataType(type))
            return `(static_cast<void>(${cpp}), bbl::js::JsonValue{})`;
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
            ].includes(type.kind)
        )
            return undefined;
        return `bbl::js::json_value(${cpp})`;
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
        if (this.jsonBoxedStructs.has(type.name)) return;
        const stored = this.classStructLayout(type.name);
        const source = this.classStruct(type.name);
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
            this.ownPropertyPresentCpp(type.name, field, "value", node);
            if (this.jsonValueCpp(field.type, "value", node) === undefined)
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
            const present = fields.map((field) =>
                this.ownPropertyPresentCpp(
                    name,
                    field,
                    `value->${field.name}`,
                    node,
                ),
            );
            lines.push(
                `inline bbl::js::JsonValue json_value_property(const ${name}&${fields.length ? " value" : ""}, std::string_view${fields.length ? " key" : ""}) {`,
            );
            fields.forEach((field, index) => {
                const property = `value->${field.name}${field.accessor ? ".get()" : ""}`;
                const cpp = this.jsonValueCpp(field.type, property, node)!;
                // An absent shared object reads undefined, not its null, and
                // a nullable field's empty storage refuses to guess.
                const read =
                    present[index] &&
                    (field.type.kind === "struct" ||
                        this.ownPropertyPresence(name, field) === "nullable")
                        ? `${present[index]} ? ${cpp} : bbl::js::JsonValue{}`
                        : cpp;
                lines.push(
                    `    if (key == ${stringLiteral(field.sourceName)}) return ${read};`,
                );
            });
            lines.push("    return {};", "}");
            if (present.every((condition) => condition === undefined))
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
                        return present[index]
                            ? `    if (${present[index]}) ${push}`
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
        if (names.length === 0) {
            return [];
        }
        const structName = (name: string): string =>
            `${name}${this.isReferenceStruct(name) ? "Data" : ""}`;
        const lines: string[] = names.map(
            (name) =>
                `inline void json_write(bbl::js::JsonWriter& writer, const ${structName(name)}& value);`,
        );
        lines.push("");
        for (const name of names) {
            const definition = this.structsByName.get(name);
            lines.push(
                `inline void json_write(bbl::js::JsonWriter& writer, const ${structName(name)}& value) {`,
                "    writer.begin_object();",
            );
            for (const field of definition?.fields ?? []) {
                if (isUndefinedDataType(field.type)) {
                    lines.push(
                        `    static_cast<void>(value.${field.name}${field.accessor ? ".get()" : ""});`,
                    );
                    continue;
                }
                const key = stringLiteral(field.sourceName);
                if (
                    field.optionalProperty &&
                    field.type.kind === "struct" &&
                    this.isReferenceStruct(field.type.name)
                ) {
                    const slot = `value.${field.name}`;
                    const present =
                        this.ownPropertyPresentCpp(
                            name,
                            field,
                            slot,
                            this.jsonSerializedStructs.get(name)!,
                        ) ?? "true";
                    lines.push(
                        `    if (${present}) {`,
                        `        writer.key(${key});`,
                        `        json_write(writer, ${slot});`,
                        "    }",
                    );
                    continue;
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
                if (omittable) {
                    lines.push(
                        `    if (${optionalPresentCpp(`value.${field.name}`)}) {`,
                        `        writer.key(${key});`,
                        `        json_write(writer, *value.${field.name});`,
                        "    }",
                    );
                    continue;
                }
                lines.push(
                    `    writer.key(${key});`,
                    `    json_write(writer, value.${field.name}${field.accessor ? ".get()" : ""});`,
                );
            }
            lines.push("    writer.end_object();", "}", "");
        }
        return lines;
    }

    /**
     * Renders the generated enum, struct, and table definitions in
     * dependency order inside `namespace bblscene`.
     */
    public renderPreamble(structuredClone = false): DataPreamble {
        this.checkFieldPresenceReads();
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
            for (const field of definition.fields) {
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
                          "    }",
                      ]),
                ...(structuredClone
                    ? [
                          "",
                          ...["const ", ""].flatMap((qualifier) => [
                              `    template <typename Visitor> friend void clone_fields(${qualifier}${definition.name}${this.isReferenceStruct(definition.name) ? "Data" : ""}& record, Visitor&& visitor) {`,
                              ...cloneFields.map((field) => {
                                  if (field.presentForTags) {
                                      const condition = field.presentForTags
                                          .map(
                                              (alternative) =>
                                                  `(${alternative
                                                      .map(
                                                          ({
                                                              discriminant,
                                                              value,
                                                          }) => {
                                                              const tag =
                                                                  definition.fields.find(
                                                                      (
                                                                          candidate,
                                                                      ) =>
                                                                          candidate.sourceName ===
                                                                          discriminant,
                                                                  )!;
                                                              let literal =
                                                                  tag.type
                                                                      .kind ===
                                                                  "string"
                                                                      ? JSON.stringify(
                                                                            value,
                                                                        )
                                                                      : value;
                                                              if (
                                                                  tag.type
                                                                      .kind ===
                                                                  "enum"
                                                              ) {
                                                                  const enumType =
                                                                      tag.type;
                                                                  const definition =
                                                                      this.enumsByName.get(
                                                                          enumType.name,
                                                                      )!;
                                                                  literal = `${enumType.name}::${this.enumMemberIdentifier(definition, value)}`;
                                                              }
                                                              return `record.${tag.name} == ${literal}`;
                                                          },
                                                      )
                                                      .join(" && ")})`,
                                          )
                                          .join(" || ");
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
