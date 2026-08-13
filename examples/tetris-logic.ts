// Project-owned differential gate: compiles the pinned Babylon Lite tetris
// rules (corpus demos/tetris/game.ts + pieces.ts) through the plain-data
// compiler subset, runs a scripted deterministic sequence under the seeded
// Math.random contract, and renders the resulting board as Standard-material
// boxes. The browser reference runs the identical TypeScript against the
// pinned package with the identical seeded Math.random stub.

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
    registerScene,
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
    previewCells,
    rotateCCW,
    rotateCW,
    softDrop,
    tickGame,
    togglePause,
} from "../corpus/babylon-lite/lab/lite/src/demos/tetris/game.js";
import {
    PIECE_COLORS,
    PIECE_ROTATIONS,
} from "../corpus/babylon-lite/lab/lite/src/demos/tetris/pieces.js";

const BLOCK_SIZE = 0.92;

function cellWorldX(col: number): number {
    return (BOARD_COLS - 1) / 2 - col;
}

function cellWorldY(row: number): number {
    return BOARD_ROWS - 1 - row;
}

async function main(): Promise<void> {
    const canvas = document.getElementById(
        "renderCanvas",
    ) as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // Scripted deterministic play: the seeded Math.random contract makes the
    // 7-bag draws identical in the browser reference and the native build,
    // so the final board is a pure function of this sequence.
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

    scene.camera = createArcRotateCamera(
        -Math.PI / 2,
        Math.PI / 2.35,
        30,
        { x: 0, y: (cellWorldY(0) + cellWorldY(BOARD_ROWS - 1)) / 2, z: 0 },
    );
    attachControl(
        scene.camera as ArcRotateCamera,
        canvas,
        scene,
    );
    scene.clearColor = { r: 0.02, g: 0.024, b: 0.05, a: 1 };

    addToScene(
        scene,
        createHemisphericLight([0, 1, 0.25], 0.55),
    );
    addToScene(
        scene,
        createDirectionalLight([0.25, -0.6, -0.75], 0.9),
    );

    // Locked board cells, one Standard-material box per occupied cell.
    for (let y = 0; y < BOARD_ROWS; y++) {
        for (let x = 0; x < BOARD_COLS; x++) {
            const value = game.board[y * BOARD_COLS + x]!;
            if (value !== 0) {
                const box = createBox(engine, BLOCK_SIZE);
                box.position.set(
                    cellWorldX(x),
                    cellWorldY(y),
                    0,
                );
                const material = createStandardMaterial();
                material.diffuseColor = [
                    PIECE_COLORS[value - 1]![0],
                    PIECE_COLORS[value - 1]![1],
                    PIECE_COLORS[value - 1]![2],
                ];
                box.material = material;
                addToScene(scene, box);
            }
        }
    }

    // Active piece plus its ghost landing preview (covers the object-spread
    // collision probe in ghostRow).
    if (game.active !== null) {
        const activeColor =
            PIECE_COLORS[game.active.type]!;
        const landing = ghostRow(game);
        const cells =
            PIECE_ROTATIONS[game.active.type]![
                game.active.rotation
            ]!;
        for (const [dx, dy] of cells) {
            const col = game.active.col + dx;
            const row = game.active.row + dy;
            if (row >= 0) {
                const box = createBox(engine, BLOCK_SIZE);
                box.position.set(
                    cellWorldX(col),
                    cellWorldY(row),
                    0,
                );
                const material = createStandardMaterial();
                material.diffuseColor = [
                    activeColor[0],
                    activeColor[1],
                    activeColor[2],
                ];
                box.material = material;
                addToScene(scene, box);
            }
            const ghostCellRow = landing + dy;
            if (
                ghostCellRow >= 0 &&
                landing !== game.active.row
            ) {
                const ghost = createBox(engine, 0.4);
                ghost.position.set(
                    cellWorldX(col),
                    cellWorldY(ghostCellRow),
                    0,
                );
                const ghostMaterial =
                    createStandardMaterial();
                ghostMaterial.diffuseColor = [
                    0.35, 0.35, 0.4,
                ];
                ghost.material = ghostMaterial;
                addToScene(scene, ghost);
            }
        }
    }

    // Next-piece preview column beside the board (span-returning helper and
    // tuple destructuring over its cells).
    const preview = previewCells(game.next);
    const previewColor = PIECE_COLORS[game.next]!;
    for (const [dx, dy] of preview) {
        const box = createBox(engine, 0.6);
        box.position.set(
            cellWorldX(BOARD_COLS + 2 - dx),
            cellWorldY(2 + dy),
            0,
        );
        const material = createStandardMaterial();
        material.diffuseColor = [
            previewColor[0],
            previewColor[1],
            previewColor[2],
        ];
        box.material = material;
        addToScene(scene, box);
    }

    // Cleared-line markers above the board, tinted by the snapshot colors the
    // rules recorded before shifting rows down (struct destructuring over the
    // pending queue plus nested vector reads).
    let clearedIndex = 0;
    for (const { row, colors } of game.pendingClears) {
        if (row >= 0) {
            for (let x = 0; x < BOARD_COLS; x++) {
                const colorValue = colors[x]!;
                if (colorValue !== 0) {
                    const marker = createBox(engine, 0.3);
                    marker.position.set(
                        cellWorldX(x),
                        cellWorldY(-2 - clearedIndex),
                        0,
                    );
                    const material =
                        createStandardMaterial();
                    material.diffuseColor = [
                        PIECE_COLORS[colorValue - 1]![0],
                        PIECE_COLORS[colorValue - 1]![1],
                        PIECE_COLORS[colorValue - 1]![2],
                    ];
                    marker.material = material;
                    addToScene(scene, marker);
                }
            }
        }
        clearedIndex++;
    }

    // Outcome-sound tally (enum tags over the drained rules queue): stack one
    // indicator box per queued sound left of the board, brightening for the
    // rarer events.
    let soundIndex = 0;
    for (const sound of game.pendingSounds) {
        const indicator = createBox(engine, 0.35);
        indicator.position.set(
            cellWorldX(-3),
            0.5 * soundIndex,
            0,
        );
        const material = createStandardMaterial();
        if (sound === "tetris") {
            material.diffuseColor = [1.0, 0.85, 0.2];
        } else if (sound === "clear") {
            material.diffuseColor = [0.3, 0.9, 0.5];
        } else if (sound === "levelUp") {
            material.diffuseColor = [0.9, 0.3, 0.8];
        } else {
            material.diffuseColor = [0.25, 0.3, 0.45];
        }
        indicator.material = material;
        addToScene(scene, indicator);
        soundIndex++;
    }

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch((error) => console.error(error));
