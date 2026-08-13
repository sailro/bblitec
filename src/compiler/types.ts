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
    shaderVariants: ShaderMaterialVariantName[];
    geometryOutputTasks: GeometryOutputTaskManifest[];
    adaptations: CompileAdaptation[];
}

export interface CompileAsset {
    source: string;
    output: string;
    kind:
        | "babylon"
        | "environment"
        | "gltf"
        | "hdr-environment"
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
    | "point";

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
    | "camera-world-matrix"
    | "color4"
    | "data"
    | "engine"
    | "light"
    | "material"
    | "mesh"
    | "number"
    | "render-target"
    | "render-target-texture"
    | "render-texture"
    | "record"
    | "scene"
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
    callbackDeclaration?:
        | ts.ArrowFunction
        | ts.FunctionExpression;
    engineCpp?: string;
    geometryTask?: GeometryOutputTaskManifest;
    lightKind?: LightKind;
    shaderVariant?: ShaderMaterialVariantName;
    animationFrameRate?: string;
    animationDuration?: string;
    staticNumber?: number;
    staticString?: string;
    tupleElements?: Value[];
    recordProperties?: Record<string, Value>;
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
    | "environment:ibl"
    | "environment:env"
    | "environment:hdr"
    | "light:hemispheric"
    | "light:directional"
    | "light:point"
    | "loader:babylon"
    | "loader:gltf"
    | "material:pbr"
    | "material:no-color-view"
    | "material:grid"
    | "material:shader"
    | "material:standard"
    | "mesh:box"
    | "mesh:from-data"
    | "mesh:ground"
    | "mesh:plane"
    | "mesh:sphere"
    | "mesh:thin-instances"
    | "mesh:torus"
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
