import {
    createEffectRenderer,
    createEffectWrapper,
    createEngine,
    createTexture3DFromPixels,
    registerEffectRenderer,
    setEffectTexture,
    startEngine,
} from "@babylonjs/lite";
import type { EngineContext, Texture3D } from "@babylonjs/lite";

// One fullscreen effect samples two Texture3D values through
// `viewDimension: "3d"` bindings. The left half looks its own colour up in a
// 2x2x2 identity cube through the default sampler (linear, clamp-to-edge),
// which returns the colour at half-texel-inset coordinates: the bottom
// quarter through binding 1, the top quarter through binding 4 holding the
// same texture. The right half shows a 3x2x4 volume through nearest
// filtering, one z slice per vertical band and one texel per cell, so texel
// (x, y, z) is (40 + 80x, 60 + 120y, 30 + 60z).
const FRAGMENT_WGSL = `@group(0) @binding(0) var cubeSampler:sampler;
@group(0) @binding(1) var cube:texture_3d<f32>;
@group(0) @binding(2) var volume:texture_3d<f32>;
@group(0) @binding(3) var volumeSampler:sampler;
@group(0) @binding(4) var cubeAgain:texture_3d<f32>;
@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4<f32>{
    let uv=clamp(input.uv,vec2<f32>(0.0),vec2<f32>(1.0));
    if(uv.x<0.5){
        let colour=vec3<f32>(uv.x*2.0,uv.y,0.25+0.5*uv.y);
        let uvw=(colour+0.5)/2.0;
        if(uv.y<0.5){return vec4<f32>(textureSampleLevel(cube,cubeSampler,uvw,0.0).rgb,1.0);}
        return vec4<f32>(textureSampleLevel(cubeAgain,cubeSampler,uvw,0.0).rgb,1.0);
    }
    let bands=(uv.x-0.5)*8.0;
    let uvw=vec3<f32>(fract(bands),uv.y,(floor(bands)+0.5)/4.0);
    return vec4<f32>(textureSampleLevel(volume,volumeSampler,uvw,0.0).rgb,1.0);
}`;

/** The 2x2x2 RGB-cube corners, x fastest, then y, then z. */
function identityCube(engine: EngineContext): Texture3D {
    const data = new Uint8Array(2 * 2 * 2 * 4);
    let offset = 0;
    for (let z = 0; z < 2; z++) {
        for (let y = 0; y < 2; y++) {
            for (let x = 0; x < 2; x++) {
                data[offset++] = x * 255;
                data[offset++] = y * 255;
                data[offset++] = z * 255;
                data[offset++] = 255;
            }
        }
    }
    return createTexture3DFromPixels(engine, data, 2, 2, 2);
}

function texelVolume(engine: EngineContext): Texture3D {
    const data = new Uint8Array(3 * 2 * 4 * 4);
    let offset = 0;
    for (let z = 0; z < 4; z++) {
        for (let y = 0; y < 2; y++) {
            for (let x = 0; x < 3; x++) {
                data[offset++] = 40 + 80 * x;
                data[offset++] = 60 + 120 * y;
                data[offset++] = 30 + 60 * z;
                data[offset++] = 255;
            }
        }
    }
    return createTexture3DFromPixels(engine, data, 3, 2, 4, { filter: "nearest" });
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const effect = createEffectWrapper(engine, {
        name: "effect-texture-3d",
        fragmentWGSL: FRAGMENT_WGSL,
        bindings: [
            { binding: 0, kind: "sampler", textureBinding: 1 },
            { name: "cube", binding: 1, kind: "texture", viewDimension: "3d" },
            { binding: 2, kind: "texture", textureSampleType: "float", viewDimension: "3d" },
            { binding: 3, kind: "sampler", samplerType: "filtering", textureBinding: "2" },
            { binding: 4, kind: "texture", viewDimension: "3d" },
        ],
    });
    const textures = new Map<string, Texture3D>();
    textures.set("cube", identityCube(engine));
    textures.set("volume", texelVolume(engine));
    const cube = textures.get("cube");
    const volume = textures.get("volume");
    if (!cube || !volume) throw new Error("effect-texture-3d: missing texture");
    setEffectTexture(effect, "cube", cube);
    setEffectTexture(effect, 2, volume);
    setEffectTexture(effect, "4", cube);
    registerEffectRenderer(
        createEffectRenderer(engine, effect, { name: "effect-texture-3d", clear: true }),
    );
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch((error) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) canvas.dataset.error = String(error);
});
