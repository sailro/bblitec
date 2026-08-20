import type ts from "typescript";
import type { CompileAdaptation } from "../fidelity.js";
import type { DataType } from "./data-types.js";

export interface CompileOptions {
    fileName?: string;
    title?: string;
    width?: number;
    height?: number;
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
    /** The sprite-family custom fragment shaders scene code built. */
    spriteCustomShaders: SpriteCustomShaderManifest[];
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
    /** Every scene-code material creation, any family, for the handle count. */
    sceneMaterialCount: number;
    sceneMeshes: SceneMeshManifest[];
}

/**
 * One `createSprite2DCustomShader` / `createBillboardCustomShader` descriptor.
 *
 * The caller's WGSL fragment body is scene data, so it travels to generation
 * rather than being read back out of the pin: what the pin owns is the
 * composition around it, which the lowerer folds from the pin's own builder.
 */
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
    /** For `from-data` meshes: which optional streams the call passes, in
     *  the pin's own argument order (uvs, uv2s, tangents, colors). */
    hasUv2?: boolean;
    hasTangents?: boolean;
    hasColors?: boolean;
}

/**
 * One scene-code `createPbrMaterial(...)` call's resolved options, in creation
 * order. The pin's own `createPbrMaterial` is `{...props}` — the props ARE the
 * material record its feature derivation and extension detects read — so this
 * carries the reached option values verbatim for the composer, textures as
 * presence. Recorded by `compilePbrMaterialOptions`, which already resolves
 * every option to a static value.
 */
/** The `setPbrSheen` options a scene stamps on a material, verbatim. */
export interface ScenePbrSheenManifest {
    isEnabled: boolean;
    color: readonly number[];
    roughness: number;
    intensity: number;
    hasTexture: boolean;
    albedoScaling: boolean;
}

/** The `setPbrClearCoat` options a scene stamps on a material, verbatim. */
export interface ScenePbrClearCoatManifest {
    isEnabled: boolean;
    intensity: number;
    roughness: number;
    indexOfRefraction: number;
}

/** The `setPbrIridescence` options a scene stamps on a material, verbatim. */
export interface ScenePbrIridescenceManifest {
    isEnabled: boolean;
    intensity: number;
    indexOfRefraction: number;
    minimumThickness: number;
    maximumThickness: number;
}

export interface ScenePbrMaterialManifest {
    /**
     * How many scene-code materials of any family the program had created
     * when this one was, so the runtime handle is
     * glTF-materials + this. Standard, grid and shader materials share the
     * same handle sequence.
     */
    materialsBefore: number;
    /** Stamped by the pin's `setPbrUnlit`: `mat._unlit = true`. */
    unlit?: boolean;
    /** Stamped by the pin's `setPbrSkybox`: `mat._skyboxMode = true`. */
    skyboxMode?: boolean;
    /** A `createPbrNoColorMaterialView` of the scene material before it:
     *  the same record with the pin's `PBR2_NO_COLOR_OUTPUT` bit, drawn by
     *  the depth-only render tasks. */
    noColorView?: boolean;
    /** Stamped by the pin's own setter shape: `mat._sheen = sheen`. */
    sheen?: ScenePbrSheenManifest;
    /** Stamped by the pin's own setter shape: `mat._clearCoat = clearCoat`. */
    clearCoat?: ScenePbrClearCoatManifest;
    /** Stamped by the pin's own setter shape: `mat._iridescence = iridescence`. */
    iridescence?: ScenePbrIridescenceManifest;
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
    hasOrmTexture: boolean;
    metallicFactor: number;
    roughnessFactor: number;
    directIntensity: number;
    environmentIntensity: number;
    alpha: number;
    reflectance: number;
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
    needAlphaBlending: boolean;
    needAlphaTesting: boolean;
    backFaceCulling: boolean;
    depthWrite: boolean;
    clipDepth: "matrix" | "direct-webgpu";
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
export type CompiledNodeMaterial =
    | { kind: "literal"; graph: Record<string, unknown> }
    | {
        kind: "module";
        /** Repository-relative path of the module that builds the graph. */
        module: string;
        /** The exported binding whose value is the graph. */
        exportName: string;
    };

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
        | "texture";
    faceSize?: number;
    /**
     * The `KHR_materials_variants` name a scene's `selectVariant` chose on
     * this asset. One static selection is the reached shape, so generation
     * resolves which material each mapped primitive draws with instead of
     * carrying the pin's run-time variant table.
     */
    selectedVariant?: string;
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

export type ShaderMaterialVariantName =
    | "alpha-card"
    | "circular-cutout";

export type LightKind =
    | "directional"
    | "hemispheric"
    | "point"
    | "spot";

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
}

