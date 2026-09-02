import ts from "typescript";
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
import {
    compileLightIntrinsic,
    type LightIntrinsicContext,
} from "./light.js";
import {
    compileClusteredLightIntrinsic,
    runtimeOnlyClusteredLightIntrinsics,
    type ClusteredLightIntrinsicContext,
} from "./clustered-light.js";
import {
    compileEffectIntrinsic,
    type EffectIntrinsicContext,
} from "./effect.js";
import {
    compileLineIntrinsic,
    type LineIntrinsicContext,
} from "./line.js";
import {
    compileMaterialConstant,
    compileMaterialIntrinsic,
    type MaterialIntrinsicContext,
} from "./material.js";
import {
    compileMeshIntrinsic,
    type MeshIntrinsicContext,
} from "./mesh.js";
import {
    compilePickingIntrinsic,
    type PickingIntrinsicContext,
} from "./picking.js";
import {
    compileGizmoIntrinsic,
    type GizmoIntrinsicContext,
} from "./gizmo.js";
import {
    compileParticleIntrinsic,
    type ParticleIntrinsicContext,
} from "./particle.js";
import {
    compilePhysicsIntrinsic,
    type PhysicsIntrinsicContext,
} from "./physics.js";
import {
    compileSceneIntrinsic,
    type SceneIntrinsicContext,
} from "./scene.js";
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
import {
    compileAudioIntrinsic,
    type AudioIntrinsicContext,
} from "./audio.js";
import type { Value } from "../types.js";

export interface IntrinsicContext
    extends AnimationIntrinsicContext,
        AssetIntrinsicContext,
        AudioIntrinsicContext,
        CameraIntrinsicContext,
        EngineIntrinsicContext,
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
export const runtimeOnlyIntrinsics: ReadonlySet<string> = new Set([
    ...runtimeOnlyClusteredLightIntrinsics,
]);

type IntrinsicCompiler = (
    context: IntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
) => Value | undefined;

const intrinsicCompilers: readonly IntrinsicCompiler[] = [
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
    compileNavigationIntrinsic,
    compileAudioIntrinsic,
    compilePickingIntrinsic,
    compileGizmoIntrinsic,
];

/**
 * A pinned constant a scene imports by name. Same shape as the call
 * dispatch: each family answers for its own exports, and an unknown name
 * falls through to the ordinary variable lookup and its error.
 */
export function compileRegisteredConstant(
    importedName: string,
): Value | undefined {
    return compileSpriteConstant(importedName) ??
        compileMaterialConstant(importedName) ??
        compileAssetConstant(importedName);
}

export function compileRegisteredIntrinsic(
    context: IntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    for (const compile of intrinsicCompilers) {
        const value = compile(
            context,
            importedName,
            call,
        );
        if (value) {
            return value;
        }
    }
    return undefined;
}
