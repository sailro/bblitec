// Project-owned differential gate: the demo renderer's dynamic
// thin-instance mechanics (lab/lite/src/demos/tetris/renderer.ts sync)
// through the sanctioned update path. The pinned rules play a scripted
// game one action per frame inside onBeforeRender; every frame rewrites
// seven fixed-capacity per-color pools in place (degenerate matrices
// hiding unused slots) and flushes them with flushThinInstances, while
// the ghost landing preview varies its active count each frame through
// setThinInstanceCount. Every pool mesh carries a non-identity record
// transform, composing mesh.world with the instance matrices like the
// pinned thin-instance vertex fragment. The browser reference runs the
// identical TypeScript against the pinned package under the identical
// seeded Math.random stub.

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createDirectionalLight,
    createEngine,
    createHemisphericLight,
    createMeshFromData,
    createPbrMaterial,
    createSceneContext,
    createSolidTexture2D,
    flushThinInstances,
    onBeforeRender,
    registerScene,
    setThinInstanceCount,
    setThinInstances,
    startEngine,
} from "babylon-lite";
import type { ArcRotateCamera, Mesh } from "babylon-lite";
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
    type GameState,
} from "../corpus/babylon-lite/lab/lite/src/demos/tetris/game.js";
import {
    PIECE_COLORS,
    PIECE_ROTATIONS,
} from "../corpus/babylon-lite/lab/lite/src/demos/tetris/pieces.js";
import { createChamferedBoxData } from "../corpus/babylon-lite/lab/lite/src/demos/tetris/chamfered-box.js";

const BLOCK_SIZE = 0.92;
const MAX_INSTANCES = BOARD_COLS * BOARD_ROWS + 4;
const GHOST_INSTANCES = 4;

// The well sits off the origin so the composed record transform is
// visible in the golden: world = mesh.world (this translation) times
// each instance matrix.
const WELL_X = 0.5;
const WELL_Y = -0.5;

// One scripted action per frame, repeating the tetris-logic gate's
// 12-step sequence as a flat tape: 0 tick(120), 1 left, 2 right,
// 3 rotateCW, 4 rotateCCW, 5 softDrop, 6 hardDrop.
const STEP_ACTIONS: readonly number[] = [
    3, 1, 1, 0, 5, 2, 4, 0, 6, 2, 2, 2, 3, 6,
];
const STEP_FRAMES = 14;
const TOTAL_STEPS = 12;
const TAPE_FRAMES = STEP_FRAMES * TOTAL_STEPS;
const READY_FRAME = TAPE_FRAMES + 8;

function cellWorldX(col: number): number {
    return (BOARD_COLS - 1) / 2 - col;
}

function cellWorldY(row: number): number {
    return BOARD_ROWS - 1 - row;
}

