// Stage-2 capstone: the tetris demo's board, drawn the way the demo's own
// renderer draws it (lab/lite/src/demos/tetris/renderer.ts) at a fixed game
// state. The pinned rules play the scripted seeded sequence, then the locked
// board and the ghost preview are written into per-colour thin-instance
// pools wearing the demo's PBR recipes under its studio IBL: the blurred
// skybox box, the dark backboard, the glossy emissive chips, and the
// translucent ghost.
//
// Not ported: the stone frame ring (`loadGeometryFromUrl` is outside the
// subset) and the "pets" style (its geometry is fetched at runtime).

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createDirectionalLight,
    createEngine,
    createHemisphericLight,
    createMeshFromData,
    createPbrMaterial,
    createSceneContext,
    createSolidTexture2D,
    flushThinInstances,
    loadEnvironment,
    onBeforeRender,
    registerScene,
    setPbrEmissive,
    setPbrSkybox,
    setThinInstances,
    startEngine,
} from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";
import {
    BOARD_COLS,
    BOARD_ROWS,
    createGame,
    ghostRow,
    hardDrop,
    moveLeft,
    moveRight,
    rotateCCW,
    rotateCW,
    softDrop,
    tickGame,
    togglePause,
} from "../corpus/babylon-lite/lab/lite/src/demos/tetris/game.js";
import { PIECE_ROTATIONS } from "../corpus/babylon-lite/lab/lite/src/demos/tetris/pieces.js";
import { createChamferedBoxData } from "../corpus/babylon-lite/lab/lite/src/demos/tetris/chamfered-box.js";

const BLOCK_SIZE = 0.92;
/** 200 board cells + 4 active-piece cells, the demo's bound. */
const MAX_INSTANCES = 204;
const GHOST_INSTANCES = 4;
const COLORS = 7;
const READY_FRAME = 6;

/** The demo's punchy block palette, in I,O,T,S,Z,J,L order. */
const ARCADE_COLORS: readonly (readonly [
    number,
    number,
    number,
])[] = [
    [0.95, 0.24, 0.52],
    [0.9, 0.9, 0.95],
    [0.98, 0.5, 0.24],
    [0.93, 0.16, 0.14],
    [1.0, 0.8, 0.12],
    [0.22, 0.34, 0.95],
    [0.13, 0.8, 0.38],
];

/** Cell to world, mirroring the col axis exactly as the demo does. */
function cellWorldX(col: number): number {
    return (BOARD_COLS - 1) / 2 - col;
}
function cellWorldY(row: number): number {
    return BOARD_ROWS - 1 - row;
}

/** The demo's writeMatrix: a uniform-scale translation, column-major. */
function writeMatrix(
    out: Float32Array,
    index: number,
    x: number,
    y: number,
    z: number,
    s: number,
): void {
    const o = index * 16;
    out[o + 0] = s;
    out[o + 1] = 0;
    out[o + 2] = 0;
    out[o + 3] = 0;
    out[o + 4] = 0;
    out[o + 5] = s;
    out[o + 6] = 0;
    out[o + 7] = 0;
    out[o + 8] = 0;
    out[o + 9] = 0;
    out[o + 10] = s;
    out[o + 11] = 0;
    out[o + 12] = x;
    out[o + 13] = y;
    out[o + 14] = z;
    out[o + 15] = 1;
}

/** The demo's degenerate slot: scale 0 renders nothing. */
function writeHidden(
    out: Float32Array,
    index: number,
): void {
    writeMatrix(out, index, 0, 0, 0, 0);
}

