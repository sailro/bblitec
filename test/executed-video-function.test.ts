import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { loadedFunctions } from "./fixture-functions.js";
import {
    bakeExecutedVideoFunction,
    decodeExecutedVideoBake,
    executedVideoFunctionShape,
    type ExecutedVideoFunctionShape,
} from "../src/compiler/executed-video-function.js";
import { parseDataUrl } from "../src/data-url.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerShaderExternalTextures } from "../src/lowering/shader-external-texture.js";
import { composeStandaloneWgsl } from "../src/shader-material-programs.js";
import { lowerWgslShaderProgram } from "../src/shader-ir.js";
import { emitNativeWgslProgram } from "../src/shader-wgsl-emitter.js";

/**
 * A video a scene produces in the browser and samples through a
 * ShaderMaterial external texture. The producer is a media pipeline this
 * port does not have, so it runs at generation: the bake imports each video
 * through WebGPU as the binding does and packages the texels, and measures
 * what each returned method does to the video's readyState.
 */

const vertexSource = `struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.position = vec4<f32>(input.position.xy, 0.0, 1.0);
    out.uv = input.uv;
    return out;
}`;

const fragmentSource = `struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
    return textureSampleBaseClampToEdge(frame, frameSampler, input.uv) * tint[0];
}`;

function compileScene(body: string): ReturnType<typeof compileSource> {
    return compileSource(
        `
        import {
            addToScene, createArcRotateCamera, createEngine, createExternalTexture,
            createPlane, createSceneContext, createShaderMaterial, isExternalTextureReady,
            registerScene, setShaderExternalTexture, startEngine,
        } from "@babylonjs/lite";
        import { createStillVideo } from "./fixtures/executed-video/producers.js";
        const vertexSource = ${JSON.stringify(vertexSource)};
        const fragmentSource = ${JSON.stringify(fragmentSource.replace(" * tint[0]", ""))};
        async function main(): Promise<void> {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 4, { x: 0, y: 0, z: 0 });
            const material = createShaderMaterial({
                vertexSource,
                fragmentSource,
                attributes: ["position", "uv"],
                externalTextures: ["frame"],
            });
            const plane = createPlane(engine, { width: 2, height: 2 });
            plane.material = material;
            addToScene(scene, plane);
            ${body}
        }
        void main();
        `,
        { fileName: "test/executed-video.ts" },
    );
}

/** The fixture producers' shapes, by name, through a real program. */
function producers(): {
    shape(this: void, name: string): ExecutedVideoFunctionShape | undefined;
} {
    const { checker, declaration } = loadedFunctions(
        'import * as fixture from "./fixtures/executed-video/producers.js";\n' +
            "export const used = fixture;\n",
        "test/executed-video-shape.ts",
    );
    return {
        shape: (name) =>
            executedVideoFunctionShape(
                checker,
                declaration("fixtures/executed-video/producers.ts", name),
            ),
    };
}

test("accepts a closed video producer, declines other functions and refuses what one run cannot describe", () => {
    const { shape } = producers();
    assert.deepEqual(
        { ...shape("createStillVideo"), sourceFile: undefined },
        {
            name: "createStillVideo",
            sourceFile: undefined,
            member: "video",
            method: "dispose",
        },
    );
    // A parameter or no video element: an ordinary local call.
    assert.equal(shape("createSizedVideo"), undefined);
    assert.equal(shape("createNoVideo"), undefined);
    // A producer whose result one run cannot describe refuses at its call.
    assert.match(
        shape("createVideoWithAccessor")!.refusal!,
        /returns accessors or spreads/,
    );
    assert.match(
        shape("createVideoWithTwoMethods")!.refusal!,
        /one synchronous, parameterless method/,
    );
    assert.match(
        shape("createVideoReachingDocument")!.refusal!,
        /method 'show' reaches 'document'/,
    );
});

