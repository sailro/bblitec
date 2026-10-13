// Project-owned differential gate: runtime RGBA8 writes into
// createTexture2DFromPixels textures through updateTexture2DFromPixels.
//
//   * Explicit regions written before the first frame: blocks, a row and a
//     column of an 8x8 texture sampled by a shader material and, through a
//     second binding, a Standard material.
//   * The defaulted forms: a full-texture write from the data alone, from x,
//     from x and y, and a full-height column from x, y and width.
//   * Writes issued by the frame callback land before that frame's draws: a
//     row rewritten and a cursor texel written over it every frame, so the
//     capture shows the captured frame's own cursor; the same pair on a
//     billboard custom shader's extra texture.

import {
    addBillboardSpriteIndex,
    addFacingBillboardSystem,
    addToScene,
    createArcRotateCamera,
    createBillboardCustomShader,
    createEngine,
    createFacingBillboardSystem,
    createGridSpriteAtlas,
    createPlane,
    createSceneContext,
    createShaderMaterial,
    createStandardMaterial,
    createTexture2DFromPixels,
    onBeforeRender,
    registerScene,
    setShaderTexture,
    startEngine,
    updateTexture2DFromPixels,
    wgsl,
} from "babylon-lite";
import type { EngineContext, SceneContext, Texture2D } from "babylon-lite";

type Rgba = readonly [number, number, number, number];

const PANEL_SIZE = 2.2;
const COLUMN_STEP = 2.6;
const ROW_STEP = 1.3;
const CURSOR_ROW = 3;

const RED: Rgba = [230, 40, 40, 255];
const GREEN: Rgba = [40, 210, 70, 255];
const BLUE: Rgba = [50, 90, 240, 255];
const YELLOW: Rgba = [240, 220, 40, 255];
const WHITE: Rgba = [250, 250, 250, 255];
const MAGENTA: Rgba = [235, 40, 220, 255];
const ORANGE: Rgba = [250, 140, 30, 255];
const CYAN: Rgba = [40, 220, 230, 255];
const ROW_BASE: Rgba = [20, 24, 36, 255];

const VERTEX = wgsl`struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  out.uv = input.uv;
  return out;
}`;
const FRAGMENT = wgsl`struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32>, };
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
  return textureSample(textureSampler, textureSamplerSampler, input.uv);
}`;

/** `width * height` texels of one colour. */
function solid(width: number, height: number, colour: Rgba): Uint8Array {
    const data = new Uint8Array(width * height * 4);
    for (let texel = 0; texel < width * height; texel++) {
        for (let channel = 0; channel < 4; channel++) {
            data[texel * 4 + channel] = colour[channel]!;
        }
    }
    return data;
}

/** A square texture's distinct per-texel pattern, shifted by `seed`. */
function gradient(size: number, seed: number): Uint8Array {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const offset = (y * size + x) * 4;
            data[offset] = (x * 60 + seed) % 256;
            data[offset + 1] = (y * 60 + seed * 3) % 256;
            data[offset + 2] = ((x + y) * 30 + 90) % 256;
            data[offset + 3] = 255;
        }
    }
    return data;
}

/** Two-tone checker so every written region shows its edges. */
function checker(size: number): Uint8Array {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const offset = (y * size + x) * 4;
            const light = (x + y) % 2 === 0;
            data[offset] = light ? 70 : 40;
            data[offset + 1] = light ? 76 : 44;
            data[offset + 2] = light ? 96 : 60;
            data[offset + 3] = 255;
        }
    }
    return data;
}

function shaderPanel(
    engine: EngineContext,
    scene: SceneContext,
    name: string,
    texture: Texture2D,
    column: number,
    row: number,
): void {
    const material = createShaderMaterial({
        name,
        vertexSource: VERTEX,
        fragmentSource: FRAGMENT,
        attributes: ["position", "uv"],
        uniforms: ["worldViewProjection"],
        samplers: ["textureSampler"],
        backFaceCulling: false,
    });
    setShaderTexture(material, "textureSampler", texture);
    const plane = createPlane(engine, { width: PANEL_SIZE, height: PANEL_SIZE });
    plane.material = material;
    plane.position.set(column * COLUMN_STEP, row * ROW_STEP, 0);
    addToScene(scene, plane);
}