async function main(): Promise<void> {
    const canvas = document.getElementById(
        "renderCanvas",
    ) as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // The environment drives IBL only: the visible backdrop is the
    // blurred skybox box below, and the well has its own floor.
    await loadEnvironment(
        scene,
        "/textures/environment.env",
        {
            brdfUrl: "/brdf-lut.png",
            skipSkybox: true,
            skipGround: true,
        },
    );

    const wellCenterY =
        (cellWorldY(0) + cellWorldY(BOARD_ROWS - 1)) / 2;
    scene.camera = createArcRotateCamera(
        Math.PI / 2 + 0.04,
        Math.PI / 2,
        30,
        { x: 0, y: wellCenterY, z: 0 },
    );
    scene.camera.nearPlane = 0.5;
    scene.camera.farPlane = 400;
    attachControl(
        scene.camera as ArcRotateCamera,
        canvas,
        scene,
    );
    // Only viewport pixels the skybox misses show this.
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    // A camera-centred PBR box in skybox mode samples the IBL along the
    // view ray, blurred by its own roughness.
    const skybox = createBox(engine, (400 - 0.5) / 2);
    skybox.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(
            engine,
            1,
            1,
            1,
        ),
        ormTexture: createSolidTexture2D(
            engine,
            1.0,
            0.45,
            1.0,
        ),
        environmentIntensity: 1.0,
        directIntensity: 0,
        doubleSided: true,
    });
    setPbrSkybox(skybox.material);
    skybox.position.set(0, wellCenterY, -30);
    addToScene(scene, skybox);

    // IBL carries reflections and ambient; a low hemi lifts the floor and
    // a strong key sits behind-and-above the resting camera.
    addToScene(
        scene,
        createHemisphericLight([0, 1, 0.25], 0.75),
    );
    addToScene(
        scene,
        createDirectionalLight([0.22, -0.5, -0.84], 2.2),
    );

    // The PBR pipeline always binds a base-colour texture, so the
    // untinted surfaces share one 1x1 white one.
    const whiteTex = createSolidTexture2D(
        engine,
        1.0,
        1.0,
        1.0,
    );

    // Backboard: dark and slightly glossy so the chips read against an
    // even surface instead of the busy skybox.
    const back = createBox(engine, 1);
    back.material = createPbrMaterial({
        // The demo tints a white texture with `baseColorFactor`; that
        // option is not in the subset yet, and a solid texture of the
        // same colour drives the identical base-colour input.
        baseColorTexture: createSolidTexture2D(
            engine,
            0.018,
            0.02,
            0.028,
        ),
        ormTexture: createSolidTexture2D(
            engine,
            1.0,
            0.42,
            0.0,
        ),
        environmentIntensity: 0.7,
        directIntensity: 0.45,
        reflectance: 0.06,
    });
    back.scaling.set(
        BOARD_COLS + 1.6,
        BOARD_ROWS + 1.6,
        0.4,
    );
    back.position.set(0, wellCenterY, -0.7);
    addToScene(scene, back);

    // The pinned chamfered generator supplies the "arcade" block.
    const chamfer = createChamferedBoxData(BLOCK_SIZE);

    // The ghost preview: translucent, unsaturated, double-sided.
    const ghostMat = createPbrMaterial({
        baseColorTexture: whiteTex,
        ormTexture: createSolidTexture2D(
            engine,
            1.0,
            0.55,
            0.0,
        ),
        environmentIntensity: 0.5,
        directIntensity: 0.5,
        alpha: 0.3,
        doubleSided: true,
    });

    // Scripted deterministic play: the seeded Math.random contract makes
    // the 7-bag draws identical in the browser and the native build, so
    // the board below is a pure function of this sequence.
    const game = createGame();
    togglePause(game);
    togglePause(game);
    for (let step = 0; step < 12; step++) {
        rotateCW(game);
        moveLeft(game);
        moveLeft(game);
        tickGame(game, 120);
        softDrop(game);
        moveRight(game);
        rotateCCW(game);
        tickGame(game, 120);
        hardDrop(game);
        moveRight(game);
        moveRight(game);
        moveRight(game);
        rotateCW(game);
        hardDrop(game);
    }

    // One thin-instanced chamfered mesh per piece colour, plus a matching
    // ghost mesh, exactly as the demo's buildRenderSet wires them.
    for (let color = 0; color < COLORS; color++) {
        const rgb = ARCADE_COLORS[color]!;
        const solid = createPbrMaterial({
            baseColorTexture: createSolidTexture2D(
                engine,
                rgb[0],
                rgb[1],
                rgb[2],
            ),
            ormTexture: createSolidTexture2D(
                engine,
                1.0,
                0.22,
                0.0,
            ),
            environmentIntensity: 0.45,
            directIntensity: 2.4,
            reflectance: 0.08,
        });
        // A slice of the body colour as emissive lifts each chip off the
        // dark stage instead of letting the IBL grey it out.
        setPbrEmissive(solid, [
            rgb[0] * 0.35,
            rgb[1] * 0.35,
            rgb[2] * 0.35,
        ]);

        const mesh = createMeshFromData(
            engine,
            `tetris_box_${color}`,
            chamfer.positions,
            chamfer.normals,
            chamfer.indices,
            chamfer.uvs,
        );
        mesh.material = solid;
        const matrices = new Float32Array(
            16 * MAX_INSTANCES,
        );

        // Locked cells of this colour, then the active piece's cells.
        let used = 0;
        for (let y = 0; y < BOARD_ROWS; y++) {
            for (let x = 0; x < BOARD_COLS; x++) {
                const value =
                    game.board[y * BOARD_COLS + x]!;
                if (value === color + 1) {
                    writeMatrix(
                        matrices,
                        used,
                        cellWorldX(x),
                        cellWorldY(y),
                        0,
                        1,
                    );
                    used++;
                }
            }
        }
        const active = game.active;
        if (active !== null && active.type === color) {
            const cells =
                PIECE_ROTATIONS[active.type]![
                    active.rotation
                ]!;
            for (let i = 0; i < cells.length; i++) {
                const cell = cells[i]!;
                const cy = active.row + cell[1];
                if (cy >= 0) {
                    writeMatrix(
                        matrices,
                        used,
                        cellWorldX(active.col + cell[0]),
                        cellWorldY(cy),
                        0,
                        1,
                    );
                    used++;
                }
            }
        }
        // Unused slots stay degenerate so the fixed-capacity draw call
        // never has to be re-recorded.
        for (let i = used; i < MAX_INSTANCES; i++) {
            writeHidden(matrices, i);
        }
        setThinInstances(mesh, matrices, MAX_INSTANCES);
        flushThinInstances(mesh);
        addToScene(scene, mesh);

        const ghost = createMeshFromData(
            engine,
            `tetris_box_ghost_${color}`,
            chamfer.positions,
            chamfer.normals,
            chamfer.indices,
            chamfer.uvs,
        );
        ghost.material = ghostMat;
        const ghostMatrices = new Float32Array(
            16 * GHOST_INSTANCES,
        );
        let ghostUsed = 0;
        // The demo hides the ghost when it coincides with the piece,
        // and when the game is over or paused.
        if (
            active !== null &&
            active.type === color &&
            !game.over &&
            !game.paused
        ) {
            const landing = ghostRow(game);
            if (landing !== active.row) {
                const cells =
                    PIECE_ROTATIONS[active.type]![
                        active.rotation
                    ]!;
                for (let i = 0; i < cells.length; i++) {
                    const cell = cells[i]!;
                    const cy = landing + cell[1];
                    if (cy >= 0) {
                        writeMatrix(
                            ghostMatrices,
                            ghostUsed,
                            cellWorldX(
                                active.col + cell[0],
                            ),
                            cellWorldY(cy),
                            0,
                            1,
                        );
                        ghostUsed++;
                    }
                }
            }
        }
        for (
            let i = ghostUsed;
            i < GHOST_INSTANCES;
            i++
        ) {
            writeHidden(ghostMatrices, i);
        }
        setThinInstances(
            ghost,
            ghostMatrices,
            GHOST_INSTANCES,
        );
        flushThinInstances(ghost);
        addToScene(scene, ghost);
    }

    let frame = 0;
    onBeforeRender(scene, () => {
        frame++;
        if (frame === READY_FRAME) {
            canvas.dataset.ready = "true";
        }
    });

    await registerScene(scene);
    await startEngine(engine);
}

main().catch((error) => console.error(error));
