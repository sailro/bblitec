import type ts from "typescript";
import type { CompileAdaptation } from "../fidelity.js";
import type {
  NodeParticleBakeRequest,
  NodeParticleBuilder,
  NodeParticleCamera,
  NodeParticleGraphSource,
  NodeParticleRegistration,
  NodeParticleSetRequest,
  NodeParticleSprite2DRequest,
  NodeParticleStep,
} from "../pinned-node-particle.js";
import type { MaterialPluginManifest } from "../pinned-material-plugins.js";
import type { DataType, TypedArrayKind } from "./data-types.js";

export interface CompileOptions {
  fileName?: string;
  title?: string;
  width?: number;
  height?: number;
  /**
   * The query string the scene's reference pose is captured at
   * (`"?seekTime=0"`). `window.location.search` folds to it, so a scene
   * that branches on a query parameter takes the same branch natively
   * that the reference page takes. Empty when the pin serves the scene
   * bare, which is every scene that does not read the query.
   */
  search?: string;
}

export interface CompileManifest {
  source: string;
  features: string[];
  /**
   * feature -> "file:line" of the first scene-source call site that
   * reached it, keyed and ordered like `features` but kept as a
   * parallel record so consumers of the array are untouched. The
   * compiler's walk is a single deterministic pass (entry statements
   * in document order, sub-expressions depth-first), so first-reach
   * wins and regeneration is stable. Features that are reached
   * without a source node (the seeded "core") and features the CLI
   * asset-join adds after compilation carry no entry.
   */
  featureSites: Record<string, string>;
  runtimeSources: string[];
  generatedSources: string[];
  assets: CompileAsset[];
  shaderVariants: string[];
  customShaderPrograms: CompiledShaderProgram[];
  /** Every node-material graph the scene parsed, in reach order. */
  nodeMaterials: CompiledNodeMaterial[];
  /** The scene's node-particle program, summarized. */
  nodeParticles?: NodeParticleManifest;
  /**
   * The pinned tone-mapping export the scene assigned, when it assigned one.
   * Absent means the pin's own default, which is what `pbr-renderable.ts`
   * resolves an unset `imageProcessing.toneMapping` to.
   */
  toneMapping?: string;
  /** The sprite-family custom fragment shaders scene code built. */
  spriteCustomShaders: SpriteCustomShaderManifest[];
  /** Every `createEffectWrapper` the scene built, in reach order. */
  effects: EffectManifest[];
  /**
   * Whether any layer or system draws with the stock program. A scene whose
   * every one opts into a custom shader never loads it, so it is not
   * composed, compiled or deployed.
   */
  plainSpriteLayer: boolean;
  plainBillboardSystem: boolean;
  geometryOutputTasks: GeometryOutputTaskManifest[];
  postProcessTasks: PostProcessTaskManifest[];
  postProcessComposites: PostProcessCompositeManifest[];
  adaptations: CompileAdaptation[];
  scenePbrMaterials: ScenePbrMaterialManifest[];
  /**
   * The `GsShaderFragment` plugins a `loadSplat` call passed, in the order
   * it wrote them — which is the order the pin's own splicer concatenates
   * two plugins sharing a slot in.
   */
  splatFragments: SplatFragmentManifest[];
  /**
   * The distinct `MaterialPlugin` lists a STANDARD material carries, in
   * the order the first material carrying each was assigned one.
   *
   * The position is the identity: the pin's Standard bridge numbers a
   * signature from one in the order `registerStdPlugins` first sees it,
   * and it sees only Standard materials (it filters on `_buildGroup`). So
   * the generated material record carries `position + 1`, composition
   * hands the pin the same lists in the same order, and it refuses if the
   * pin disagreed (`src/pinned-material-plugins.ts`).
   *
   * A PBR material's plugins ride `scenePbrMaterials` instead: its bridge
   * numbers them itself during feature derivation, and a PBR draw
   * resolves its variant by material index, so no index travels.
   */
  standardMaterialPlugins: MaterialPluginManifest[][];
  /** Every scene-code material creation, any family, for the handle count. */
  sceneMaterialCount: number;
  /** glTF load count at each scene material creation, across all families. */
  sceneMaterialGltfAssetsBefore?: number[];
  sceneMeshes: SceneMeshManifest[];
  /** Scene-code lights added outside a repeating/deferred callback, in
   *  scene order. When `dynamicSceneLights` is false this is the complete
   *  light topology and shader composition must not widen it. */
  sceneLightKinds: LightKind[];
  /** A callback can add lights at run time, so the static list above is
   *  then only a lower bound and composition must retain compatible arms. */
  dynamicSceneLights: boolean;
  /** A reached assignment to `toneMappingEnabled` makes both states
   *  potentially reachable. Without one, environment loading fixes the
   *  state and composition emits only that arm. */
  mutableToneMappingEnabled: boolean;
  /** Every shadow generator a scene built, in reach order. */
  shadowGenerators: ShadowGeneratorManifest[];
  /** The `sceneMeshes` entries `mesh.receiveShadows = true` marked. */
  shadowReceiverMeshes: number[];
  /** A runtime handle collection may mark imported or otherwise dynamic
   *  meshes as receivers, so composition must retain both receiver states. */
  dynamicShadowReceivers: boolean;
  /**
   * The clustered light field this scene added, if it added one.
   *
   * `addClusteredLightContainer` stamps `_clusteredLightState` onto every
   * material present, which is what each clustered extension's `detect`
   * reads -- so composition needs to know the scene reached it, and whether
   * a spot was ever created, since that decides which of the two extensions
   * takes the material and with it the data layout the fragment reads.
   */
  clusteredLights?: { hasSpots: boolean };
}

/**
 * One Gaussian-splat shader plugin a `loadSplat` call named.
 *
 * A plugin is pure data upstream, and a scene reaches one of two ways: by
 * importing one of the pin's own exported records, or by declaring its own.
 * The first carries only the export name, because what that export contains
 * is the pin's to answer at composition — the same split the tone-mapping
 * records take.
 */
export type SplatFragmentManifest =
  | { kind: "pinned"; exportName: string }
  | {
      kind: "scene";
      id: string;
      helperFunctions?: string;
      fragmentSlots: { slot: string; code: string }[];
    };

/**
 * One `create*ShadowGenerator` call, in reach order.
 *
 * Everything here is what the composed receiver fragment is keyed by or what
 * the PAL sizes its resources from; the light-space matrices themselves are
 * computed at run time from the light, exactly as `renderPcfShadowMap`
 * recomputes them when the light moves.
 */
/** One mesh `setShadowTaskCasterMeshes` named, and what it carries. */
/** Which mesh a generator casts from, before its material is resolved. */
export interface ShadowCasterMeshManifest {
  /** Its `sceneMeshes` row. */
  meshIndex: number;
}

export interface ShadowCasterManifest extends ShadowCasterMeshManifest {
  /**
   * Its `scenePbrMaterials` row, or `null` for a material of another
   * family -- which still takes a runtime handle.
   */
  pbrMaterial: number | null;
  /**
   * Its composed node graph, or `null` for a material of another family.
   *
   * A node caster's ESM view is a second MODULE compiled from the same
   * graph rather than a variant of another material, so the caster names
   * the graph and composition asks the pin for that module.
   */
  nodeMaterial: number | null;
}

export interface ShadowGeneratorManifest {
  /**
   * The pinned filter. Composition maps it onto the receiver fragment's
   * own `shadowType` — so a generator family added here without a
   * receiver arm refuses at composition rather than composing a
   * neighbour's.
   */
  kind: "pcf-spot" | "pcf-directional" | "esm-directional";
  /**
   * Which `scene.lights` slot the owning light occupies. The pinned
   * receiver fragment suffixes every varying and binding with it, so a
   * light added at a different position composes a different fragment.
   */
  lightIndex: number;
  /**
   * The three ESM options that decide generated artifacts rather than
   * run-time values, for the generators that carry them.
   *
   * `createShadowBlurFragmentWGSL` folds `blurKernel` into the tap offsets
   * and weights it emits, and `mapSize`/`blurScale` size four textures and
   * the texel step the blur walks — so all three decide shader TEXT or a
   * GPU resource and have to reach generation.
   */
  esm?: {
    mapSize?: number;
    blurKernel?: number;
    blurScale?: number;
  };
  /**
   * One entry per mesh `setShadowTaskCasterMeshes` named, in the order it
   * named them.
   *
   * `registerSceneWithShadowSupport` builds one caster material VIEW per
   * caster at run time and appends it to `engine.materials`, so these are
   * material creations generation never sees at a call site. Every caster
   * takes a handle; only a scene-code PBR one needs a composed row, since
   * a PBR view resolves its variant by material HANDLE and a handle the
   * table never named resolves nothing. The Standard family keys on
   * feature bits and reads `no_color` off the record instead.
   *
   * The mesh row rides along because the view composes over that mesh's
   * own attribute set and no other: a caster view is drawn on its casters
   * and nowhere else, which is the same narrowing the pin gets for free
   * by composing per renderable.
   */
  casters: ShadowCasterManifest[];
  /**
   * At least one caster travels through a runtime mesh array. Composition
   * therefore closes the pass over source material families/mesh feature
   * sets rather than pretending one creation-site row is one mesh handle.
   */
  dynamicCasters?: true;
}

