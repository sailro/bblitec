import ts from "typescript";
import { reachPhysicsViewerMaterialProgram } from "./physics-viewer-material.js";
import {
    compileDdsEnvironmentBackgroundOptions,
    compileDdsEnvironmentOptions,
    compileEnvironmentOptions,
    compileHdrEnvironmentOptions,
    type AssetOptionContext,
} from "./intrinsics/asset-options.js";
import {
    compileCopyTaskOptions,
    compileGeometryTaskOptions,
    compileRenderTargetOptions,
    compileRenderTaskOptions,
    compileSceneDefaultRenderTask,
    type CompiledRenderTargetOptions,
    type EngineOptionContext,
} from "./intrinsics/engine-options.js";
import {
    compileAnisotropyOptions,
    compileClearCoatOptions,
    compileIridescenceOptions,
    compileMetallicReflectanceOptions,
    compilePbrMaterialOptions,
    compileSheenOptions,
    compileSubsurfaceOptions,
    type CompiledAnisotropyOptions,
    type CompiledClearCoatOptions,
    type CompiledIridescenceOptions,
    type CompiledMetallicReflectanceOptions,
    type CompiledPbrMaterialOptions,
    type CompiledSheenOptions,
    type CompiledSubsurfaceOptions,
    type MaterialOptionContext,
} from "./intrinsics/material-options.js";
import {
    compileBoxOptions,
    compileGroundFromHeightMapOptions,
    compileGroundOptions,
    compilePlaneOptions,
    compileSphereOptions,
    compileTorusOptions,
    type MeshOptionContext,
} from "./intrinsics/mesh-options.js";
import {
    PropertyAnimationTargetLowerer,
    compilePropertyAnimationClip,
    compilePropertyAnimationGroupOptions,
    type PropertyAnimationContext,
    type PropertyAnimationTargetContext,
} from "./property-animation.js";
import {
    compileNodeMaterialOptions,
    type CompiledNodeMaterialCall,
    type NodeMaterialContext,
} from "./node-material.js";
import {
    lineMaterialPermutation,
    reachLineMaterialProgram,
    type LineMaterialPermutation,
    type ReachedLineMaterial,
} from "./line-material.js";
import { reachLinearDepthMaterialProgram } from "./linear-depth-material.js";
import {
    reachGridMaterial,
    type ReachedGridMaterial,
} from "./grid-material.js";
import type { LinearDepthMaterialOptions } from "../lowering/linear-depth-lowerer.js";
import {
    compileShaderMaterialOptions,
    compileShaderUniformComponents,
    resolveShaderStorageBufferSlot,
    resolveShaderTextureSlot,
    resolveShaderUniform,
    type ShaderMaterialContext,
} from "./shader-material.js";
import type { GeometryOutputTaskManifest, Value } from "./types.js";

/** What the option adapters hand the per-intrinsic option lowerers. */
type IntrinsicOptionsContext = AssetOptionContext &
    EngineOptionContext &
    MaterialOptionContext &
    MeshOptionContext &
    NodeMaterialContext &
    PropertyAnimationContext &
    PropertyAnimationTargetContext &
    ShaderMaterialContext;

/**
 * The option objects of mesh, material, task, environment and animation intrinsics, and the shader
 * programs (grid, line, linear-depth, physics-viewer, node, shader material) they reach. Each
 * adapter delegates to its family's lowerer.
 */
export class IntrinsicOptions {
    constructor(private readonly context: IntrinsicOptionsContext) {}

    public compileBoxOptions(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): [string, string, string] {
        return compileBoxOptions(this.context, expression, precision);
    }

    public compileRenderTargetOptions(
        expression: ts.Expression,
    ): CompiledRenderTargetOptions {
        return compileRenderTargetOptions(this.context, expression);
    }

    public compileRenderTaskOptions(expression: ts.Expression): string {
        return compileRenderTaskOptions(this.context, expression);
    }

    public compileGeometryTaskOptions(expression: ts.Expression): {
        cpp: string;
        manifest: GeometryOutputTaskManifest;
    } {
        return compileGeometryTaskOptions(this.context, expression);
    }

    public compileCopyTaskOptions(expression: ts.Expression): string {
        return compileCopyTaskOptions(this.context, expression);
    }

    public compileGroundOptions(
        expression: ts.Expression,
    ): [string, string, string, string, string] {
        return compileGroundOptions(this.context, expression);
    }

    public compileGroundFromHeightMapOptions(
        expression: ts.Expression,
    ): [string, string, string, string, string, string, string] {
        return compileGroundFromHeightMapOptions(this.context, expression);
    }

    public compilePlaneOptions(expression: ts.Expression): [string, string] {
        return compilePlaneOptions(this.context, expression);
    }

    public compileSphereOptions(
        expression: ts.Expression,
    ): [string, string, string, string] {
        return compileSphereOptions(this.context, expression);
    }

    public compileTorusOptions(
        expression: ts.Expression,
    ): [string, string, string] {
        return compileTorusOptions(this.context, expression);
    }

    public compilePbrMaterialOptions(
        expression: ts.Expression,
    ): CompiledPbrMaterialOptions {
        return compilePbrMaterialOptions(this.context, expression);
    }

    public compileMetallicReflectanceOptions(
        expression: ts.Expression,
    ): CompiledMetallicReflectanceOptions {
        return compileMetallicReflectanceOptions(this.context, expression);
    }

    public reachGridMaterial(
        call: ts.CallExpression,
        options: ts.Expression | undefined,
    ): ReachedGridMaterial {
        return reachGridMaterial(this.context, call, options);
    }

