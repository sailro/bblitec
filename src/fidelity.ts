export type FidelityRisk = "low" | "medium" | "high";

export interface CompileAdaptation {
    id: string;
    category:
        | "asset-materialization"
        | "async"
        | "browser-erasure"
        | "determinism"
        | "language"
        | "platform"
        | "rendering";
    sourceSemantics: string;
    nativeSemantics: string;
    risk: FidelityRisk;
    validation: string[];
}

export interface ShaderInvariant {
    id: string;
    upstreamModule: string;
    upstreamMarker: string;
    nativeBehavior: string;
    validation: string[];
}

export interface RendererFidelityManifest {
    sourceLanguage: "WGSL";
    emittedSources: Array<"HLSL" | "MSL">;
    compiledArtifacts: Array<"DXIL" | "SPIR-V">;
    bindingContract: {
        vertexUniformSpace: number;
        sampledTextureSpace: number;
        fragmentUniformSpace: number;
    };
    textureContract: {
        baseColor: "sRGB";
        emissive: "sRGB";
        normal: "linear";
        metallicRoughness: "linear";
        environment: "linear-rgba16f";
        brdfLut: "linear-rgba32f";
    };
    invariants: ShaderInvariant[];
}