/**
 * One `createSprite2DCustomShader` / `createBillboardCustomShader` descriptor.
 *
 * The caller's WGSL fragment body is scene data, so it travels to generation
 * rather than being read back out of the pin: what the pin owns is the
 * composition around it, which the lowerer folds from the pin's own builder.
 */
/**
 * One bind-group entry an `EffectWrapper` declares.
 *
 * Upstream takes the layout explicitly rather than reflecting it out of the
 * WGSL (`EffectBindingLayout[]`), so the descriptor is the authority on what
 * group 0 holds and this manifest is that descriptor, read once.
 */
export interface EffectBindingManifest {
  /** The descriptor's own `name`, or "" when it declared none. */
  name: string;
  binding: number;
  kind: "uniform" | "texture" | "sampler";
  /** `uniformByteLength` after the pin's align4; 0 for the other kinds. */
  uniformBytes: number;
  /**
   * For a sampler: which texture slot it samples through, as a position in
   * the declared texture list rather than as a binding number. The pin
   * resolves `textureBinding` against its slots and falls back to the first
   * one, so both the lookup and the fallback happen here and each backend
   * indexes its uploaded textures directly. -1 on the other kinds.
   */
  texture: number;
}

/**
 * One `createEffectWrapper` descriptor: the caller's fullscreen fragment and
 * the bind-group layout it declares.
 *
 * The WGSL is scene data, so it travels to generation the way a sprite custom
 * shader's body does; what the pin owns is the vertex stage it concatenates
 * ahead of it, which generation lifts from the pinned module rather than
 * restating.
 */
export interface EffectManifest {
  /** Which pinned API owns this wrapper's fullscreen-pass contract. */
  family: "effect" | "uniform-effect";
  name: string;
  fragment: string;
  bindings: EffectBindingManifest[];
}

export interface SpriteCustomShaderManifest {
  family: "sprite" | "billboard";
  fragment: string;
  /**
   * The identifiers the caller's WGSL samples the extra textures through,
   * in binding order. The pin splices each into a `<name>Tex` /
   * `<name>Samp` pair ahead of the fx block.
   */
  extraTextures: string[];
}

/**
 * One scene-code mesh creation, in creation order, so generation can key the
 * per-renderable variant table the way the runtime keys mesh handles. The
 * builders share one fixed attribute set; `kind` names the intrinsic so a
 * builder with a different set fails by name instead of composing against the
 * wrong bits.
 */
export interface SceneMeshManifest {
  kind: string;
  gltfAssetsBefore: number;
  /** This creation site is assigned a scene-code Standard material. */
  standardMaterial?: true;
  /** A material read from an asset mesh can be assigned to this row. */
  assetPbrMaterial?: true;
  /**
   * The container a PROVEN whole-list flatten is walking, on the member it
   * bound and on what is read off that member.
   *
   * A loaded material has no compile-time identity of its own, so a setter
   * reaching one can only name the document its container composes. That is
   * sound only when the loop is known to reach every renderable, which is
   * why this rides the flatten walk's own binding and not the generic
   * collection loop: `getContainerMeshes(a)` bound to a variable, or
   * `a.meshes ?? []`, iterate the same handles without that proof.
   */
  assetWholeMeshList?: CompileAsset;
  /** For `from-data` meshes: which optional streams the call passes, in
   *  the pin's own argument order (uvs, uv2s, tangents, colors). */
  hasUv2?: boolean;
  hasTangents?: boolean;
  hasColors?: boolean;
  /** Whether this exact mesh reaches thin instancing before rendering, or
   *  can acquire it later from a callback. */
  thinInstances?: "always" | "possible";
  /** Whether the mesh also carries the per-instance RGBA stream. */
  thinInstanceColors?: true;
  /**
   * The scene-local shader variant this mesh was assigned, by name.
   *
   * The pin decides a ShaderMaterial's instanced form mostly from the MESH:
   * `hasColor` is `!!ti.colors && material._tic != 0`, so the mesh's stream
   * decides and the material only opts out (a key this port refuses, so the
   * mesh decides outright). Either way it cannot be settled where the
   * material is created -- that precedes both the assignment and the
   * instances -- so the pair is recorded and settled once, after the entry,
   * in either source order.
   */
  shaderVariant?: string;
}

/**
 * One scene-code `createPbrMaterial(...)` call's resolved options, in creation
 * order. The pin's own `createPbrMaterial` is `{...props}` — the props ARE the
 * material record its feature derivation and extension detects read — so this
 * carries the reached option values verbatim for the composer, textures as
 * presence. Recorded by `compilePbrMaterialOptions`, which already resolves
 * every option to a static value.
 */
/** The `setPbrSheen` options a scene stamps on a material. Values the scene
 *  computes at runtime stay in emitted C++ and are absent here, so composition
 *  replays the pinned writer's own defaults instead of inventing a number. */
export interface ScenePbrSheenManifest {
  isEnabled: boolean;
  color?: readonly [number, number, number];
  roughness?: number;
  intensity?: number;
  hasTexture: boolean;
  albedoScaling: boolean;
}

/** The `setPbrClearCoat` options a scene stamps on a material. Runtime-computed
 *  numbers are absent for the same pinned-default convention as anisotropy. */
export interface ScenePbrClearCoatManifest {
  isEnabled: boolean;
  intensity?: number;
  roughness?: number;
  indexOfRefraction?: number;
}

/** The `setPbrIridescence` options a scene stamps on a material. Runtime-
 *  computed numbers are absent for the pinned writer to default. */
export interface ScenePbrIridescenceManifest {
  isEnabled: boolean;
  intensity?: number;
  indexOfRefraction?: number;
  minimumThickness?: number;
  maximumThickness?: number;
}

/** The reached `setPbrSubsurface` translucency slice. Texture presence is
 *  enough for composition; the static values feed the pin's own UBO writer. */
export interface ScenePbrSubsurfaceManifest {
  intensity: number;
  color: readonly [number, number, number];
  diffusionDistance: readonly [number, number, number];
  hasThicknessTexture: boolean;
  minimumThickness: number;
  maximumThickness: number;
}

/**
 * `AnisotropyProps`, as the pin's own `writeUbo` reads it: the intensity
 * and the two direction components, with the defaults that writer resolves.
 * A texture carries the extension's second feature bit and is refused.
 */
export interface ScenePbrAnisotropyManifest {
  isEnabled: boolean;
  /** Absent where the scene computes it; the composition then replays the
   *  pin's own default, as its writer's `?? 1.0` would. */
  intensity?: number;
  direction: readonly [number, number];
}

/**
 * The options one reached `setPbrMetallicReflectance` call stamps. Presence
 * of this object is also the pin's global reflectance-extension registration;
 * an empty setter call is therefore distinct from no call.
 */
export interface ScenePbrMetallicReflectanceManifest {
  /** Whether the setter supplied a colour. The exact tuple is optional:
   *  mapped materials compose from texture presence alone, while their
   *  runtime colour expression is preserved in emitted C++. */
  hasColor: boolean;
  color?: readonly [number, number, number];
  hasMetallicTexture: boolean;
  hasReflectanceTexture: boolean;
  useOnlyMetallicFromTexture?: boolean;
}

