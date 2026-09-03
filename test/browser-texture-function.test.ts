import assert from "node:assert/strict";
import test from "node:test";

import ts from "typescript";

import { compileSource } from "../src/compiler.js";
import {
    bakeBrowserTextureFunction,
    browserTextureFunctionShape,
    decodeBrowserTextureBake,
    pngDimensions,
    type BrowserTextureFunctionShape,
} from "../src/compiler/browser-texture-function.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import { parseDataUrl } from "../src/data-url.js";
import type { CompileResult } from "../src/compiler/types.js";

/**
 * Textures a scene function produces with a browser canvas.
 *
 * Two shapes reach this and neither is lowerable here: a rasterized face,
 * whose pixels are a browser rasterizer's, and a procedural tile that
 * rounds through a `Math.round` this data model does not carry and then
 * crosses a browser PNG encode. So the function is executed at generation
 * and what its pinned factories were handed is packaged.
 *
 * These tests hold the boundary: what the structural gate accepts, what it
 * declines back to ordinary inlining, what the driver refuses once it has
 * accepted, and that the packaged bytes and options are exactly what the
 * browser produced -- twice running.
 */

const fixtureEntry = `
    import { addToScene, createBox, createEngine, createSceneContext, startEngine } from "@babylonjs/lite";
`;

function compileFixture(body: string, fileName = "test/browser-texture.ts"): CompileResult {
    return compileSource(`${fixtureEntry}${body}`, { fileName });
}

/** The fixture module's declarations, by name, through a real program. */
function fixtureDeclarations(
    module: "tiles" | "refusals",
): {
    checker: ts.TypeChecker;
    declaration(name: string): ts.FunctionDeclaration;
} {
    const fileName = "test/browser-texture-shape.ts";
    const frontend = createCompilerProgram(
        `import * as fixture from "./fixtures/browser-texture/${module}.js";\n` +
            "export const used = fixture;\n",
        fileName,
    );
    const source = frontend.program
        .getSourceFiles()
        .find((candidate) =>
            candidate.fileName.endsWith(
                `fixtures/browser-texture/${module}.ts`,
            ),
        );
    assert.ok(source, `fixture module ${module}.ts was not loaded`);
    return {
        checker: frontend.checker,
        declaration(name) {
            const found = source.statements.find(
                (statement): statement is ts.FunctionDeclaration =>
                    ts.isFunctionDeclaration(statement) &&
                    statement.name?.text === name,
            );
            assert.ok(found, `fixture function ${name} was not found`);
            return found;
        },
    };
}

test("accepts a canvas-owning producer and reports its closure", () => {
    const { checker, declaration } = fixtureDeclarations("tiles");
    const pair = browserTextureFunctionShape(
        checker,
        declaration("createTilePair"),
    );
    assert.ok(pair, "createTilePair should be a browser texture producer");
    assert.equal(pair.returns, "record");
    assert.equal(pair.exported, true);
    // The canvas lives in a same-file helper, so the closure has to have
    // followed the call rather than looking only at the target's own body.
    assert.deepEqual(
        pair.closure.map((member) => member.name?.text).sort(),
        ["createTilePair", "encodeTile", "rampBytes"],
    );

    // A non-exported target reached through a local helper: both the helper
    // and the producer itself match, and the helper is what a call site hits
    // first, so nothing inside is ever inlined.
    const helper = browserTextureFunctionShape(
        checker,
        declaration("makeFaceTexture"),
    );
    assert.ok(helper, "makeFaceTexture should be a browser texture producer");
    assert.equal(helper.returns, "value");
    assert.equal(helper.exported, false);
    const inner = browserTextureFunctionShape(
        checker,
        declaration("createFaceTexture"),
    );
    assert.ok(inner, "createFaceTexture should be a browser texture producer");
    assert.equal(inner.exported, false);
});

test("declines every shape it cannot bound", () => {
    const { checker, declaration } = fixtureDeclarations("refusals");
    for (const [name, why] of [
        ["createBoxBesideTexture", "reaches a pinned export beyond the two factories"],
        ["measureCanvas", "owns a canvas but reaches no texture factory"],
        ["loadTile", "reaches a texture factory but owns no canvas"],
        ["createCachedTile", "memoizes through module-level state"],
        ["createBranchingTile", "returns from two arms"],
    ] as const) {
        assert.equal(
            browserTextureFunctionShape(checker, declaration(name)),
            undefined,
            `${name} ${why}, so it must fall through to ordinary inlining`,
        );
    }
    // The one shape the gate accepts and the driver rejects: the canvas and
    // the factory are both there, but the URL is fetched rather than made.
    assert.ok(
        browserTextureFunctionShape(
            checker,
            declaration("loadFetchedTileBesideCanvas"),
        ),
    );
});

