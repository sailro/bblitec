import { compileComputeUniformArenaIntrinsic } from "./compute-uniform-arena.js";
import {
    compileProceduralSkyIntrinsic,
    type ProceduralSkyIntrinsicContext,
} from "./procedural-sky.js";
import { compileComputeUniformWriterIntrinsic } from "./compute-uniform-writer.js";
import { compileComputeBindingDeclIntrinsic } from "./compute-binding-decl.js";
import { compileComputeBindingsIntrinsic } from "./compute-bindings.js";
import { compileComputeOneShotIntrinsic } from "./compute-one-shot.js";
import { compileComputeDispatchIntrinsic } from "./compute-dispatch.js";
import { compileStorageReadbackIntrinsic } from "./storage-readback.js";
import {
    compileComputeShaderIntrinsic,
    type ComputeShaderIntrinsicContext,
} from "./compute-shader.js";
import { EmissionSet } from "../emission-transaction.js";
import ts from "typescript";
import { CompileError } from "../compile-error.js";
import { compileCharacterIntrinsic } from "./character-controller.js";
import {
    compileUniformBufferIntrinsic,
    type UniformBufferIntrinsicContext,
} from "./uniform-buffer.js";
import {
    compileComputeUniformIntrinsic,
    type ComputeUniformIntrinsicContext,
} from "./compute-uniform.js";
import {
    compileComputeTaskIntrinsic,
    type ComputeTaskIntrinsicContext,
} from "./compute-task.js";
import {
    compileAnimationIntrinsic,
    type AnimationIntrinsicContext,
} from "./animation.js";
import {
    compileAssetConstant,
    compileAssetIntrinsic,
    type AssetIntrinsicContext,
} from "./asset.js";
import {
    compileCameraIntrinsic,
    type CameraIntrinsicContext,
} from "./camera.js";
import {
    compileEngineIntrinsic,
    type EngineIntrinsicContext,
} from "./engine.js";
import { compileLightIntrinsic, type LightIntrinsicContext } from "./light.js";
import {
    compileClusteredLightIntrinsic,
    runtimeOnlyClusteredLightIntrinsics,
    type ClusteredLightIntrinsicContext,
} from "./clustered-light.js";
import {
    compileEffectIntrinsic,
    type EffectIntrinsicContext,
} from "./effect.js";
import { compileLineIntrinsic, type LineIntrinsicContext } from "./line.js";
import {
    compileMaterialConstant,
    compileMaterialIntrinsic,
    type MaterialIntrinsicContext,
} from "./material.js";
import {
    compileMeshIntrinsic,
    nativeMeshDataIntrinsics,
    type MeshIntrinsicContext,
} from "./mesh.js";
import {
    compilePickingIntrinsic,
    runtimeOnlyPickingIntrinsics,
    type PickingIntrinsicContext,
} from "./picking.js";
import { compileGizmoIntrinsic, type GizmoIntrinsicContext } from "./gizmo.js";
import {
    compileParticleIntrinsic,
    type ParticleIntrinsicContext,
} from "./particle.js";
import {
    compilePhysicsIntrinsic,
    type PhysicsIntrinsicContext,
} from "./physics.js";
import { compileSceneIntrinsic, type SceneIntrinsicContext } from "./scene.js";
import {
    compileSkeletonIntrinsic,
    type SkeletonIntrinsicContext,
} from "./skeleton.js";
import {
    compileShadowIntrinsic,
    type ShadowIntrinsicContext,
} from "./shadow.js";
import {
    compileSpriteConstant,
    compileSpriteIntrinsic,
    type SpriteIntrinsicContext,
} from "./sprite.js";
import {
    compileNavigationIntrinsic,
    type NavigationIntrinsicContext,
} from "./navigation.js";
import { compileAudioIntrinsic, type AudioIntrinsicContext } from "./audio.js";
import { compileVatIntrinsic, type VatIntrinsicContext } from "./vat.js";
import type { Value } from "../types.js";
import { compileTextIntrinsic, type TextIntrinsicContext } from "./text.js";
import {
    compileComputeTextureIntrinsic,
    type ComputeTextureIntrinsicContext,
} from "./compute-texture.js";

interface IntrinsicContext
    extends
        ProceduralSkyIntrinsicContext,
        AnimationIntrinsicContext,
        AssetIntrinsicContext,
        AudioIntrinsicContext,
        CameraIntrinsicContext,
        EngineIntrinsicContext,
        ComputeTextureIntrinsicContext,
        ComputeTaskIntrinsicContext,
        ComputeShaderIntrinsicContext,
        ComputeUniformIntrinsicContext,
        UniformBufferIntrinsicContext,
        ClusteredLightIntrinsicContext,
        LightIntrinsicContext,
        LineIntrinsicContext,
        MaterialIntrinsicContext,
        MeshIntrinsicContext,
        NavigationIntrinsicContext,
        ParticleIntrinsicContext,
        PhysicsIntrinsicContext,
        PickingIntrinsicContext,
        SceneIntrinsicContext,
        ShadowIntrinsicContext,
        SkeletonIntrinsicContext,
        SpriteIntrinsicContext,
        GizmoIntrinsicContext,
        VatIntrinsicContext,
        TextIntrinsicContext,
        EffectIntrinsicContext {}