export interface ScenePbrMaterialManifest {
  /**
   * How many scene-code materials of any family the program had created
   * when this one was, so the runtime handle is
   * glTF-materials + this. Standard, grid and shader materials share the
   * same handle sequence.
   */
  materialsBefore: number;
  /** The source material slot for a no-colour/ESM view. */
  sourceMaterialsBefore?: number;
  /** Stamped by the pin's `setPbrUnlit`: `mat._unlit = true`. */
  unlit?: boolean;
  /** Stamped by the pin's `setPbrSkybox`: `mat._skyboxMode = true`. */
  skyboxMode?: boolean;
  /** A `createPbrNoColorMaterialView` of the scene material before it:
   *  the same record with the pin's `PBR2_NO_COLOR_OUTPUT` bit, drawn by
   *  the depth-only render tasks. */
  noColorView?: boolean;
  /** The ESM caster's view: the no-colour view's sibling bit. */
  esmShadowView?: boolean;
  /**
   * The attribute sets this material's variants compose over, when they
   * are fewer than the scene's.
   *
   * A scene-code material can be assigned to any renderable, so by
   * default the composition covers every distinct set in the scene. A
   * shadow caster's no-colour view is the exception: it is drawn on its
   * own caster and nowhere else, so composing it against the scene's
   * whole product deploys stage pairs no draw can select.
   */
  meshFeatureSets?: readonly number[];
  /** Exact scene-mesh creation rows this material can be assigned to.
   *  Composition converts them to the pin's attribute masks. */
  sceneMeshIndices?: readonly number[];
  /** At least one assignment targets a mesh whose identity is not static,
   *  so the exact rows above cannot close the material's mesh space. */
  unknownSceneMesh?: true;
  /** Stamped by the pin's own setter shape: `mat._sheen = sheen`. */
  sheen?: ScenePbrSheenManifest;
  /** Stamped by the pin's own setter shape: `mat._clearCoat = clearCoat`. */
  clearCoat?: ScenePbrClearCoatManifest;
  /** Stamped by the pin's own setter shape: `mat._iridescence = iridescence`. */
  iridescence?: ScenePbrIridescenceManifest;
  /** Stamped by `setPbrSubsurface`: `mat._subsurface = subsurface`. */
  subsurface?: ScenePbrSubsurfaceManifest;
  /** Stamped by the pin's own setter shape: `mat._anisotropy = anisotropy`. */
  anisotropy?: ScenePbrAnisotropyManifest;
  /** Stamped by the pin's `setPbrMetallicReflectance` setter. */
  metallicReflectance?: ScenePbrMetallicReflectanceManifest;
  /**
   * The linear RGB `setPbrEmissive` passes. Its presence is what the
   * emissive extension's `detect` reads, so a material that never
   * reached the setter composes no emissive arm at all.
   */
  emissiveColor?: readonly number[];
  /**
   * How many glTF assets the program had loaded when this material was
   * created. The runtime keys the variant table by material handle, which
   * is creation order, so a scene material created after every load simply
   * appends to the assets' materials; one created before a load would
   * interleave, which no reached scene does.
   */
  gltfAssetsBefore: number;
  hasBaseColorTexture: boolean;
  /**
   * Present only when scene code authored the option. The pin composes the
   * base-color-factor UBO field from property presence, including when the
   * value happens to be neutral white.
   */
  baseColorFactor?: readonly [number, number, number, number];
  hasOrmTexture: boolean;
  metallicFactor: number;
  roughnessFactor: number;
  directIntensity: number;
  environmentIntensity: number;
  alpha: number;
  /** Explicit `alphaBlend: true`; alpha below one is derived separately. */
  alphaBlend?: true;
  reflectance: number;
  /** A non-default value for the pin's `occlusionStrength ?? 1.0`. */
  occlusionStrength?: number;
  /** A non-default internal `_metallicF0Factor ?? 1.0` creation value. */
  metallicF0Factor?: number;
  /** The pin's opt-in geometric-normal derivative roughness floor. */
  enableSpecularAA?: boolean;
  /**
   * Present only when the scene turned the pin's default-true
   * `usePhysicalLightFalloff` off, which is the shape `_writeMaterialData`
   * reads (`=== false ? 0 : 1`). It selects a punctual arm at run time and
   * composes nothing, so it rides the manifest for the record rather than
   * for the composer.
   */
  usePhysicalLightFalloff?: false;
  /**
   * `material.plugins = [...]`, folded. The pin's PBR bridge reads the
   * list off the material in its own `detect`, so the composed input
   * carries the plugins themselves rather than an index.
   */
  plugins?: readonly MaterialPluginManifest[];
  /**
   * Stamped by the pin's `setPbrGammaAlbedo`: `mat._gammaAlbedo = true`,
   * which the gamma extension's `detect` turns into
   * `PBR_HAS_GAMMA_ALBEDO` and the base template's decode slot turns into
   * `pow(baseColorSample.rgb, 2.2)`.
   */
  gammaAlbedo?: boolean;
  doubleSided: boolean;
  transmission: number;
  ior: number;
  thickness: number;
}

/**
 * A scene-local shader-material program compiled from the entry file's
 * own WGSL sources through the typed shader IR. Predeclared variants
 * (the ShaderMaterialVariantName registry) keep their pinned records;
 * scene-local programs carry the equivalent fields plus the typed
 * uniform defaults the pinned createShaderMaterial applies at creation.
 */
export interface CompiledShaderProgram {
  name: string;
  vertexSource: string;
  fragmentSource: string;
  attributes: string[];
  uniforms: string[];
  uniformDefaults: CompiledShaderUniformDefault[];
  /**
   * The `samplers` list: each name reaches WGSL as the pin's own
   * `<name>` / `<name>Sampler` texture-and-sampler pair, and
   * `setShaderTexture` binds by the index it has here.
   */
  samplers: string[];
  /**
   * The `defines` map, normalized into the pin's own sorted
   * `ShaderDefine[]`. Each becomes a module-scope WGSL `const` in both
   * stages' prelude, which is why it is part of the program's identity
   * rather than per-draw state: the pin keys its pipeline cache on the
   * define set too, and nothing at run time can change one.
   */
  defines: CompiledShaderDefine[];
  needAlphaBlending: boolean;
  needAlphaTesting: boolean;
  backFaceCulling: boolean;
  depthWrite: boolean;
  /**
   * The pin's own `_topology`, absent where it resolves
   * `material._topology ?? "triangle-list"`. A line material is the one
   * reached program that names one, and it names the primitive the
   * pipeline is built at rather than anything about the program's text.
   */
  topology?: "line-list";
  /**
   * `useThinInstances`: the material draws through the mesh's
   * thin-instance matrices, which the pin's own thin-instance module
   * appends to its `VertexInput` as four lanes the vertex stage reads.
   */
  useThinInstances?: boolean;
  /**
   * `useThinInstanceColors`: the material binds the mesh's per-instance
   * RGBA stream and its vertex stage reads `input.instanceColor`. Part of
   * the program's identity, because the attribute is declared in the
   * prelude the stage compiles against.
   */
  useThinInstanceColors?: boolean;
}

export interface CompiledShaderDefine {
  name: string;
  value: boolean | number;
}

export interface CompiledShaderUniformDefault {
  name: string;
  values: number[];
}

/**
 * One Babylon NME graph a scene handed `parseNodeMaterialFromSnippet`.
 *
 * The graph is carried whole rather than summarised: what it means is the
 * pin's own compiler to decide, and composition runs that compiler over
 * exactly these bytes.
 *
 * Two routes reach one, because the corpus writes graphs both ways. A module
 * that exports the object outright is read as data — the fold, and the one to
 * prefer, because a literal cannot drift. A module that *builds* its graph at
 * load (id counters, spread-composed inputs, arrays it pushes into) is code
 * this compiler does not lower, so it is executed instead, exactly as a drawn
 * atlas and a computed pixel buffer are.
 */
/**
 * One shadow generator a node material receives from.
 *
 * `_shadowType` is the whole of what the pin reads off the generator, and
 * `lightIndex` is its light's slot in `scene.lights` — the same slot the
 * Standard and PBR receivers key their composition by.
 */
export interface NodeShadowLight {
  lightIndex: number;
  /**
   * Its `shadowGenerators` row.
   *
   * The FILTER is not carried: `pinnedShadowFilter` reads it off the
   * pinned factory the row's kind names, and composition asks it there --
   * so a generator family added without a receiver arm fails by name
   * instead of being classified here as the one it is not.
   */
  generatorIndex: number;
}

