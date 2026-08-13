// Project-owned differential gate: the tetris demo renderer's block-style
// switch (lab/lite/src/demos/tetris/renderer.ts). Three render sets are
// keyed by the demo's own `TetrisMode` union in a `Record`, and the active
// one is chosen at runtime by a tag the frame loop moves. Every set sits in
// the SAME place, so exactly one is ever visible: if the tag selected the
// wrong slot, the picture would show a different set outright.

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createDirectionalLight,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    createStandardMaterial,
    onBeforeRender,
    registerScene,
    startEngine,
} from "babylon-lite";
import type { ArcRotateCamera, Mesh } from "babylon-lite";
import {
    PIECE_COLORS,
} from "../corpus/babylon-lite/lab/lite/src/demos/tetris/pieces.js";

/** The demo's block style, cycled at runtime through the renderer. */
type TetrisMode = "pets" | "arcade" | "smooth";

/** The demo's per-style render set, trimmed to what this gate renders:
 *  one mesh per piece colour plus the per-instance uniform scale. */
interface RenderSet {
    colorMeshes: Mesh[];
    scale: number;
}

const COLORS = 7;
const SWITCH_TO_ARCADE = 10;
const SWITCH_TO_SMOOTH = 20;
const READY_FRAME = 30;

async function main(): Promise<void> {
    const canvas = document.getElementById(
        "renderCanvas",
    ) as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    scene.camera = createArcRotateCamera(
        -Math.PI / 2,
        Math.PI / 2.3,
        16,
        { x: 0, y: 0, z: 0 },
    );
    attachControl(
        scene.camera as ArcRotateCamera,
        canvas,
        scene,
    );
    scene.clearColor = { r: 0.02, g: 0.024, b: 0.05, a: 1 };

    addToScene(
        scene,
        createHemisphericLight([0, 1, 0.25], 0.75),
    );
    addToScene(
        scene,
        createDirectionalLight([0.22, -0.5, -0.84], 1.4),
    );

    // One row of boxes per style. Every row occupies the same cells, so
    // the visible row is entirely decided by which slot the tag picks.
    function buildRow(tint: number): Mesh[] {
        const colorMeshes: Mesh[] = [];
        for (let color = 0; color < COLORS; color++) {
            const mesh = createBox(engine, 1);
            const material = createStandardMaterial();
            const rgb = PIECE_COLORS[color]!;
            material.diffuseColor = [
                rgb[0] * tint,
                rgb[1] * tint,
                rgb[2] * tint,
            ];
            mesh.material = material;
            mesh.position.set(color - 3, 0, 0);
            mesh.scaling.set(0, 0, 0);
            addToScene(scene, mesh);
            colorMeshes.push(mesh);
        }
        return colorMeshes;
    }

    // Written out of tag order on purpose. The union's members are
    // numbered alphabetically, so the slots are reordered on the way in
    // for `sets[mode]` to land on the value written under that key —
    // while the rows are still built in the order written here, which
    // is the order their meshes enter the scene.
    const sets: Record<TetrisMode, RenderSet> = {
        pets: { colorMeshes: buildRow(1.0), scale: 1.0 },
        arcade: { colorMeshes: buildRow(0.55), scale: 0.6 },
        smooth: { colorMeshes: buildRow(0.8), scale: 0.85 },
    };

    /** Park every mesh of a set at scale 0, hiding it. */
    function hideSet(set: RenderSet): void {
        for (
            let index = 0;
            index < set.colorMeshes.length;
            index++
        ) {
            set.colorMeshes[index]!.scaling.set(0, 0, 0);
        }
    }

    /** Show every mesh of a set at its own uniform scale. */
    function showSet(set: RenderSet): void {
        for (
            let index = 0;
            index < set.colorMeshes.length;
            index++
        ) {
            set.colorMeshes[index]!.scaling.set(
                set.scale,
                set.scale,
                set.scale,
            );
        }
    }

    // The marker reports what the renderer says its mode is: its height
    // comes from the getter, so a getter reading the wrong mode moves it.
    const marker = createBox(engine, 1);
    const markerMaterial = createStandardMaterial();
    markerMaterial.diffuseColor = [0.9, 0.9, 0.95];
    marker.material = markerMaterial;
    marker.scaling.set(0.25, 0.25, 0.25);
    addToScene(scene, marker);

    /** The demo renderer's public shape (renderer.ts `TetrisRenderer`). */
    interface TetrisRenderer {
        setMode(mode: TetrisMode): void;
        toggleMode(): void;
        readonly mode: TetrisMode;
    }

    function createRenderer(): TetrisRenderer {
        let currentMode: TetrisMode = "pets";
        showSet(sets[currentMode]);

        function setMode(mode: TetrisMode): void {
            hideSet(sets[currentMode]);
            currentMode = mode;
            showSet(sets[currentMode]);
        }

        // pets → arcade → smooth → pets, the demo's MODE_CYCLE order.
        // Written as a chain because `Array.indexOf` is not in the
        // subset yet.
        function toggleMode(): void {
            if (currentMode === "pets") {
                setMode("arcade");
                return;
            }
            if (currentMode === "arcade") {
                setMode("smooth");
                return;
            }
            setMode("pets");
        }

        return {
            setMode,
            toggleMode,
            get mode() {
                return currentMode;
            },
        };
    }

    const renderer = createRenderer();

    let frame = 0;
    onBeforeRender(scene, () => {
        // The style changes mid-flight, so the index is a value the
        // frame loop moves rather than anything foldable at compile time.
        if (frame === SWITCH_TO_ARCADE) {
            renderer.toggleMode();
        }
        if (frame === SWITCH_TO_SMOOTH) {
            renderer.toggleMode();
        }
        marker.position.set(
            0,
            2 + sets[renderer.mode].scale,
            0,
        );

        frame++;
        if (frame === READY_FRAME) {
            canvas.dataset.ready = "true";
        }
    });

    await registerScene(scene);
    await startEngine(engine);
}

main().catch((error) => console.error(error));
