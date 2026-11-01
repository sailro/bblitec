import type {
    FrameGraph,
    Mesh,
    SceneContext,
    SceneContextOptions,
} from "@babylonjs/lite";
import type { LoweringContext } from "../src/lowering/context.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { pinnedDeclaration } from "./pinned-source.js";

/**
 * The pin's scene with the internal members tests read. The package's
 * `.d.ts` strips `@internal` members, so these restate the pin's
 * `SceneContext` (`src/scene/scene-core.ts`), with open element types for
 * the inert stand-ins tests store.
 */
export interface PinnedScene<SceneMesh extends object = Mesh> extends Omit<
    SceneContext,
    "meshes"
> {
    meshes: SceneMesh[];
    _beforeRender: ((deltaMs: number) => void)[];
    _disposables: (() => void)[];
    _renderables: object[];
    _renderableVersion: number;
    _groups: Map<object, object>;
    _frameGraph: FrameGraph & { _tasks: object[] };
}

/**
 * A scene from the pin's own `createSceneContext`. Without the default render
 * task it reads only `surface.engine`, so no GPU is needed. `built` runs the
 * pin's `buildScene` as registration does. The pin creates `meshes` empty,
 * so a test names the stand-in mesh type it adds.
 */
export async function createPinnedScene<SceneMesh extends object = Mesh>(
    surface: { readonly engine: object } = { engine: {} },
    options: { built?: boolean } = {},
): Promise<PinnedScene<SceneMesh>> {
    const { createSceneContext, buildScene } = await importPinnedModule<{
        createSceneContext<Created extends object>(
            this: void,
            surface: object,
            options: SceneContextOptions,
        ): PinnedScene<Created>;
        buildScene(this: void, scene: object): Promise<void>;
    }>("scene/scene-core.js");
    const scene = createSceneContext<SceneMesh>(surface, {
        defaultRenderTask: false,
    });
    if (options.built) await buildScene(scene);
    return scene;
}

/**
 * The pin's `createSceneContext`, its frame graph and its camera sync, for a
 * source oracle to call as `createSceneContext({engine}, {defaultRenderTask:
 * false})`. An oracle that runs the scene's update declares
 * `processMaterialSwaps` itself.
 */
export function sceneContextSource(context: LoweringContext): string {
    return (
        [
            ["src/scene/scene-core.ts", "createSceneContext"],
            ["src/scene/scene-core.ts", "syncCameraFloatingOrigin"],
            ["src/frame-graph/frame-graph.ts", "createFrameGraph"],
            ["src/frame-graph/frame-graph.ts", "recordTask"],
        ] as const
    )
        .map(([module, name]) => pinnedDeclaration(context, module, name))
        .join("\n");
}