    public compileClearCoatOptions(
        expression: ts.Expression,
    ): CompiledClearCoatOptions {
        return compileClearCoatOptions(this.context, expression);
    }

    public compileIridescenceOptions(
        expression: ts.Expression,
    ): CompiledIridescenceOptions {
        return compileIridescenceOptions(this.context, expression);
    }

    public compileAnisotropyOptions(
        expression: ts.Expression,
    ): CompiledAnisotropyOptions {
        return compileAnisotropyOptions(this.context, expression);
    }

    public compileSheenOptions(
        expression: ts.Expression,
    ): CompiledSheenOptions {
        return compileSheenOptions(this.context, expression);
    }

    public compileSubsurfaceOptions(
        expression: ts.Expression,
    ): CompiledSubsurfaceOptions {
        return compileSubsurfaceOptions(this.context, expression);
    }

    public compileShaderMaterialOptions(expression: ts.Expression): {
        name: string;
        id: number;
        dynamicUniforms?: Array<{
            offset: number;
            components: string[];
        }>;
    } {
        return compileShaderMaterialOptions(this.context, expression);
    }

    /**
     * Registers the shader variant a `createLineMaterial` (or the material a
     * `createLineSystem` builds for itself) composes. The program is folded
     * from the pin's own factory; what is decided here is only that this
     * scene reached it.
     */
    public reachLineMaterial(
        node: ts.Node,
        options: ReachedLineMaterial,
    ): { name: string; id: number } {
        return reachLineMaterialProgram(this.context, node, options);
    }

    public reachPhysicsViewerMaterial(
        node: ts.Node,
        color: readonly [number, number, number, number],
    ): { name: string; id: number } {
        return reachPhysicsViewerMaterialProgram(this.context, node, color);
    }

    public reachLinearDepthMaterial(
        node: ts.Node,
        options: LinearDepthMaterialOptions,
    ): { name: string; id: number } {
        return reachLinearDepthMaterialProgram(this.context, node, options);
    }

    /** What a registered line variant settled, by variant name. */
    public lineMaterialPermutation(
        name: string,
        node: ts.Node,
    ): LineMaterialPermutation | undefined {
        return lineMaterialPermutation(this.context, name, node);
    }

    public compileNodeMaterialOptions(
        snippetExpression: ts.Expression,
        optionsExpression: ts.Expression | undefined,
    ): CompiledNodeMaterialCall {
        return compileNodeMaterialOptions(
            this.context,
            snippetExpression,
            optionsExpression,
        );
    }

    public resolveShaderUniform(
        material: Value,
        nameExpression: ts.Expression,
        expectedCounts: number[],
    ): { offset: number; count: number } {
        return resolveShaderUniform(
            this.context,
            material,
            nameExpression,
            expectedCounts,
        );
    }

    public resolveShaderTextureSlot(
        material: Value,
        nameExpression: ts.Expression,
    ): number {
        return resolveShaderTextureSlot(this.context, material, nameExpression);
    }

    public resolveShaderStorageBufferSlot(
        material: Value,
        nameExpression: ts.Expression,
    ): number {
        return resolveShaderStorageBufferSlot(
            this.context,
            material,
            nameExpression,
        );
    }

    public compileShaderUniformComponents(
        expression: ts.Expression,
        count: number,
    ): string[] {
        return compileShaderUniformComponents(this.context, expression, count);
    }

    public compilePropertyAnimationClip(
        nameExpression: ts.Expression,
        tracksExpression: ts.Expression,
        optionsExpression: ts.Expression | undefined,
    ): {
        cpp: string;
        frameRate: string;
        duration: string;
        target: "mesh" | "camera" | "record";
        paths: readonly string[];
    } {
        return compilePropertyAnimationClip(
            this.context,
            nameExpression,
            tracksExpression,
            optionsExpression,
        );
    }

    private readonly propertyAnimationTargets =
        new PropertyAnimationTargetLowerer();

    public compilePropertyAnimationTargets(
        target: Value,
        paths: readonly string[],
        node: ts.Expression,
    ): { cpp: string; engineCpp: string } {
        return this.propertyAnimationTargets.compile(
            this.context,
            target,
            paths,
            node,
        );
    }

    public compilePropertyAnimationGroupOptions(
        expression: ts.Expression | undefined,
        clip: Value,
    ): string {
        return compilePropertyAnimationGroupOptions(
            this.context,
            expression,
            clip,
        );
    }

    public compileEnvironmentOptions(expression: ts.Expression): {
        groundTextureUrl: string;
        skyboxUrl: string;
        skyboxSize: string;
        brdfUrl: string;
        brdfPathCpp?: string;
        skipSkybox: boolean;
        skipGround: boolean;
    } {
        return compileEnvironmentOptions(this.context, expression);
    }

    public compileDdsEnvironmentOptions(expression: ts.Expression): string {
        return compileDdsEnvironmentOptions(this.context, expression);
    }

    public compileDdsEnvironmentBackgroundOptions(expression: ts.Expression): {
        groundTextureUrl: string;
        skyboxUrl: string;
        skyboxSize: string;
        enableNoise: boolean;
    } {
        return compileDdsEnvironmentBackgroundOptions(this.context, expression);
    }

    public compileSceneDefaultRenderTask(
        expression: ts.Expression | undefined,
    ): boolean {
        return compileSceneDefaultRenderTask(this.context, expression);
    }

    public compileHdrEnvironmentOptions(expression: ts.Expression): {
        faceSize: number;
        useCubemapSkybox: boolean;
        skipGround: boolean;
        skyboxSize: string;
        skyboxPosition: string;
    } {
        return compileHdrEnvironmentOptions(this.context, expression);
    }
}
