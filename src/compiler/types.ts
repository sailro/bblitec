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
    runtimeSources: string[];
    generatedSources: string[];
    assets: CompileAsset[];
    shaderVariants: string[];
    customShaderPrograms: CompiledShaderProgram[];
    geometryOutputTasks: GeometryOutputTaskManifest[];
    adaptations: CompileAdaptation[];
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

export interface CompileAsset {
    source: string;
    output: string;
    kind:
        | "babylon"
        | "dds-environment"
        | "environment"
        | "gltf"
        | "hdr-environment"
        // The one asset kind whose source is scene-adjacent TypeScript run at
        // compile time rather than a URL fetched and repacked: the pinned
        // sprite-atlas module draws its pixels with canvas2D.
        | "sprite-atlas"
        | "texture";
    faceSize?: number;
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
    engineCpp?: string;
    geometryTask?: GeometryOutputTaskManifest;
    lightKind?: LightKind;
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
    | "material:pbr"
    | "material:clearcoat"
    | "material:sheen"
    | "material:sheen-albedo-scaling"
    | "material:no-color-view"
    | "material:grid"
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
    | "renderer:sprite"
    | "renderer:pbr"
    | "renderer:transmission"
    | "renderer:fog"
    | "renderer:geometry-output"
    | "background:image-skybox";

export interface ResolvedCompileOptions {
    fileName: string;
    title: string;
    width: number;
    height: number;
}
