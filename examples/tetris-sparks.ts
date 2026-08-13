// Project-owned differential gate: the tetris demo's line-clear particle
// shader (lab/lite/src/demos/tetris/particles.ts) compiled as a
// scene-local shader variant from its own WGSL sources — the unlit
// vertex-color program with the worldViewProjection system uniform and
// the brightness custom uniform (declared default 1.6, set to the demo's
// 2.4 like TetrisParticles does). A seeded burst of tumbling cubes wears
// the demo piece colors through per-vertex colors; Math.random draws run
// under the pinned seeded contract so browser and native build the
// identical burst. The browser reference runs the identical TypeScript
// against the pinned package.

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createEngine,
    createMeshFromData,
    createSceneContext,
    createShaderMaterial,
    registerScene,
    setShaderFloat,
    startEngine,
} from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";
import {
    PIECE_COLORS,
} from "../corpus/babylon-lite/lab/lite/src/demos/tetris/pieces.js";

// The demo particle program, byte-for-byte from tetris/particles.ts.
const vertexSource = `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
};
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  out.color = input.color;
  return out;
}`;

const fragmentSource = `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
};
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(input.color.rgb * shaderUniforms.brightness, 1.0);
}`;

const CUBE_POS = new Float32Array([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
]);
const CUBE_IDX = new Uint32Array([
    0, 1, 2, 0, 2, 3, 1, 5, 6, 1, 6, 2, 5, 4, 7, 5, 7, 6, 4, 0, 3, 4, 3, 7, 3, 2, 6, 3, 6, 7, 4, 5, 1, 4, 1, 0,
]);

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
        { x: 0, y: 2, z: 0 },
    );
    attachControl(
        scene.camera as ArcRotateCamera,
        canvas,
        scene,
    );
    scene.clearColor = { r: 0.02, g: 0.024, b: 0.05, a: 1 };

    const material = createShaderMaterial({
        name: "tetrisParticles",
        vertexSource,
        fragmentSource,
        attributes: ["position", "color"],
        uniforms: [
            "worldViewProjection",
            { name: "brightness", type: "f32", defaultValue: 1.6 },
        ],
    });
    setShaderFloat(material, "brightness", 2.4);

    const normals = new Float32Array(24);

    // Seven frozen bursts, one per piece color, spread like cleared
    // cells: sixteen tumbling cubes each with seeded-random offsets,
    // sizes, and spins matching the demo's burst() distributions.
    for (let colorIndex = 0; colorIndex < 7; colorIndex++) {
        const color = PIECE_COLORS[colorIndex]!;
        const colors = new Float32Array(8 * 4);
        for (let vertex = 0; vertex < 8; vertex++) {
            colors[vertex * 4] = color[0];
            colors[vertex * 4 + 1] = color[1];
            colors[vertex * 4 + 2] = color[2];
            colors[vertex * 4 + 3] = 1;
        }
        const centerX = colorIndex - 3;
        const centerY = 1 + (colorIndex % 2) * 2.5;
        for (let index = 0; index < 16; index++) {
            const mesh = createMeshFromData(
                engine,
                "tetris_spark",
                CUBE_POS,
                normals,
                CUBE_IDX,
                undefined,
                undefined,
                undefined,
                colors,
            );
            mesh.material = material;
            const size = 0.14 + Math.random() * 0.16;
            const angle = Math.random() * Math.PI * 2;
            const speed = 0.6 + Math.random() * 0.8;
            mesh.position.set(
                centerX + Math.cos(angle) * speed,
                centerY + (Math.random() - 0.5) * 1.6,
                (Math.random() - 0.5) * 1.2,
            );
            mesh.scaling.set(size, size, size);
            mesh.rotation.set(
                (Math.random() - 0.5) * 3,
                (Math.random() - 0.5) * 3,
                (Math.random() - 0.5) * 3,
            );
            addToScene(scene, mesh);
        }
    }

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch((error) => console.error(error));
