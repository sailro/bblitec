import type ts from "typescript";
import { sharedPinnedContext } from "../lowering/context.js";
import { physicsViewerMaterialProgram } from "../lowering/physics-viewer-material.js";
import {
    reachFoldedShaderProgram,
    type ShaderMaterialContext,
} from "./shader-material.js";

export function reachPhysicsViewerMaterialProgram(
    context: ShaderMaterialContext,
    node: ts.Node,
    color: readonly [number, number, number, number],
): { name: string; id: number } {
    return reachFoldedShaderProgram(
        context,
        node,
        `physics-debug-lines-${color.join("-")}`,
        "physics debug line",
        () => physicsViewerMaterialProgram(sharedPinnedContext(), color),
    );
}