export type CompiledNodeMaterial = {
  /**
   * The binding names the scene supplied textures for.
   *
   * The names are the graph's own, so they belong to the graph rather
   * than to the call: composition checks this set against the bindings
   * the pin's own compiler declared, which is the check upstream makes
   * at the first render instead.
   */
  textureNames: readonly string[];
  /**
   * The shadow generators the call named, as the pin reads them.
   *
   * `parseNodeMaterialFromSnippet` takes `shadowGenerators` plus the
   * `scene.lights` index of each one's light, and reads nothing off a
   * generator but its `_shadowType` — so what travels is that filter
   * and the index, which is also what the composed fragment names its
   * bindings and varyings by. Empty for a material that receives no
   * shadow, which composes exactly what it always did.
   */
  shadowLights: readonly NodeShadowLight[];
} & (
  | { kind: "literal"; graph: Record<string, unknown> }
  | {
      kind: "module";
      /** Repository-relative path of the module that builds the graph. */
      module: string;
      /** The exported binding whose value is the graph. */
      exportName: string;
    }
);

/**
 * The scene's whole node-particle program: every set it built, the ordered
 * calls it made on their systems, and which of those systems it froze.
 *
 * It IS the bake request `src/pinned-node-particle.ts` replays -- one record
 * per SCENE rather than per set, because the deterministic seed a scene
 * installs is global, so a scene stepping two sets draws one random sequence
 * across both. Only `synced` is this side's: the compiler refuses a second
 * write to one frozen state, which the driver has no opinion about.
 */
/**
 * A `createTexture2DFromPixels` call, as the bake driver replays it: the
 * executed module that produces the bytes, the size the call named, and the
 * sampler literals it passed, in the pin's own spelling.
 */
export interface PixelsTextureSource {
  /** `pixels:<module>#<export>`, the executed-module asset source. */
  source: string;
  /** The packaged asset's output name, as a native string literal. */
  asset: string;
  width: number;
  height: number;
  options: Record<string, string>;
}

/**
 * One `system.texture = ...` the scene wrote.
 *
 * The call is not carried as its compiled expression, because the generated
 * atlas builder evaluates it in a translation unit of its own where the
 * scene's engine local does not exist: what travels is what the call named,
 * and the builder writes the call against its own parameter.
 */
export interface NodeParticleTextureAssignment extends PixelsTextureSource {
  set: number;
  system: number;
}

export interface CompiledNodeParticles extends Omit<
  NodeParticleBakeRequest,
  "sets" | "billboards" | "registrations"
> {
  sets: NodeParticleSetRequest[];
  billboards: Array<{
    set: number;
    system: number;
    /** Whether a `syncParticleBillboard` already wrote this one. */
    synced?: boolean;
  }>;
  registrations: NodeParticleRegistration[];
  /** Every `system.texture = ...` the scene wrote, in reach order. */
  textures: NodeParticleTextureAssignment[];
  /** Every pure-2D bridge registration, in reach order. */
  sprite2d: NodeParticleSprite2DRequest[];
  steps: NodeParticleStep[];
}

/**
 * One engine handle collection as a compile-time value: the loop target the
 * inline shapes already resolve, plus — for an asset-derived collection —
 * the materialized asset whose document names the members.
 */
export interface HandleCollectionInfo {
  /** The property name as the source writes it (`animationGroups`). */
  property: string;
  /** The generated temporary's label, so emitted names stay stable. */
  temporaryLabel: string;
  /** The native vector expression the runtime loop iterates. */
  containerCpp: string;
  /** The element handle kind an iteration binds. */
  elementKind: ValueKind;
  /** The element's native type (`bbl::AnimationGroupHandle`). */
  elementCppType: string;
  engineCpp: string;
  /**
   * The materialized asset the collection came from. Present exactly for
   * a loaded container's own collection; a scene-owned collection has no
   * generation-known member list and keeps every operation runtime.
   */
  asset?: CompileAsset;
}

export interface CompileAsset {
  source: string;
  output: string;
  kind:
    | "babylon"
    | "dds-environment"
    | "environment"
    | "gltf"
    | "hdr-environment"
    // The two asset kinds whose source is scene-adjacent TypeScript run
    // at compile time rather than a URL fetched and repacked: the
    // sprite-atlas module draws its pixels with canvas2D, and a pixels
    // module computes a texture's bytes outright.
    | "sprite-atlas"
    | "pixels"
    // A Gaussian-splat container, packaged into the interchange row
    // buffer the pin's own `.splat` files already are.
    | "splat"
    // A Basis Universal texture, transcoded by the pin's own loader at
    // generation and packaged as the KTX1 container the runtime's one
    // compressed-texture reader takes.
    | "basis"
    // Opaque bytes consumed by scene code through fetch().arrayBuffer().
    // The compiler packages them unchanged and the native program reads
    // the local payload synchronously through the PAL.
    | "binary"
    | "texture";
  faceSize?: number;
  /**
   * The `KHR_materials_variants` name a scene's `selectVariant` chose on
   * this asset. One static selection is the reached shape, so generation
   * resolves which material each mapped primitive draws with instead of
   * carrying the pin's run-time variant table.
   */
  selectedVariant?: string;
  /**
   * The `setPbrUnlit` a scene applied to this container's own materials,
   * with the optional linear-RGB tint it passed.
   *
   * A loaded material has no scene-side record to stamp, so the fact is
   * kept on the container: generation composes its materials from the
   * document, and the unlit fragment is chosen there. The setter is
   * accepted only over the container's whole flattened mesh list, which is
   * what makes the fact the container's rather than one material's.
   */
  sceneUnlit?: { tint?: readonly [number, number, number] };
  /**
   * How many `loadGltf` calls this record backs.
   *
   * Assets are keyed by source, so loading one URL twice yields two
   * containers over one record. Anything generation stamps on the record
   * therefore reaches both, which a per-container fact must refuse rather
   * than silently widen.
   */
  containerCount?: number;
}

export type GeometryTextureTypeName =
  | "IRRADIANCE"
  | "WORLD_POSITION"
  | "LOCAL_POSITION"
  | "REFLECTIVITY"
  | "VIEW_DEPTH"
  | "NORMALIZED_VIEW_DEPTH"
  | "SCREENSPACE_DEPTH"
  | "VIEW_NORMAL"
  | "WORLD_NORMAL"
  | "ALBEDO"
  | "LINEAR_VELOCITY";

export type ShaderMaterialVariantName = "alpha-card" | "circular-cutout";

export type LightKind = "directional" | "hemispheric" | "point" | "spot";

export interface GeometryOutputTaskManifest {
  shaderIndex: number;
  attachments: GeometryTextureTypeName[];
  emitColor: boolean;
}

/**
 * One effect option, in the shape the pin's own factory receives it. Vector
 * options are the `{x, y}` pair the pinned configs are written with.
 */
export type PostProcessOptionValue =
  | number
  | boolean
  /**
   * A string setting a composite forwards to the pass it ends on --
   * `sourceSamplingMode` is the reached one. The framework consumes it
   * for an ordinary pass, but from a composite's side it is config the
   * pin reads itself, so it travels to the factory unread.
   */
  | string
  | { x: number; y: number }
  /**
   * A member of one of the pin's own enums, unresolved. Scene code writes
   * `DepthOfFieldBlurLevel.High` and what that is worth is the pin's to
   * say, so the name travels to composition and the pinned module answers
   * it -- the value is never restated here.
   */
  | { pinnedEnum: string; member: string };

/**
 * One reached post-process pass, in reach order.
 *
 * The pin builds every effect on one `createPostProcessTask`, so what varies
 * between two passes is the `_shader` record its factory hands over — which is
 * why this carries the entry point and the options that reach the composed
 * text, and nothing about the pass itself. `shaderIndex` is the reach order,
 * which is the generated shader table's index order.
 */
/**
 * One reached composite pass, in reach order.
 *
 * What its passes are is the pin's own factory's to say, so this carries only
 * the entry point and the options that reach it; generation runs the factory
 * and emits the chain it built.
 */
export interface PostProcessCompositeManifest {
  /** Reach order, which is the generated factory's identity. */
  compositeIndex: number;
  /** The Babylon Lite entry point the task was created through. */
  intrinsic: string;
  /** Every option the composite reads, statically resolved. */
  options: Record<string, PostProcessOptionValue>;
  /** Whether the scene named a target, which a composite branches on. */
  hasTarget: boolean;
}

