export type AssignmentValueKind = "color3" | "number";

export interface DirectPropertyAssignment {
  collection: "lights";
  nativeProperty: string;
  valueKind: AssignmentValueKind;
  supportsCompound: boolean;
}

/**
 * Property writes that store one value into one field of an engine
 * record. They differ only in which record, which field, and how the
 * right-hand side compiles, so they are declared rather than repeated:
 * the ceremony around them (resolving the engine, rejecting a compound
 * assignment where JavaScript semantics need a fresh value) was identical
 * in every copy.
 *
 * `simpleOnly` marks the fields where `+=` has no meaning because the
 * value is a colour or a flag rather than an accumulating number.
 */
interface RecordFieldAssignment {
  kind: "material" | "camera-ortho" | "mesh";
  property: string;
  collection: "materials" | "cameras" | "meshes";
  /** The record field, or the pair a two-element source writes. */
  field: string | readonly [string, string];
  value: "color3" | "number" | "boolean" | "number2";
  simpleOnly?: boolean;
  /** Stored as the logical inverse of what the source assigns. */
  invert?: boolean;
  feature?: Feature;
}

/**
 * The `Texture2D` properties a scene writes on a texture it built.
 *
 * Upstream these are plain fields on the object every loader and factory
 * returns; `enableMaterialUvTransform` is what makes any of them observable,
 * because `writeUvTransformData` is the only reader. The table is that
 * writer's own, imported rather than restated, so the member a write lands
 * on and the member the block reads back cannot drift apart. `invertY` is the
 * texture-OBJECT property, which is also what `isStandardUvInverted` reads --
 * not `loadTexture2D`'s upload flip.
 */
const textureRecordFields = TEXTURE_UV_PROPERTIES;

const recordFieldAssignments: readonly RecordFieldAssignment[] = [
  {
    // Mesh visibility is a live scene-node field in the pin. The native
    // renderer and camera-bounds traversal both read this record bit, so
    // the plain assignment is the complete reached contract.
    kind: "mesh",
    property: "visible",
    collection: "meshes",
    field: "visible",
    value: "boolean",
    simpleOnly: true,
    feature: "mesh:visible",
  },
  {
    kind: "mesh",
    property: "pickable",
    collection: "meshes",
    field: "pickable",
    value: "boolean",
    simpleOnly: true,
    feature: "mesh:pickable",
  },
  {
    kind: "material",
    property: "diffuseColor",
    collection: "materials",
    field: "diffuse_color",
    value: "color3",
    simpleOnly: true,
  },
  {
    kind: "material",
    property: "specularColor",
    collection: "materials",
    field: "specular_color",
    value: "color3",
    simpleOnly: true,
  },
  {
    kind: "material",
    property: "emissiveColor",
    collection: "materials",
    field: "emissive_factor",
    value: "color3",
    simpleOnly: true,
  },
  {
    kind: "material",
    property: "alpha",
    collection: "materials",
    field: "alpha",
    value: "number",
  },
  {
    // The pin's `uvScale: [number, number]`, which
    // `writeStandardUvTransformData` reads into the material's own UV
    // block. It is a pair of record fields because
    // `standard_material_props` composes them back into the props
    // mirror the pinned writer reads.
    kind: "material",
    property: "uvScale",
    collection: "materials",
    field: ["diffuse_u_scale", "diffuse_v_scale"],
    value: "number2",
    simpleOnly: true,
  },
  {
    kind: "material",
    property: "specularPower",
    collection: "materials",
    field: "specular_power",
    value: "number",
  },
  {
    kind: "material",
    property: "disableLighting",
    collection: "materials",
    field: "disable_lighting",
    value: "boolean",
    simpleOnly: true,
  },
  {
    // src/material/standard/create-standard-material.ts defaults
    // `backFaceCulling: true`, and standard-pipeline.ts culls with
    // `features & DOUBLE_SIDED ? "none" : "back"`, so the flag is the
    // native `double_sided` inverted.
    kind: "material",
    property: "backFaceCulling",
    collection: "materials",
    field: "double_sided",
    value: "boolean",
    simpleOnly: true,
    invert: true,
  },
  {
    // The pin's default-true `usePhysicalLightFalloff`, which
    // `_writeMaterialData` reads as `=== false ? 0 : 1` into the
    // material UBO's falloff-mode lane. Every composed punctual arm
    // carries both falloffs and selects on that lane, so the property
    // composes nothing and a write after creation is one store — the
    // same lane `createPbrMaterial`'s own option fills.
    kind: "material",
    property: "usePhysicalLightFalloff",
    collection: "materials",
    field: "use_physical_light_falloff",
    value: "boolean",
    simpleOnly: true,
  },
  {
    // src/camera/orthographic.ts: the bounds stay live, and its setter
    // only stores the extent and invalidates the projection cache. The
    // native projection is rebuilt from the record every frame, so
    // storing it is the whole contract.
    kind: "camera-ortho",
    property: "halfHeight",
    collection: "cameras",
    field: "ortho_half_height",
    value: "number",
  },
];

function emitFrameGraphTransmission(
  context: AssignmentContext,
  expression: ts.BinaryExpression,
  left: ts.PropertyAccessExpression,
): boolean {
  if (
    left.name.text !== "transmission" ||
    !ts.isPropertyAccessExpression(left.expression) ||
    left.expression.name.text !== "_config"
  ) {
    return false;
  }
  const task = context.unwrap(left.expression.expression);
  if (
    !ts.isElementAccessExpression(task) ||
    !ts.isPropertyAccessExpression(task.expression) ||
    task.expression.name.text !== "_tasks"
  ) {
    return false;
  }
  const frameGraph = context.unwrap(task.expression.expression);
  if (
    !ts.isCallExpression(frameGraph) ||
    !ts.isIdentifier(frameGraph.expression) ||
    context.importedName(frameGraph.expression) !== "getFrameGraph" ||
    frameGraph.arguments.length !== 1
  ) {
    return false;
  }
  const options = context.unwrap(expression.right);
  if (!ts.isObjectLiteralExpression(options)) {
    context.fail(
      expression.right,
      "Frame-graph transmission requires an options object.",
    );
  }
  const copyCount = context.objectProperty(options, "copyCount");
  if (!copyCount || context.compileNumber(copyCount) !== "1.0f") {
    context.fail(
      options,
      "Reached frame-graph transmission requires copyCount: 1.",
    );
  }
  const scene = context.compileValue(frameGraph.arguments[0]!);
  context.expectKind(scene, "scene", frameGraph.arguments[0]!);
  context.reachFeature("renderer:scene", expression);
  context.reachFeature("renderer:transmission", expression);
  context.reachFeature("material:pbr-linear-image-processing", expression);
  context.emit(`bbl::enable_scene_transmission(${scene.cpp});`);
  return true;
}

/**
 * Assignment shapes recognized from their complete source structure.
 *
 * These run before plain-data path probing because their intermediate
 * objects are intentionally generation-only and are not independently
 * readable values.
 */
export function emitStructuralPropertyAssignment(
  context: AssignmentContext,
  expression: ts.BinaryExpression,
): boolean {
  const left = context.unwrap(expression.left);
  return (
    ts.isPropertyAccessExpression(left) &&
    emitFrameGraphTransmission(context, expression, left)
  );
}

const commonLightProperties: Readonly<
  Record<string, DirectPropertyAssignment>
> = {
  intensity: {
    collection: "lights",
    nativeProperty: "intensity",
    valueKind: "number",
    supportsCompound: true,
  },
};

/** The colour pair every positional kind writes. */
const positionalLightProperties: Readonly<
  Record<string, DirectPropertyAssignment>
> = {
  ...commonLightProperties,
  diffuse: {
    collection: "lights",
    nativeProperty: "diffuse_color",
    valueKind: "color3",
    supportsCompound: false,
  },
  specular: {
    collection: "lights",
    nativeProperty: "specular_color",
    valueKind: "color3",
    supportsCompound: false,
  },
};

/** `_writeLightUbo` packs it into the same lane for point and spot alike. */
const lightRangeProperty: DirectPropertyAssignment = {
  collection: "lights",
  nativeProperty: "range",
  valueKind: "number",
  supportsCompound: true,
};

/**
 * The spot cone's falloff exponent. `spot-light.ts` declares it as a plain
 * number on the object it hands to `applyWorldMatrixAccessors`, and its own
 * `_writeLightUbo` packs it into `vLightSpecular.w`, so a write is one store
 * with nothing to re-derive — unlike `angle` below.
 */
const lightExponentProperty: DirectPropertyAssignment = {
  collection: "lights",
  nativeProperty: "exponent",
  valueKind: "number",
  supportsCompound: true,
};

const lightProperties: Readonly<
  Record<LightKind, Readonly<Record<string, DirectPropertyAssignment>>>
> = {
  directional: positionalLightProperties,
  hemispheric: {
    ...commonLightProperties,
    diffuseColor: {
      collection: "lights",
      nativeProperty: "diffuse_color",
      valueKind: "color3",
      supportsCompound: false,
    },
    specularColor: {
      collection: "lights",
      nativeProperty: "specular_color",
      valueKind: "color3",
      supportsCompound: false,
    },
    groundColor: {
      collection: "lights",
      nativeProperty: "ground_color",
      valueKind: "color3",
      supportsCompound: false,
    },
  },
  // The three positional kinds carry the same colour pair; the two whose
  // pinned writer packs an attenuation range carry that too, and the spot
  // adds the cone exponent its own writer packs. Its `angle` is not here:
  // upstream that one is an accessor rather than a field, so it lowers
  // through `lightScalarSetters` below.
  point: {
    ...positionalLightProperties,
    range: lightRangeProperty,
  },
  spot: {
    ...positionalLightProperties,
    range: lightRangeProperty,
    exponent: lightExponentProperty,
  },
};