/**
 * Intrinsics a large counted loop may call without being unrolled.
 *
 * `requiresStaticIteration` unrolls any loop whose body reaches the pinned
 * package, because lowering such a call usually records generation-owned
 * state -- a composed variant, a scene mesh slot, a materialized asset, a
 * baked simulation step -- and emitting the body once inside C++ would record
 * one of those for many run-time iterations.
 *
 * A family whose intrinsics record none says so in its own module, which is
 * where the reason for it lives; this composes what they declare.
 */
export const runtimeOnlyIntrinsics: ReadonlySet<string> = new EmissionSet([
    ...runtimeOnlyClusteredLightIntrinsics,
    ...runtimeOnlyPickingIntrinsics,
]);

/** Repeated data work still uses its normal lowerer to record stream facts. */
export const nativeDataIterationIntrinsics: ReadonlySet<string> =
    new EmissionSet([
        ...runtimeOnlyIntrinsics,
        ...nativeMeshDataIntrinsics,
        // These operations update native instances or closed bindings; their
        // ordinary lowerers still validate options and record reached features.
        "addSprite2DIndex",
        "addSprite2D",
        "updateSprite2DIndex",
        "updateSprite2D",
        "clearSprite2DLayer",
        "removeSprite2D",
        "createPhysicsAggregate",
        "setPhysicsShapeFilterMembershipMask",
        "createPhysicsBody",
        "createPhysicsShape",
        "setPhysicsBodyShape",
        "setParent",
        "markMeshDirty",
        "setMeshVisible",
        "setSubtreeVisible",
        "createStorageBuffer",
        "setShaderStorageBuffer",
        "updateStorageBuffer",
        "disposeStorageBuffer",
        "setShaderUniform",
        "setShaderFloat",
        "setShaderVector3",
        "setShaderTexture",
    ]);

/**
 * Operations on runtime handles a shared body lowers natively for every
 * caller. A closed loop still expands these statically to keep its facts.
 */
export const sharedBodyIntrinsics: ReadonlySet<string> = new EmissionSet([
    ...nativeDataIterationIntrinsics,
    "createTexture2DFromPixels",
    "getViewProjectionMatrix",
    "createPickingRay",
    "markMaterialUboDirty",
    "unlockAudioEngineAsync",
    "updateAnimationManager",
    "updateMeshPositions",
    "updateMeshUvs",
]);

type IntrinsicCompiler = (
    context: IntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
) => Value | undefined;

const intrinsicCompilers: readonly IntrinsicCompiler[] = [
    compileProceduralSkyIntrinsic,
    compileStorageReadbackIntrinsic,
    compileComputeDispatchIntrinsic,
    compileComputeShaderIntrinsic,
    compileComputeBindingDeclIntrinsic,
    compileComputeBindingsIntrinsic,
    compileComputeOneShotIntrinsic,
    compileUniformBufferIntrinsic,
    compileComputeUniformArenaIntrinsic,
    compileComputeUniformWriterIntrinsic,
    compileComputeUniformIntrinsic,
    compileComputeTaskIntrinsic,
    compileComputeTextureIntrinsic,
    compileTextIntrinsic,
    compileEngineIntrinsic,
    compileCameraIntrinsic,
    compileLightIntrinsic,
    compileClusteredLightIntrinsic,
    compileMeshIntrinsic,
    compileLineIntrinsic,
    compileSceneIntrinsic,
    compileShadowIntrinsic,
    compileSkeletonIntrinsic,
    compileAnimationIntrinsic,
    compileMaterialIntrinsic,
    compileAssetIntrinsic,
    compileSpriteIntrinsic,
    compileEffectIntrinsic,
    compileParticleIntrinsic,
    compilePhysicsIntrinsic,
    compileCharacterIntrinsic,
    compileNavigationIntrinsic,
    compileAudioIntrinsic,
    compilePickingIntrinsic,
    compileGizmoIntrinsic,
    compileVatIntrinsic,
];

export interface IntrinsicRoute {
    name: string;
    lowerer?: string;
    outcome: "accepted" | "refused" | "missing";
}
let routeObserver: ((route: IntrinsicRoute) => void) | undefined;

/** Tooling can distinguish a claimed name from an unregistered fallthrough. */
export function observeIntrinsicRouting(
    next: (route: IntrinsicRoute) => void,
): () => void {
    const previous = routeObserver;
    routeObserver = next;
    return () => {
        routeObserver = previous;
    };
}

/**
 * A pinned constant a scene imports by name. Same shape as the call
 * dispatch: each family answers for its own exports, and an unknown name
 * falls through to the ordinary variable lookup and its error.
 */
export function compileRegisteredConstant(
    importedName: string,
): Value | undefined {
    return (
        compileSpriteConstant(importedName) ??
        compileMaterialConstant(importedName) ??
        compileAssetConstant(importedName)
    );
}

export function compileRegisteredIntrinsic(
    context: IntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    for (const compile of intrinsicCompilers) {
        let value: Value | undefined;
        try {
            value = compile(context, importedName, call);
        } catch (error) {
            if (error instanceof CompileError)
                routeObserver?.({
                    name: importedName,
                    lowerer: compile.name,
                    outcome: "refused",
                });
            throw error;
        }
        if (value) {
            routeObserver?.({
                name: importedName,
                lowerer: compile.name,
                outcome: "accepted",
            });
            return value;
        }
    }
    routeObserver?.({ name: importedName, outcome: "missing" });
    return undefined;
}