// The demo renderer's uniform-scale instance matrix (column-major,
// translation in elements 12-14), written into the shared pool array
// like tetris/renderer.ts writeMatrix.
function writeMatrix(
    out: Float32Array,
    idx: number,
    x: number,
    y: number,
    z: number,
    s: number,
): void {
    const o = idx * 16;
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

// The demo renderer's hidden-slot matrix: zero scale collapses the
// block and the far-plane translation parks it, so unused fixed-pool
// slots draw nothing (tetris/renderer.ts writeHidden).
function writeHidden(out: Float32Array, idx: number): void {
    const o = idx * 16;
    out[o + 0] = 0;
    out[o + 1] = 0;
    out[o + 2] = 0;
    out[o + 3] = 0;
    out[o + 4] = 0;
    out[o + 5] = 0;
    out[o + 6] = 0;
    out[o + 7] = 0;
    out[o + 8] = 0;
    out[o + 9] = 0;
    out[o + 10] = 0;
    out[o + 11] = 0;
    out[o + 12] = 0;
    out[o + 13] = 10000000;
    out[o + 14] = 0;
    out[o + 15] = 1;
}

// Rebuild one color pool from the locked board plus the active piece,
// park the remaining slots, and flush the whole fixed-capacity pool —
// the demo renderer's per-frame sync for one color mesh.
function syncPool(
    mesh: Mesh,
    pool: Float32Array,
    color: number,
    game: GameState,
): void {
    let used = 0;
    for (let y = 0; y < BOARD_ROWS; y++) {
        for (let x = 0; x < BOARD_COLS; x++) {
            const value = game.board[y * BOARD_COLS + x]!;
            if (value - 1 === color) {
                writeMatrix(
                    pool,
                    used,
                    cellWorldX(x),
                    cellWorldY(y),
                    0,
                    BLOCK_SIZE,
                );
                used++;
            }
        }
    }
    if (game.active !== null && game.active.type === color) {
        const cells =
            PIECE_ROTATIONS[game.active.type]![
                game.active.rotation
            ]!;
        for (const [dx, dy] of cells) {
            const col = game.active.col + dx;
            const row = game.active.row + dy;
            if (row >= 0) {
                writeMatrix(
                    pool,
                    used,
                    cellWorldX(col),
                    cellWorldY(row),
                    0,
                    BLOCK_SIZE,
                );
                used++;
            }
        }
    }
    for (let index = used; index < MAX_INSTANCES; index++) {
        writeHidden(pool, index);
    }
    flushThinInstances(mesh);
}

async function main(): Promise<void> {
    const canvas = document.getElementById(
        "renderCanvas",
    ) as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    scene.camera = createArcRotateCamera(
        -Math.PI / 2,
        Math.PI / 2.35,
        30,
        {
            x: WELL_X,
            y:
                (cellWorldY(0) + cellWorldY(BOARD_ROWS - 1)) / 2 +
                WELL_Y,
            z: 0,
        },
    );
    attachControl(
        scene.camera as ArcRotateCamera,
        canvas,
        scene,
    );
    scene.clearColor = { r: 0.02, g: 0.024, b: 0.05, a: 1 };

    // The demo renderer's analytic rig: hemispheric floor lift plus the
    // directional key light.
    addToScene(
        scene,
        createHemisphericLight([0, 1, 0.25], 0.75),
    );
    addToScene(
        scene,
        createDirectionalLight([0.22, -0.5, -0.84], 1.4),
    );

    const chamfer = createChamferedBoxData(1, 0.08);
    const game = createGame();

    // Seven fixed-capacity pools, one chamfered-block mesh per piece
    // color, every record translated off the origin so the composed
    // parent world is part of the measurement.
    function createPool(color: number): Mesh {
        const mesh = createMeshFromData(
            engine,
            "tetris_pool",
            chamfer.positions,
            chamfer.normals,
            chamfer.indices,
            chamfer.uvs,
        );
        mesh.position.set(WELL_X, WELL_Y, 0);
        mesh.material = createPbrMaterial({
            baseColorTexture: createSolidTexture2D(
                engine,
                PIECE_COLORS[color]![0],
                PIECE_COLORS[color]![1],
                PIECE_COLORS[color]![2],
            ),
            ormTexture: createSolidTexture2D(
                engine,
                1.0,
                0.35,
                0.0,
            ),
            environmentIntensity: 0.45,
            directIntensity: 2.4,
            reflectance: 0.08,
        });
        addToScene(scene, mesh);
        return mesh;
    }

    const pool0 = createPool(0);
    const pool1 = createPool(1);
    const pool2 = createPool(2);
    const pool3 = createPool(3);
    const pool4 = createPool(4);
    const pool5 = createPool(5);
    const pool6 = createPool(6);
    const matrices0 = new Float32Array(16 * MAX_INSTANCES);
    const matrices1 = new Float32Array(16 * MAX_INSTANCES);
    const matrices2 = new Float32Array(16 * MAX_INSTANCES);
    const matrices3 = new Float32Array(16 * MAX_INSTANCES);
    const matrices4 = new Float32Array(16 * MAX_INSTANCES);
    const matrices5 = new Float32Array(16 * MAX_INSTANCES);
    const matrices6 = new Float32Array(16 * MAX_INSTANCES);
    for (let index = 0; index < MAX_INSTANCES; index++) {
        writeHidden(matrices0, index);
        writeHidden(matrices1, index);
        writeHidden(matrices2, index);
        writeHidden(matrices3, index);
        writeHidden(matrices4, index);
        writeHidden(matrices5, index);
        writeHidden(matrices6, index);
    }
    setThinInstances(pool0, matrices0, MAX_INSTANCES);
    setThinInstances(pool1, matrices1, MAX_INSTANCES);
    setThinInstances(pool2, matrices2, MAX_INSTANCES);
    setThinInstances(pool3, matrices3, MAX_INSTANCES);
    setThinInstances(pool4, matrices4, MAX_INSTANCES);
    setThinInstances(pool5, matrices5, MAX_INSTANCES);
    setThinInstances(pool6, matrices6, MAX_INSTANCES);

    // Ghost landing preview: one translucent pool whose ACTIVE COUNT
    // changes frame to frame through setThinInstanceCount while the
    // capacity (and GPU buffer) stays fixed.
    const ghost = createMeshFromData(
        engine,
        "tetris_ghost",
        chamfer.positions,
        chamfer.normals,
        chamfer.indices,
        chamfer.uvs,
    );
    ghost.position.set(WELL_X, WELL_Y, 0);
    ghost.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(
            engine,
            0.7,
            0.7,
            0.78,
        ),
        ormTexture: createSolidTexture2D(engine, 1.0, 0.55, 0.0),
        environmentIntensity: 0.5,
        directIntensity: 0.5,
        alpha: 0.3,
    });
    addToScene(scene, ghost);
    const ghostMatrices = new Float32Array(
        16 * GHOST_INSTANCES,
    );
    for (let index = 0; index < GHOST_INSTANCES; index++) {
        writeHidden(ghostMatrices, index);
    }
    setThinInstances(ghost, ghostMatrices, GHOST_INSTANCES);

    let frameIndex = 0;
    onBeforeRender(scene, () => {
        if (frameIndex < TAPE_FRAMES) {
            const action =
                STEP_ACTIONS[frameIndex % STEP_FRAMES]!;
            switch (action) {
                case 0:
                    tickGame(game, 120);
                    break;
                case 1:
                    moveLeft(game);
                    break;
                case 2:
                    moveRight(game);
                    break;
                case 3:
                    rotateCW(game);
                    break;
                case 4:
                    rotateCCW(game);
                    break;
                case 5:
                    softDrop(game);
                    break;
                case 6:
                    hardDrop(game);
                    break;
            }
        }

        syncPool(pool0, matrices0, 0, game);
        syncPool(pool1, matrices1, 1, game);
        syncPool(pool2, matrices2, 2, game);
        syncPool(pool3, matrices3, 3, game);
        syncPool(pool4, matrices4, 4, game);
        syncPool(pool5, matrices5, 5, game);
        syncPool(pool6, matrices6, 6, game);

        let ghostCount = 0;
        if (game.active !== null) {
            const landing = ghostRow(game);
            if (landing !== game.active.row) {
                const cells =
                    PIECE_ROTATIONS[game.active.type]![
                        game.active.rotation
                    ]!;
                for (const [dx, dy] of cells) {
                    const col = game.active.col + dx;
                    const row = landing + dy;
                    if (row >= 0) {
                        writeMatrix(
                            ghostMatrices,
                            ghostCount,
                            cellWorldX(col),
                            cellWorldY(row),
                            0,
                            0.4,
                        );
                        ghostCount++;
                    }
                }
            }
        }
        setThinInstanceCount(ghost, ghostCount);

        frameIndex++;
        if (frameIndex === READY_FRAME) {
            canvas.dataset.ready = "true";
        }
    });

    await registerScene(scene);
    await startEngine(engine);
}

main().catch((error) => console.error(error));
