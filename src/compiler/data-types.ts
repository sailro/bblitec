import ts from "typescript";
import { cppIdentifier, doubleLiteral } from "../cpp-literals.js";

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
  | "camera"
  | "ui-element"
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
  camera: "bbl::CameraHandle",
  "ui-element": "bbl::UiElementHandle",
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
  // TransformNode is a pure alias for the pin's SceneNode interface.
  SceneNode: "transform-node",
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
    }
  | { kind: "struct"; name: string }
  | { kind: "enum"; name: string }
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
  name: string;
  type: DataType;
  /** A discriminated-union field absent from at least one inactive arm. */
  defaultWhenMissing?: boolean;
}

interface DataStructDefinition {
  name: string;
  fields: DataStructField[];
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
    case "u8array":
    case "f64array":
    case "f32array":
    case "u16array":
    case "i16array":
    case "u32array":
    case "i32array":
      return true;
    case "handle":
      return left.handle === (right as { handle: string }).handle;
    case "function": {
      const other = right as {
        parameters: DataType[];
        result?: DataType;
      };
      return (
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
    ts.Symbol | ts.Type,
    string
  >();
  private readonly structTypesByIdentity = new Map<
    ts.Symbol | ts.Type,
    DataType & { kind: "struct" }
  >();
  private readonly referenceStructNames = new Set<string>();
  private anonymousStructIndex = 0;
  private anonymousEnumIndex = 0;

  public constructor(
    private readonly checker: ts.TypeChecker,
    private readonly fail: Fail,
    private readonly assetRootsReachable: () => boolean = () => false,
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
        return { ...dataType, element };
      }
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
    if (type.symbol && isDomElementType(type.symbol)) {
      return { kind: "handle", handle: "ui-element" };
    }
    if ((type.symbol?.declarations ?? []).some(ts.isClassDeclaration)) {
      // Reached local classes keep their methods and identity in the
      // class lowerer. Treating their public fields as an anonymous
      // struct would erase both at a parameter or field boundary.
      return undefined;
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
    const pinnedHandle = type.symbol
      ? pinnedHandleTypes[type.symbol.name]
      : undefined;
    if (pinnedHandle && declaredInBabylonLite(type.symbol!)) {
      if (pinnedHandle === "transform-node" && this.assetRootsReachable()) {
        // TransformNode has two native representations: a node the scene
        // created (a bbl::TransformNodeHandle) and an imported asset's
        // synthetic root, which native loading folds into the asset record
        // rather than allocating a node. A program that can mint the second
        // keeps every TransformNode-typed record compile-time, where either
        // may sit; only a program that cannot gets the handle.
        return undefined;
      }
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
        const element = this.fromTsType(elementType, node);
        return element ? { kind: "span", element } : undefined;
      }
      if (symbolName === "Array" || symbolName === "ReadonlyArray") {
        const [elementType] = this.checker.getTypeArguments(reference);
        if (!elementType) {
          return undefined;
        }
        const element = this.fromTsType(elementType, node);
        if (!element) {
          return undefined;
        }
        // Replacing an element and mutating the object stored in an
        // element are separate permissions: even ReadonlyArray keeps
        // object identity for its values.
        const storedElement = this.markStoredObjectReferences(element);
        return symbolName === "Array"
          ? { kind: "vector", element: storedElement }
          : { kind: "span", element: storedElement };
      }
      if (symbolName === "Map" || symbolName === "ReadonlyMap") {
        const [keyType, valueType] = this.checker.getTypeArguments(reference);
        if (!keyType || !valueType) return undefined;
        const key = this.fromTsType(keyType, node);
        const value = this.fromTsType(valueType, node);
        if (!key || !value) return undefined;
        return {
          kind: "map",
          key: this.markStoredObjectReferences(key),
          value: this.markStoredObjectReferences(value),
        };
      }
      if (symbolName === "Set") {
        const [elementType] = this.checker.getTypeArguments(reference);
        if (!elementType) return undefined;
        const element = this.fromTsType(elementType, node);
        return element
          ? {
              kind: "set",
              element: this.markStoredObjectReferences(element),
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
    const parameters = signature.getParameters().map((parameter) => {
      const declaration =
        parameter.valueDeclaration ?? parameter.declarations?.[0];
      return this.fromTsType(
        this.checker.getTypeOfSymbolAtLocation(parameter, declaration ?? node),
        declaration ?? node,
      );
    });
    if (parameters.some((parameter) => parameter === undefined)) {
      return undefined;
    }
    const resultType = this.checker.getReturnTypeOfSignature(signature);
    const result = (resultType.flags & ts.TypeFlags.Void) !== 0
      ? undefined
      : this.fromTsType(resultType, node);
    if ((resultType.flags & ts.TypeFlags.Void) === 0 && !result) {
      return undefined;
    }
    return {
      kind: "function",
      parameters: parameters as DataType[],
      ...(result ? { result } : {}),
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
        name: sanitizeIdentifier(property.name),
        type: this.markStoredObjectReferences(first),
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
      .map((field) => `${field.name}:${this.typeKey(field.type)}:required`)
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
        name: sanitizeIdentifier(propertyName),
        type: this.markStoredObjectReferences(mapped),
        ...(propertyTypes.length < type.types.length
          ? { defaultWhenMissing: true }
          : {}),
      });
    }
    const key = fields
      .map(
        (field) =>
          `${field.name}:${this.typeKey(field.type)}:${field.defaultWhenMissing ? "default" : "required"}`,
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
    const mapped = elements.map((element) => this.fromTsType(element, node));
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

  private structIdentity(type: ts.Type): ts.Symbol | ts.Type {
    // A generic alias symbol names the factory, not one instantiation.
    // `Record<ClosedKeys, T>` and `Record<string, U>` therefore share the
    // global `Record` symbol while exposing different property sets. Key
    // instantiated aliases by the checker type itself so one mapping
    // cannot poison the next; non-generic aliases and named interfaces
    // retain their stable symbol identity.
    if (type.aliasSymbol && (type.aliasTypeArguments?.length ?? 0) > 0) {
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
          ts.isPropertySignature(declaration) &&
          (property.flags & ts.SymbolFlags.Optional) === 0
          ? this.fromFunctionType(propertyType, declaration ?? node)
          : undefined
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
        name: sanitizeIdentifier(property.name),
        type: mapped,
        ...(optional && mapped.kind !== "optional"
          ? { defaultWhenMissing: true }
          : {}),
      });
    }
    const key = `${fields
      .map(
        (field) =>
          `${field.name}:${this.typeKey(field.type)}:${field.defaultWhenMissing ? "default" : "required"}`,
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
      const element = this.fromTsType(indexedValue, node);
      if (!element) return undefined;
      return {
        kind: "map",
        key: stringValue ? { kind: "string" } : { kind: "number" },
        value: this.markStoredObjectReferences(element),
      };
    }
    const key = this.fromTsType(keyType, node);
    const element = this.fromTsType(valueType, node);
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
      element,
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
      fieldsFor(right.name).map((field) => [field.name, field]),
    );
    const fields = fieldsFor(left.name).filter((field) => {
      const candidate = rightFields.get(field.name);
      return candidate && dataTypesEqual(candidate.type, field.type);
    });
    if (fields.length === 0) return undefined;
    const key = fields
      .map((field) => `${field.name}:${this.typeKey(field.type)}:required`)
      .join(",");
    const existing = this.structsByKey.get(key);
    if (existing) return { kind: "struct", name: existing.name };
    const name = this.uniqueName(
      `Record${++this.anonymousStructIndex}`,
      this.structNames,
    );
    this.structsByKey.set(key, {
      name,
      fields: fields.map(({ name: fieldName, type }) => ({
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
      (candidate) => candidate.name === field,
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
      case "string":
        return "std::string";
      case "handle":
        return handleCppTypes[dataType.handle];
      case "function":
        return `std::function<${dataType.result ? this.cppType(dataType.result) : "void"}(${dataType.parameters.map((parameter) => this.cppType(parameter)).join(", ")})>`;
      case "struct":
        this.emittedNamedTypes.add(dataType.name);
        return `bblscene::${dataType.name}`;
      case "enum":
        this.emittedNamedTypes.add(dataType.name);
        return `bblscene::${dataType.name}`;
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
      case "string":
        return "str";
      case "handle":
        return `h(${dataType.handle})`;
      case "function":
        return `fn(${dataType.parameters.map((parameter) => this.typeKey(parameter)).join(",")})->${dataType.result ? this.typeKey(dataType.result) : "void"}`;
      case "struct":
        return `s(${dataType.name})`;
      case "enum":
        return `e(${dataType.name})`;
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