export interface PostProcessTaskManifest {
  shaderIndex: number;
  /** The Babylon Lite entry point the pass was created through. */
  intrinsic: string;
  /**
   * Every option the pass itself does not read, statically resolved and
   * forwarded whole — the pin decides which of them its text branches on.
   */
  options: Record<string, PostProcessOptionValue>;
}

export interface CompileResult {
  cpp: string;
  cmake: string;
  manifest: CompileManifest;
  /**
   * Asset sources needed only while generation materializes the tree.
   *
   * A `data:` URL is the asset's whole payload, so recording it as the
   * manifest source duplicates the bytes from the scene module into
   * `manifest.json`. The manifest carries a content-addressed opaque source
   * instead, and this in-process map keeps the materializer's lookup out of
   * the generated tree. This is the same boundary as `nodeParticles` below:
   * generation consumes the full value, while the manifest retains only
   * the identity a reader needs.
   */
  assetPayloads: Map<string, string>;
  /**
   * The scene's node-particle program, when it built one.
   *
   * Compiler output rather than manifest content: it is the bake request
   * generation replays, it is consumed in-process before anything is
   * written, and it holds the whole graph document plus one record per
   * simulation step -- 60 KB on a scene whose manifest is otherwise 5 KB.
   * What the manifest carries instead is the summary below, which is what
   * a reader of the tree actually wants.
   */
  nodeParticles?: CompiledNodeParticles;
}

/** What `manifest.json` records about a node-particle program. */
export interface NodeParticleManifest {
  sets: Array<{
    builder: NodeParticleBuilder;
    /**
     * The document's identity: a factory's `module#export`, or the
     * SHA-256 of a literal graph. The bytes themselves live in the
     * corpus module the scene imported, and any change to them moves
     * the baked state in `upstream/src/node_particles.cpp`.
     */
    graph: string;
    emitter: readonly [number, number, number];
    textureBaseUrl?: string;
  }>;
  /** How many `animateParticleSystem` calls the program replays. */
  steps: number;
  /** Whether the program installs a deterministic seed before them. */
  seeded: boolean;
  billboards: Array<{ set: number; system: number }>;
}

export type ValueKind =
  | "animation-clip"
  | "animation-group"
  /**
   * The include/exclude target-name filter `createAnimationGroupMask`
   * builds. Its two fields are both compile-time -- a constant array of
   * names and one of the pin's two enum members -- so the value declares
   * nothing native and the assignment to `group.mask` is what emits.
   */
  | "animation-group-mask"
  | "animation-manager"
  | "asset-entity"
  | "asset-root"
  | "asset"
  | "boolean"
  | "browser"
  | "callback"
  | "camera"
  /**
   * The `Math.random` function itself, saved by a scene that replaces it
   * for a node-particle bake and puts it back afterwards. It emits
   * nothing: the replacement parameterizes generation and the restore
   * closes that window.
   */
  | "js-random"
  /**
   * The binding `registerNodeParticleSet2D*` returns: the hook and the
   * layers it attached, which upstream owns and this port folds into the
   * generated registrar. Every operation on it refuses at its own
   * intrinsic, and the corpus only reports its state through the canvas
   * dataset -- so a read of it erases with the instrumentation around it,
   * and one that reaches anything else fails rather than compiling.
   */
  | "node-particle-2d-binding"
  | "camera-ortho"
  | "camera-world-matrix"
  | "color4"
  | "data"
  | "engine"
  // A captured browser GPUDevice exists only so a structurally recognized
  // thin-instance upload helper can be replaced as a unit. No generic raw
  // device operation is part of the compiled surface.
  | "gpu-device"
  | "static-fetch-response"
  | "json-null"
  | "light"
  | "material"
  | "mesh"
  | "transform-node"
  | "morph-targets"
  | "node-particle-graph"
  | "node-particle-set"
  | "node-particle-system"
  | "number"
  // The physics family. `physics-engine-module` is the `hknp` the pin
  // takes as a parameter -- the WASM module a browser scene loads. It has
  // no native representation at all: the solver is reached through the
  // PAL, so the value exists only to be accepted by `createHavokWorld`
  // and dropped, exactly as the tracking installers are accepted and emit
  // nothing. Bodies and shapes are opaque native values that may travel
  // through the demo's arrays and maps just like mesh handles do.
  | "physics-engine-module"
  // The clustered light field. The container is a native record and its
  // lights are built by the emitted loop, as upstream builds them; only
  // whether a spot was created is compile-time, because that decides which
  // extension composes the fragment.
  | "clustered-light-container"
  | "clustered-light"
  | "physics-world"
  | "physics-aggregate"
  | "physics-body"
  | "physics-shape"
  /** Callback-local platform keyboard data; it has no storable JS shape. */
  | "platform-keyboard-event"
  /** Callback-local platform mouse data; it has no storable JS shape. */
  | "platform-mouse-event"
  // The navigation plugin: the Detour surface behind the PAL, held the
  // way `physics-world` holds the solver. A crowd is a second handle
  // over the same seam, because the pin models it as one too --
  // `NavCrowd` carries its plugin and its `dtCrowd`, and every agent
  // call takes the crowd rather than the plugin.
  | "navigation"
  | "navigation-crowd"
  // One obstacle a tile-cache navmesh holds. `ObstacleHandle` is opaque
  // upstream too -- the only thing a scene does with one is hand it back
  // to `removeObstacle` -- so it is a kind rather than a record.
  | "navigation-obstacle"
  // The Web Audio family. The seam is the pin's own: `src/audio/*.ts`
  // reaches the browser through `AudioContext`/`GainNode`/`AudioParam`
  // and nothing else, so those are the handles -- the same shape
  // `physics-world` holds the solver behind. `audio-engine` is the Lite
  // engine record; `audio-context` is the `BaseAudioContext` it hands
  // back, which every reached demo builds its own graph on.
  | "audio-engine"
  | "audio-buffer"
  | "audio-context"
  | "audio-node"
  | "audio-param"
  | "render-target"
  | "render-target-texture"
  | "render-texture"
  | "record"
  | "regexp"
  | "scene"
  | "frame-graph-context"
  | "sprite-atlas"
  | "sprite-layer"
  | "sprite-blend"
  | "tone-mapping"
  | "effect-wrapper"
  | "effect-renderer"
  /**
   * A collection of engine handles known at generation: the loader's own
   * `animationGroups`, bound to a local or passed into a reached user
   * function. The members come from the materialized asset, so `.find`
   * over one resolves at generation; iteration stays the same native
   * loop the inline property read already emits. Constructed only at
   * binding points — the inline expression shapes keep their existing
   * emission byte for byte.
   */
  | "handle-collection"
  | "sprite-custom-shader"
  | "billboard-custom-shader"
  | "billboard-system"
  | "billboard-sprite"
  | "sprite-2d-handle"
  | "sprite-animation-manager"
  | "sprite-renderer"
  | "splat-mesh"
  /**
   * A `GsShaderFragment` a `loadSplat` call passes: WGSL slots the pin's
   * own splicer folds into the splat module at generation, so the value
   * declares nothing native.
   */
  | "splat-fragment"
  // The GPU picker holds the 1x1 attachments, the depth buffer and the
  // staging buffers its readback maps, so it is a native handle for the
  // same reason a shadow generator is.
  | "gpu-picker"
  // What a pick resolved to. Upstream `PickingInfo` is a mutable object
  // the contributor's own `resolve` fills in; here it is a value, because
  // nothing in the reached slice writes one back.
  | "picking-info"
  // `PickingInfo.pickedMesh`. Upstream it is whichever node was hit and
  // both kinds carry a `name`; this port keeps meshes and clouds in
  // separate collections, so the value is the tagged pair and `.name` is
  // the one member the reached slice reads.
  | "picked-node"
  // The `ShadowGenerator` a filter factory returns. It holds GPU state
  // (a depth map, a comparison sampler, two uniform buffers), so it is a
  // native handle rather than a compile-time record -- but which lights
  // and meshes it joins is generation's to resolve, since the composed
  // receiver fragment is keyed by the scene's shadow-light slots.
  | "shadow-generator"
  // The opt-in bone-control pair: a `Skeleton` the loader built per glTF
  // skin instance, and one `Bone` of it. Both are native handles because
  // the bones and their overrides live on records the loader fills, and
  // the bake reads them back.
  | "skeleton"
  | "bone"
  | "string"
  | "task"
  | "texture"
  | "tuple"
  | "void";