test("a declined producer is inlined, not executed", () => {
    // `loadTile` owns no canvas, so it lowers as the ordinary file texture
    // it is -- and records no browser-texture adaptation.
    const result = compileFixture(`
        import { createStandardMaterial } from "@babylonjs/lite";
        import { loadTile } from "./fixtures/browser-texture/refusals.js";
        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const box = createBox(engine, { size: 1 });
            const material = createStandardMaterial();
            material.diffuseTexture = await loadTile(engine);
            box.material = material;
            addToScene(scene, box);
            startEngine(engine);
        }
        void main();
    `);
    assert.match(result.cpp, /bbl::load_file_texture\(/);
    assert.match(result.cpp, /bbl::set_standard_diffuse_file_texture\(/);
    assert.equal(
        result.manifest.adaptations.some(
            (adaptation) => adaptation.id === "browser-produced-textures",
        ),
        false,
    );
    assert.deepEqual(
        result.manifest.assets.map((asset) => asset.kind),
        ["texture"],
    );
});

test("packages both textures a record-returning producer made", () => {
    const compile = (): CompileResult =>
        compileFixture(`
            import { createTilePair } from "./fixtures/browser-texture/tiles.js";
            async function main() {
                const engine = await createEngine({});
                const tiles = await createTilePair(engine);
                const width = tiles.baseColor.width + tiles.normalMap.width;
                const unused = width + 1;
                startEngine(engine);
            }
            void main();
        `);
    const result = compile();
    assert.equal(
        result.manifest.features.includes("browser:file"),
        false,
        "the Blob/object URL inside the executed producer belongs to Chromium, not the native file bridge",
    );

    // Two packaged PNGs, and the exact sampler the source named: repeat
    // addressing both ways, invertY false, sRGB and premultiply left at the
    // pin's own defaults, mips on so anisotropy is the pin's 4.
    const assets = result.manifest.assets;
    assert.deepEqual(
        assets.map((asset) => asset.kind),
        ["texture", "texture"],
    );
    const loads = [
        ...result.cpp.matchAll(
            /const auto \w+ = bbl::load_file_texture\([^;]*\);/g,
        ),
    ].map((match) => match[0]);
    assert.equal(loads.length, 2);
    for (const load of loads) {
        assert.match(
            load,
            /bbl::TextureSamplerState\{bbl::TextureFilter::linear, bbl::TextureFilter::linear, bbl::TextureMipmapMode::linear, bbl::TextureAddressMode::repeat, bbl::TextureAddressMode::repeat, 4\.0f, 1000\.0f\}, false, false, false/,
        );
    }
    // Each texture is created once and bound; a `cpp` left as the factory
    // expression would load it again at every use.
    assert.equal(
        [...result.cpp.matchAll(/bbl::load_file_texture\(/g)].length,
        2,
    );

    // The payload is the browser's own PNG, at the size the source asked
    // for, and both tiles differ -- the two ramps are not the same image.
    const payloads = assets.map((asset) => {
        const source = result.assetPayloads.get(asset.source);
        assert.ok(source, `asset ${asset.output} carries no payload`);
        const parsed = parseDataUrl(source);
        assert.ok(parsed, `asset ${asset.output} is not a data URL`);
        assert.equal(parsed.mediaType, "image/png");
        return parsed.bytes;
    });
    for (const bytes of payloads) {
        assert.deepEqual(pngDimensions(bytes), { width: 4, height: 4 });
    }
    assert.notDeepEqual(payloads[0], payloads[1]);

    // Repeating the compile re-runs the bake (both the durable cache and
    // the same-process memo are off under the test runner) and must produce
    // byte-identical generated output.
    const again = compile();
    assert.equal(again.cpp, result.cpp);
    assert.deepEqual(
        again.manifest.assets.map((asset) => asset.output),
        assets.map((asset) => asset.output),
    );
    for (const [index, asset] of again.manifest.assets.entries()) {
        assert.equal(
            again.assetPayloads.get(asset.source),
            result.assetPayloads.get(assets[index]!.source),
        );
    }
});

test("carries a produced pixels texture into the Standard diffuse slot", () => {
    // The sandblox character's route: a non-exported producer, returned
    // through a local helper, bound to a local, handed to a second local
    // function as a parameter, and assigned only there.
    const result = compileFixture(`
        import { createFaceMaterialThroughParameter } from "./fixtures/browser-texture/tiles.js";
        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const box = createBox(engine, { size: 1 });
            box.material = createFaceMaterialThroughParameter(engine);
            addToScene(scene, box);
            startEngine(engine);
        }
        void main();
    `);
    assert.match(
        result.cpp,
        /const auto \w+ = bbl::create_texture_2d_from_pixels\(\w+, bbl::asset_path\("[^"]+\.rgba"\), 2\.0, 2\.0, bbl::PixelsTextureOptions\{bbl::TextureFilter::linear, true, bbl::TextureFilter::linear, true, \{\}, false, \{\}, false, false\}\);/,
    );
    // The metadata survived both hops; without it the slot falls through to
    // the render-texture-only arm and refuses.
    assert.match(result.cpp, /bbl::set_standard_diffuse_pixels_texture\(/);
    assert.ok(
        result.manifest.features.includes(
            "material:standard-diffuse-pixels-texture",
        ),
    );

    // The packaged payload is the raw RGBA the call was handed: 2x2x4, with
    // the source's own vertical flip already applied.
    const asset = result.manifest.assets[0]!;
    assert.equal(asset.kind, "pixels");
    const parsed = parseDataUrl(result.assetPayloads.get(asset.source)!);
    assert.ok(parsed);
    assert.equal(parsed.bytes.length, 2 * 2 * 4);
    assert.deepEqual(
        [...parsed.bytes],
        [
            255, 255, 255, 255, 255, 255, 255, 255,
            0x11, 0x22, 0x33, 255, 255, 255, 255, 255,
        ],
    );

    assert.ok(
        result.manifest.adaptations.some(
            (adaptation) =>
                adaptation.id === "browser-produced-textures" &&
                adaptation.sourceSemantics.includes("makeFaceTexture"),
        ),
    );
});

test("refuses a fetched URL inside an accepted producer", () => {
    assert.throws(
        () =>
            compileFixture(`
                import { loadFetchedTileBesideCanvas } from "./fixtures/browser-texture/refusals.js";
                async function main() {
                    const engine = await createEngine({});
                    const tile = await loadFetchedTileBesideCanvas(engine);
                    const width = tile.width;
                    const unused = width + 1;
                    startEngine(engine);
                }
                void main();
            `),
        /not a browser object URL/,
    );
});

test("exposes a non-exported target to the driver", () => {
    const { checker, declaration } = fixtureDeclarations("tiles");
    const shape = browserTextureFunctionShape(
        checker,
        declaration("createFaceTexture"),
    )!;
    let entryJavascript = "";
    bakeBrowserTextureFunction(shape, process.cwd(), (modules, entry) => {
        entryJavascript = modules[entry]!.javascript;
        return JSON.stringify({
            textures: [
                {
                    factory: "createTexture2DFromPixels",
                    pixels: Buffer.alloc(4).toString("base64"),
                    width: 1,
                    height: 1,
                    options: null,
                },
            ],
            result: { kind: "texture", index: 0 },
        });
    });
    assert.match(
        entryJavascript,
        /exports\.__bblBrowserTextureTarget = createFaceTexture;/,
    );
    // The whole module is transpiled, so the target's own helpers travel
    // with it rather than being re-derived.
    assert.match(entryJavascript, /function encodeTile/);
});

test("refuses a driver result it cannot package", () => {
    const shape = {
        name: "createTilePair",
        returns: "record",
    } as unknown as BrowserTextureFunctionShape;
    const single = {
        name: "createFaceTexture",
        returns: "value",
    } as unknown as BrowserTextureFunctionShape;
    const pixelTexture = {
        factory: "createTexture2DFromPixels",
        pixels: Buffer.alloc(4).toString("base64"),
        width: 1,
        height: 1,
        options: null,
    };
    for (const [payload, pattern] of [
        [
            { textures: [pixelTexture], result: { kind: "texture", index: 0 } },
            /returned one texture where the source returns an object/,
        ],
        [
            { textures: [pixelTexture], result: { kind: "record", properties: { a: 3 } } },
            /returned 'a' as something other than a texture/,
        ],
        [
            { textures: [pixelTexture], result: { kind: "other" } },
            /did not return a texture or an object of textures/,
        ],
        [
            {
                textures: [{ ...pixelTexture, width: 4 }],
                result: { kind: "record", properties: { a: 0 } },
            },
            /received 4 bytes for 4x1 RGBA/,
        ],
        [
            {
                textures: [{ ...pixelTexture, options: { mipMaps: true } }],
                result: { kind: "record", properties: { a: 0 } },
            },
            /option 'mipMaps' is not lowered/,
        ],
        [
            {
                textures: [
                    {
                        factory: "loadTexture2D",
                        image: Buffer.alloc(4).toString("base64"),
                        mediaType: "image/gif",
                        options: null,
                    },
                ],
                result: { kind: "record", properties: { a: 0 } },
            },
            /is not one of the image types this port packages/,
        ],
    ] as const) {
        assert.throws(
            () => decodeBrowserTextureBake(shape, JSON.stringify(payload)),
            pattern,
        );
    }
    assert.throws(
        () =>
            decodeBrowserTextureBake(
                single,
                JSON.stringify({
                    textures: [pixelTexture],
                    result: { kind: "record", properties: { a: 0 } },
                }),
            ),
        /returned an object where the source returns one value/,
    );
});

test("preserves the pinned Sandblox producers' bytes and options", () => {
    const corpus = "corpus/babylon-lite/lab/lite/src/demos/sandblox";
    const frontend = createCompilerProgram(
        `import { createStudTextures } from "../${corpus}/stud-texture.js";\n` +
            `import { buildCharacter } from "../${corpus}/character.js";\n` +
            "export const used = [createStudTextures, buildCharacter];\n",
        "test/sandblox-producers.ts",
    );
    const declaration = (
        module: string,
        name: string,
    ): ts.FunctionDeclaration => {
        const source = frontend.program
            .getSourceFiles()
            .find((candidate) => candidate.fileName.endsWith(`${corpus}/${module}`));
        assert.ok(source, `pinned Sandblox module ${module} was not loaded`);
        const found = source.statements.find(
            (statement): statement is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(statement) &&
                statement.name?.text === name,
        );
        assert.ok(found, `pinned Sandblox function ${name} was not found`);
        return found;
    };

    // The stud tile pair: an exported async producer returning a record,
    // through an OffscreenCanvas PNG encode and two loadTexture2D calls.
    const studs = browserTextureFunctionShape(
        frontend.checker,
        declaration("stud-texture.ts", "createStudTextures"),
    );
    assert.ok(studs);
    assert.equal(studs.returns, "record");
    const studBake = bakeBrowserTextureFunction(studs, process.cwd());
    assert.deepEqual(studBake.result, {
        kind: "record",
        properties: { baseColor: 0, normalMap: 1 },
    });
    for (const texture of studBake.textures) {
        assert.equal(texture.factory, "loadTexture2D");
        assert.equal(texture.mediaType, "image/png");
        assert.deepEqual(texture.options, {
            addressModeU: "repeat",
            addressModeV: "repeat",
            invertY: "false",
        });
        assert.deepEqual(pngDimensions(texture.image), {
            width: 64,
            height: 64,
        });
    }
    assert.notDeepEqual(
        studBake.textures[0]!.factory === "loadTexture2D"
            ? studBake.textures[0]!.image
            : undefined,
        studBake.textures[1]!.factory === "loadTexture2D"
            ? studBake.textures[1]!.image
            : undefined,
    );

    // The two loads are started by one `Promise.all`, so they complete in
    // whichever order the page settles them. The recorded order is the
    // order the pin CALLED them in, which has to hold across runs or the
    // generated tree would not be byte-stable.
    const studAgain = bakeBrowserTextureFunction(studs, process.cwd());
    assert.deepEqual(studAgain.result, studBake.result);
    assert.deepEqual(studAgain.textures, studBake.textures);

    // The character face: a NON-exported producer whose whole point is the
    // rasterizer, handed to createTexture2DFromPixels as raw RGBA.
    const face = browserTextureFunctionShape(
        frontend.checker,
        declaration("character.ts", "createClassicSmileTexture"),
    );
    assert.ok(face);
    assert.equal(face.exported, false);
    assert.equal(face.returns, "value");
    const faceBake = bakeBrowserTextureFunction(face, process.cwd());
    assert.deepEqual(faceBake.result, { kind: "texture", index: 0 });
    const [faceTexture] = faceBake.textures;
    assert.equal(faceTexture?.factory, "createTexture2DFromPixels");
    assert.equal(faceTexture.width, 128);
    assert.equal(faceTexture.height, 128);
    assert.equal(faceTexture.pixels.length, 128 * 128 * 4);
    assert.deepEqual(faceTexture.options, {
        minFilter: "linear",
        magFilter: "linear",
    });
    // The source paints the background white and rewrites its alpha to zero,
    // so the top-left texel of the FLIPPED buffer is transparent white and
    // the drawn ink is opaque somewhere.
    assert.deepEqual([...faceTexture.pixels.subarray(0, 4)], [255, 255, 255, 0]);
    assert.ok(
        faceTexture.pixels.some((byte, index) => index % 4 === 3 && byte === 255),
        "the rasterized face has no opaque texel",
    );
});

test("reads a PNG's own dimensions and nothing else's", () => {
    const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEklEQVR4nGP8" +
            "z8DAwMDAxAADEAYADgABAAoAAf/9AAAAAElFTkSuQmCC",
        "base64",
    );
    assert.deepEqual(pngDimensions(new Uint8Array(png)), {
        width: 2,
        height: 3,
    });
    assert.equal(pngDimensions(new Uint8Array(8)), undefined);
    assert.equal(
        pngDimensions(new Uint8Array(Buffer.from("not a png at all!!!!!!!!"))),
        undefined,
    );
});
