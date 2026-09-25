import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SceneDefinition } from "./scene-registry.js";
import { artifactDirectory } from "./tooling/artifacts.js";

/** An instrumented build with the source scene's pose and independent outputs. */
export function attributionScene(scene: SceneDefinition): SceneDefinition {
    if (!scene.parity)
        throw new Error(`Scene '${scene.id}' has no parity definition.`);
    const id = `${scene.id}-attribution`;
    const output = `generated/${id}`;
    const outputDirectory = artifactDirectory("parity-attribution", scene.id);
    return {
        ...scene,
        id,
        output,
        buildDirectory: `native/build-${id}-release`,
        parity: {
            ...scene.parity,
            outputDirectory,
            reference: {
                ...scene.parity.reference,
                path: join(outputDirectory, "reference.png"),
            },
            attribution: {
                specialization: `${output}/upstream/gltf-specialization.json`,
                drawIds: true,
                triangleClusters: true,
            },
        },
    };
}

/** Refresh diagnostic copies; recapture may replace only the twin's references. */
export function copyAttributionReferences(
    scene: SceneDefinition,
    twin: SceneDefinition,
): void {
    if (!scene.parity || !twin.parity)
        throw new Error("Attribution requires a parity definition.");
    const pairs = [
        [scene.parity.reference.path, twin.parity.reference.path],
        [
            artifactDirectory("parity-canvas", scene.id, "browser-canvas.png"),
            artifactDirectory("parity-canvas", twin.id, "browser-canvas.png"),
        ],
    ] as const;
    for (const [source, destination] of pairs) {
        if (!existsSync(source)) continue;
        mkdirSync(dirname(resolve(destination)), { recursive: true });
        copyFileSync(source, destination);
    }
}