export function directPropertyAssignment(
  owner: Value,
  property: string,
): DirectPropertyAssignment | undefined {
  if (owner.kind !== "light" || !owner.lightKind) {
    return undefined;
  }
  return lightProperties[owner.lightKind][property];
}

/**
 * The light vectors a scene may write after creation, beside the scalar and
 * colour properties above and for the same reason: a kind carries the vectors
 * its pinned type declares, and one no reached scene writes stays unlowered
 * and fails explicitly rather than being accepted and ignored.
 *
 * `light.position.set(x, y, z)` is not a record-field write like the entries
 * above — an `ObservableVec3` write also marks the light's local matrix
 * dirty — so each of these lowers to its own kind's emitted entry point
 * rather than to a `DirectPropertyAssignment`. `LightLowerer` emits exactly
 * these, checked against the pinned factory's own `ObservableVec3`
 * properties.
 */
const lightVectors: Readonly<Record<LightKind, readonly string[]>> = {
  // No reached scene writes a hemispheric direction.
  hemispheric: [],
  point: ["position"],
  directional: ["position"],
  spot: ["position", "direction"],
};

/** The emitted entry point for `light.<vector>.set(...)`, if there is one. */
export function lightVectorSetter(
  owner: Value,
  vector: string,
): string | undefined {
  if (owner.kind !== "light" || !owner.lightKind) {
    return undefined;
  }
  return lightVectors[owner.lightKind].includes(vector)
    ? `set_${owner.lightKind}_light_${vector}`
    : undefined;
}

/**
 * The light scalars whose write is more than one record store, and the
 * emitted entry point each takes.
 *
 * A spot's `angle` is the one such property in the pinned light family: the
 * factory installs it with `Object.defineProperty`, and its setter recomputes
 * the `_cosHalfAngle` the UBO writer actually packs. The record holds both
 * (`LightRecord::angle` beside `cos_half_angle`, because a spot shadow
 * projection reads the angle itself), so a write that stored one of them
 * would leave the pair disagreeing. `LightLowerer` emits the setter from the
 * pin's own `Math.cos(angle * 0.5)` for the same reason the factory does.
 */
const lightScalars: Readonly<Record<LightKind, readonly string[]>> = {
  hemispheric: [],
  directional: [],
  point: [],
  spot: ["angle"],
};

/** The emitted entry point for `light.<scalar> = ...`, if there is one. */
export function lightScalarSetter(
  owner: Value,
  property: string,
): string | undefined {
  if (owner.kind !== "light" || !owner.lightKind) {
    return undefined;
  }
  return lightScalars[owner.lightKind].includes(property)
    ? `set_${owner.lightKind}_light_${property}`
    : undefined;
}

export interface AssignmentContext extends DeterministicRandomContext {
  readonly checker: ts.TypeChecker;
  /** Which material a scene-code mesh was assigned, by its mesh index. */
  recordSceneMeshMaterial(
    meshIndex: number,
    material: {
      pbrMaterial: number | null;
      nodeMaterial: number | null;
      standardMaterial: boolean;
      sceneShaderVariant?: string | undefined;
    },
  ): void;
  recordUnknownSceneMeshMaterial(materialIndex: number): void;
  recordSceneMeshAssetPbrMaterial(meshIndex: number): void;
  recordToneMappingEnabledMutation(): void;
  /** The scene's node-particle program; a texture write lands on it. */
  readonly reachedNodeParticles: CompiledNodeParticles;
  /** Pixels-texture locals already copied into a material slot. */
  readonly boundPixelsTextures: Set<string>;
  resolveStaticExpression(expression: ts.Expression): ts.Expression;
  lookupOptional(identifier: ts.Identifier): Value | undefined;
  resolveThisField(name: string): Value | undefined;
  resolveRecordValue(expression: ts.Expression): Value | undefined;
  /**
   * Records the tone-mapping curve the scene selected, refusing a second
   * differing selection: the composed arms are closed at generation, so a
   * scene reaching two curves would need a variant table this port does not
   * key by them.
   */
  selectToneMapping(name: string, node: ts.Node): void;
  lookup(identifier: ts.Identifier): Value;
  compileValue(expression: ts.Expression): Value;
  /**
   * Declares storage for a typed plain-data class field on its first
   * constructor assignment. Returns undefined for resource/record fields,
   * which remain compile-time bindings below.
   */
  bindClassDataField(
    name: ts.Identifier,
    initializer: ts.Expression,
  ): Value | undefined;
  bindClassField(name: ts.Identifier, initializer: ts.Expression): void;
  emitOptionalResourceAssignment(
    expression: ts.BinaryExpression,
    target: Value,
  ): boolean;
  /** Scene-created DOM property writes owned by the retained UI IR. */
  emitUiPropertyAssignment(expression: ts.BinaryExpression): boolean;
  compileNumber(
    expression: ts.Expression,
    precision?: "float" | "double",
  ): string;
  compileBoolean(expression: ts.Expression): string;
  compileColor3(expression: ts.Expression): string;
  compileColor4(expression: ts.Expression): string;
  compileVec3(
    expression: ts.Expression,
    precision?: "float" | "double",
  ): string;
  objectProperty(
    object: ts.ObjectLiteralExpression,
    name: string,
  ): ts.Expression | undefined;
  unwrap(expression: ts.Expression): ts.Expression;
  importedName(identifier: ts.Identifier): string | undefined;
  expectKind(value: Value, kind: ValueKind, node: ts.Node): void;
  expectSameEngine(left: Value, right: Value, node: ts.Node): void;
  requireEngine(value: Value, node: ts.Node): string;
  assertAssetRootWritable(root: Value, node: ts.Node): void;
  eraseBrowserInstrumentation(position: number): void;
  isBrowserOnlyExpression(expression: ts.Expression): boolean;
  isNativeUiValueExpression(expression: ts.Expression): boolean;
  isBrowserDomValue(expression: ts.Expression): boolean;
  emit(line: string): void;
  /** The dirty entry appropriate to startup code or a live callback. */
  meshTransformDirtyEntry():
    | "mark_mesh_dirty"
    | "mark_mesh_runtime_transform";
  /**
   * Records the feature and its first reaching scene-source call
   * site (here the assignment expression), so the activation
   * inventory can cite file:line.
   */
  reachFeature(feature: Feature, site: ts.Node): void;
  /** `mesh.receiveShadows = true`, by scene-mesh index. */
  recordShadowReceiver(sceneMeshIndex: number): void;
  recordDynamicShadowReceivers(): void;
  /** `mesh.id = "..."`, by the handle spelling the write named. */
  recordSceneMeshId(meshCpp: string, id: string, node: ts.Node): void;
  /** The meshes an `includedOnlyMeshIds` set names, as handle spellings. */
  resolveSceneMeshIds(ids: readonly string[], node: ts.Node): string[];
  propertyName(name: ts.PropertyName): string | undefined;
  probeStaticArrayLiteral(
    expression: ts.Expression,
  ): ts.ArrayLiteralExpression | undefined;
  /**
   * The strings a generation-known array expression holds, spreads and a
   * `const` binding nothing writes through included — a pure probe that
   * emits nothing, so it is the first question to ask.
   */
  staticStringElements(
    expression: ts.Expression,
  ): readonly string[] | undefined;
  compileStaticString(expression: ts.Expression): string;
  /** `material.plugins = [...]` on the scene PBR material the write names. */
  recordScenePbrPlugins(
    plugins: readonly MaterialPluginManifest[],
    index: number | undefined,
  ): void;
  /** The same, on a Standard material: its signature index, from one. */
  recordStandardMaterialPlugins(
    plugins: readonly MaterialPluginManifest[],
  ): number;
  fail(node: ts.Node, message: string): never;
}

/**
 * `scene.lights.length = 0` empties the scene's light list, which is how a
 * scene drops the lights a loaded asset brought with it and lights itself
 * from the environment alone. Only the clear is lowered: truncating to a
 * non-zero length would have to decide which handles survive, and no reached
 * scene asks for it.
 */
function emitSceneLightListClear(
  context: AssignmentContext,
  expression: ts.BinaryExpression,
  left: ts.PropertyAccessExpression,
): boolean {
  if (
    left.name.text !== "length" ||
    !ts.isPropertyAccessExpression(left.expression) ||
    left.expression.name.text !== "lights"
  ) {
    return false;
  }
  const owner = context.compileValue(left.expression.expression);
  if (owner.kind !== "scene") {
    return false;
  }
  requireSimpleAssignment(context, expression, "scene light list length");
  if (
    !ts.isNumericLiteral(expression.right) ||
    Number(expression.right.text) !== 0
  ) {
    context.fail(
      expression.right,
      "Reached scene light list assignment supports clearing to zero.",
    );
  }
  context.emit(`${owner.cpp}.lights.clear();`);
  return true;
}

/**
 * The three TRS vector properties a transform-component write names
 * (`node.position.x = ...`). One list serves the imported-root intercept,
 * the owner-path guard, and the generic component arm here — and, through
 * the exported membership test, the handle read path (`compiler.ts`), the
 * mesh `.set` guard (`statements.ts`), and the plain-data deferral
 * (`data-lowering.ts`) — so the vectors one of them discriminates on
 * cannot drift from the others'.
 */
const trsVectorNames: readonly string[] = ["position", "rotation", "scaling"];

export function isTrsVectorName(name: string): boolean {
  return trsVectorNames.includes(name);
}

/** The lane a TRS component name selects; `undefined` off the axes. */
function trsAxisIndex(name: string): number | undefined {
  return { x: 0, y: 1, z: 2 }[name as "x" | "y" | "z"];
}

/**
 * The scalars a scene writes on a particle system between simulation steps.
 *
 * All three are inputs to `animateParticleSystem` rather than properties of
 * the state it produces, so a write travels to the bake as one more step in
 * the sequence. `blendMode` and `texture` are deliberately not here: the
 * first would move a composed variant after the set is closed, and the
 * second is a resource rather than a scalar.
 */