test("decodes a bake and refuses one it cannot package", () => {
    const shape = producers().shape("createStillVideo")!;
    const frame = Buffer.alloc(2 * 2 * 4, 7).toString("base64");
    const valid = {
        video: { readyState: 4, width: 2, height: 2, frame },
        readyState: 0,
    };
    const decoded = decodeExecutedVideoBake(shape, JSON.stringify(valid));
    assert.equal(decoded.video.frame.length, 16);
    assert.equal(decoded.methodReadyState, 0);

    const refuses = (payload: unknown, pattern: RegExp): void =>
        assert.throws(
            () => decodeExecutedVideoBake(shape, JSON.stringify(payload)),
            pattern,
        );
    refuses(
        { ...valid, video: { ...valid.video, width: 3 } },
        /a 3x2 frame carried 16 bytes/,
    );
    refuses(
        { video: valid.video },
        /method 'dispose' has no measured readyState/,
    );
    refuses(
        { ...valid, video: { readyState: 1, width: 2, height: 2 } },
        /carries no frame/,
    );

    // The driver is handed the source's member and method; its answer is decoded.
    let asked: unknown;
    const baked = bakeExecutedVideoFunction(shape, process.cwd(), (input) => {
        asked = [input.member, input.method];
        return JSON.stringify(valid);
    });
    assert.deepEqual(asked, ["video", "dispose"]);
    assert.equal(baked.methodReadyState, 0);
});

