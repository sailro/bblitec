import ts from "typescript";
import { cppIdentifier, doubleLiteral } from "../cpp-literals.js";
import { nativeReturnTsType } from "./native-return-type.js";

type Fail = (node: ts.Node, message: string) => never;

/**
 * Native representation for the TypeScript data subset: numbers, booleans,
 * interface-typed structs, string-literal-union enums, nullable objects,
 * containers, tuples, and the resource values whose native representation is
 * safe to carry through those structures.
 *
 * Most resources below are trivially copyable ids. A pixels texture is the
 * pin's value-shaped CPU upload record; it is also safe to copy into a cache,
 * and remains a texture when read back out.
 */
export type HandleKind =
  | "mesh"
  | "animation-group"
  | "audio-buffer"
  | "audio-context"
  | "camera"
  | "property-animation-group"
  | "ui-element"
  | "utility-layer"
  | "pointer-drag"
  | "gamepad"
  | "gamepad-button"
  | "scene"
  | "scene-node"
  | "light"
  | "shadow-generator"
  | "hierarchy-instance-pool"
  | "storage-buffer"
  | "material"
  | "physics-body"
  | "physics-shape"
  | "billboard-sprite"
  | "billboard-system"
  | "sprite-layer"
  | "sprite-atlas"
  | "splat-mesh"
  | "texture"
  | "transform-node"
  | "skeleton"
  | "bone"
  | "navigation-obstacle";

const handleCppTypes: Record<HandleKind, string> = {
  mesh: "bbl::MeshHandle",
  "animation-group": "bbl::AnimationGroupHandle",
  "audio-buffer": "bbl::pal::AudioBufferHandle",
  "audio-context": "bbl::pal::AudioContextHandle",
  camera: "bbl::CameraHandle",
  "property-animation-group": "bbl::PropertyAnimationGroup",
  "ui-element": "bbl::UiElementHandle",
  "utility-layer": "bbl::UtilityLayerHandle",
  "pointer-drag": "bbl::PointerDragHandle",
  gamepad: "bbl::GamepadHandle",
  "gamepad-button": "bbl::GamepadButtonHandle",
  scene: "bbl::Scene",
  "scene-node": "bbl::SceneNodeHandle",
  light: "bbl::LightHandle",
  "shadow-generator": "bbl::ShadowGeneratorHandle",
  "hierarchy-instance-pool": "bbl::HierarchyInstancePoolHandle",
  "storage-buffer": "bbl::StorageBufferHandle",
  material: "bbl::MaterialHandle",
  "physics-body": "bbl::upstream::PhysicsBody",
  "physics-shape": "bbl::upstream::PhysicsShape",
  "billboard-sprite": "bbl::BillboardSpriteHandle",
  "billboard-system": "bbl::BillboardSystemHandle",
  "sprite-layer": "bbl::Sprite2DLayerHandle",
  "sprite-atlas": "bbl::SpriteAtlasHandle",
  "splat-mesh": "bbl::SplatMeshHandle",
  texture: "bbl::StoredTexture",
  "transform-node": "bbl::TransformNodeHandle",
  skeleton: "bbl::SkeletonHandle",
  bone: "bbl::BoneHandle",
  "navigation-obstacle": "bbl::pal::NavObstacleHandle",
};

/** Whether a compiler value kind is one of the data model's copyable handles. */
export function isHandleKind(kind: string): kind is HandleKind {
  return Object.prototype.hasOwnProperty.call(handleCppTypes, kind);
}

/** The pinned type name each handle kind is declared as. */
const pinnedHandleTypes: Record<string, HandleKind> = {
  Mesh: "mesh",
  AnimationGroup: "animation-group",
  BillboardSpriteHandle: "billboard-sprite",
  BillboardSpriteSystem: "billboard-system",
  Camera: "camera",
  BankedFreeCamera: "camera",
  UtilityLayer: "utility-layer",
  PointerDrag: "pointer-drag",
  SceneContext: "scene",
  SceneNode: "scene-node",
  LightBase: "light",
  HemisphericLight: "light",
  DirectionalLight: "light",
  PointLight: "light",
  SpotLight: "light",
  ShadowGenerator: "shadow-generator",
  HierarchyInstancePool: "hierarchy-instance-pool",
  StorageBuffer: "storage-buffer",
  Material: "material",
  PhysicsBody: "physics-body",
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

export type DataType =
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "arraybuffer" }
  | { kind: "dataview" }
  /**
   * A DOM event borrowed from one active synchronous platform callback.
   * `event` is the exact supported view: the base Event exposes only
   * preventDefault, while the two typed views reuse the existing platform
   * event property lowering.
   */
  | {
      kind: "borrowed-platform-event";
      event: "event" | "mouse" | "keyboard";
    }
  // A resource value stored inside ordinary data. Most are handles, while
  // the pixels-texture arm maps the pin's Texture2D to its native upload
  // record. `compileForSink` rejects texture producers represented by a
  // different native record instead of allowing an invalid C++ conversion.
  // A runtime string. String fields and parameters are part of the same
  // plain-data model as numbers: fetched/decoded binary documents commonly
  // carry names through records and containers before rendering reaches
  // them.
  | { kind: "string" }
  | { kind: "handle"; handle: HandleKind }
  | {
      kind: "function";
      parameters: DataType[];
      result?: DataType;
      /**
       * The container this function is stored in observes its JavaScript
       * identity -- a Set membership, a Map key. Such a value carries the
       * identity of the declaration it was materialized from so `delete`
       * and a duplicate `add` answer the way the source does.
       */
      identity?: true;
      /**
       * Source parameters whose type is void/never and therefore have no
       * native argument. Their expressions are still validated at calls; no
       * placeholder runtime value is invented.
       */
      erasedParameters?: number[];
    }
  | { kind: "struct"; name: string }
  | { kind: "enum"; name: string }
  /**
   * A `JSON.parse` result: the one dynamic value in the model, because a
   * parsed document's shape is exactly what the source has not proven yet.
   * Reads over it answer `undefined` where the document has nothing, so
   * the source's own guards -- `Array.isArray`, `typeof`, a strict
   * comparison, an optional property read -- decide as they do in the
   * browser. Nothing else produces one, so it stays where the parse put it.
   */
  | { kind: "json" }
  | { kind: "optional"; inner: DataType }
  | { kind: "vector"; element: DataType }
  | { kind: "map"; key: DataType; value: DataType }
  | { kind: "set"; element: DataType }
  | { kind: "span"; element: DataType }
  | { kind: "tuple"; arity: number }
  // `Record<Union, T>`: one slot per member of a string-literal
  // union, indexed at runtime by the union's own enum tag. The key
  // space is closed at compile time, so this is a fixed table rather
  // than a growable array.
  | { kind: "enummap"; enumName: string; element: DataType }
  | { kind: "table"; dimensions: number[] }
  | { kind: "u8array" }
  | { kind: "f64array" }
  | { kind: "f32array" }
  | { kind: "u16array" }
  | { kind: "i16array" }
  | { kind: "u32array" }
  | { kind: "i32array" };

/**
 * The element exposed by a native data-container `for...of` loop.
 * Maps expose a typed key/value entry rather than the all-number tuple used
 * for ordinary numeric tuple values.
 */
export type DataIterationElement =
  DataType | { kind: "map-entry"; key: DataType; value: DataType };

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
  /**
   * The source declared the property with `?`, so JavaScript can observe it
   * as absent rather than as null. `JSON.stringify` is the observer: it
   * omits an absent member and writes `null` for one that is present and
   * null, which is the whole difference between `sh?: number` and
   * `sh: number | null` once both are a `Nullable` field here.
   */
  optionalProperty?: boolean;
}

function propertyIsReadOnly(property: ts.Symbol): boolean {
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
}

/**
 * One local class with a demanded runtime representation.
 *
 * `type` is the instantiated class type the demand named, so a generic
 * class's fields resolve through `Workspace<Part>` rather than through the
 * declaration's own `P`.
 */