const particleScalars = ["emitRate", "updateSpeed", "targetStopDuration"];

/**
 * One such write, recorded where the scene made it.
 *
 * The bake replays the whole sequence, so the position of this write among
 * the start/animate calls is what it means -- `updateSpeed = 0` after the
 * last step is what freezes the system a scene then registers.
 */
function emitNodeParticleScalarAssignment(
  context: AssignmentContext,
  expression: ts.BinaryExpression,
  left: ts.PropertyAccessExpression,
  target: Value,
  property: string,
): void {
  requireSimpleAssignment(
    context,
    expression,
    `node-particle system ${property}`,
  );
  const set = target.nodeParticleSetIndex;
  const system = target.nodeParticleSystemIndex;
  if (set === undefined || system === undefined) {
    context.fail(
      left,
      "This particle system did not come from a built " + "node-particle set.",
    );
  }
  const value = staticNumberValue(context, expression.right);
  if (value === undefined) {
    context.fail(
      expression.right,
      `A node-particle system's ${property} is a static number: the ` +
        "simulation runs at generation.",
    );
  }
  context.reachedNodeParticles.steps.push({
    op: "scalar",
    set,
    system,
    name: property as "emitRate" | "updateSpeed" | "targetStopDuration",
    value,
  });
}

/**
 * `system.texture = <texture>`: the image a particle system renders with.
 *
 * A graph whose `ParticleTextureSourceBlock` carries no URL leaves the
 * system untextured, and `createParticleBillboard` throws there — so the
 * corpus assigns the texture itself, and the assignment is part of the
 * program the bake replays. It is folded rather than emitted: the write is
 * a static fact about this system, and what reads it is the atlas the
 * generated billboard builder makes. A write AFTER that builder ran would
 * be a second state, so it refuses.
 */
function emitNodeParticleTextureAssignment(
  context: AssignmentContext,
  expression: ts.BinaryExpression,
  left: ts.PropertyAccessExpression,
  target: Value,
): void {
  requireSimpleAssignment(context, expression, "node-particle system texture");
  const texture = context.compileValue(expression.right);
  context.expectKind(texture, "texture", expression.right);
  if (!texture.pixelsTexture) {
    context.fail(
      expression.right,
      "A node-particle system's texture comes from " +
        "createTexture2DFromPixels with a static size: the bake " +
        "partitions its atlas by that size, and the graph's own " +
        "texture block loads every other kind.",
    );
  }
  const set = target.nodeParticleSetIndex;
  const system = target.nodeParticleSystemIndex;
  if (set === undefined || system === undefined) {
    context.fail(
      left,
      "This particle system did not come from a built " + "node-particle set.",
    );
  }
  const program = context.reachedNodeParticles;
  if (
    program.billboards.some(
      (frozen) => frozen.set === set && frozen.system === system,
    ) ||
    program.registrations.some((entry) => entry.set === set)
  ) {
    context.fail(
      left,
      "This particle system's billboard was already built; its " +
        "texture is read there.",
    );
  }
  if (
    program.textures.some(
      (entry) => entry.set === set && entry.system === system,
    )
  ) {
    context.fail(
      left,
      "This particle system's texture is already assigned; the " +
        "bake carries one.",
    );
  }
  program.textures.push({
    set,
    system,
    ...texture.pixelsTexture,
  });
}

/**
 * A post-process effect's own settable option.
 *
 * The pin gives each one a `defineProperty` pair over the factory's `params`
 * record, so a write is a store into that record and nothing else -- the
 * uniform block moves only when `updateUniforms` runs. Native keeps the same
 * split: the parameter vector takes the value here, and the backend rewrites
 * the block when the pass is next recorded.
 */
function emitPostProcessOptionAssignment(
  context: AssignmentContext,
  expression: ts.BinaryExpression,
  left: ts.PropertyAccessExpression,
  owner: Value,
): boolean {
  if (owner.kind === "task" && owner.postProcessComposite) {
    // The pin publishes setters on a composite too, but each writes a
    // parameter on a pass its own factory built, and generation baked
    // those in. Refusing says so rather than writing a slot that is not
    // the one the pin would have moved.
    context.fail(
      left,
      `'${left.name.text}' is a setter on a composite post-process ` +
        "task, which this port bakes at generation.",
    );
  }
  if (owner.kind !== "task" || !owner.postProcessTask) {
    return false;
  }
  const effect = postProcessEffect(owner.postProcessTask.intrinsic);
  const slot = effect?.params.findIndex(
    (candidate) => candidate.path === left.name.text,
  );
  if (!effect || slot === undefined || slot < 0) {
    context.fail(
      left,
      `Post-process effect '${
        owner.postProcessTask.intrinsic
      }' has no settable option '${left.name.text}'.`,
    );
  }
  requireSimpleAssignment(context, expression, "post-process option");
  // A plain effect is a task recording one pass, so its parameter vector is
  // that pass's. A composite's would be several, which is why a setter on
  // one is refused above.

  context.emit(
    `${context.requireEngine(owner, expression)}.frame_tasks[${
      owner.cpp
    }.value].post_process.passes[0].params[${slot}] = ${context.compileNumber(
      expression.right,
      "double",
    )};`,
  );
  return true;
}

/** Writes the mutable view fields exposed by `Sprite2DLayer.view`. */
function emitSpriteLayerViewAssignment(
  context: AssignmentContext,
  expression: ts.BinaryExpression,
): boolean {
  const left = context.unwrap(expression.left);
  let layerExpression: ts.Expression | undefined;
  let field: string | undefined;
  if (
    ts.isPropertyAccessExpression(left) &&
    (left.name.text === "zoom" || left.name.text === "rotation") &&
    ts.isPropertyAccessExpression(context.unwrap(left.expression)) &&
    (context.unwrap(left.expression) as ts.PropertyAccessExpression).name
      .text === "view"
  ) {
    layerExpression = (
      context.unwrap(left.expression) as ts.PropertyAccessExpression
    ).expression;
    field = left.name.text;
  } else if (
    ts.isElementAccessExpression(left) &&
    ts.isPropertyAccessExpression(context.unwrap(left.expression)) &&
    (context.unwrap(left.expression) as ts.PropertyAccessExpression).name
      .text === "positionPx"
  ) {
    const position = context.unwrap(
      (context.unwrap(left.expression) as ts.PropertyAccessExpression)
        .expression,
    );
    if (
      ts.isPropertyAccessExpression(position) &&
      position.name.text === "view"
    ) {
      const index = context.compileValue(left.argumentExpression);
      if (
        index.kind !== "number" ||
        index.staticNumber === undefined ||
        (index.staticNumber !== 0 && index.staticNumber !== 1)
      ) {
        context.fail(
          left.argumentExpression,
          "Sprite2DLayer view position requires static index 0 or 1.",
        );
      }
      layerExpression = position.expression;
      field = index.staticNumber === 0 ? "position_px.x" : "position_px.y";
    }
  }
  if (!layerExpression || !field) return false;
  requireSimpleAssignment(context, expression, "Sprite2DLayer view");
  const layer = context.compileValue(layerExpression);
  context.expectKind(layer, "sprite-layer", layerExpression);
  context.emit(
    `${context.requireEngine(layer, layerExpression)}.sprite_layers[${layer.cpp}.value].view.${field} = static_cast<float>(${context.compileNumber(expression.right, "double")});`,
  );
  return true;
}