test("packages the imported frame and lowers the producer's method to its measured state", () => {
    const compile = () =>
        compileScene(`
            const still = await createStillVideo();
            const texture = createExternalTexture(still.video);
            setShaderExternalTexture(material, "frame", texture);
            await registerScene(scene);
            await startEngine(engine);
            if (isExternalTextureReady(texture)) still.dispose();
        `);
    const result = compile();
    assert.ok(
        result.manifest.features.includes("material:shader-external-texture"),
    );
    assert.match(
        result.cpp,
        /bbl::create_baked_video\(bbl::asset_path\("[^"]+"\), 4u, 4u, 4\)/,
    );
    assert.match(result.cpp, /->ready_state = 0; \}/);
    assert.match(result.cpp, /bbl::set_shader_external_texture\(/);
    assert.match(result.cpp, /bbl::is_external_texture_ready\(/);

    // The browser's import of a black-and-white still: the black quadrant
    // stays dark and the white one bright through its video encoding.
    const [asset] = result.manifest.assets;
    assert.ok(asset);
    const payload = parseDataUrl(result.assetPayloads.get(asset.source)!);
    assert.ok(payload);
    assert.equal(payload.bytes.length, 4 * 4 * 4);
    // An import is opaque; a capture that never wrote reads back zero alpha.
    for (let alpha = 3; alpha < payload.bytes.length; alpha += 4)
        assert.equal(payload.bytes[alpha], 255);
    assert.ok(payload.bytes[0]! < 16, `black texel read ${payload.bytes[0]}`);
    assert.ok(
        payload.bytes[(3 * 4 + 3) * 4]! > 239,
        `white texel read ${payload.bytes[(3 * 4 + 3) * 4]}`,
    );

    // The bake re-runs (the caches are off under the test runner) and must
    // reproduce the generated program and texels exactly.
    const again = compile();
    assert.equal(again.cpp, result.cpp);
    assert.equal(
        again.assetPayloads.get(again.manifest.assets[0]!.source),
        result.assetPayloads.get(asset.source),
    );
});

test("lowers a producer that returns its video itself", () => {
    const result = compileSource(
        `import { createExternalTexture } from "@babylonjs/lite";
        import { createBareVideo } from "./fixtures/executed-video/producers.js";
        async function main(): Promise<void> {
            createExternalTexture(await createBareVideo());
        }
        void main();`,
        { fileName: "test/executed-video.ts" },
    );
    assert.match(
        result.cpp,
        /const bbl::VideoHandle (\w+) = bbl::create_baked_video\([^;]*4u, 4u, 4\);[\s\S]*bbl::create_external_texture\(\1\)/,
    );
});

test("binds an external texture before the engine starts, by a declared name, from a reproducible producer", () => {
    assert.throws(
        () =>
            compileScene(`setShaderExternalTexture(material, "other", null);`),
        /declares no external texture 'other'/,
    );
    // Registration uploads nothing; the engine's first frame does.
    assert.match(
        compileScene(`
            await registerScene(scene);
            setShaderExternalTexture(material, "frame", null);
        `).cpp,
        /bbl::set_shader_external_texture\(/,
    );
    assert.throws(
        () =>
            compileScene(`
                await registerScene(scene);
                await startEngine(engine);
                setShaderExternalTexture(material, "frame", null);
            `),
        /before the engine starts/,
    );
    assert.throws(
        () =>
            compileSource(
                `import { createVideoReachingDocument } from "./fixtures/executed-video/producers.js";
                async function main(): Promise<void> { await createVideoReachingDocument(); }
                void main();`,
                { fileName: "test/executed-video.ts" },
            ),
        /method 'show' reaches 'document'/,
    );
});

test("binds external pairs after the samplers and before the storage buffers", () => {
    const program = {
        name: "external",
        vertexSource,
        fragmentSource,
        attributes: ["position", "uv"],
        uniforms: [],
        samplers: [],
        externalTextures: ["frame"],
        storageBuffers: [{ name: "tint", type: "array<vec4<f32>>" }],
        needAlphaBlending: false,
        needAlphaTesting: false,
        backFaceCulling: true,
        depthWrite: true,
    };
    const native = emitNativeWgslProgram(
        lowerWgslShaderProgram(program),
        "fragment",
    );
    assert.match(
        native,
        /@group\(2\) @binding\(0\) var frame: texture_2d<f32>;/,
    );
    assert.match(
        native,
        /@group\(2\) @binding\(1\) var frameSampler: sampler;/,
    );
    assert.match(
        native,
        /@group\(2\) @binding\(2\) var<storage, read> tint: array<vec4<f32>>;/,
    );
    // The evidence copy keeps the pin's own addresses and type.
    const evidence = composeStandaloneWgsl(program, "", "fragment");
    assert.match(
        evidence,
        /@group\(1\) @binding\(1\) var frame: texture_external;/,
    );
    assert.match(evidence, /@group\(1\) @binding\(3\) var<storage, read> tint/);
    // An external textureLoad takes no level; the 2D frame reads level 0.
    const loaded = emitNativeWgslProgram(
        lowerWgslShaderProgram({
            ...program,
            fragmentSource: fragmentSource.replace(
                "textureSampleBaseClampToEdge(frame, frameSampler, input.uv)",
                "textureLoad(frame, vec2u(input.position.xy))",
            ),
        }),
        "fragment",
    );
    assert.match(
        loaded,
        /textureLoad\(frame, vec2u\(input\.position\.xy\), 0\)/,
    );
    // A vertex stage read refuses like a sampler's does.
    assert.throws(
        () =>
            lowerWgslShaderProgram({
                ...program,
                vertexSource: vertexSource.replace(
                    "out.uv = input.uv;",
                    "out.uv = textureSampleBaseClampToEdge(frame, frameSampler, input.uv).xy;",
                ),
            }),
        /read by the vertex stage/,
    );
});

test("the bind checks carry the pin's own messages", () => {
    const { source } = lowerShaderExternalTextures(new LoweringContext());
    for (const message of [
        "ShaderMaterial external textures require setShaderExternalTexture before pipeline preparation.",
        '" has no source. Call setShaderExternalTexture() before rendering.',
        '" is not ready.',
    ]) {
        assert.ok(source.includes(message), `missing ${message}`);
    }
    // The slot binds the frame through the material's own texture setters.
    assert.match(source, /set_shader_pixels_texture\(engine, material, slot/);
});