/**
 * A value that exists only at generation: it binds a name, and declares
 * nothing native.
 *
 * The two binding paths -- a variable declaration and an assignment to an
 * already-declared local -- both have to recognize the same set, and each
 * used to carry its own list. They disagreed, which is the failure this
 * exists to stop: a kind added to one silently fell through to the generic
 * emit in the other and produced a declaration with no initializer.
 */
/**
 * The one compile-time fact about a clustered light container: whether the
 * scene reaches `createClusteredSpotLight`.
 *
 * Everything else about the container is a run-time value. Both reached
 * scenes fill 1000 lights from a seeded PRNG inside a counted loop, which
 * lowers to a native `for` rather than an unrolled table, so the rows are
 * built by the emitted code exactly as the pin builds them.
 *
 * Whether a spot was ever created is different in kind, because it decides
 * COMPOSITION: `_enableClusteredSpotSupport` installs the stride-3 layout and
 * registers the spot extension, whose `detect` then takes the material over
 * from the point one. The pin reaches that at the spot factory, so this port
 * reads it there too.
 */
export interface ClusteredContainerState {
  hasSpots: boolean;
  /**
   * Set once `addClusteredLightContainer` has built the GPU state. A light
   * created after that point refuses, because the pin bakes both the light
   * capacity and the point-versus-spot layout there and its own refresh
   * throws rather than growing either.
   */
  frozen: boolean;
}

export function isCompileTimeOnlyValue(kind: ValueKind): boolean {
  return (
    kind === "tuple" ||
    kind === "record" ||
    kind === "gpu-device" ||
    kind === "static-fetch-response" ||
    kind === "json-null" ||
    kind === "morph-targets" ||
    // A handle collection binds a name to the container the loader
    // already owns; nothing native is declared for the binding itself.
    kind === "handle-collection" ||
    // A custom-shader descriptor is compile-time data: the program it
    // names is composed at generation and the layer it is passed to
    // carries only that it has one.
    kind === "sprite-custom-shader" ||
    kind === "billboard-custom-shader" ||
    // A splat shader plugin is WGSL the pin splices at generation.
    kind === "splat-fragment" ||
    // The mask a group is about to be given: names and a mode, both
    // known at generation.
    kind === "animation-group-mask" ||
    // The solver module a physics scene loads. The pin hands it to
    // `createHavokWorld`; a native build reaches its solver through
    // the PAL, so the binding exists for that call to accept.
    kind === "physics-engine-module" ||
    isNodeParticleValue(kind)
  );
}

/**
 * The node-particle values are compile-time records: a graph, the set built
 * from it and one of its systems name entries in the scene's own particle
 * program, and nothing native holds them -- the simulation is baked at
 * generation. Both binding paths ask the same question, so they ask it here.
 */
export function isNodeParticleValue(kind: ValueKind): boolean {
  return (
    kind === "node-particle-graph" ||
    kind === "node-particle-set" ||
    kind === "node-particle-system"
  );
}

export type FrameCallbackSignature =
  "delta" | "timestamp" | "interval" | "void";

/** One symbol binding in the compiler's lexical scope stack. */
export interface VariableBinding {
  name: string;
  value: Value;
  /** The native storage belongs to an application frame callback. */
  frameLocal?: boolean;
  /**
   * Set where a nested callback pointed this handle at something else.
   *
   * The storage is shared, so after such a rebind this binding's `value`
   * describes an identity the storage may no longer hold -- it depends on
   * whether the callback ran. Reading it out here is refused rather than
   * guessed.
   */
  reboundInNestedScope?: true;
}

