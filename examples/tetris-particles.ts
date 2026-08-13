// Project-owned differential gate: the tetris demo's particle system
// (lab/lite/src/demos/tetris/particles.ts TetrisParticles) in its own
// class shape — private fields, a constructor, and command methods. Each live
// particle is a struct holding its MESH HANDLE alongside its velocity,
// spin, size, and remaining life; the list is a dynamic array of those
// structs. Every frame the sweep integrates gravity, writes the mesh
// transforms through the struct's handle, and retires expired particles
// by removing the mesh from the scene and splicing the entry out of the
// list — the demo's exact reverse-iteration removal.

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
    removeFromScene,
    startEngine,
} from "babylon-lite";
import type {
    ArcRotateCamera,
    EngineContext,
    Mesh,
    SceneContext,
} from "babylon-lite";
import {
    PIECE_COLORS,
} from "../corpus/babylon-lite/lab/lite/src/demos/tetris/pieces.js";

// The demo's particle record, mesh handle included.
interface Particle {
    mesh: Mesh;
    px: number;
    py: number;
    pz: number;
    vx: number;
    vy: number;
    vz: number;
    spin: number;
    angle: number;
    life: number;
    maxLife: number;
    size: number;
}


const GRAVITY = 2.0;
const STEP = 1 / 60;
const SETTLE_FRAME = 30;
const READY_FRAME = 40;

/** The demo's particle system: private state, a constructor that captures
 *  the engine and scene, and command methods that own the burst and the
 *  per-frame sweep (lab/lite/src/demos/tetris/particles.ts). */
class TetrisParticles {
    private readonly engine: EngineContext;
    private readonly scene: SceneContext;
    private readonly live: Particle[] = [];
    private counter = 0;

    constructor(engine: EngineContext, scene: SceneContext) {
        this.engine = engine;
        this.scene = scene;
    }

    /** Spawn one burst at a cell, tinted by the piece color. */
    burst(color: number, count = 4): void {
        for (let index = 0; index < count; index++) {
            const mesh = createBox(this.engine, 1);
            const size = 0.35 + Math.random() * 0.25;
            const angle = Math.random() * Math.PI * 2;
            const speed = 0.5 + Math.random() * 0.8;
            mesh.position.set(color - 3, 1.5, 0);
            mesh.scaling.set(size, size, size);
            const material = createStandardMaterial();
            const tint = PIECE_COLORS[color]!;
            material.diffuseColor = [tint[0], tint[1], tint[2]];
            mesh.material = material;
            addToScene(this.scene, mesh);
            // The mesh handle travels into the data model here.
            this.live.push({
                mesh,
                px: color - 3,
                py: 1.5,
                pz: 0,
                angle: 0,
                vx: Math.cos(angle) * speed,
                vy: 0.4 + Math.random() * 0.9,
                vz: Math.sin(angle) * speed * 0.3,
                spin: (Math.random() - 0.5) * 2.5,
                life: 0.15 + Math.random() * 0.9,
                maxLife: 1.05,
                size,
            });
            this.counter++;
        }
    }

    /** Integrate every live particle and retire the expired ones. */
    update(dt: number): void {
        for (let index = this.live.length - 1; index >= 0; index--) {
            const p = this.live[index]!;
            p.life -= dt;
            if (p.life <= 0) {
                removeFromScene(this.scene, p.mesh);
                this.live.splice(index, 1);
                continue;
            }
            p.vy -= GRAVITY * dt;
            p.px += p.vx * dt;
            p.py += p.vy * dt;
            p.pz += p.vz * dt;
            p.angle += p.spin * dt;
            p.mesh.position.set(p.px, p.py, p.pz);
            p.mesh.rotation.set(p.angle, 0, p.angle);
            const remaining = p.life / p.maxLife;
            const scale = p.size * (0.55 + 0.45 * remaining);
            p.mesh.scaling.set(scale, scale, scale);
        }
    }
}

async function main(): Promise<void> {
    const canvas = document.getElementById(
        "renderCanvas",
    ) as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    scene.camera = createArcRotateCamera(
        -Math.PI / 2,
        Math.PI / 2.3,
        14,
        { x: 0, y: 1, z: 0 },
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

    const particles = new TetrisParticles(engine, scene);
    for (let color = 0; color < 7; color++) {
        particles.burst(color);
    }

    let frame = 0;
    onBeforeRender(scene, () => {
        // The sweep is the class method now.
        if (frame < SETTLE_FRAME) {
            particles.update(STEP);
        }

        frame++;
        if (frame === READY_FRAME) {
            canvas.dataset.ready = "true";
        }
    });

    await registerScene(scene);
    await startEngine(engine);
}

main().catch((error) => console.error(error));