function standardPanel(
    engine: EngineContext,
    scene: SceneContext,
    texture: Texture2D,
    column: number,
    row: number,
): void {
    const material = createStandardMaterial();
    material.disableLighting = true;
    material.diffuseColor = [1, 1, 1];
    material.emissiveColor = [1, 1, 1];
    material.diffuseTexture = texture;
    const plane = createPlane(engine, { width: PANEL_SIZE, height: PANEL_SIZE });
    plane.material = material;
    plane.position.set(column * COLUMN_STEP, row * ROW_STEP, 0);
    addToScene(scene, plane);
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.05, g: 0.06, b: 0.09, a: 1 };
    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 8, { x: 0, y: 0, z: 0 });

    // Explicit regions before the first frame; the cursor row is rewritten
    // every frame below.
    const blocks = createTexture2DFromPixels(engine, checker(8), 8, 8);
    updateTexture2DFromPixels(engine, blocks, solid(2, 2, RED), 0, 0, 2, 2);
    updateTexture2DFromPixels(engine, blocks, solid(3, 1, GREEN), 5, 1, 3, 1);
    updateTexture2DFromPixels(engine, blocks, solid(1, 4, BLUE), 2, 4, 1, 4);
    updateTexture2DFromPixels(engine, blocks, solid(2, 2, YELLOW), 5, 5, 2, 2);
    shaderPanel(engine, scene, "region-blocks", blocks, -1, 1);
    standardPanel(engine, scene, blocks, 1, -1);

    // The data alone writes the whole texture; x, y and width leave the
    // height to default to the texture's.
    const full = createTexture2DFromPixels(engine, solid(4, 4, ROW_BASE), 4, 4);
    updateTexture2DFromPixels(engine, full, gradient(4, 0));
    updateTexture2DFromPixels(engine, full, solid(1, 4, WHITE), 3, 0, 1);
    shaderPanel(engine, scene, "region-full", full, 0, 1);

    // Written only from the frame callback: x alone, then a block over it.
    const fromX = createTexture2DFromPixels(engine, solid(4, 4, ROW_BASE), 4, 4);
    standardPanel(engine, scene, fromX, 1, 1);

    // Written only from the frame callback: x and y, then a column.
    const fromXY = createTexture2DFromPixels(engine, solid(4, 4, ROW_BASE), 4, 4);
    shaderPanel(engine, scene, "region-from-xy", fromXY, -1, -1);

    // A billboard custom shader showing its extra texture across the quad.
    const white = createTexture2DFromPixels(engine, solid(2, 2, WHITE), 2, 2);
    const atlas = createGridSpriteAtlas(white, { cellWidthPx: 2, cellHeightPx: 2 });
    const palette = createTexture2DFromPixels(engine, gradient(4, 200), 4, 4);
    const customShader = createBillboardCustomShader({
        fragment: `let texel = textureSample(atlasTex, atlasSamp, in.uv);
let pal = textureSample(paletteTex, paletteSamp, in.uv);
return vec4<f32>(pal.rgb, texel.a);`,
        extraTextures: [{ name: "palette", texture: palette }],
    });
    const billboards = createFacingBillboardSystem(atlas, { capacity: 1, customShader });
    addBillboardSpriteIndex(billboards, {
        position: [0, -ROW_STEP, 0],
        sizeWorld: [PANEL_SIZE, PANEL_SIZE],
        frame: 0,
        color: [1, 1, 1, 1],
    });
    addFacingBillboardSystem(scene, billboards);

    const rowBase = solid(8, 1, ROW_BASE);
    const cursor = solid(1, 1, MAGENTA);
    const paletteBase = gradient(4, 40);
    const paletteMark = solid(2, 2, CYAN);
    let frame = 0;
    onBeforeRender(scene, () => {
        frame++;
        // Two writes per frame into the same texels: the later one wins and
        // both land before this frame's draws.
        updateTexture2DFromPixels(engine, blocks, rowBase, 0, CURSOR_ROW, 8, 1);
        updateTexture2DFromPixels(engine, blocks, cursor, frame % 8, CURSOR_ROW, 1, 1);
        updateTexture2DFromPixels(engine, palette, paletteBase);
        updateTexture2DFromPixels(engine, palette, paletteMark, frame % 3, 1, 2, 2);
        if (frame === 2) updateTexture2DFromPixels(engine, fromX, gradient(4, 80), 0);
        if (frame === 4) updateTexture2DFromPixels(engine, fromX, solid(2, 2, ORANGE), 1, 1, 2, 2);
        if (frame === 3) updateTexture2DFromPixels(engine, fromXY, gradient(4, 160), 0, 0);
        if (frame === 5) updateTexture2DFromPixels(engine, fromXY, solid(1, 4, CYAN), 1, 0, 1);
    });

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