export interface Value {
  kind: ValueKind;
  cpp: string;
  /**
   * The exact handle members held by a native array at this point in the
   * source walk. Explicitly typed handle arrays need runtime identity, but
   * an initial complete list can still close generated render variants.
   * Any native mutation clears this snapshot before subsequent reads.
   */
  staticHandleElements?: Value[];
  /** Root binding whose static handle snapshot this parameter alias shares. */
  staticHandleElementsOwner?: Value;
  /**
   * Keep this lookup nullable when it initializes a local even if
   * TypeScript reports the binding itself as non-nullable.
   *
   * An open `Record<string | number, T>` has that checker shape, but an
   * arbitrary JavaScript property can still be absent. Retaining the
   * native nullable lets a later `!== undefined` test observe the miss
   * before any use dereferences the value.
   */
  preserveUncheckedLookup?: true;
  /**
   * A reached user function was inlined and left this value as its
   * result. If its call is used as a statement, C++ needs an explicit
   * discard instead of a bare value expression.
   */
  requiresExplicitDiscard?: boolean;
  dataType?: DataType;
  /** The expression returns existing mutable storage, not a JS value copy. */
  borrowedData?: true;
  /** The expression creates an owning data container at this read. */
  freshData?: true;
  dataStore?: TypedArrayKind;
  /**
   * Set on a value read out of a container of const elements (a span,
   * including a materialized constant table). It cannot be bound by
   * reference, and the source language would not let it be written
   * through either.
   */
  readOnly?: boolean;
  callbackDeclaration?:
    | ts.Identifier
    | ts.FunctionDeclaration
    | ts.ArrowFunction
    | ts.FunctionExpression
    | ts.MethodDeclaration;
  /**
   * Runtime parameter types for a locally specialized recursive function.
   * An undefined entry is a compile-time argument captured by the lambda.
   */
  nativeCallbackParameterTypes?: readonly (DataType | undefined)[];
  /** Captured values learned from calls within one recursive specialization. */
  nativeCallbackStaticArguments?: (Value | undefined)[];
  /** Undefined is also the native void return type. */
  nativeCallbackReturnType?: DataType;
  /** Scope-carrying record a function-valued property was read from. */
  callbackRecordOwner?: Value;
  /** Constructed class identity, retained when an inlined return wraps Value. */
  classDeclaration?: ts.ClassDeclaration;
  /** The concrete native texture record produced by a texture factory. */
  textureStorage?: "file" | "pixels" | "solid" | "render";
  textureFile?: {
    srgb: boolean;
    /** Packaged source used only when source dimensions are reached. */
    source?: string;
    entryFileName?: string;
  };
  /** Statically decoded source dimensions for file-backed image textures. */
  textureWidth?: number;
  textureHeight?: number;
  /**
   * Which `scenePbrMaterials` entry this value names. The pin's opt-in
   * setters mutate the material object they are handed, so a setter has
   * to reach the same record the creation did; the index is that object
   * identity at compile time. It rides the material a
   * `createPbrMaterial` returned, and a mesh a material was assigned
   * to, which is how `setPbrSkybox(box.material)` resolves the record
   * the assignment stored.
   */
  scenePbrMaterialIndex?: number;
  /** This material was read from a mesh whose identity came from an asset. */
  assetPbrMaterial?: true;
  /**
   * The container a PROVEN whole-list flatten is walking, on the member it
   * bound and on what is read off that member.
   *
   * A loaded material has no compile-time identity of its own, so a setter
   * reaching one can only name the document its container composes. That is
   * sound only when the loop is known to reach every renderable, which is
   * why this rides the flatten walk's own binding and not the generic
   * collection loop: `getContainerMeshes(a)` bound to a variable, or
   * `a.meshes ?? []`, iterate the same handles without that proof.
   */
  assetWholeMeshList?: CompileAsset;
  /**
   * A `createStandardMaterial` result, which is the family question
   * `material.plugins` has to answer: the pin's Standard plugin bridge
   * filters on `_buildGroup === standardGroupBuilder`, so a plugin on a
   * grid, shader or node material composes nothing upstream and refuses
   * here.
   */
  standardMaterial?: true;
  /**
   * Which composed node graph a material value names.
   *
   * It rides a `parseNodeMaterialFromSnippet` result; the assignment that
   * puts it on a mesh records the pair the caster list resolves against,
   * so the mesh's own Value never carries it.
   */
  nodeMaterialIndex?: number;
  /**
   * Which `sceneMeshes` entry this mesh value names, so a scene-code
   * mesh can be resolved to the runtime handle the composed variant
   * tables are keyed by: the asset renderables come first, in load
   * order, and the scene meshes follow in creation order.
   */
  sceneMeshIndex?: number;
  /**
   * Which `scene.lights` slot a light was added at. The pin's shadow
   * receiver fragment names its per-light varyings and bindings by that
   * index (`shadowTex_0`, `shadowFactors[0]`), so it is composition
   * input rather than a runtime lookup.
   */
  sceneLightIndex?: number;
  /**
   * Which `shadowGenerators` entry a light was given, so
   * `setShadowTaskCasterMeshes(light.shadowGenerator, ...)` reaches the
   * record the assignment stored -- the same object identity
   * `scenePbrMaterialIndex` carries for a material.
   */
  shadowGeneratorIndex?: number;
  /**
   * Set on a read whose value can differ between two evaluations of the
   * same expression -- a clock, not a constant.
   *
   * `collectStaticConstants` registers every `const` initializer so a
   * later use folds back to it, which is right for a literal and wrong
   * for `ctx.currentTime`: `const now = ctx.currentTime` followed by two
   * uses would call the clock twice and schedule against two different
   * instants, where the source asked for one. A declaration bound to an
   * impure value therefore stops being a static constant and its uses
   * read the native local.
   */
  impure?: true;
  /**
   * `mainBus._in` under an audio engine -- the gain a sound source
   * connects into. It rides the engine value because the pin reaches it
   * through the engine object rather than by name.
   */
  audioMainBusCpp?: string;
  /**
   * The context a node or parameter belongs to. Web Audio forbids
   * connecting across contexts and every factory is a method on one, so
   * the context travels with everything it made; `carriesAudioContext`
   * in the property table is what moves it across a read.
   */
  audioContextCpp?: string;
  /**
   * The materialized asset an `asset` value was loaded from.
   * `selectVariant` needs it the way the pin's own setter reaches
   * `container.materialVariants`: through the object, not by name.
   */
  asset?: CompileAsset;
  /**
   * Set on the hierarchy `cloneTransformNode` returned for a glTF root.
   * Both values use the asset handle as their native identity, but only
   * the clone is an entity the source may add on its own: the original
   * root is already owned by its container and adding it must not pull in
   * the container-level animation/camera wiring a second time.
   */
  assetRootClone?: true;
  /**
   * The graph a `node-particle-graph` value carries, and — on a set, its
   * systems and one of them — which recorded set it names. The program
   * those calls append to is the scene's, not the value's, so only the
   * index travels here.
   */
  nodeParticleGraph?: NodeParticleGraphSource;
  /**
   * What a `splat-fragment` value carries: the pinned export a scene
   * imported, or the record it declared. Read at composition, where the
   * pin's own splicer turns the list into one WGSL module.
   */
  splatFragment?: SplatFragmentManifest;
  /** Which set, and which of its systems, in the manifest's own order. */
  nodeParticleSetIndex?: number;
  nodeParticleSystemIndex?: number;
  /**
   * For a `createTexture2DFromPixels` texture: what the bake driver needs
   * to build the same texture in the browser. A particle system's texture
   * is assigned in scene code, and the pin reads its width and height to
   * partition the atlas, so the driver has to hold the real one.
   */
  pixelsTexture?: PixelsTextureSource;
  /**
   * Set on the `animation-group` a property clip produced. A glTF group
   * is the engine handle its loader created, while
   * `createPropertyAnimationGroup` returns the shared record the manager
   * drives, and the two take different native entry points — so an
   * operation serving one names the other with a source location instead
   * of emitting C++ that would not compile. Absent means the handle form.
   */
  animationGroupSource?: "property";
  /**
   * What an `animation-group-mask` value carries: the target names the
   * mask lists, and whether listing them excludes or includes. The pin's
   * `animationGroupMaskRetainsTarget` reads exactly those two, and the
   * generated writer resolves them against the asset's own node names.
   */
  animationGroupMask?: {
    readonly names: readonly string[];
    readonly include: boolean;
  };
  /**
   * For a handle that may be absent: the native boolean saying whether
   * it is there. A search produces one — upstream's `find` returns
   * `undefined` when nothing matched — and so does a record slot
   * nothing filled, which carries `invalid_handle`. Either way the flag
   * is what a scene's own guard reads, through `if`, `??` or a null
   * comparison. A find the materialized asset resolved at generation
   * carries the constant `"true"`, which is what folds the scene's own
   * not-found guard away.
   */
  optionalFoundCpp?: string;
  /** JavaScript truthiness when it differs from mere optional presence. */
  truthinessCpp?: string;
  /** Storage behind a nullable resource value whose `cpp` is its dereference. */
  optionalStorageCpp?: string;
  /** Native pointer token carrying JavaScript identity for a data object. */
  objectIdentityCpp?: string;
  /**
   * For a `handle-collection` value: where the collection lives and, when
   * it is asset-derived, which materialized asset decides its members.
   */
  handleCollection?: HandleCollectionInfo;
  /**
   * A generation-time identity for a handle whose collection slot is
   * known — `<asset source>#animationGroups[<index>]`. Two values carrying
   * identities compare by them, which is what lets `group === sadPose`
   * fold per unrolled iteration; a value without one compares its native
   * `.value` at run time instead.
   */
  handleIdentity?: string;
  engineCpp?: string;
  geometryTask?: GeometryOutputTaskManifest;
  /**
   * Set on a `render-texture` or `render-target-texture` whose texture is
   * a depth attachment rather than a colour one. Two things make one: a
   * geometry task's own depth, which is what a render task's `depth` may
   * bind, and a render target that declared no colour format, because
   * `rtt.ts` then hands its depth attachment to samplers.
   *
   * This is the ASPECT -- what sampling it gives you. `renderTextureSource`
   * is the separate question of who owns it.
   */
  isDepthTexture?: true;
  /**
   * Which native `RenderTextureSource` a render texture names. The
   * compiler knows it at every construction site, so a slot that accepts
   * only some of them refuses the rest by name with a location, rather
   * than leaving a backend to fail a binding at run time.
   */
  renderTextureSource?:
    "render-target" | "geometry" | "geometry-output" | "geometry-depth";
  /**
   * Which post-process pass a `task` value names. `outputTexture` reads it
   * to resolve the internal target the pin's `prepareOutputTarget` creates,
   * and a settable effect option resolves its parameter slot through it.
   */
  postProcessTask?: PostProcessTaskManifest;
  /**
   * Set instead when a `task` value names a composite. It records passes of
   * its own, so it answers `updateUniforms` and `outputTexture` the same way
   * -- but its parameters live on the passes the pin built, not on a slot a
   * scene can name, so a setter on one is refused.
   */
  postProcessComposite?: PostProcessCompositeManifest;
  lightKind?: LightKind;
  /**
   * A camera's own construction, as static numbers, and the scene's
   * reference to the camera it was assigned.
   *
   * One executed port reads the scene's camera rather than only the
   * scene's own records: a node-particle graph's `UpdateFlowMapBlock`
   * derives the view-projection at build, so the driver that runs that
   * build has to hold the same camera. Everything in it is a literal the
   * scene wrote, and a camera assembled any other way carries no program
   * and refuses there.
   */
  cameraProgram?: NodeParticleCamera;
  /** The camera value `scene.camera = ...` stored, by reference. */
  sceneCamera?: Value;
  /**
   * The extra textures a custom-shader descriptor binds, as the native
   * expressions that build them, in binding order. They ride the
   * descriptor because that is what the layer or system is handed.
   */
  spriteCustomTextures?: string[];
  /** The corresponding shader identifiers, in the same binding order. */
  spriteCustomTextureNames?: string[];
  /** One-based program index; zero is the stock sprite/billboard shader. */
  spriteCustomShaderIndex?: number;
  shaderVariant?: string;
  /**
   * The same name, but only for a program `createShaderMaterial` built
   * from the entry's own WGSL.
   *
   * The line and linear-depth families also carry `shaderVariant`, and
   * both settle their own instanced form from their options -- the line
   * family even names the permutation. Only a scene-local program leaves
   * that to the mesh, so only it is marked here.
   */
  sceneShaderVariant?: string;
  /** Stable creation slot for a scene-owned material that escapes a scope. */
  sceneMaterialSlot?: number;
  animationFrameRate?: string;
  animationDuration?: string;
  /**
   * Which object kind an `animation-clip` value's paths bind to. A
   * pinned path is resolved against whatever object the group was
   * created with, so the clip and the target have to agree; the closed
   * path table decides which kind each one names.
   */
  animationTargetKind?: "mesh" | "camera";
  staticNumber?: number;
  /** Generation-known boolean retained across readonly scalar bindings. */
  staticBoolean?: boolean;
  /** Materialized mutable parameter; static caller facts cannot fold branches. */
  parameterBinding?: boolean;
  /** A value bound by a native runtime iteration, not a static unroll. */
  runtimeIteration?: true;
  staticString?: string;
  /** Runtime path selected from a compiler-packaged closed asset directory. */
  dynamicAssetPathCpp?: string;
  /** Parsed payload carried only by a generation-time fetch response. */
  staticJson?: unknown;
  tupleElements?: Value[];
  recordProperties?: Record<string, Value>;
  /**
   * Record properties that carry a function: either an identifier
   * naming a local one, or a function literal written in place. The
   * node the literal wrote is kept so a call through the property
   * resolves and inlines exactly as a direct call does — which for the
   * identifier form is the same resolver a direct call uses, and for
   * the literal form is the callback path a function-literal argument
   * already takes.
   */
  recordMethods?: Record<
    string,
    | ts.Identifier
    | ts.ArrowFunction
    | ts.FunctionExpression
    | ts.MethodDeclaration
  >;
  /**
   * Record properties declared with `get`. The accessor is kept
   * rather than its value, so each read re-evaluates it.
   */
  recordGetters?: Record<string, ts.GetAccessorDeclaration>;
  /**
   * The scope chain in force where a record carrying methods or
   * getters was built. A record can outlive the scope its state
   * lives in -- a factory returns it, and the frame loop calls it --
   * so that scope travels with it and is restored while a method or
   * getter of the record runs. This is the closure the source wrote.
   */
  recordScopes?: ReadonlyArray<Map<ts.Symbol, VariableBinding>>;
  defaultRenderTask?: boolean;
  defaultRenderTaskEmitted?: boolean;
  /** The context's optional per-frame `update(deltaMs)` callback. */
  frameGraphUpdateCpp?: string;
  /** Shared across compiler aliases of one native scene. */
  sceneEnvironmentState?: {
    rotationSet: boolean;
    hasTexturedSkybox: boolean;
  };
  /**
   * Shared across compiler aliases of one clustered light container.
   *
   * The rows accumulate as scene code calls `createClusteredPointLight` /
   * `createClusteredSpotLight`, and `addClusteredLightContainer` freezes
   * them: the pin's own `buildClusteredLightGpuState` bakes the light
   * capacity and the point-versus-spot data layout there and throws if
   * either grows, so a light created afterwards refuses at generation
   * rather than reaching a state that cannot hold it.
   */
  clusteredContainerState?: ClusteredContainerState;
  /** The layer an `addSprite2D` handle lives in, which its animation
   *  target names beside the sprite's own id. */
  spriteLayerCpp?: string;
  browserValue?:
    | { kind: "boolean"; value: boolean }
    | { kind: "number"; value: number }
    | { kind: "null" }
    | { kind: "dom-rect" }
    | { kind: "object" }
    | { kind: "search-params"; search: string }
    | { kind: "string"; value: string };
  cameraKind?: "arc-rotate" | "free";
  msaaSamples?: 1 | 4;
  directMorphCompatible?: boolean;
  morphTarget?: {
    positionsCpp: string;
    normalsCpp: string;
    vertexCountCpp: string;
    weightCpp: string;
    meshCpp?: string;
  };
}

