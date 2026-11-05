// Project-owned differential gate: shader materials composed from run-time
// options.
//
// One factory builds a shader material's sources and declarations from an
// options record whose fields are run-time values -- a boolean, an optional
// boolean and an optional object -- read from parsed data. The native port
// compiles the call once per outcome of those fields and selects the variant
// at run time; each box shows one combination.

import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createEngine,
    createSceneContext,
    createShaderMaterial,
    registerScene,
    startEngine,
} from "@babylonjs/lite";
import type { EngineContext, ShaderMaterial } from "@babylonjs/lite";

interface SurfaceOptions {
    tint: [number, number, number];
    bright?: boolean;
    glow?: { strength: number };
    tall: boolean;
}

const VERTEX = `struct VertexOutput{@builtin(position) position:vec4<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{
    var out:VertexOutput;
    out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position * vec3<f32>(1.0, HEIGHT, 1.0), 1.0);
    return out;
}`;

function surface(engine: EngineContext, name: string, opts: SurfaceOptions): ShaderMaterial {
    void engine;
    const vertexSource = VERTEX.replace("HEIGHT", opts.tall ? "1.6" : "0.8");
    const glow = opts.glow ? " + vec3<f32>(shaderUniforms.uGlow)" : "";
    let fragmentSource = `struct VertexOutput{@builtin(position) position:vec4<f32>,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{
    return vec4<f32>(shaderUniforms.uTint${glow}, 1.0);
}`;
    if (opts.bright) fragmentSource = fragmentSource.replace("shaderUniforms.uTint", "shaderUniforms.uTint * 2.0");
    return createShaderMaterial({
        name,
        vertexSource,
        fragmentSource,
        attributes: ["position"],
        uniforms: [
            "worldViewProjection",
            { name: "uTint", type: "vec3<f32>", defaultValue: opts.tint },
            ...(opts.glow ? [{ name: "uGlow", type: "f32" as const, defaultValue: opts.glow.strength }] : []),
        ],
        backFaceCulling: false,
    });
}

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = await createEngine(canvas);
const scene = createSceneContext(engine);
scene.clearColor = { r: 0.1, g: 0.1, b: 0.15, a: 1 };

// Parsed rows: every field the factory specializes on is a run-time value.
const rows = JSON.parse(`[
    { "tall": true, "bright": true, "glow": null },
    { "tall": false, "bright": null, "glow": 0.3 },
    { "tall": true, "bright": false, "glow": 0.1 },
    { "tall": false, "bright": null, "glow": null }
]`) as { tall: boolean; bright: boolean | null; glow: number | null }[];
let index = 0;
for (const row of rows) {
    const bright = row.bright === null ? undefined : row.bright;
    const glow = row.glow === null ? undefined : { strength: row.glow };
    const tall = row.tall;
    const box = createBox(engine, { size: 0.8 });
    box.position.x = index * 1.2 - 1.8;
    box.material = surface(engine, `case-split-${index}`, {
        tint: [0.2 + 0.1 * index, 0.25, 0.4 - 0.05 * index],
        bright,
        glow,
        tall,
    });
    addToScene(scene, box);
    index++;
}
scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.4, 6, { x: 0, y: 0, z: 0 });
await registerScene(scene);
await startEngine(engine);