function optionalNumberPropertyInAssertion(
  type: ts.TypeNode,
  property: string,
): boolean {
  if (ts.isParenthesizedTypeNode(type)) {
    return optionalNumberPropertyInAssertion(type.type, property);
  }
  if (ts.isIntersectionTypeNode(type)) {
    return type.types.some((member) =>
      optionalNumberPropertyInAssertion(member, property),
    );
  }
  if (!ts.isTypeLiteralNode(type)) return false;
  return type.members.some((member) => {
    if (
      !ts.isPropertySignature(member) ||
      !member.questionToken ||
      member.type?.kind !== ts.SyntaxKind.NumberKeyword
    ) {
      return false;
    }
    return (
      (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
      member.name.text === property
    );
  });
}

function explicitOptionalNumberExpandoOwner(
  expression: ts.Expression,
  property: string,
): ts.Expression | undefined {
  let asserted = expression;
  while (ts.isParenthesizedExpression(asserted)) {
    asserted = asserted.expression;
  }
  if (
    !ts.isAsExpression(asserted) &&
    !ts.isTypeAssertionExpression(asserted)
  ) {
    return undefined;
  }
  if (!optionalNumberPropertyInAssertion(asserted.type, property)) {
    return undefined;
  }
  return asserted.expression;
}

function propertyAccessName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    (ts.isStringLiteral(node.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
  ) {
    return node.argumentExpression.text;
  }
  return undefined;
}

function isSimplePropertyWrite(node: ts.Node): boolean {
  return (
    ts.isBinaryExpression(node.parent) &&
    node.parent.left === node &&
    node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  );
}

/**
 * Erase an explicitly declared optional expando that the source only writes.
 *
 * A TypeScript intersection may widen a pinned resource with a JavaScript-own
 * property that Babylon Lite neither declares nor reads. Native handles are
 * not general JavaScript objects, so retaining arbitrary property bags would
 * give every resource a run-time dictionary for a value with no observer.
 * The fold is valid only when all of the following are proven from the source:
 * the assertion spells the optional numeric member directly, the pinned owner
 * type does not declare it, and no property access with that name is read.
 * The right-hand side is still compiled and discarded so its evaluation is
 * not lost.
 */
function emitWriteOnlyNumberExpandoAssignment(
  context: AssignmentContext,
  expression: ts.BinaryExpression,
  left: ts.PropertyAccessExpression,
): boolean {
  const property = left.name.text;
  const assertedOwner = explicitOptionalNumberExpandoOwner(
    left.expression,
    property,
  );
  if (!assertedOwner) return false;

  const ownerExpression = context.unwrap(assertedOwner);
  if (!ts.isIdentifier(ownerExpression)) return false;
  const owner = context.lookup(ownerExpression);
  if (owner.kind !== "mesh") return false;

  // This is an expando only when the type before the assertion did not expose
  // the member. A cast that merely widens or re-spells a real pinned property
  // must continue through its ordinary lowering contract.
  if (
    context.checker
      .getTypeAtLocation(ownerExpression)
      .getProperty(property)
  ) {
    return false;
  }

  let observed: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (observed) return;
    if (
      node !== left &&
      propertyAccessName(node) === property &&
      !isSimplePropertyWrite(node)
    ) {
      observed = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression.getSourceFile());
  if (observed) {
    context.fail(
      observed,
      `Optional expando property '${property}' is read, so its assignment cannot be erased.`,
    );
  }

  requireSimpleAssignment(context, expression, `optional expando ${property}`);
  context.emit(
    `static_cast<void>(${context.compileNumber(expression.right, "double")});`,
  );
  return true;
}

export function emitPropertyAssignment(
  context: AssignmentContext,
  expression: ts.BinaryExpression,
): void {
  // A particle column write edits the state the bake reads, so it is
  // recorded as a step rather than emitted -- and it is an ELEMENT
  // access, which the property gate below would refuse first.
  if (emitParticleBufferWrite(context, expression)) {
    return;
  }
  if (emitSpriteLayerViewAssignment(context, expression)) {
    return;
  }
  if (!ts.isPropertyAccessExpression(expression.left)) {
    context.fail(expression.left, "Only property assignments are supported.");
  }

  const operator = assignmentOperator(context, expression);
  const left = expression.left;
  const regexpOwner = ts.isIdentifier(left.expression)
    ? (context.lookupOptional(left.expression) ??
      (context.checker.getTypeAtLocation(left.expression).symbol?.name ===
      "RegExp"
        ? context.compileValue(left.expression)
        : undefined))
    : undefined;
  if (regexpOwner?.kind === "regexp") {
    if (left.name.text !== "lastIndex") {
      context.fail(
        left.name,
        `RegExp property '${left.name.text}' is not writable.`,
      );
    }
    if (operator !== "=") {
      context.fail(
        expression.operatorToken,
        "RegExp.lastIndex requires a simple assignment.",
      );
    }
    context.emit(
      `${regexpOwner.cpp}.last_index = ${context.compileNumber(expression.right, "double")};`,
    );
    return;
  }
  if (
    emitDeterministicRandomInstall(context, expression, left, context.checker)
  ) {
    return;
  }
  // Web Audio is part of the browser type surface in TypeScript, but it
  // has an explicit native owner in this compiler. Give that owner first
  // refusal before the broad browser-only erasure gate below; otherwise a
  // supported write such as `gain.value = 0.5` disappears as if it were a
  // DOM-only operation.
  if (emitAudioPropertyAssignment(context, expression, left)) {
    return;
  }
  if (context.emitUiPropertyAssignment(expression)) {
    return;
  }
  // The same distinction applies to a nullable Web Audio handle stored in
  // a lowered class. Its declaration already created optional native
  // storage, so an assignment to `this.context` or `this.node` must fill
  // that storage before browser erasure considers the field's DOM type.
  if (operator === "=" && left.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const existing = context.resolveThisField(left.name.text);
    if (
      existing &&
      context.emitOptionalResourceAssignment(expression, existing)
    ) {
      return;
    }
  }
  if (
    operator === "=" &&
    left.expression.kind === ts.SyntaxKind.ThisKeyword &&
    ts.isIdentifier(left.name) &&
    context.isNativeUiValueExpression(expression.right)
  ) {
    const instance = context.compileValue(left.expression);
    const fields = instance.recordProperties;
    if (!fields || fields[left.name.text]) {
      context.fail(
        left,
        `Native UI field '${left.name.text}' must be wired exactly once.`,
      );
    }
    context.bindClassField(left.name, expression.right);
    fields[left.name.text] = context.compileValue(left.name);
    return;
  }
  if (
    context.isBrowserOnlyExpression(left) ||
    context.isBrowserDomValue(left)
  ) {
    context.eraseBrowserInstrumentation(expression.pos);
    return;
  }
  if (emitWriteOnlyNumberExpandoAssignment(context, expression, left)) {
    return;
  }
  if (operator === "=") {
    const owner = context.resolveRecordValue(left.expression);
    if (owner) {
      // Probe record wiring without evaluating an arbitrary RHS.
      // Calls and data expressions may emit substantial native work;
      // compiling one merely to discover it is not a record would run
      // it again in the actual assignment path.
      const right = context.unwrap(expression.right);
      const existing = owner.recordProperties?.[left.name.text];
      let assigned = ts.isObjectLiteralExpression(right)
        ? context.compileValue(right)
        : context.resolveRecordValue(right);
      if (
        !assigned &&
        existing?.kind === "json-null" &&
        (ts.isCallExpression(right) ||
          ts.isArrowFunction(right) ||
          ts.isFunctionExpression(right))
      ) {
        assigned = context.compileValue(right);
      }
      if (assigned?.kind === "record" || assigned?.kind === "callback") {
        owner.recordProperties ??= {};
        owner.recordProperties[left.name.text] = assigned;
        return;
      }
    }
  }
  if (emitStructuralPropertyAssignment(context, expression)) {
    return;
  }
  if (emitSceneLightListClear(context, expression, left)) {
    return;
  }
  if (
    ts.isIdentifier(left.expression) &&
    emitPostProcessOptionAssignment(
      context,
      expression,
      left,
      context.lookup(left.expression),
    )
  ) {
    return;
  }
  if (
    ts.isPropertyAccessExpression(left.expression) &&
    left.expression.name.text === "dataset" &&
    ts.isIdentifier(left.expression.expression)
  ) {
    const target = context.lookup(left.expression.expression);
    if (target.kind === "browser") {
      context.eraseBrowserInstrumentation(expression.pos);
      return;
    }
  }
  if (
    ts.isPropertyAccessExpression(left.expression) &&
    left.expression.name.text === "imageProcessing" &&
    ts.isIdentifier(left.expression.expression)
  ) {
    const scene = context.lookup(left.expression.expression);
    context.expectKind(scene, "scene", left.expression.expression);
    const property = left.name.text;
    if (
      !["exposure", "contrast", "toneMapping", "toneMappingEnabled"].includes(
        property,
      )
    ) {
      context.fail(
        left.name,
        `Unsupported image-processing property '${property}'.`,
      );
    }
    if (property === "toneMapping") {
      // The curve is one of the pin's own `ToneMapping` records, whose
      // WGSL the composer splices into the PBR fragment. Nothing about
      // it survives to run time, so the assignment emits no statement
      // and records which record composition should read.
      requireSimpleAssignment(
        context,
        expression,
        `image-processing property '${property}'`,
      );
      const value = context.compileValue(expression.right);
      if (value.kind !== "tone-mapping" || value.staticString === undefined) {
        context.fail(
          expression.right,
          "A scene's tone mapping is one of the pinned records: " +
            `${toneMappingExportNames().join(", ")}.`,
        );
      }
      context.selectToneMapping(value.staticString, expression.right);
      return;
    }
    if (property === "toneMappingEnabled") {
      requireSimpleAssignment(
        context,
        expression,
        `image-processing property '${property}'`,
      );
      context.recordToneMappingEnabledMutation();
      context.emit(
        `${scene.cpp}.environment.tone_mapping_enabled = ${context.compileBoolean(expression.right)};`,
      );
      return;
    }
    context.emit(
      `${scene.cpp}.environment.${property} ${operator} ${context.compileNumber(expression.right)};`,
    );
    return;
  }
  if (
    ts.isPropertyAccessExpression(left.expression) &&
    left.expression.name.text === "camera" &&
    ts.isIdentifier(left.expression.expression)
  ) {
    const scene = context.lookup(left.expression.expression);
    context.expectKind(scene, "scene", left.expression.expression);
    const property = left.name.text;
    const nativeProperty = cameraRecordField(property);
    if (!nativeProperty) {
      context.fail(left.name, `Unsupported camera property '${property}'.`);
    }
    noteCameraRecordWrite(
      context,
      scene.sceneCamera,
      property,
      expression.right,
      operator === "=",
    );
    context.emit(
      `${context.requireEngine(scene, expression)}.cameras[${scene.cpp}.camera.value].${nativeProperty} ${operator} ${context.compileNumber(expression.right, "double")};`,
    );
    return;
  }
  if (left.expression.kind === ts.SyntaxKind.ThisKeyword) {
    // A resource field write — the engine, the scene, a material.
    // Data fields never reach here: they resolve as data paths
    // above and assign through the local that holds them.
    //
    // The first write wires the field and materializes its value once.
    // A second write remains outside the subset: it would need runtime
    // class identity and branch-sensitive field storage.
    const instance = context.compileValue(left.expression);
    const fields = instance.recordProperties;
    if (!fields) {
      context.fail(left, "'this' does not resolve to a class instance here.");
    }
    const existing = fields[left.name.text];
    if (
      existing &&
      operator === "=" &&
      context.emitOptionalResourceAssignment(expression, existing)
    ) {
      return;
    }
    if (existing) {
      context.fail(
        expression,
        `Field '${left.name.text}' is already bound; a class field that holds a resource is wired once and cannot be reassigned.`,
      );
    }
    if (!ts.isIdentifier(left.name)) {
      context.fail(
        left.name,
        "Private class fields are outside the supported subset.",
      );
    }
    context.bindClassField(left.name, expression.right);
    fields[left.name.text] = context.compileValue(left.name);
    return;
  }
  if (
    ts.isPropertyAccessExpression(left.expression) &&
    ts.isIdentifier(left.expression.expression) &&
    context.lookup(left.expression.expression).kind === "camera" &&
    left.expression.name.text === "target"
  ) {
    // Component writes into the camera target record (the demo
    // renderer's camera shake). The record's properties already
    // carry their native lvalues for reads.
    const record = context.compileValue(left.expression);
    const component = record.recordProperties?.[left.name.text];
    if (!component || component.kind !== "number") {
      context.fail(
        left.name,
        `Unsupported camera target component '${left.name.text}'.`,
      );
    }
    context.emit(
      `${component.cpp} ${operator} ${context.compileNumber(expression.right, "double")};`,
    );
    return;
  }
  // An imported TransformNode root is represented by an AssetHandle rather
  // than a data record. Intercept its nested TRS component before the broad
  // property-owner path tries to materialize `root.rotation` as a record.
  if (
    ts.isPropertyAccessExpression(left.expression) &&
    isTrsVectorName(left.expression.name.text)
  ) {
    const root = context.compileValue(left.expression.expression);
    if (root.kind === "asset-root") {
      context.assertAssetRootWritable(root, expression);
      const vector = left.expression.name.text;
      const axis = trsAxisIndex(left.name.text);
      if (axis === undefined) {
        context.fail(
          left.name,
          `Unsupported imported root axis '${left.name.text}'.`,
        );
      }
      if (vector === "scaling") {
        context.fail(
          left.expression,
          "An imported root currently exposes position and Y rotation; scaling requires a retained outer matrix.",
        );
      }
      requireSimpleAssignment(context, expression, `imported root ${vector}`);
      const engine = context.requireEngine(root, expression);
      if (vector === "rotation") {
        context.emit(
          `bbl::set_asset_root_rotation_component(` +
            `${engine}, ${root.cpp}, ${axis}u, ` +
            `${context.compileNumber(expression.right)});`,
        );
        return;
      }
      context.emit(
        `bbl::set_asset_root_position_component(` +
          `${engine}, ${root.cpp}, ${axis}u, ` +
          `${context.compileNumber(expression.right)});`,
      );
      return;
    }
  }
  // A scene may widen the target before writing a property the narrow
  // type does not carry -- `(sphere as { material?: unknown }).material`
  // is how the corpus assigns a node material to a mesh. The cast is a
  // type-level annotation with no value, so the target it names is the
  // expression underneath it.
  const targetExpression = context.unwrap(left.expression);
  const transformComponent =
    ts.isPropertyAccessExpression(targetExpression) &&
    isTrsVectorName(targetExpression.name.text);
  if (
    ts.isIdentifier(targetExpression) ||
    (ts.isPropertyAccessExpression(targetExpression) &&
      !transformComponent) ||
    ts.isElementAccessExpression(targetExpression)
  ) {
    // Resource identity can travel through compile-time records and tuples
    // (`lighting.sun.shadowGenerator`, `track.ground.receiveShadows`) just as
    // it can through a local. Compile the complete owner path so the same
    // assignment table serves both spellings.
    const target = ts.isIdentifier(targetExpression)
      ? context.lookup(targetExpression)
      : context.compileValue(targetExpression);
    const property = left.name.text;

    if (target.kind === "node-particle-system" && property === "buffer") {
      context.fail(
        left,
        "A particle buffer is generation-time state; only one of " +
          "its columns may be written, by index.",
      );
    }

    if (
      target.kind === "node-particle-system" &&
      particleScalars.includes(property)
    ) {
      emitNodeParticleScalarAssignment(
        context,
        expression,
        left,
        target,
        property,
      );
      return;
    }

    if (target.kind === "node-particle-system" && property === "texture") {
      emitNodeParticleTextureAssignment(context, expression, left, target);
      return;
    }

    if (target.kind === "scene" && property === "clearColor") {
      requireSimpleAssignment(context, expression, "scene clearColor");
      context.emit(
        `${target.cpp}.clear_color = ${context.compileColor4(expression.right)};`,
      );
      return;
    }

    if (target.kind === "scene" && property === "camera") {
      requireSimpleAssignment(context, expression, "scene camera");
      const camera = context.compileValue(expression.right);
      context.expectKind(camera, "camera", expression.right);
      // The scene keeps the camera VALUE, not a copy: a property
      // written after the assignment still reaches it, and one
      // executed port -- the node-particle flow-map build -- reads
      // the scene's camera rather than the scene's own records.
      target.sceneCamera = camera;
      context.emit(`${target.cpp}.camera = ${camera.cpp};`);
      return;
    }

    if (target.kind === "scene" && property === "fixedDeltaMs") {
      context.emit(
        `${target.cpp}.fixed_delta_ms ${operator} ${context.compileNumber(expression.right)};`,
      );
      return;
    }

    if (target.kind === "mesh" && property === "renderOrder") {
      requireSimpleAssignment(context, expression, "mesh renderOrder");
      const engine = context.requireEngine(target, expression);
      context.emit(
        `${engine}.meshes[${target.cpp}.value].render_order = ${context.compileNumber(expression.right, "double")};`,
      );
      context.emit(
        `${engine}.meshes[${target.cpp}.value].has_render_order = true;`,
      );
      return;
    }

    // A cloud is a SceneNode upstream exactly as a mesh is, so the name
    // write is the same statement over the other collection. A GPU pick
    // reads it back, which is what gives a splat scene a reason to set it.
    if (
      (target.kind === "mesh" || target.kind === "splat-mesh") &&
      property === "name"
    ) {
      const collection =
        target.kind === "splat-mesh" ? "splat_meshes" : "meshes";
      requireSimpleAssignment(
        context,
        expression,
        target.kind === "splat-mesh" ? "splat cloud name" : "mesh name",
      );
      const name = context.compileValue(expression.right);
      context.expectKind(name, "string", expression.right);
      context.emit(
        `${context.requireEngine(target, expression)}.${collection}[${target.cpp}.value].name = ${name.cpp};`,
      );
      return;
    }

    // `Mesh.id` is not `SceneNode.name`. The pin declares it separately --
    // "Unique ID from source file (e.g. .babylon). Used for light
    // include/exclude filtering" -- and `src/render/lights-ubo.ts`
    // `affectsMesh` is its only reader, which is why an unset id is
    // `undefined` where an unset name is the factory's own literal. That
    // join folds here, so the write records which mesh the id names and
    // emits nothing: `LightRecord` keys index vectors where the pin keys
    // Sets of strings, exactly as the `.babylon` loader already resolves
    // its own `mesh_records_by_id`, and no run-time reader is left to
    // store the string for.
    if (target.kind === "mesh" && property === "id") {
      requireSimpleAssignment(context, expression, "mesh id");
      context.recordSceneMeshId(
        target.cpp,
        context.compileStaticString(expression.right),
        expression,
      );
      return;
    }

    // `mesh.receiveShadows` is a composition key and nothing else:
    // `_computeMeshFeatures` turns it into `MSH_RECEIVE_SHADOWS`, which
    // selects the fragment carrying the per-light sampling, and every
    // consumer downstream — the variant selector, both backends' bind
    // decision — reads that composed word rather than a record lane. So
    // the assignment records the receiver for composition and emits
    // nothing, exactly as the material-tracking installers do.
    if (target.kind === "mesh" && property === "receiveShadows") {
      requireSimpleAssignment(context, expression, "mesh receiveShadows");
      const enabled = context.compileValue(expression.right);
      context.expectKind(enabled, "boolean", expression.right);
      const staticEnabled =
        enabled.staticBoolean ??
        (enabled.cpp === "true"
          ? true
          : enabled.cpp === "false"
            ? false
            : undefined);
      if (staticEnabled === false) {
        return;
      }
      if (staticEnabled !== true) {
        context.fail(
          expression.right,
          "Only `receiveShadows = true` is lowered: the composed " +
            "variant is selected at generation, so a value the " +
            "scene computes would need both fragments.",
        );
      }
      if (target.sceneMeshIndex === undefined) {
        // A handle read from a runtime collection has no generation-known
        // mesh row. Keep both composed states; the emitted record lane is
        // the runtime half of the same key used by both material families.
        context.recordDynamicShadowReceivers();
      } else {
        context.recordShadowReceiver(target.sceneMeshIndex);
      }
      // The record lane too, which the node family reads per draw:
      // its receiver mixes each light's factor by `receivesShadow`
      // rather than selecting a variant, so one composed module
      // serves a receiving mesh and a non-receiving one. The two
      // composed families never read the lane.
      context.emit(
        `${context.requireEngine(target, expression)}.meshes[` +
          `${target.cpp}.value].receives_shadows = true;`,
      );
      return;
    }

    // `material.plugins = [plugin]` is the pin's per-instance attach, and
    // the whole of it is composition input: both bridges read the list
    // to build one `ShaderFragment` and to number a signature, and that
    // number rides the host material's feature bits so every compose and
    // pipeline cache rebuilds on a plugin change.
    //
    // Which half of that reaches the runtime differs by family, because
    // the two variant selectors are keyed differently. A PBR draw
    // resolves its variant by MATERIAL INDEX, so the composed row for
    // this material already carries the plugin and nothing has to travel
    // on the record. A Standard draw resolves by the feature word
    // `standard_material_features` derives from the record, so the index
    // has to be there -- which is exactly what `registerStdPlugins`
    // pre-bakes into `_renderFeatures` upstream, for the same reason.
    if (target.kind === "material" && property === "plugins") {
      requireSimpleAssignment(context, expression, "material plugins");
      const plugins = foldMaterialPluginList(context, expression.right);
      if (target.scenePbrMaterialIndex !== undefined) {
        context.recordScenePbrPlugins(plugins, target.scenePbrMaterialIndex);
        return;
      }
      if (!target.standardMaterial) {
        context.fail(
          left.expression,
          "Material plugins attach to a PBR or a Standard " +
            "material: the pin's two bridges are the only " +
            "readers, and its Standard one filters on the " +
            "material's own group builder, so a plugin on any " +
            "other family composes nothing upstream either.",
        );
      }
      // The record lane is its own reach, separate from the
      // opt-in: upstream a `plugins` array on a material is always
      // legal and is simply inert until `enableMaterialPlugins`
      // registers the bridges, so the write has to compile either way
      // -- gating the setter's definition on the opt-in instead would
      // leave this call undefined for a scene that never made it.
      context.reachFeature("material:plugin-index", expression);
      context.emit(
        `bbl::set_material_plugins(` +
          `${context.requireEngine(target, expression)}, ` +
          `${target.cpp}, static_cast<std::uint8_t>(` +
          `${context.recordStandardMaterialPlugins(plugins)}));`,
      );
      return;
    }

    if (target.kind === "light" && property === "shadowGenerator") {
      requireSimpleAssignment(context, expression, "light shadowGenerator");
      const generator = context.compileValue(expression.right);
      context.expectKind(generator, "shadow-generator", expression.right);
      context.expectSameEngine(target, generator, expression);
      context.emit(
        `${context.requireEngine(target, expression)}.lights[${target.cpp}.value].shadow_generator = ${generator.cpp};`,
      );
      // The pin's `ShadowTask` walks `scene.lights` and its receiver
      // slots come from the same walk, so the generator has to be
      // reachable from the light -- and a later
      // `setShadowTaskCasterMeshes(light.shadowGenerator, ...)` reads
      // it back off the light, which is what this carries.
      if (generator.shadowGeneratorIndex !== undefined) {
        if (!target.lightIdentity) {
          context.fail(
            left.expression,
            "A light shadow generator assignment is missing its compiler identity.",
          );
        }
        target.lightIdentity.shadowGeneratorIndex =
          generator.shadowGeneratorIndex;
      }
      return;
    }

    // `light.includedOnlyMeshIds = new Set(ids)`: the pin's per-mesh light
    // set. `src/render/lights-ubo.ts` `writeMeshLightSelection` asks
    // `affectsMesh` per light per mesh and packs the survivors' slots into
    // the mesh block, so the selection is UBO data and nothing composes
    // from it. What generation owns is the JOIN: the ids are static
    // strings and the meshes are generation-known, so the id list folds to
    // the index list `light_affects_mesh` already searches, and the record
    // keeps exactly what the `.babylon` loader's own resolution keeps.
    if (target.kind === "light" && property === "includedOnlyMeshIds") {
      requireSimpleAssignment(context, expression, "light includedOnlyMeshIds");
      const meshes = context.resolveSceneMeshIds(
        staticMeshIdSet(context, expression.right),
        expression.right,
      );
      context.reachFeature("light:included-meshes", expression);
      context.emit(
        `${context.requireEngine(target, expression)}.lights[` +
          `${target.cpp}.value].included_meshes = {` +
          `${meshes.map((mesh) => `${mesh}.value`).join(", ")}};`,
      );
      return;
    }

    if (target.kind === "mesh" && property === "material") {
      requireSimpleAssignment(context, expression, "mesh material");
      const material = context.compileValue(expression.right);
      context.expectKind(material, "material", expression.right);
      context.expectSameEngine(target, material, expression);
      context.emit(
        `${context.requireEngine(target, expression)}.meshes[${target.cpp}.value].material = ${material.cpp};`,
      );
      // The pin's opt-in setters take the material back off the mesh
      // (`setPbrSkybox(box.material)`) and mutate the same object, so
      // the mesh carries which scene material it was given and a
      // later read of `mesh.material` resolves that record.
      if (material.scenePbrMaterialIndex !== undefined) {
        target.scenePbrMaterialIndex = material.scenePbrMaterialIndex;
      }
      // The family travels the same way, and for the same reason: a
      // write on `box.material` has to resolve which of the pin's two
      // bridges would read it.
      if (material.standardMaterial) {
        target.standardMaterial = true;
      }
      // The pair the caster list resolves against. Upstream reads
      // `mesh.material` when the shadow pass builds, so a scene may
      // name its casters before assigning their materials -- which is
      // why the mesh's own Value does not carry the graph: this map is
      // the one producer of the pair.
      if (target.sceneMeshIndex !== undefined) {
        context.recordSceneMeshMaterial(target.sceneMeshIndex, {
          pbrMaterial: material.scenePbrMaterialIndex ?? null,
          nodeMaterial: material.nodeMaterialIndex ?? null,
          standardMaterial: material.standardMaterial === true,
          // Only a scene-local program: the other families that carry a
          // variant settle their own instanced form from their options.
          sceneShaderVariant: material.sceneShaderVariant,
        });
        if (material.assetPbrMaterial) {
          context.recordSceneMeshAssetPbrMaterial(target.sceneMeshIndex);
        }
      } else if (material.scenePbrMaterialIndex !== undefined) {
        context.recordUnknownSceneMeshMaterial(material.scenePbrMaterialIndex);
      }
      return;
    }

    if (
      target.kind === "mesh" &&
      (property === "boundMin" || property === "boundMax")
    ) {
      requireSimpleAssignment(context, expression, `mesh ${property}`);
      const engine = context.requireEngine(target, expression);
      const nativeProperty =
        property === "boundMin" ? "bounds_min" : "bounds_max";
      const side = property === "boundMin" ? "min" : "max";
      context.emit(
        `${engine}.meshes[${target.cpp}.value].${nativeProperty}_override = ${context.compileVec3(expression.right)};`,
      );
      context.emit(
        `${engine}.meshes[${target.cpp}.value].has_bounds_${side}_override = true;`,
      );
      return;
    }

    if (target.kind === "mesh" && property === "morphTargets") {
      requireSimpleAssignment(context, expression, "mesh morphTargets");
      if (!target.directMorphCompatible) {
        context.fail(
          left.expression,
          "Direct morph targets require a compiler-created mesh.",
        );
      }
      const morph = context.compileValue(expression.right);
      context.expectKind(morph, "morph-targets", expression.right);
      context.expectSameEngine(target, morph, expression);
      if (!morph.morphTarget) {
        context.fail(expression.right, "Morph target data is incomplete.");
      }
      if (morph.morphTarget.meshCpp) {
        context.fail(
          expression.right,
          "Direct morph target data can be attached to one mesh.",
        );
      }
      const engine = context.requireEngine(target, expression);
      context.emit(
        `bbl::attach_morph_target(${engine}, ${target.cpp}, ` +
          `${morph.morphTarget.positionsCpp}, ` +
          `${morph.morphTarget.normalsCpp}, ` +
          `${morph.morphTarget.vertexCountCpp}, ` +
          `${morph.morphTarget.weightCpp});`,
      );
      morph.morphTarget.meshCpp = target.cpp;
      context.reachFeature("mesh:morph-targets", expression);
      return;
    }

    if (target.kind === "texture" && property in textureRecordFields) {
      const field = textureRecordFields[property]!;
      requireSimpleAssignment(context, expression, `texture ${property}`);
      // A `loadTexture2D` image takes these writes too: upstream one
      // `Texture2D` carries them whatever built it, and the PBR lightmap
      // extension reads `uAng` back off a loaded texture to pick its V-flip
      // arm. The record member is one level down there (`FileTexture::data`
      // is the `TextureData` a pixels texture IS), which is the only
      // difference the write sees.
      const owner = target.pixelsTexture
        ? target.cpp
        : target.textureStorage === "file"
          ? `${target.cpp}.data`
          : undefined;
      if (owner === undefined) {
        context.fail(
          left,
          `Reached '${property}' writes land on a ` +
            "createTexture2DFromPixels or loadTexture2D texture; a solid " +
            "colour and a render attachment carry no transform this port " +
            "reads back.",
        );
      }
      if (context.boundPixelsTextures.has(target.cpp)) {
        context.fail(
          left,
          `'${property}' is written after this texture was bound ` +
            "to a material, where the slot already took its " +
            "copy. Upstream binds one object, so the write " +
            "would reach the material there and not here.",
        );
      }
      // Compiled once and reused by the record store below: asking a
      // second time would emit the value's own lowering twice.
      const rendered = field.value === "boolean"
        ? context.compileBoolean(expression.right)
        : context.compileNumber(expression.right, "double");
      if (property === "invertY") {
        // The one boolean in `TEXTURE_UV_PROPERTIES`, which is why the
        // refusal below can name it.
        if (rendered !== "true" && rendered !== "false") {
          context.fail(
            expression.right,
            "A texture's `invertY` is composition input — the lightmap " +
              "extension folds it against `uAng` — so it settles at " +
              "generation.",
          );
        }
        target.textureObjectInvertY = rendered === "true";
      } else if (property === "uAng") {
        // The value reaches composition as well as the record: the pinned
        // lightmap `detect` compares it against `Math.PI`. A write that
        // does not settle still emits, and the consumer that needs it
        // refuses by name rather than reading a stale zero here.
        const folded = staticNumberValue(context, expression.right);
        if (folded !== undefined) target.textureUvAng = folded;
      }
      context.emit(`${owner}.${field.record} = ${rendered};`);
      return;
    }

    if (target.kind === "material" && property === "occlusionTexture") {
      requireSimpleAssignment(context, expression, "PBR occlusionTexture");
      if (!target.assetPbrMaterial) {
        context.fail(
          left,
          "Replacing occlusionTexture is lowered for a PBR material read from a loaded asset, whose composed variant already carries that slot.",
        );
      }
      const texture = context.compileValue(expression.right);
      context.expectKind(texture, "texture", expression.right);
      if (texture.textureStorage !== "solid") {
        context.fail(
          expression.right,
          "Reached PBR occlusionTexture replacement uses createSolidTexture2D.",
        );
      }
      context.expectSameEngine(target, texture, expression);
      context.emit(
        `bbl::set_pbr_occlusion_solid_texture(` +
          `${context.requireEngine(target, expression)}, ` +
          `${target.cpp}, ${texture.cpp});`,
      );
      return;
    }

    if (target.kind === "material" && property === "diffuseTexture") {
      requireSimpleAssignment(context, expression, "material diffuseTexture");
      const texture = context.compileValue(expression.right);
      // A `createTexture2DFromPixels` texture is the second source
      // this slot takes. It is a C++ value rather than a handle, so
      // the record takes a copy and the local is recorded as spent:
      // a transform write afterwards would move the local where the
      // pin would have moved the material's own texture object.
      if (texture.kind === "texture" && texture.pixelsTexture) {
        context.reachFeature(
          "material:standard-diffuse-pixels-texture",
          expression,
        );
        context.boundPixelsTextures.add(texture.cpp);
        context.emit(
          `bbl::set_standard_diffuse_pixels_texture(` +
            `${context.requireEngine(target, expression)}, ` +
            `${target.cpp}, ${texture.cpp});`,
        );
        return;
      }
      // A loaded image is the third source, and the one the
      // `.babylon` loader already fills this slot with. The texture
      // object travels whole rather than as bytes, because the
      // sampler, the upload flip and the texture-object `invertY`
      // the Standard UV block reads are all the texture's own.
      if (texture.kind === "texture" && texture.textureFile) {
        if (texture.textureFile.srgb) {
          context.fail(
            expression.right,
            "A Standard diffuse slot uploads through the " +
              "family's own encoding, which is linear; an " +
              "sRGB texture in it is not lowered.",
          );
        }
        context.reachFeature(
          "material:standard-diffuse-file-texture",
          expression,
        );
        context.emit(
          `bbl::set_standard_diffuse_file_texture(` +
            `${context.requireEngine(target, expression)}, ` +
            `${target.cpp}, ${texture.cpp});`,
        );
        return;
      }
      // What this slot accepts, said the way every frame-graph slot
      // says it. `sampling: "color"` is the aspect the setter folds
      // -- `rtt.ts` gives a colour view `invertY: true` and the
      // bilinear sampler, a depth one `invertY: false` and the
      // nearest -- and `sources` is the ownership: only a target the
      // scene made, never a geometry task's attachment.
      const textureCpp = compileRenderTextureValue(
        context,
        expression.right,
        texture,
        "Reached Standard diffuseTexture",
        { sampling: "color", sources: ["render-target"] },
      );
      context.expectSameEngine(target, texture, expression);
      context.reachFeature(
        "material:standard-diffuse-render-texture",
        expression,
      );
      context.emit(
        `bbl::set_standard_diffuse_render_texture(` +
          `${context.requireEngine(target, expression)}, ` +
          `${target.cpp}, ${textureCpp});`,
      );
      return;
    }

    if (target.kind === "mesh" && property === "parent") {
      // `IParentable.parent`: the write that drives the transform
      // math. Upstream it leaves `children` alone -- the traversal
      // list is `push`ed separately -- so this stores the link and
      // nothing else, and the world composes through it lazily the
      // way `createWorldMatrixState` composes it.
      requireSimpleAssignment(context, expression, "mesh parent");
      const parent = context.compileValue(expression.right);
      context.expectKind(parent, "transform-node", expression.right);
      context.expectSameEngine(target, parent, expression);
      context.emit(
        `bbl::set_mesh_transform_parent(` +
          `${context.requireEngine(target, expression)}, ` +
          `${target.cpp}, ${parent.cpp});`,
      );
      return;
    }

    const recordField = recordFieldAssignments.find(
      (candidate) =>
        candidate.kind === target.kind && candidate.property === property,
    );
    if (recordField) {
      if (recordField.feature) {
        context.reachFeature(recordField.feature, expression);
      }
      if (recordField.simpleOnly) {
        requireSimpleAssignment(
          context,
          expression,
          `${recordField.kind} ${recordField.property}`,
        );
      }
      const record =
        `${context.requireEngine(target, expression)}` +
        `.${recordField.collection}[${target.cpp}.value]`;
      if (recordField.value === "number2") {
        const elements = context.unwrap(expression.right);
        const fields = recordField.field;
        if (
          !ts.isArrayLiteralExpression(elements) ||
          elements.elements.length !== 2 ||
          typeof fields === "string"
        ) {
          context.fail(
            expression.right,
            `Reached ${recordField.kind} ${recordField.property} ` +
              "takes a two-element array literal.",
          );
        }
        for (const [index, field] of fields.entries()) {
          context.emit(
            `${record}.${field} = ` +
              `${context.compileNumber(elements.elements[index]!)};`,
          );
        }
        return;
      }
      if (typeof recordField.field !== "string") {
        context.fail(
          expression,
          `Reached ${recordField.kind} ${recordField.property} ` +
            "names a field pair with a scalar value.",
        );
      }
      const value =
        recordField.value === "color3"
          ? context.compileColor3(expression.right)
          : recordField.value === "boolean"
            ? context.compileBoolean(expression.right)
            : context.compileNumber(
                expression.right,
                recordField.collection === "cameras" ? "double" : "float",
              );
      const stored = recordField.invert ? `!(${value})` : value;
      context.emit(
        `${record}.${recordField.field} ` +
          `${recordField.simpleOnly ? "=" : operator} ${stored};`,
      );
      if (recordField.kind === "material" && recordField.property === "alpha") {
        // The pin reads `mat.alpha < 1` live when it builds
        // renderables, so a post-creation write moves the
        // material between the opaque and blended families.
        // One shared home for the rule (the factory calls the
        // same helper), so the transmission arm and the family
        // gates cannot drift from the creation-time derivation.
        context.emit(`bbl::derive_material_alpha_mode(${record});`);
      }
      return;
    }

    if (target.kind === "camera" && property === "target") {
      requireSimpleAssignment(context, expression, "camera target");
      // The program records the target the constructor gave; a later
      // write is not one of its scalar properties, so it invalidates.
      noteCameraRecordWrite(context, target, "target", undefined, false);
      context.emit(
        `${context.requireEngine(target, expression)}.cameras[${target.cpp}.value].target = ${context.compileVec3(expression.right, "double")};`,
      );
      return;
    }

    if (target.kind === "camera") {
      const nativeProperty = cameraRecordField(property);
      if (nativeProperty) {
        noteCameraRecordWrite(
          context,
          target,
          property,
          expression.right,
          expression.operatorToken.kind === ts.SyntaxKind.EqualsToken,
        );
        context.emit(
          `${context.requireEngine(target, expression)}.cameras[${target.cpp}.value].${nativeProperty} ${operator} ${context.compileNumber(expression.right, "double")};`,
        );
        return;
      }
    }

    const scalarSetter = lightScalarSetter(target, property);
    if (scalarSetter) {
      requireSimpleAssignment(context, expression, `light ${property}`);
      // The pin recomputes the cone cosine from the JavaScript-number
      // angle and rounds only at its own UBO store, so the value stays
      // double across this boundary exactly as it does at creation.
      context.emit(
        `bbl::${scalarSetter}(` +
          `${context.requireEngine(target, expression)}, ` +
          `${target.cpp}, ` +
          `${context.compileNumber(expression.right, "double")});`,
      );
      return;
    }

    const direct = directPropertyAssignment(target, property);
    if (direct) {
      if (!direct.supportsCompound) {
        requireSimpleAssignment(
          context,
          expression,
          `${target.kind} ${property}`,
        );
      }
      const value =
        direct.valueKind === "color3"
          ? context.compileColor3(expression.right)
          : context.compileNumber(expression.right);
      context.emit(
        `${context.requireEngine(target, expression)}.${direct.collection}[${target.cpp}.value].${direct.nativeProperty} ${operator} ${value};`,
      );
      return;
    }
  }

  if (left.name.text === "loopAnimation") {
    // AnimationGroup.loopAnimation is a public field upstream, and a
    // glTF group's state lives in its asset's runtime, so the write
    // takes the same writer route the group operations take.
    const group = gltfGroupWriteTarget(
      context,
      left,
      expression,
      "loopAnimation",
    );
    context.emit(
      `bbl::set_animation_loop(${context.requireEngine(
        group,
        expression,
      )}, ${group.cpp}, ${context.compileBoolean(expression.right)});`,
    );
    return;
  }

  if (left.name.text === "speedRatio") {
    // AnimationGroup.speedRatio is a public mutable field upstream, and
    // syncControllerFromGroup pushes it onto the controller whose tick
    // scales its delta by it. The write takes the same writer route
    // `loopAnimation` does.
    const group = gltfGroupWriteTarget(context, left, expression, "speedRatio");
    context.reachFeature("animation:gltf-group-speed", left);
    context.emit(
      `bbl::set_animation_speed_ratio(${context.requireEngine(
        group,
        expression,
      )}, ${group.cpp}, ${context.compileNumber(expression.right)});`,
    );
    return;
  }

  if (left.name.text === "mask") {
    // AnimationGroup.mask is the public field createAnimationGroupMask
    // fills. The mask value is compile-time, so the write hands its
    // names and mode to the loader's own resolver, which is where the
    // pin resolves them too -- the controller's `_setMask`.
    const group = gltfGroupWriteTarget(context, left, expression, "mask");
    const mask = context.compileValue(expression.right);
    context.expectKind(mask, "animation-group-mask", expression.right);
    const names = mask.animationGroupMask?.names ?? [];
    context.reachFeature("animation:gltf-group-mask", left);
    context.emit(
      `bbl::set_animation_mask(${context.requireEngine(
        group,
        expression,
      )}, ${group.cpp}, std::vector<std::string>{${names
        .map(stringLiteral)
        .join(
          ", ",
        )}}, ${mask.animationGroupMask?.include ? "true" : "false"});`,
    );
    return;
  }

  if (left.name.text === "currentTime") {
    // AnimationGroup.currentTime is a public mutable field upstream
    // (src/animation/animation-group.ts): the write is the whole
    // operation, and whoever drives the group applies the pose on its
    // next tick. A glTF group's time lives in its asset's runtime, so
    // the write takes the same clip-writer route the group operations
    // and `loopAnimation` above take.
    const group = gltfGroupWriteTarget(
      context,
      left,
      expression,
      "currentTime",
    );
    const value = context.compileValue(expression.right);
    context.expectKind(value, "number", expression.right);
    context.reachFeature("animation:gltf-group-time", left);
    context.emit(
      `bbl::set_animation_current_time(${context.requireEngine(
        group,
        expression,
      )}, ${group.cpp}, ${value.cpp});`,
    );
    return;
  }

  if (
    ts.isPropertyAccessExpression(left.expression) &&
    isTrsVectorName(left.expression.name.text)
  ) {
    // The owner is compiled rather than looked up, so a mesh read
    // out of the data model (a handle stored in a struct or array)
    // writes its transform exactly like a mesh local.
    const mesh = context.compileValue(left.expression.expression);
    const axis = trsAxisIndex(left.name.text);
    if (axis === undefined) {
      context.fail(left.name, `Unsupported rotation axis '${left.name.text}'.`);
    }
    if (mesh.kind === "light") {
      const vector = left.expression.name.text;
      const setter = lightVectorSetter(mesh, vector);
      if (!setter) {
        context.fail(
          left.expression,
          `A ${mesh.lightKind ?? "generic"} light has no '${vector}' to set.`,
        );
      }
      requireSimpleAssignment(context, expression, `light ${vector} component`);
      const engine = context.requireEngine(mesh, expression);
      const component = ["x", "y", "z"][axis]!;
      // A component store on the pin's ObservableVec3 invalidates the
      // light-local matrix just like `.set(...)`. Preserve the other
      // two live lanes, then take the same generated setter route so
      // the field write and matrix refresh cannot drift apart.
      context.emit(
        `bbl::${setter}(${engine}, ${mesh.cpp}, bbl::Vec3{` +
          ["x", "y", "z"]
            .map((lane) =>
              lane === component
                ? context.compileNumber(expression.right)
                : `${engine}.lights[${mesh.cpp}.value].${vector}.${lane}`,
            )
            .join(", ") +
          `});`,
      );
      return;
    }
    if (mesh.kind === "camera") {
      const vector = left.expression.name.text;
      if (vector !== "position" && vector !== "target") {
        context.fail(
          left.expression,
          `A camera has no writable '${vector}' vector.`,
        );
      }
      const component = ["x", "y", "z"][axis]!;
      const engine = context.requireEngine(mesh, expression);
      context.emit(
        `${engine}.cameras[${mesh.cpp}.value].${vector}.${component} ${operator} ${context.compileNumber(expression.right, "double")};`,
      );
      return;
    }
    // A GaussianSplattingMesh is a SceneNode upstream, so its TRS lanes
    // are the same ones a mesh carries and `build_splat_world` composes
    // them the same way -- which is why the write is the same statement
    // over a different collection. What differs is the dirty signal: a
    // cloud's world matrix is re-derived per frame rather than cached,
    // so nothing has to be marked.
    const record =
      mesh.kind === "splat-mesh"
        ? { collection: "splat_meshes", bumpsTransformVersion: false }
        : { collection: "meshes", bumpsTransformVersion: true };
    if (mesh.kind === "splat-mesh") {
      // All three TRS lanes compose in `build_splat_world`, so a
      // component write is the same statement over a different lane.
      //
      // `rotation` is the one that needs saying. Upstream it is an
      // Euler PROXY over `rotationQuaternion` (`createEulerProxy`,
      // scene-node.ts) rather than storage of its own: a component
      // write re-applies the whole cached triple through the pin's
      // `eulerToQuat`. This record keeps the two lanes apart and
      // `build_splat_world` derives the quaternion from the Euler lane
      // through that same pinned writer, so the composed matrix is the
      // proxy's — and the transform bake, which is where the pin's
      // quaternion write would make the two disagree, clears both.
      if (
        left.expression.name.text !== "position" &&
        left.expression.name.text !== "rotation" &&
        left.expression.name.text !== "scaling"
      ) {
        context.fail(
          left.expression,
          `A splat cloud's '${left.expression.name.text}' is not ` +
            "lowered; the reached slice writes its position, " +
            "rotation and scaling.",
        );
      }
    } else {
      context.expectKind(mesh, "mesh", left.expression.expression);
    }
    const component = ["x", "y", "z"][axis]!;
    const engine = context.requireEngine(mesh, expression);
    // A mesh's translation is kept at the pin's own width, so the
    // component spelling writes it there too: narrowing here and
    // widening back into the field would round a large-world
    // coordinate to the float32 grid, which is the whole reason the
    // field is a double.
    const wide =
      record.collection === "meshes" &&
      left.expression.name.text === "position";
    context.emit(
      `${engine}.${record.collection}[${mesh.cpp}.value].${left.expression.name.text}.${component} ${operator} ${context.compileNumber(
        expression.right,
        wide ? "double" : "float",
      )};`,
    );
    // Ordinary geometry bakes the full parent chain into its uploaded
    // vertices. A parent-only write therefore has to dirty descendants as
    // well as the mesh itself; mark_mesh_dirty owns that recursive contract.
    if (record.bumpsTransformVersion) {
      context.emit(
        `bbl::${context.meshTransformDirtyEntry()}(${engine}, ${mesh.cpp});`,
      );
    }
    return;
  }

  context.fail(left, `Unsupported property assignment '${left.getText()}'.`);
}

function assignmentOperator(
  context: AssignmentContext,
  expression: ts.BinaryExpression,
): "=" | "+=" | "-=" | "*=" | "/=" {
  switch (expression.operatorToken.kind) {
    case ts.SyntaxKind.EqualsToken:
      return "=";
    case ts.SyntaxKind.PlusEqualsToken:
      return "+=";
    case ts.SyntaxKind.MinusEqualsToken:
      return "-=";
    case ts.SyntaxKind.AsteriskEqualsToken:
      return "*=";
    case ts.SyntaxKind.SlashEqualsToken:
      return "/=";
    default:
      return context.fail(
        expression.operatorToken,
        `Unsupported assignment operator '${expression.operatorToken.getText()}'.`,
      );
  }
}

/**
 * The group a `group.<field> = …` write names, checked the four ways every
 * such write has to be: it is a group, it came from a loader rather than
 * `createPropertyAnimationGroup`, the assignment is plain, and the glTF
 * group feature is reached. Four fields lower this way -- `loopAnimation`,
 * `speedRatio`, `mask` and `currentTime` -- and the preamble is where they
 * would otherwise disagree.
 */
function gltfGroupWriteTarget(
  context: AssignmentContext,
  left: ts.PropertyAccessExpression,
  expression: ts.BinaryExpression,
  field: string,
): Value {
  const group = context.compileValue(left.expression);
  context.expectKind(group, "animation-group", left.expression);
  requireGroupSource(context, group, left, field, "gltf");
  requireSimpleAssignment(context, expression, field);
  context.reachFeature("animation:gltf-groups", left);
  return group;
}

/**
 * The mesh ids one `new Set(...)` names, in the Set's own order.
 *
 * The pin's field is a `ReadonlySet<string>` and both writers upstream
 * build it the same way — `new Set(io)` in `load-babylon.ts` — so the
 * constructor is where the ids are, and reading them here is the whole
 * fold. A set built any other way keeps its refusal.
 */
function staticMeshIdSet(
  context: AssignmentContext,
  expression: ts.Expression,
): readonly string[] {
  const unwrapped = context.unwrap(
    context.resolveStaticExpression(expression),
  );
  if (
    !ts.isNewExpression(unwrapped) ||
    !ts.isIdentifier(unwrapped.expression) ||
    unwrapped.expression.text !== "Set" ||
    unwrapped.arguments?.length !== 1
  ) {
    context.fail(
      expression,
      "A light's includedOnlyMeshIds must be `new Set(<mesh ids>)`.",
    );
  }
  return staticStringList(context, unwrapped.arguments[0]!);
}

/** A generation-known list of strings, spreads of such lists included. */
function staticStringList(
  context: AssignmentContext,
  expression: ts.Expression,
): readonly string[] {
  // The pure probe first. It owns the array walk and the spread recursion,
  // and it also answers for a `const` array binding nothing writes through
  // — a shape a literal-only walk cannot see.
  const probed = context.staticStringElements(expression);
  if (probed) return probed;
  // The list a scene's own helper was handed: an inlined call keeps the
  // argument's value and drops its expression, so the ids ride the value.
  const carried = context.compileValue(expression).staticStrings;
  if (carried) return carried;
  context.fail(
    expression,
    "Expected a generation-known array of mesh id strings.",
  );
}

function requireSimpleAssignment(
  context: AssignmentContext,
  expression: ts.BinaryExpression,
  target: string,
): void {
  if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    context.fail(
      expression.operatorToken,
      `Compound assignment is not supported for ${target}.`,
    );
  }
}
import ts from "typescript";

import { emitAudioPropertyAssignment } from "./audio-surface.js";
import { TEXTURE_UV_PROPERTIES } from "../lowering/standard-uv-transform-lowerer.js";
import { requireGroupSource } from "./intrinsics/animation.js";
import { emitParticleBufferWrite } from "./particle-buffer.js";
import { staticNumberValue } from "./option-helpers.js";
import { stringLiteral } from "../cpp-literals.js";
import {
  emitDeterministicRandomInstall,
  type DeterministicRandomContext,
} from "./deterministic-random.js";
import { noteCameraRecordWrite } from "./intrinsics/camera.js";
import { cameraRecordField } from "./properties.js";
import { compileRenderTextureValue } from "./intrinsics/engine-options.js";
import { postProcessEffect } from "../post-process-effects.js";
import { toneMappingExportNames } from "../pinned-tone-mapping.js";
import { foldMaterialPluginList } from "./material-plugin.js";
import type { MaterialPluginManifest } from "../pinned-material-plugins.js";
import type {
  CompiledNodeParticles,
  Feature,
  LightKind,
  Value,
  ValueKind,
} from "./types.js";
