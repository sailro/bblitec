// Project-owned differential gate: shader materials selected by the members
// of an options record the caller names.
//
// One factory builds a shader material's sources and declarations from an
// options record. Each caller builds that record first -- a run-time boolean
// member, a member only some rows write, a boolean inside a nested record --
// and hands the factory its name. The native port compiles the call once per
// outcome of those members and selects the variant at run time; a uniform
// only some variants declare is then written through the returned material.

import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createEngine,
    createSceneContext,
    createShaderMaterial,
    registerScene,
    setShaderUniform,
    startEngine,
} from "@babylonjs/lite";
import type { ShaderMaterial } from "@babylonjs/lite";
import { SURFACE_VERTEX } from "./regression-option-surface.js";

interface SurfaceOptions {
    name: string;
    tint: [number, number, number];
    tall: boolean;
    glow?: { strength: number };
    tone: { warm: boolean };
}

function surface(opts: SurfaceOptions): ShaderMaterial {
    const vertexSource = SURFACE_VERTEX.replace("HEIGHT", opts.tall ? "1.6" : "0.8");
    const glow = opts.glow ? " + vec3<f32>(shaderUniforms.uGlow)" : "";
    let fragmentSource = `struct VertexOutput{@builtin(position) position:vec4<f32>,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{
    return vec4<f32>(shaderUniforms.uTint${glow}, 1.0);
}`;
    if (opts.tone.warm) fragmentSource = fragmentSource.replace("shaderUniforms.uTint", "shaderUniforms.uTint * vec3<f32>(1.6, 1.0, 0.6)");
    return createShaderMaterial({
        name: opts.name,
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

// Parsed rows: every member the factory specializes on is a run-time value.
const rows = JSON.parse(`[
    { "tall": true, "warm": true, "glow": null },
    { "tall": false, "warm": false, "glow": 0.1 },
    { "tall": true, "warm": false, "glow": 0.05 },
    { "tall": false, "warm": true, "glow": null }
]`) as { tall: boolean; warm: boolean; glow: number | null }[];
let index = 0;
for (const row of rows) {
    const options = {
        name: `member-selected-${index}`,
        tint: [0.2 + 0.1 * index, 0.25, 0.4 - 0.05 * index] as [number, number, number],
        tall: row.tall,
        tone: { warm: row.warm },
        ...(row.glow === null ? {} : { glow: { strength: row.glow } }),
    };
    const material = surface(options);
    // Only a glowing variant declares uGlow: the write names it on whichever
    // variant the material is.
    if (row.glow !== null) setShaderUniform(material, "uGlow", row.glow * 3);
    const box = createBox(engine, { size: 0.8 });
    box.position.x = index * 1.2 - 1.8;
    box.material = material;
    addToScene(scene, box);
    index++;
}
scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.4, 6, { x: 0, y: 0, z: 0 });
await registerScene(scene);
await startEngine(engine);