export interface ClassStructBinding {
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
 * True when a symbol is declared by the pinned Babylon Lite typings, so
 * a scene's own interface named `Mesh` is never mistaken for the engine
 * resource type.
 */
function declaredInBabylonLite(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some((declaration) =>
    declaration
      .getSourceFile()
      .fileName.replace(/\\/g, "/")
      .includes("@babylonjs/lite/"),
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

function declaredInDomLibrary(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some((declaration) =>
    declaration
      .getSourceFile()
      .fileName.replace(/\\/g, "/")
      .endsWith("/lib.dom.d.ts"),
  );
}

function borrowedPlatformEventKind(
  symbol: ts.Symbol | undefined,
): "event" | "mouse" | "keyboard" | undefined {
  if (!symbol || !declaredInDomLibrary(symbol)) return undefined;
  if (symbol.name === "Event") return "event";
  if (symbol.name === "MouseEvent") return "mouse";
  if (symbol.name === "KeyboardEvent") return "keyboard";
  return undefined;
}

function isDomElementType(symbol: ts.Symbol): boolean {
  return (
    declaredInDomLibrary(symbol) &&
    (symbol.name === "Element" ||
      symbol.name === "HTMLElement" ||
      /^HTML[A-Za-z0-9]*Element$/.test(symbol.name))
  );
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
    value.dataType?.kind === "tuple" &&
    value.dataType.arity === arity
  );
}

/** The typed-array kinds this model carries, as one narrowing test. */
export type TypedArrayKind =
  | "u8array"
  | "f64array"
  | "f32array"
  | "u16array"
  | "i16array"
  | "u32array"
  | "i32array";

/**
 * Whether a data type is one of them.
 *
 * Every typed-array method and every native-function parameter rule asks
 * this, and each site that spelled the three-way disjunction itself was a
 * place a fourth kind could be forgotten.
 */
export function isTypedArrayType(
  dataType: DataType | undefined,
): dataType is DataType & { kind: TypedArrayKind } {
  return (
    dataType?.kind === "u8array" ||
    dataType?.kind === "f64array" ||
    dataType?.kind === "f32array" ||
    dataType?.kind === "u16array" ||
    dataType?.kind === "i16array" ||
    dataType?.kind === "u32array" ||
    dataType?.kind === "i32array"
  );
}

/**
 * The runtime spelling stem for one typed-array kind: the `bbl::js::`
 * `<stem>_array_from` / `<stem>_array_sized` family, and the `<STEM>Array`
 * alias its elements are stored in.
 */
export function typedArrayStem(kind: TypedArrayKind): string {
  switch (kind) {
    case "u8array":
      return "u8";
    case "f64array":
      return "f64";
    case "f32array":
      return "f32";
    case "u16array":
      return "u16";
    case "i16array":
      return "i16";
    case "u32array":
      return "u32";
    case "i32array":
      return "i32";
  }
}

/** Apply the reached ECMAScript store conversion for one typed-array lane. */
export function typedArrayStoreExpression(
  kind: TypedArrayKind,
  value: string,
): string {
  switch (kind) {
    case "u8array":
      return `bbl::js::to_uint8(${value})`;
    case "u16array":
      return `bbl::js::to_uint16(${value})`;
    case "i16array":
      return `bbl::js::to_int16(${value})`;
    case "u32array":
      return `bbl::js::to_uint32(${value})`;
    case "i32array":
      return `bbl::js::to_int32(${value})`;
    case "f64array":
      return value;
    case "f32array":
      return `static_cast<float>(${value})`;
  }
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
 * The reference-passed kinds a data type answers for by ITSELF -- every
 * one but `struct`, which needs the registry to say whether the struct is
 * reference-backed. Split out because a table-validation pass has rules
 * rather than a compiled program, and so has no registry to ask.
 */
export function passesByReferenceKind(dataType: DataType): boolean {
  return (
    dataType.kind === "vector" ||
    dataType.kind === "map" ||
    dataType.kind === "set" ||
    dataType.kind === "tuple" ||
    dataType.kind === "enummap" ||
    dataType.kind === "arraybuffer" ||
    dataType.kind === "dataview" ||
    isTypedArrayType(dataType)
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

/**
 * Marks a stored value's own function type as identity-carrying.
 *
 * A Set member and a Map key are the two positions whose behaviour depends
 * on comparing the value: everything else stores a function without ever
 * asking whether two of them are the same one, and keeps the plain
 * `std::function` it already emitted.
 */
function markIdentityFunctions(dataType: DataType): DataType {
  switch (dataType.kind) {
    case "function":
      return { ...dataType, identity: true };
    case "optional":
      return {
        kind: "optional",
        inner: markIdentityFunctions(dataType.inner),
      };
    default:
      return dataType;
  }
}

export function dataTypesEqual(left: DataType, right: DataType): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case "number":
    case "boolean":
    case "string":
    case "arraybuffer":
    case "dataview":
    case "json":
    case "u8array":
    case "f64array":
    case "f32array":
    case "u16array":
    case "i16array":
    case "u32array":
    case "i32array":
      return true;
    case "borrowed-platform-event":
      return (
        left.event ===
        (right as { event: "event" | "mouse" | "keyboard" }).event
      );
    case "handle":
      return left.handle === (right as { handle: string }).handle;
    case "function": {
      const other = right as {
        parameters: DataType[];
        result?: DataType;
        identity?: true;
        erasedParameters?: number[];
      };
      return (
        left.identity === other.identity &&
        (left.erasedParameters ?? []).join(",") ===
          (other.erasedParameters ?? []).join(",") &&
        left.parameters.length === other.parameters.length &&
        left.parameters.every((parameter, index) =>
          dataTypesEqual(parameter, other.parameters[index]!)) &&
        (left.result === undefined
          ? other.result === undefined
          : other.result !== undefined &&
            dataTypesEqual(left.result, other.result))
      );
    }
    case "struct":
    case "enum":
      return left.name === (right as { name: string }).name;
    case "optional":
      return dataTypesEqual(left.inner, (right as { inner: DataType }).inner);
    case "vector":
    case "span":
      return dataTypesEqual(
        left.element,
        (right as { element: DataType }).element,
      );
    case "map": {
      const other = right as {
        key: DataType;
        value: DataType;
      };
      return (
        dataTypesEqual(left.key, other.key) &&
        dataTypesEqual(left.value, other.value)
      );
    }
    case "set":
      return dataTypesEqual(
        left.element,
        (right as { element: DataType }).element,
      );
    case "tuple":
      return left.arity === (right as { arity: number }).arity;
    case "enummap": {
      const other = right as {
        enumName: string;
        element: DataType;
      };
      return (
        left.enumName === other.enumName &&
        dataTypesEqual(left.element, other.element)
      );
    }
    case "table":
      return (
        left.dimensions.join(",") ===
        (right as { dimensions: number[] }).dimensions.join(",")
      );
  }
}

function sanitizeIdentifier(name: string): string {
  return cppIdentifier(name);
}

/**
 * Maps checker types onto native data types and owns the generated struct,
 * enum, and static-table definitions emitted ahead of `main`.
 */
export class DataTypeRegistry {
  private readonly structsByKey = new Map<string, DataStructDefinition>();
  private readonly structNames = new Set<string>();
  private readonly enumsByKey = new Map<string, DataEnumDefinition>();
  private readonly enumNames = new Set<string>();
  /** String-union enums that actually receive a runtime string value. */
  private readonly runtimeEnumParsers = new Set<string>();
  private readonly runtimeEnumSerializers = new Set<string>();
  /** Named data types that reached emitted C++ rather than a type probe. */
  private readonly emittedNamedTypes = new Set<string>();
  private readonly tables = new Map<ts.Node, DataTableDefinition>();
  private readonly tableNames = new Set<string>();
  /**
   * One-dimensional constant arrays, materialized so a runtime index
   * can reach them. The numeric tables above are doubles all the way
   * down and may nest; these are flat and hold any scalar element.
   */
  private readonly tagTables = new Map<
    ts.Node,
    {
      name: string;
      elementCppType: string;
      elements: string[];
    }
  >();
  private readonly structNamesInProgress = new Map<
    ts.Symbol | ts.Type | string,
    string
  >();
  private readonly structTypesByIdentity = new Map<
    ts.Symbol | ts.Type | string,
    DataType & { kind: "struct" }
  >();
  private readonly referenceStructNames = new Set<string>();
  /**
   * Local classes that reached a native data position, by the struct name
   * standing for them. The declaration is how a method call on a value read
   * back out of a container recovers what to inline.
   */
  private readonly classStructDeclarations = new Map<
    string,
    ClassStructBinding
  >();
  private readonly classStructNames = new Map<
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
  private classDemanded = false;
  /**
   * What the class's type parameters stand for while one of its bodies is
   * being inlined. Empty outside a generic receiver.
   */
  private activeTypeArguments: ReadonlyMap<ts.Symbol, ts.Type> | undefined;
  /** That substitution as one struct-identity key, spelled when it is set. */
  private activeTypeArgumentKey = "";
  private anonymousStructIndex = 0;
  private anonymousEnumIndex = 0;
  /**
   * The structs `JSON.stringify` actually reaches, in the order the walk
   * found them. Nothing else emits a codec: a scene that serializes one
   * record does not carry a writer for every other record it declares.
   */
  private readonly jsonSerializedStructs = new Set<string>();

  public constructor(
    private readonly checker: ts.TypeChecker,
    private readonly fail: Fail,
  ) {}

  /**
   * Marks object values stored behind another JavaScript object/container
   * as references. Copies of arrays, maps, sets, and record fields retain
   * the identity of their object-valued entries in JavaScript.
   */
  public markStoredObjectReferences(dataType: DataType): DataType {
    switch (dataType.kind) {
      case "struct":
        this.referenceStructNames.add(dataType.name);
        return dataType;
      case "optional": {
        const inner = this.markStoredObjectReferences(dataType.inner);
        return inner.kind === "struct" && this.isReferenceStruct(inner.name)
          ? inner
          : { kind: "optional", inner };
      }
      case "vector":
      case "span": {
        const element = this.markStoredObjectReferences(dataType.element);
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
      case "set":
        return {
          kind: "set",
          element: this.markStoredObjectReferences(dataType.element),
        };
      case "map":
        return {
          kind: "map",
          key: this.markStoredObjectReferences(dataType.key),
          value: this.markStoredObjectReferences(dataType.value),
        };
      default:
        return dataType;
    }
  }

  /**
   * Maps a checker type to native data, or undefined for values whose host
   * representation is opaque here (promises, functions, DOM objects, ...).
   */
  public fromTsType(type: ts.Type, node: ts.Node): DataType | undefined {
    if (
      (type.flags & ts.TypeFlags.Union) !== 0 &&
      (type.flags & ts.TypeFlags.Boolean) === 0 &&
      (type as ts.UnionType).types.some(
        (member) =>
          (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0,
      )
    ) {
      const inner = this.fromNonNullableType(
        this.checker.getNonNullableType(type),
        node,
      );
      if (!inner) {
        return undefined;
      }
      // std::function already has the nullable state JavaScript callbacks
      // need: an empty function represents null/undefined and converts to
      // false in a presence guard. Avoid wrapping it in Nullable so calls,
      // assignments and truthiness all use that single native state.
      if (inner.kind === "function") {
        return inner;
      }
      if (inner.kind === "struct" && this.isReferenceStruct(inner.name)) {
        // Shared object handles carry null directly; wrapping one
        // in Nullable would add a second, non-JavaScript state.
        return inner;
      }
      return { kind: "optional", inner };
    }
    return this.fromNonNullableType(type, node);
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

  private fromNonNullableType(
    type: ts.Type,
    node: ts.Node,
  ): DataType | undefined {
    const substituted = this.substituteTypeParameter(type);
    if (substituted) {
      return this.fromTsType(substituted, node);
    }
    if (
      (type.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) !==
      0
    ) {
      return numberType;
    }
    if (
      (type.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !==
      0
    ) {
      return booleanType;
    }
    if (
      (type.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) !==
      0
    ) {
      return { kind: "string" };
    }
    if ((type.flags & ts.TypeFlags.Union) !== 0) {
      return this.fromUnionType(type as ts.UnionType, node);
    }
    if ((type.flags & ts.TypeFlags.Intersection) !== 0) {
      return this.fromStructType(type, node);
    }
    if ((type.flags & ts.TypeFlags.Object) === 0) {
      return undefined;
    }
    if (type.symbol?.name === "ArrayBuffer") {
      return { kind: "arraybuffer" };
    }
    if (type.symbol?.name === "DataView") {
      return { kind: "dataview" };
    }
    if (
      type.symbol &&
      declaredInDomLibrary(type.symbol) &&
      type.symbol.name === "Gamepad"
    ) {
      return { kind: "handle", handle: "gamepad" };
    }
    if (
      type.symbol &&
      declaredInDomLibrary(type.symbol) &&
      type.symbol.name === "GamepadButton"
    ) {
      return { kind: "handle", handle: "gamepad-button" };
    }
    const borrowedEvent = borrowedPlatformEventKind(type.symbol);
    if (borrowedEvent) {
      return {
        kind: "borrowed-platform-event",
        event: borrowedEvent,
      };
    }
    if (
      type.symbol?.name === "RegExpExecArray" ||
      type.symbol?.name === "RegExpMatchArray"
    ) {
      return {
        kind: "vector",
        element: { kind: "string" },
      };
    }
    // Web Audio buffers are opaque context-owned resources. They are safe
    // to retain in ordinary JS containers (sound caches are the common
    // case), but their PCM storage stays behind the audio PAL.
    if (type.symbol?.name === "AudioBuffer") {
      return { kind: "handle", handle: "audio-buffer" };
    }
    if (
      type.symbol?.name === "AudioContext" ||
      type.symbol?.name === "BaseAudioContext" ||
      type.symbol?.name === "OfflineAudioContext"
    ) {
      return { kind: "handle", handle: "audio-context" };
    }
    if (
      type.symbol?.name === "AudioEngine" &&
      declaredInBabylonLite(type.symbol)
    ) {
      // AudioEngine carries compiler-owned context, buses, and nullable
      // construction state; its public interface is not a plain-data record.
      return undefined;
    }
    if (type.symbol && isDomElementType(type.symbol)) {
      return { kind: "handle", handle: "ui-element" };
    }
    if (
      type.symbol &&
      (type.symbol.declarations ?? []).some(ts.isClassDeclaration)
    ) {
      if (declaredInBabylonLite(type.symbol)) {
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
    if (type.symbol?.name === "Float32Array") {
      return { kind: "f32array" };
    }
    if (type.symbol?.name === "Float64Array") {
      return { kind: "f64array" };
    }
    if (type.symbol?.name === "Uint8Array") {
      return { kind: "u8array" };
    }
    if (type.symbol?.name === "Uint16Array") {
      return { kind: "u16array" };
    }
    if (type.symbol?.name === "Int16Array") {
      return { kind: "i16array" };
    }
    if (type.symbol?.name === "Uint32Array") {
      return { kind: "u32array" };
    }
    if (type.symbol?.name === "Int32Array") {
      return { kind: "i32array" };
    }
    const pinnedHandleSymbol =
      type.aliasSymbol && pinnedHandleTypes[type.aliasSymbol.name]
        ? type.aliasSymbol
        : type.symbol;
    const pinnedHandle = pinnedHandleSymbol
      ? pinnedHandleTypes[pinnedHandleSymbol.name]
      : undefined;
    if (pinnedHandle && declaredInBabylonLite(pinnedHandleSymbol!)) {
      return { kind: "handle", handle: pinnedHandle };
    }
    if (type.symbol && declaredInBabylonLite(type.symbol) && isSceneGraphNode(type)) {
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
      if (type.symbol?.name === "Promise") {
        const [resolvedType] = this.checker.getTypeArguments(reference);
        if (!resolvedType) return undefined;
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
      const symbolName = type.symbol?.name;
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
      if (symbolName === "Map" || symbolName === "ReadonlyMap") {
        const [keyType, valueType] = this.checker.getTypeArguments(reference);
        if (!keyType || !valueType) return undefined;
        const key = this.fromStoredTsType(keyType, node);
        const value = this.fromStoredTsType(valueType, node);
        if (!key || !value) return undefined;
        return {
          kind: "map",
          key: markIdentityFunctions(this.markStoredObjectReferences(key)),
          value: this.markStoredObjectReferences(value),
        };
      }
      if (symbolName === "Set") {
        const [elementType] = this.checker.getTypeArguments(reference);
        if (!elementType) return undefined;
        const element = this.fromStoredTsType(elementType, node);
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
    const functionType = this.fromFunctionType(type, node);
    if (functionType) return functionType;
    if (type.getConstructSignatures().length > 0) {
      return undefined;
    }
    return this.fromStructType(type, node);
  }

  /** A stored JavaScript function with a fully native data signature. */
  private fromFunctionType(type: ts.Type, node: ts.Node): DataType | undefined {
    const signatures = type.getCallSignatures();
    if (signatures.length !== 1) return undefined;
    const signature = signatures[0]!;
    for (const origin of [node, signature.declaration]) {
      let owner: ts.Node | undefined = origin;
      while (owner && !ts.isSourceFile(owner)) {
        if (
          ts.isPropertyDeclaration(owner) &&
          ts.isClassLike(owner.parent) &&
          this.checker.getTypeAtLocation(owner).getCallSignatures().length > 0
        ) {
          // Class callback fields use the class lowerer's method-like binding,
          // including `this`; they are not ordinary stored struct slots.
          return undefined;
        }
        owner = owner.parent;
      }
    }
    const erasedParameters: number[] = [];
    const parameters = signature.getParameters().flatMap((parameter, index) => {
      const declaration =
        parameter.valueDeclaration ?? parameter.declarations?.[0];
      const parameterType = this.checker.getTypeOfSymbolAtLocation(
        parameter,
        declaration ?? node,
      );
      if (
        (parameterType.flags & (ts.TypeFlags.Never | ts.TypeFlags.Void)) !== 0
      ) {
        erasedParameters.push(index);
        return [];
      }
      const mapped = this.fromStoredTsType(
        parameterType,
        declaration ?? node,
      );
      // A function passed through another stored function remains the same
      // JavaScript function object. Carry its identity across that native
      // call boundary so an eventual Array/Map/Set comparison can observe it.
      return mapped ? [markIdentityFunctions(mapped)] : [undefined];
    });
    if (parameters.some((parameter) => parameter === undefined)) {
      return undefined;
    }
    const resultType = nativeReturnTsType(
      this.checker,
      this.checker.getReturnTypeOfSignature(signature),
      signature.declaration,
    );
    const result = resultType
      ? this.fromStoredTsType(resultType, node)
      : undefined;
    if (resultType && !result) {
      return undefined;
    }
    return {
      kind: "function",
      parameters: parameters as DataType[],
      ...(result ? { result } : {}),
      ...(erasedParameters.length > 0 ? { erasedParameters } : {}),
    };
  }

  private fromUnionType(
    type: ts.UnionType,
    node: ts.Node,
  ): DataType | undefined {
    const members = type.types;
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
            (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !==
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
    return (
      this.fromDiscriminatedObjectUnion(type, node) ??
      this.fromCommonObjectUnion(type, node)
    );
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
  ): DataType | undefined {
    if (
      type.types.length < 2 ||
      type.types.some(
        (member) => (member.flags & ts.TypeFlags.Object) === 0,
      )
    ) {
      return undefined;
    }
    const identity = this.structIdentity(type);
    const completed = this.structTypesByIdentity.get(identity);
    if (completed) return completed;

    const propertiesByMember = type.types.map((member) =>
      this.checker.getPropertiesOfType(member),
    );
    const common = propertiesByMember[0]!.filter((property) =>
      propertiesByMember.slice(1).every((properties) =>
        properties.some(({ name }) => name === property.name),
      ),
    );
    if (common.length === 0) return undefined;

    const fields: DataStructField[] = [];
    for (const property of common) {
      const candidates = propertiesByMember.map((properties) => {
        const memberProperty = properties.find(
          ({ name }) => name === property.name,
        )!;
        const declaration =
          memberProperty.valueDeclaration ?? memberProperty.declarations?.[0];
        return this.fromTsType(
          this.checker.getTypeOfSymbolAtLocation(
            memberProperty,
            declaration ?? node,
          ),
          node,
        );
      });
      const first = candidates[0];
      if (
        !first ||
        candidates.some(
          (candidate) => !candidate || !dataTypesEqual(candidate, first),
        )
      ) {
        return undefined;
      }
      fields.push({
        sourceName: property.name,
        name: sanitizeIdentifier(property.name),
        type: this.markStoredObjectReferences(first),
        ...(propertiesByMember.every((properties) =>
          propertyIsReadOnly(
            properties.find(({ name }) => name === property.name)!,
          ))
          ? { readOnly: true }
          : {}),
      });
    }

    const preferredName = type.aliasSymbol?.name;
    const name = this.uniqueName(
      preferredName
        ? sanitizeIdentifier(preferredName)
        : `Record${++this.anonymousStructIndex}`,
      this.structNames,
    );
    const key = fields
      .map(
        (field) =>
          `${field.sourceName}:${field.name}:${this.typeKey(field.type)}:required:${field.readOnly ? "readonly" : "mutable"}`,
      )
      .join(",");
    const existing = this.structsByKey.get(key);
    if (existing) {
      const result = { kind: "struct" as const, name: existing.name };
      this.structTypesByIdentity.set(identity, result);
      return result;
    }
    this.structsByKey.set(key, { name, fields });
    const result = { kind: "struct" as const, name };
    this.structTypesByIdentity.set(identity, result);
    return result;
  }

  /**
   * A closed object union as one native struct: the tag is an enum and fields
   * which exist only in one arm receive an inert default in the other arms.
   * TypeScript's discriminant narrowing guarantees those inactive fields are
   * never observed by valid source code.
   */
  private fromDiscriminatedObjectUnion(
    type: ts.UnionType,
    node: ts.Node,
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
      this.checker.getPropertiesOfType(member));
    const discriminant = propertiesByMember[0]!.find((property) => {
      const values = propertiesByMember.map((properties) => {
        const candidate = properties.find(
          ({ name }) => name === property.name,
        );
        if (!candidate) return undefined;
        const declaration =
          candidate.valueDeclaration ?? candidate.declarations?.[0];
        const value = this.checker.getTypeOfSymbolAtLocation(
          candidate,
          declaration ?? node,
        );
        return (value.flags & ts.TypeFlags.StringLiteral) !== 0
          ? (value as ts.StringLiteralType).value
          : undefined;
      });
      return (
        values.every((value) => value !== undefined) &&
        new Set(values).size === type.types.length
      );
    });
    if (!discriminant) return undefined;

    const identity = this.structIdentity(type);
    const completed = this.structTypesByIdentity.get(identity);
    if (completed) return completed;
    const preferredName = type.aliasSymbol?.name;
    const name = this.uniqueName(
      preferredName
        ? sanitizeIdentifier(preferredName)
        : `Record${++this.anonymousStructIndex}`,
      this.structNames,
    );
    const propertyNames: string[] = [];
    for (const properties of propertiesByMember) {
      for (const property of properties) {
        if (!propertyNames.includes(property.name)) {
          propertyNames.push(property.name);
        }
      }
    }
    const fields: DataStructField[] = [];
    for (const propertyName of propertyNames) {
      const memberProperties = propertiesByMember.flatMap((properties) => {
        const property = properties.find(
          ({ name: candidate }) => candidate === propertyName,
        );
        return property ? [property] : [];
      });
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
      if (
        propertyTypes.length === type.types.length &&
        propertyTypes.every(
          (propertyType) =>
            (propertyType.flags & ts.TypeFlags.StringLiteral) !== 0,
        )
      ) {
        mapped = this.registerEnum(
          type,
          propertyTypes.map(
            (propertyType) =>
              (propertyType as ts.StringLiteralType).value,
          ),
        );
      } else {
        const candidates = propertyTypes.map((propertyType) =>
          this.fromTsType(propertyType, node));
        const first = candidates[0];
        if (
          !first ||
          candidates.some(
            (candidate) =>
              !candidate || !dataTypesEqual(candidate, first),
          )
        ) {
          return undefined;
        }
        mapped = first;
      }
      fields.push({
        sourceName: propertyName,
        name: sanitizeIdentifier(propertyName),
        type: this.markStoredObjectReferences(mapped),
        ...(memberProperties.length === type.types.length &&
        memberProperties.every(propertyIsReadOnly)
          ? { readOnly: true }
          : {}),
        ...(propertyTypes.length < type.types.length
          ? { defaultWhenMissing: true }
          : {}),
      });
    }
    const key = fields
      .map(
        (field) =>
          `${field.sourceName}:${field.name}:${this.typeKey(field.type)}:${field.defaultWhenMissing ? "default" : "required"}:${field.readOnly ? "readonly" : "mutable"}`,
      )
      .join(",");
    const existing = this.structsByKey.get(key);
    if (existing) {
      const result = { kind: "struct" as const, name: existing.name };
      this.structTypesByIdentity.set(identity, result);
      return result;
    }
    this.structsByKey.set(key, { name, fields });
    const result = { kind: "struct" as const, name };
    this.structTypesByIdentity.set(identity, result);
    return result;
  }

  private fromTupleType(
    reference: ts.TypeReference,
    node: ts.Node,
  ): DataType | undefined {
    const elements = this.checker.getTypeArguments(reference);
    if (elements.length === 0) {
      return undefined;
    }
    const mapped = elements.map((element) =>
      this.fromStoredTsType(element, node));
    if (mapped.some((element) => !element)) {
      return undefined;
    }
    const complete = mapped as DataType[];
    if (complete.every((element) => element.kind === "number")) {
      return {
        kind: "tuple",
        arity: elements.length,
      };
    }
    // JavaScript tuples are arrays at runtime. A homogeneous object tuple
    // such as `[FVertex, FVertex]` therefore uses the ordinary native
    // array representation; it keeps element identity and supports the
    // same indexed reads while retaining the fixed length in TypeScript.
    const first = complete[0]!;
    return complete.every((element) => dataTypesEqual(element, first))
      ? {
          kind: "vector",
          element: this.markStoredObjectReferences(first),
        }
      : undefined;
  }

  private fromStructType(type: ts.Type, node: ts.Node): DataType | undefined {
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
    const preferredName =
      type.aliasSymbol?.name ??
      (type.symbol &&
      type.symbol.name !== "__type" &&
      type.symbol.name !== "__object"
        ? type.symbol.name
        : undefined);
    const provisionalName = this.uniqueName(
      preferredName
        ? sanitizeIdentifier(preferredName)
        : `Record${++this.anonymousStructIndex}`,
      this.structNames,
    );
    this.structNamesInProgress.set(identity, provisionalName);
    try {
      const mapped = this.fromStructTypeInner(
        type,
        node,
        provisionalName,
        preferredName !== undefined,
      );
      if (mapped?.kind === "struct") {
        this.structTypesByIdentity.set(identity, mapped);
      }
      return mapped;
    } finally {
      this.structNamesInProgress.delete(identity);
    }
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
    // The struct-identity key folds the instantiation in, and it is the
    // same string for the whole window this substitution is in force --
    // so it is spelled here rather than once per cache lookup.
    this.activeTypeArgumentKey = substitution
      ? [...substitution.values()]
          .map((argument) => this.checker.typeToString(argument))
          .join(",")
      : "";
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
    const substitution = new Map<ts.Symbol, ts.Type>();
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
    if (
      !this.activeTypeArguments ||
      (type.flags & ts.TypeFlags.TypeParameter) === 0 ||
      !type.symbol
    ) {
      return undefined;
    }
    const argument = this.activeTypeArguments.get(type.symbol);
    return argument === type ? undefined : argument;
  }

  /**
   * Whether a type still mentions a parameter the active substitution
   * replaces, so two instantiations of one generic declaration cannot
   * share a cached struct.
   *
   * The walk covers every place a parameter can hide inside one type: a
   * union or intersection constituent, a reference's own type arguments,
   * and the members of an anonymous or instantiated object -- an inline
   * `{ part: P; distance: number }` is spelled identically under two
   * instantiations and would otherwise read back the first one's struct.
   * `seen` closes the recursion on self-referential shapes, and every
   * branch is a disjunction over a set, so no answer depends on order.
   */
  private mentionsSubstitution(
    type: ts.Type,
    seen: Set<ts.Type> = new Set(),
  ): boolean {
    if (!this.activeTypeArguments || seen.has(type)) {
      return false;
    }
    seen.add(type);
    if (this.substituteTypeParameter(type)) {
      return true;
    }
    const constituents =
      (type.flags & (ts.TypeFlags.Union | ts.TypeFlags.Intersection)) !== 0
        ? (type as ts.UnionOrIntersectionType).types
        : [];
    if (
      constituents.some((member) => this.mentionsSubstitution(member, seen))
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
    // A generic alias symbol names the factory, not one instantiation.
    // `Record<ClosedKeys, T>` and `Record<string, U>` therefore share the
    // global `Record` symbol while exposing different property sets. Key
    // instantiated aliases by the checker type itself so one mapping
    // cannot poison the next; non-generic aliases and named interfaces
    // retain their stable symbol identity.
    if (type.aliasSymbol && (type.aliasTypeArguments?.length ?? 0) > 0) {
      return type;
    }
    // Two instantiations of one generic declaration are spelled the same
    // inside its own body: `Hit<P>` under a `Workspace<Part>` and under a
    // `Workspace<Other>` are the same checker type. Fold the substitution
    // into the key so the second does not read back the first's struct.
    if (this.mentionsSubstitution(type)) {
      return `${this.checker.typeToString(type)}<${this.activeTypeArgumentKey}>`;
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

  private fromStructTypeInner(
    type: ts.Type,
    node: ts.Node,
    provisionalName: string,
    allowStoredFunctions: boolean,
  ): DataType | undefined {
    const properties = this.checker.getPropertiesOfType(type);
    if (properties.length === 0) {
      return undefined;
    }
    const fields: DataStructField[] = [];
    for (const property of properties) {
      const declaration =
        property.valueDeclaration ?? property.declarations?.[0];
      const propertyType = this.checker.getTypeOfSymbolAtLocation(
        property,
        declaration ?? node,
      );
      const callableType = this.checker.getNonNullableType(
        propertyType,
      );
      const mappedValue = callableType.getCallSignatures().length > 0
        ? allowStoredFunctions &&
          declaration !== undefined &&
          (ts.isPropertySignature(declaration) ||
            ts.isMethodSignature(declaration)) &&
          (property.flags & ts.SymbolFlags.Optional) === 0
          ? this.fromFunctionType(propertyType, declaration ?? node)
          : undefined
        // A record's own field inherits the position the record is in
        // rather than demanding one: an interface written to carry a
        // scene's singletons -- a tool context holding the workspace, the
        // mouse and the dragger -- is a compile-time record, and giving
        // each of those a runtime object because a field names them would
        // turn every one of them into a shared allocation nothing shares.
        : this.fromTsType(propertyType, declaration ?? node);
      if (!mappedValue) {
        return undefined;
      }
      const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
      const mapped: DataType = this.markStoredObjectReferences(
        optional &&
          mappedValue.kind !== "optional"
          ? { kind: "optional", inner: mappedValue }
          : mappedValue,
      );
      fields.push({
        sourceName: property.name,
        name: sanitizeIdentifier(property.name),
        type: mapped,
        ...(propertyIsReadOnly(property) ? { readOnly: true } : {}),
        ...(optional ? { optionalProperty: true } : {}),
        ...(optional && mapped.kind !== "optional"
          ? { defaultWhenMissing: true }
          : {}),
      });
    }
    if (
      fields.some((field) => this.carriesBorrowedPlatformEvent(field.type))
    ) {
      // A synchronous callback observes one JavaScript payload object. Making
      // the whole record reference-backed ensures a handler's field mutation
      // is visible to the dispatcher after the call.
      this.referenceStructNames.add(provisionalName);
    }
    const key = `${fields
      .map(
        (field) =>
          `${field.sourceName}:${field.name}:${this.typeKey(field.type)}:${field.defaultWhenMissing ? "default" : "required"}:${field.readOnly ? "readonly" : "mutable"}`,
      )
      .join(",")}`;
    const existing = this.structsByKey.get(key);
    if (existing && !this.referenceStructNames.has(provisionalName)) {
      return {
        kind: "struct",
        name: existing.name,
      };
    }
    const name = provisionalName;
    this.structsByKey.set(key, { name, fields });
    return { kind: "struct", name };
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
    const name = this.uniqueName(
      sanitizeIdentifier(declaration.name?.text ?? "Instance"),
      this.structNames,
    );
    this.classStructNames.set(identity, name);
    this.classStructDeclarations.set(name, { declaration, type });
    this.referenceStructNames.add(name);
    this.structsByKey.set(`class#${name}`, {
      name,
      fields: this.classStructFields(declaration, type),
    });
    return { kind: "struct", name };
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
    const fields: DataStructField[] = [];
    for (const member of declaration.members) {
      if (
        !ts.isPropertyDeclaration(member) ||
        (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !== 0
      ) {
        continue;
      }
      if (!ts.isIdentifier(member.name)) {
        this.fail(
          member,
          "Private class fields are outside the supported subset.",
        );
      }
      const property = type.getProperty(member.name.text);
      const propertyType = property
        ? this.checker.getTypeOfSymbolAtLocation(property, member.name)
        : this.checker.getTypeAtLocation(member.name);
      const mapped = this.fromClassFieldType(propertyType, member.name);
      if (
        !mapped &&
        this.checker
          .getNonNullableType(propertyType)
          .getCallSignatures().length > 0
      ) {
        // A handler written as a field of a class instances are stored by
        // would be a different function object per instance, and the only
        // identity a materialized callback can carry is its declaration's.
        // `off(this._handler)` would then remove every instance's handler,
        // so the shape is refused rather than conflated.
        this.fail(
          member,
          `Field '${member.name.text}' of shared class ` +
            `'${declaration.name?.text ?? "?"}' declares a callback per ` +
            "instance; a stored instance has no identity a container could " +
            "compare it by.",
        );
      }
      if (!mapped) {
        continue;
      }
      fields.push({
        sourceName: member.name.text,
        name: sanitizeIdentifier(member.name.text),
        type: this.markStoredObjectReferences(mapped),
        ...(member.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
        )
          ? { readOnly: true }
          : {}),
      });
    }
    return fields;
  }

  /**
   * The shapes that cannot be one concrete `Ref<XData>`.
   *
   * A native data position names one layout. An abstract class or a
   * subclass hierarchy would need a value that dispatches on its dynamic
   * type, which this model has no representation for -- so the demand is
   * refused by name rather than silently specialized to whichever class the
   * walk reached first.
   */
  private rejectUnsupportedRuntimeClass(
    declaration: ts.ClassDeclaration,
    node: ts.Node,
  ): void {
    const className = declaration.name?.text ?? "?";
    if (
      (ts.getCombinedModifierFlags(declaration) &
        ts.ModifierFlags.Abstract) !==
      0
    ) {
      this.fail(
        node,
        `Abstract class '${className}' has no single native representation; ` +
          "store a concrete class instead.",
      );
    }
    if (
      declaration.heritageClauses?.some(
        (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
      )
    ) {
      this.fail(
        node,
        `Class '${className}' extends another class; a stored instance would ` +
          "need dynamic dispatch, which is outside the supported subset.",
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
    name: ts.Identifier,
  ): DataType | undefined {
    const property = type.getProperty(name.text);
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
  private fromStoredTsType(
    type: ts.Type,
    node: ts.Node,
  ): DataType | undefined {
    return this.withClassDemand(true, () =>
      this.fromTsType(type, node));
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
  private fromRecordType(type: ts.Type, node: ts.Node): DataType | undefined {
    const directRecordAlias = type.aliasSymbol?.name === "Record";
    const namedRecordAlias = (type.aliasSymbol?.declarations ?? []).some(
      (declaration) =>
        ts.isTypeAliasDeclaration(declaration) &&
        ts.isTypeReferenceNode(declaration.type) &&
        ts.isIdentifier(declaration.type.typeName) &&
        declaration.type.typeName.text === "Record",
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
        value: this.markStoredObjectReferences(element),
      };
    }
    if (key?.kind !== "enum") {
      return undefined;
    }
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
    const definition = [...this.enumsByKey.values()].find(
      (entry) => entry.name === name,
    );
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
    this.enumsByKey.set(key, {
      name,
      members: sorted,
    });
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
    const definition = [...this.enumsByKey.values()].find(
      (entry) => entry.name === dataType.name,
    );
    if (!definition || !definition.members.includes(literal)) {
      this.fail(node, `'${literal}' is not a member of ${dataType.name}.`);
    }
    this.emittedNamedTypes.add(dataType.name);
    return `bblscene::${dataType.name}::${this.enumMemberIdentifier(definition, literal)}`;
  }

  /** A C++ identifier for one member, disambiguating punctuation aliases. */
  private enumMemberIdentifier(
    definition: DataEnumDefinition,
    literal: string,
  ): string {
    const occurrences = new Map<string, number>();
    for (const member of definition.members) {
      const base = sanitizeIdentifier(member);
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
    const definition = [...this.enumsByKey.values()].find(
      (entry) => entry.name === dataType.name,
    );
    if (!definition) {
      this.fail(node, `Unknown enum '${dataType.name}'.`);
    }
    this.emittedNamedTypes.add(dataType.name);
    this.runtimeEnumParsers.add(dataType.name);
    return `bblscene::${dataType.name}_from_string(${cpp})`;
  }

  /** Converts a runtime string-literal union back to its JavaScript text. */
  public enumToStringCpp(
    dataType: DataType & { kind: "enum" },
    cpp: string,
    node: ts.Node,
  ): string {
    const definition = [...this.enumsByKey.values()].find(
      (entry) => entry.name === dataType.name,
    );
    if (!definition) {
      this.fail(node, `Unknown enum '${dataType.name}'.`);
    }
    this.emittedNamedTypes.add(dataType.name);
    this.runtimeEnumSerializers.add(dataType.name);
    return `bblscene::${dataType.name}_to_string(${cpp})`;
  }

  /**
   * A struct's field types, or an empty list when the struct is not
   * registered. Unlike `structFields` this asks a question rather
   * than asserting an answer, so it needs no node to blame.
   */
  public structFieldTypes(name: string): DataType[] {
    const definition = [...this.structsByKey.values()].find(
      (entry) => entry.name === name,
    );
    return (definition?.fields ?? []).map((field) => field.type);
  }

  /** Whether a data shape contains a stored native closure. */
  public carriesFunction(type: DataType, seen = new Set<string>()): boolean {
    switch (type.kind) {
      case "function":
        return true;
      case "optional":
        return this.carriesFunction(type.inner, seen);
      case "vector":
      case "span":
      case "enummap":
      case "set":
        return this.carriesFunction(type.element, seen);
      case "map":
        return (
          this.carriesFunction(type.key, seen) ||
          this.carriesFunction(type.value, seen)
        );
      case "struct":
        if (seen.has(type.name)) return false;
        seen.add(type.name);
        return this.structFieldTypes(type.name).some((field) =>
          this.carriesFunction(field, seen),
        );
      default:
        return false;
    }
  }

  /**
   * Whether a value of this shape physically contains a borrowed event.
   *
   * Function signatures deliberately stop the walk: a stored handler may
   * accept an event-bearing payload without itself containing a live event.
   */
  public carriesBorrowedPlatformEvent(
    type: DataType,
    seen = new Set<string>(),
  ): boolean {
    switch (type.kind) {
      case "borrowed-platform-event":
        return true;
      case "optional":
        return this.carriesBorrowedPlatformEvent(type.inner, seen);
      case "vector":
      case "span":
      case "enummap":
      case "set":
        return this.carriesBorrowedPlatformEvent(type.element, seen);
      case "map":
        return (
          this.carriesBorrowedPlatformEvent(type.key, seen) ||
          this.carriesBorrowedPlatformEvent(type.value, seen)
        );
      case "function":
        return false;
      case "struct":
        if (seen.has(type.name)) return false;
        seen.add(type.name);
        return this.structFieldTypes(type.name).some((field) =>
          this.carriesBorrowedPlatformEvent(field, seen),
        );
      default:
        return false;
    }
  }

  /** The shared structural view of two record types, if one is non-empty. */
  public commonStruct(
    left: Extract<DataType, { kind: "struct" }>,
    right: Extract<DataType, { kind: "struct" }>,
  ): Extract<DataType, { kind: "struct" }> | undefined {
    if (dataTypesEqual(left, right)) return left;
    const fieldsFor = (name: string): DataStructField[] =>
      [...this.structsByKey.values()].find((entry) => entry.name === name)
        ?.fields ?? [];
    const rightFields = new Map(
      fieldsFor(right.name).map((field) => [field.sourceName, field]),
    );
    const fields = fieldsFor(left.name).filter((field) => {
      const candidate = rightFields.get(field.sourceName);
      return candidate && dataTypesEqual(candidate.type, field.type);
    });
    if (fields.length === 0) return undefined;
    const key = fields
      .map(
        (field) =>
          `${field.sourceName}:${field.name}:${this.typeKey(field.type)}:required`,
      )
      .join(",");
    const existing = this.structsByKey.get(key);
    if (existing) return { kind: "struct", name: existing.name };
    const name = this.uniqueName(
      `Record${++this.anonymousStructIndex}`,
      this.structNames,
    );
    this.structsByKey.set(key, {
      name,
      fields: fields.map(({ sourceName, name: fieldName, type }) => ({
        sourceName,
        name: fieldName,
        type,
      })),
    });
    return { kind: "struct", name };
  }

  /** Whether a plain-data shape owns an engine/PAL resource handle. */
  public carriesHandle(type: DataType, seen = new Set<string>()): boolean {
    switch (type.kind) {
      case "handle":
        return true;
      case "optional":
        return this.carriesHandle(type.inner, seen);
      case "vector":
      case "span":
      case "enummap":
      case "set":
        return this.carriesHandle(type.element, seen);
      case "map":
        return (
          this.carriesHandle(type.key, seen) ||
          this.carriesHandle(type.value, seen)
        );
      case "function":
        // A stored function reaches whatever its signature names, which is
        // what a class field holding a handler has to be judged on.
        return (
          type.parameters.some((parameter) =>
            this.carriesHandle(parameter, seen)) ||
          (type.result !== undefined && this.carriesHandle(type.result, seen))
        );
      case "struct":
        if (seen.has(type.name)) return false;
        seen.add(type.name);
        return this.structFieldTypes(type.name).some((field) =>
          this.carriesHandle(field, seen),
        );
      default:
        return false;
    }
  }

  public structFields(name: string, node: ts.Node): DataStructField[] {
    const definition = [...this.structsByKey.values()].find(
      (entry) => entry.name === name,
    );
    if (!definition) {
      this.fail(node, `Unknown generated struct '${name}'.`);
    }
    return definition.fields;
  }

  public structField(
    name: string,
    field: string,
    node: ts.Node,
  ): DataStructField {
    const found = this.structFields(name, node).find(
      (candidate) =>
        candidate.sourceName === field ||
        candidate.name === field,
    );
    if (!found) {
      this.fail(node, `Struct ${name} has no field '${field}'.`);
    }
    return found;
  }

  /**
   * Materializes a uniform static numeric table (nested readonly array
   * literals with numeric leaves) as a namespace-scope constant. Returns
   * the table name and dimensions.
   */
  public registerTable(
    declaration: ts.Node,
    preferredName: string,
    literal: ts.ArrayLiteralExpression,
    compileLeaf: (expression: ts.Expression) => number,
  ): { name: string; dimensions: number[] } {
    const existing = this.tables.get(declaration);
    if (existing) {
      return {
        name: existing.name,
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
    return { name, dimensions };
  }

  /**
   * Materializes a one-dimensional constant array as a
   * namespace-scope constant, so an index computed at runtime can
   * read it. Keyed by the array's declaration, so every use site
   * shares one constant. Returns the constant's name.
   */
  public registerConstantArray(
    declaration: ts.Node,
    preferredName: string,
    elementCppType: string,
    elements: string[],
  ): string {
    const existing = this.tagTables.get(declaration);
    if (existing) {
      return existing.name;
    }
    const name = this.uniqueName(
      sanitizeIdentifier(preferredName),
      this.tableNames,
    );
    this.tagTables.set(declaration, {
      name,
      elementCppType,
      elements,
    });
    return name;
  }

  private tableDimensions(
    literal: ts.ArrayLiteralExpression,
    compileLeaf: (expression: ts.Expression) => number,
  ): number[] {
    if (literal.elements.length === 0) {
      this.fail(literal, "Static tables require non-empty array literals.");
    }
    const first = literal.elements[0]!;
    if (ts.isArrayLiteralExpression(first)) {
      const inner = this.tableDimensions(first, compileLeaf);
      for (const element of literal.elements) {
        if (!ts.isArrayLiteralExpression(element)) {
          this.fail(element, "Static tables require uniform nesting.");
        }
        const elementDims = this.tableDimensions(element, compileLeaf);
        if (elementDims.join(",") !== inner.join(",")) {
          this.fail(element, "Static tables require uniform dimensions.");
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
    switch (dataType.kind) {
      case "number":
        return "double";
      case "boolean":
        return "bool";
      case "arraybuffer":
        return "bbl::js::ArrayBuffer";
      case "dataview":
        return "bbl::js::DataView";
      case "borrowed-platform-event":
        return dataType.event === "event"
          ? "bbl::js::BorrowedEvent"
          : `bbl::js::Borrowed<const bbl::Platform${
              dataType.event === "mouse" ? "Mouse" : "Keyboard"
            }Event>`;
      case "string":
        return "std::string";
      case "handle":
        return handleCppTypes[dataType.handle];
      case "function": {
        const signature =
          `${dataType.result ? this.cppType(dataType.result) : "void"}` +
          `(${dataType.parameters.map((parameter) => this.cppType(parameter)).join(", ")})`;
        return `bbl::js::Callback<${signature}>`;
      }
      case "struct":
        this.emittedNamedTypes.add(dataType.name);
        return `bblscene::${dataType.name}`;
      case "enum":
        this.emittedNamedTypes.add(dataType.name);
        return `bblscene::${dataType.name}`;
      case "json":
        return "bbl::js::JsonValue";
      case "optional":
        if (
          dataType.inner.kind === "struct" &&
          this.isReferenceStruct(dataType.inner.name)
        ) {
          return this.cppType(dataType.inner);
        }
        return `bbl::js::Nullable<${this.cppType(dataType.inner)}>`;
      case "vector":
        return `bbl::js::Array<${this.cppType(dataType.element)}>`;
      case "map":
        return `bbl::js::Map<${this.cppType(dataType.key)}, ${this.cppType(dataType.value)}>`;
      case "set":
        return `bbl::js::Set<${this.cppType(dataType.element)}>`;
      case "span":
        return `bbl::js::Span<const ${this.cppType(dataType.element)}>`;
      case "tuple":
        return `bbl::js::Tuple<${dataType.arity}>`;
      case "enummap":
        this.emittedNamedTypes.add(dataType.enumName);
        return `bbl::js::EnumMap<${this.cppType(dataType.element)}, ${this.enumMembers(dataType.enumName).length}>`;
      case "table":
        return `const ${this.tableCppType(dataType.dimensions)}&`;
      case "u8array":
        return "bbl::js::U8Array";
      case "f64array":
        return "bbl::js::F64Array";
      case "f32array":
        return "bbl::js::F32Array";
      case "u16array":
        return "bbl::js::U16Array";
      case "i16array":
        return "bbl::js::I16Array";
      case "u32array":
        return "bbl::js::U32Array";
      case "i32array":
        return "bbl::js::I32Array";
    }
  }

  private typeKey(dataType: DataType): string {
    switch (dataType.kind) {
      case "number":
        return "n";
      case "boolean":
        return "b";
      case "arraybuffer":
        return "ab";
      case "dataview":
        return "dv";
      case "borrowed-platform-event":
        return `borrowed(${dataType.event})`;
      case "string":
        return "str";
      case "handle":
        return `h(${dataType.handle})`;
      case "function":
        return `${dataType.identity ? "cb" : "fn"}(${dataType.parameters.map((parameter) => this.typeKey(parameter)).join(",")})${dataType.erasedParameters?.length ? `~${dataType.erasedParameters.join(",")}` : ""}->${dataType.result ? this.typeKey(dataType.result) : "void"}`;
      case "struct":
        return `s(${dataType.name})`;
      case "enum":
        return `e(${dataType.name})`;
      case "json":
        return "json";
      case "optional":
        return `o(${this.typeKey(dataType.inner)})`;
      case "vector":
        return `v(${this.typeKey(dataType.element)})`;
      case "map":
        return `map(${this.typeKey(dataType.key)},${this.typeKey(dataType.value)})`;
      case "set":
        return `set(${this.typeKey(dataType.element)})`;
      case "span":
        return `r(${this.typeKey(dataType.element)})`;
      case "tuple":
        return `t${dataType.arity}`;
      case "enummap":
        return `m(${dataType.enumName},${this.typeKey(dataType.element)})`;
      case "table":
        return `g(${dataType.dimensions.join("x")})`;
      case "u8array":
        return "u8";
      case "f64array":
        return "f64";
      case "f32array":
        return "f32";
      case "u16array":
        return "u16";
      case "i16array":
        return "i16";
      case "u32array":
        return "u32";
      case "i32array":
        return "i32";
    }
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
          this.jsonSerializedStructs.add(current.name);
          path.push(current.name);
          for (const field of this.structFields(current.name, node)) {
            visit(field.type);
          }
          path.pop();
          return;
        }
        case "optional":
          visit(current.inner);
          return;
        case "vector":
        case "set":
        case "span":
          visit(current.element);
          return;
        case "map":
          if (current.key.kind !== "string" && current.key.kind !== "number") {
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

  /**
   * The `json_write` overloads for the reached records, emitted beside the
   * structs themselves so ADL finds them from the generic writer. The
   * declarations come first, so a record that names another one -- in
   * either order -- resolves.
   */
  private renderJsonCodecs(used: ReadonlySet<string>): string[] {
    const names = [...this.jsonSerializedStructs].filter((name) =>
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
      const definition = [...this.structsByKey.values()].find(
        (candidate) => candidate.name === name,
      );
      lines.push(
        `inline void json_write(bbl::js::JsonWriter& writer, const ${structName(name)}& value) {`,
        "    writer.begin_object();",
      );
      for (const field of definition?.fields ?? []) {
        const key = JSON.stringify(field.sourceName);
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
            `    if (value.${field.name}.has_value()) {`,
            `        writer.key(${key});`,
            `        json_write(writer, *value.${field.name});`,
            "    }",
          );
          continue;
        }
        lines.push(
          `    writer.key(${key});`,
          `    json_write(writer, value.${field.name});`,
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
  public renderPreamble(): string {
    const used = this.reachableNamedTypes();
    if (
      used.structs.size === 0 &&
      used.enums.size === 0 &&
      this.tables.size === 0 &&
      this.tagTables.size === 0
    ) {
      return "";
    }
    const lines: string[] = ["namespace bblscene {", ""];
    for (const definition of this.enumsByKey.values()) {
      if (!used.enums.has(definition.name)) {
        continue;
      }
      lines.push(
        `enum class ${definition.name} {`,
        ...definition.members.map(
          (member) => `    ${this.enumMemberIdentifier(definition, member)},`,
        ),
        "};",
        "",
      );
      if (this.runtimeEnumParsers.has(definition.name)) {
        lines.push(
          `inline ${definition.name} ${definition.name}_from_string(const std::string& value) {`,
          ...definition.members.map(
            (member) =>
              `    if (value == ${JSON.stringify(member)}) return ${definition.name}::${this.enumMemberIdentifier(definition, member)};`,
          ),
          `    throw std::runtime_error("Invalid ${definition.name} value: " + value);`,
          "}",
          "",
        );
      }
      if (this.runtimeEnumSerializers.has(definition.name)) {
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
    }
    const emitted = new Set<string>();
    const structs = [...this.structsByKey.values()].filter((definition) =>
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
      lines.push(
        `struct ${definition.name}${this.isReferenceStruct(definition.name) ? "Data" : ""} {`,
        ...definition.fields.map(
          (field) => `    ${this.cppType(field.type)} ${field.name};`,
        ),
        `    friend void gc_trace_edges([[maybe_unused]] const ${definition.name}${this.isReferenceStruct(definition.name) ? "Data" : ""}& record, [[maybe_unused]] const bbl::js::TraceVisitor& visitor) {`,
        ...definition.fields.map((field) => `        visitor(record.${field.name});`),
        "    }",
        "};",
        "",
      );
    };
    for (const definition of structs) {
      emitStruct(definition);
    }
    for (const table of this.tables.values()) {
      lines.push(
        `inline const ${this.tableCppType(table.dimensions)} ${table.name} = ${table.values};`,
        "",
      );
    }
    for (const table of this.tagTables.values()) {
      lines.push(
        `inline const std::array<${table.elementCppType}, ${table.elements.length}> ${table.name}{${table.elements.join(", ")}};`,
        "",
      );
    }
    lines.push(...this.renderJsonCodecs(used.structs));
    lines.push("}  // namespace bblscene");
    return lines.join("\n");
  }

  private reachableNamedTypes(): {
    structs: Set<string>;
    enums: Set<string>;
  } {
    const structs = new Set<string>();
    const enums = new Set<string>();
    const visit = (dataType: DataType): void => {
      switch (dataType.kind) {
        case "struct": {
          if (structs.has(dataType.name)) {
            return;
          }
          structs.add(dataType.name);
          const definition = [...this.structsByKey.values()].find(
            (candidate) => candidate.name === dataType.name,
          );
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
        case "span":
          visit(dataType.element);
          return;
        case "map":
          visit(dataType.key);
          visit(dataType.value);
          return;
        case "function":
          for (const parameter of dataType.parameters) visit(parameter);
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
      const struct = [...this.structsByKey.values()].find(
        (candidate) => candidate.name === name,
      );
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
      case "struct":
        return this.isReferenceStruct(dataType.name) ? [] : [dataType.name];
      case "optional":
        return this.structDependencies(dataType.inner);
      case "vector":
      case "span":
        return this.structDependencies(dataType.element);
      case "function":
        return [
          ...dataType.parameters.flatMap((parameter) =>
            this.structDependencies(parameter)),
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
