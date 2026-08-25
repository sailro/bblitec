import ts from "typescript";
import {
    compileAnimationIntrinsic,
    type AnimationIntrinsicContext,
} from "./animation.js";
import {
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
    compileSpriteConstant,
    compileSpriteIntrinsic,
    type SpriteIntrinsicContext,
} from "./sprite.js";
import {
    compileNavigationIntrinsic,
    type NavigationIntrinsicContext,
} from "./navigation.js";
import type { Value } from "../types.js";

export interface IntrinsicContext
    extends AnimationIntrinsicContext,
        AssetIntrinsicContext,
        CameraIntrinsicContext,
        EngineIntrinsicContext,
        LightIntrinsicContext,
        LineIntrinsicContext,
        MaterialIntrinsicContext,
        MeshIntrinsicContext,
        NavigationIntrinsicContext,
        ParticleIntrinsicContext,
        PhysicsIntrinsicContext,
        SceneIntrinsicContext,
        SpriteIntrinsicContext,
        EffectIntrinsicContext {}

type IntrinsicCompiler = (
    context: IntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
) => Value | undefined;

const intrinsicCompilers: readonly IntrinsicCompiler[] = [
    compileEngineIntrinsic,
    compileCameraIntrinsic,
    compileLightIntrinsic,
    compileMeshIntrinsic,
    compileLineIntrinsic,
    compileSceneIntrinsic,
    compileAnimationIntrinsic,
    compileMaterialIntrinsic,
    compileAssetIntrinsic,
    compileSpriteIntrinsic,
    compileEffectIntrinsic,
    compileParticleIntrinsic,
    compilePhysicsIntrinsic,
    compileNavigationIntrinsic,
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
        compileMaterialConstant(importedName);
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