export type Feature =
  | "animation:gltf-groups"
  | "animation:property"
  | "animation:property-blending"
  | "animation:managed-groups"
  | "animation:gltf-blending"
  | "animation:gltf-additive"
  | "animation:gltf-group-time"
  | "animation:gltf-group-speed"
  | "animation:gltf-group-mask"
  | "background:ground"
  | "background:skybox"
  | "core"
  | "backend:sdl"
  | "camera:arc-rotate"
  | "camera:default"
  | "camera:free"
  | "camera:orthographic"
  | "environment:ibl"
  | "environment:env"
  | "environment:hdr"
  | "environment:dds"
  | "light:hemispheric"
  | "light:directional"
  | "light:point"
  | "light:spot"
  // The clustered point/spot field: its own PAL translation unit, the
  // three data textures and the params block the composed fragment reads.
  | "light:clustered"
  | "loader:babylon"
  | "loader:gltf"
  | "loader:gltf-variants"
  | "loader:gltf-cameras"
  | "loader:gltf-bone-control"
  | "loader:splat"
  | "loader:splat-bake"
  | "material:pbr"
  | "material:clearcoat"
  | "material:sheen"
  | "material:sheen-albedo-scaling"
  | "material:clearcoat-f0-remap"
  | "material:pbr-gamma-albedo"
  | "material:iridescence"
  | "material:anisotropy"
  | "material:metallic-reflectance"
  | "material:tracking"
  | "material:emissive"
  | "material:no-color-view"
  | "material:grid"
  | "material:node"
  | "material:shader"
  | "material:standard"
  | "material:standard-vertex-colors"
  | "mesh:box"
  | "mesh:from-data"
  | "mesh:update-positions"
  | "mesh:ground"
  | "mesh:ground-heightmap"
  | "mesh:lines"
  | "mesh:morph-targets"
  | "mesh:transform-node"
  | "mesh:mirrored"
  | "mesh:plane"
  | "mesh:sphere"
  | "mesh:thin-instances"
  | "mesh:thin-instance-colors"
  | "mesh:thin-instances-dynamic"
  | "mesh:cylinder"
  | "mesh:extrude"
  | "mesh:polyhedron"
  | "mesh:ribbon"
  | "mesh:disc"
  | "mesh:torus"
  | "mesh:tube"
  | "mesh:parenting"
  | "mesh:geometry-access"
  | "mesh:visible"
  | "mesh:pickable"
  | "particle:node"
  | "navigation:recast"
  | "navigation:tile-cache"
  | "sprite:animation"
  | "audio:engine"
  | "audio:buffer-source"
  | "audio:decoded-buffer"
  | "audio:oscillator"
  | "audio:biquad-filter"
  | "audio:stereo-panner"
  | "physics:world"
  | "physics:aggregate"
  | "scene:remove"
  // GPU picking. One feature, because the pin's own split is by
  // PIPELINE rather than by entry point: the simple pass, the advanced
  // one and the detailed one are three modules behind one `pickAsync`,
  // and this port reaches only the first. The GS contributor rides the
  // splat feature that already selected the cloud.
  | "picking:gpu"
  // The shadow family, split the way upstream splits it: the filter's own
  // resources and receiver composition (`shadow:pcf`), and the scene-owned
  // frame-graph task that schedules them (`shadow:task`), which
  // `registerSceneWithShadowSupport` is the only way to reach.
  | "shadow:esm"
  | "shadow:pcf"
  | "shadow:pcf-directional"
  | "shadow:csm-single-map"
  | "shadow:task"
  | "sprite:2d"
  | "sprite:uv-scroll"
  | "sprite:custom-shader"
  | "material:standard-diffuse-render-texture"
  | "material:standard-diffuse-pixels-texture"
  | "material:standard-uv-transform"
  | "material:plugins"
  | "material:plugin-index"
  | "material:standard-emissive-render-texture"
  | "material:standard-diffuse-file-texture"
  | "material:standard-emissive-file-texture"
  | "texture:file"
  | "texture:compressed"
  | "texture:pixels"
  | "sprite:billboard"
  | "sprite:billboard-axis-locked"
  | "sprite:billboard-cutout"
  | "sprite:billboard-custom-shader"
  | "renderer:sprite"
  | "renderer:effect"
  | "frame-graph:resources"
  | "renderer:frame-graph"
  | "effect:wrapper"
  | "effect:task"
  | "renderer:pbr"
  | "renderer:transmission"
  | "material:pbr-linear-image-processing"
  | "renderer:fog"
  | "renderer:geometry-output"
  | "renderer:post-process"
  | "renderer:high-precision-matrix"
  | "renderer:floating-origin"
  | "background:image-skybox"
  | "background:solid-skybox";

export interface ResolvedCompileOptions {
  fileName: string;
  title: string;
  width: number;
  height: number;
  search: string;
}