export type ValueKind =
    | "animation-clip"
    | "animation-group"
    | "animation-manager"
    | "asset"
    | "boolean"
    | "browser"
    | "callback"
    | "camera"
    | "camera-ortho"
    | "camera-world-matrix"
    | "color4"
    | "data"
    | "engine"
    | "light"
    | "material"
    | "mesh"
    | "morph-targets"
    | "number"
    | "render-target"
    | "render-target-texture"
    | "render-texture"
    | "record"
    | "scene"
    | "sprite-atlas"
    | "sprite-layer"
    | "sprite-blend"
    | "sprite-custom-shader"
    | "billboard-custom-shader"
    | "billboard-system"
    | "sprite-renderer"
    | "string"
    | "task"
    | "texture"
    | "tuple"
    | "void";

export interface Value {
    kind: ValueKind;
    cpp: string;
    dataType?: DataType;
    dataStore?: "f32" | "u32";
    /**
     * Set on a value read out of a container of const elements (a span,
     * including a materialized constant table). It cannot be bound by
     * reference, and the source language would not let it be written
     * through either.
     */
    readOnly?: boolean;
    callbackDeclaration?:
        | ts.ArrowFunction
        | ts.FunctionExpression;
    textureFile?: { srgb: boolean };
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
    /**
     * The materialized asset an `asset` value was loaded from.
     * `selectVariant` needs it the way the pin's own setter reaches
     * `container.materialVariants`: through the object, not by name.
     */
    asset?: CompileAsset;
    engineCpp?: string;
    geometryTask?: GeometryOutputTaskManifest;
    /**
     * Set on a `render-texture` naming a task's depth attachment rather than
     * a colour one, which is what a render task's `depth` may bind.
     */
    isDepthTexture?: true;
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
     * The extra textures a custom-shader descriptor binds, as the native
     * expressions that build them, in binding order. They ride the
     * descriptor because that is what the layer or system is handed.
     */
    spriteCustomTextures?: string[];
    shaderVariant?: string;
    animationFrameRate?: string;
    animationDuration?: string;
    staticNumber?: number;
    staticString?: string;
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
        ts.Identifier | ts.ArrowFunction | ts.FunctionExpression
    >;
    /**
     * Record properties declared with `get`. The accessor is kept
     * rather than its value, so each read re-evaluates it.
     */
    recordGetters?: Record<
        string,
        ts.GetAccessorDeclaration
    >;
    /**
     * The scope chain in force where a record carrying methods or
     * getters was built. A record can outlive the scope its state
     * lives in -- a factory returns it, and the frame loop calls it --
     * so that scope travels with it and is restored while a method or
     * getter of the record runs. This is the closure the source wrote.
     */
    recordScopes?: ReadonlyArray<
        Map<ts.Symbol, { name: string; value: Value }>
    >;
    defaultRenderTask?: boolean;
    defaultRenderTaskEmitted?: boolean;
    browserValue?:
        | { kind: "boolean"; value: boolean }
        | { kind: "number"; value: number }
        | { kind: "null" }
        | { kind: "search-params" }
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
    | "loader:babylon"
    | "loader:gltf"
    | "loader:gltf-variants"
    | "material:pbr"
    | "material:clearcoat"
    | "material:sheen"
    | "material:sheen-albedo-scaling"
    | "material:clearcoat-f0-remap"
    | "material:iridescence"
    | "material:emissive"
    | "material:no-color-view"
    | "material:grid"
    | "material:node"
    | "material:shader"
    | "material:standard"
    | "material:standard-vertex-colors"
    | "mesh:box"
    | "mesh:from-data"
    | "mesh:ground"
    | "mesh:morph-targets"
    | "mesh:plane"
    | "mesh:sphere"
    | "mesh:thin-instances"
    | "mesh:thin-instances-dynamic"
    | "mesh:torus"
    | "scene:remove"
    | "sprite:2d"
    | "sprite:uv-scroll"
    | "sprite:custom-shader"
    | "texture:pixels"
    | "sprite:billboard"
    | "sprite:billboard-axis-locked"
    | "sprite:billboard-cutout"
    | "sprite:billboard-custom-shader"
    | "renderer:sprite"
    | "renderer:pbr"
    | "renderer:transmission"
    | "renderer:fog"
    | "renderer:geometry-output"
    | "renderer:post-process"
    | "background:image-skybox"
    | "background:solid-skybox";

export interface ResolvedCompileOptions {
    fileName: string;
    title: string;
    width: number;
    height: number;
}
