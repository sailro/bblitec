import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { transpileCommonJs } from "../src/typescript-transpile.js";
import { compileSource } from "../src/compiler.js";
import { SpriteLowerer } from "../src/lowering/sprite-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { frameSpriteAtlasCpp } from "../src/lowering/pinned-frame-atlas.js";
import { stringLiteral, doubleLiteral } from "../src/cpp-literals.js";
import { doctoredContext } from "./doctored-store.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const packerModule = "src/sprite/shared/sprite-atlas-packer.ts";
interface Source {
    pixels: Uint8Array;
    width: number;
    height: number;
    srcX?: number;
    srcY?: number;
    srcStrideBytes?: number;
    pivot?: readonly [number, number];
}
interface Options {
    paddingPx?: number;
    maxWidthPx?: number;
    capacityPx?: readonly [number, number];
    sampling?: "nearest" | "linear";
    premultipliedAlpha?: boolean;
}
interface Atlas {
    texture: { pixels: Uint8Array; width: number; height: number };
    frames: Array<{
        uvMin: number[];
        uvMax: number[];
        sourceSizePx: number[];
        pivot: number[];
    }>;
    premultipliedAlpha: boolean;
}
function pinnedFactory(
    context: LoweringContext,
): (sources: Source[], options?: Options) => Atlas {
    const bodies = ["shelfPack", "createSpriteAtlasFromFrames"].map((name) =>
        context.functionDeclaration(packerModule, name).declaration.getText(),
    );
    const js = transpileCommonJs(bodies.join("\n"), packerModule);
    const module = { exports: {} };
    runInNewContext(js, {
        exports: module.exports,
        Uint8Array,
        U8: Uint8Array,
        ThrowLiteError: (code: number) => {
            throw new Error(`#${code}`);
        },
        createTexture2DFromPixels: (
            _engine: object,
            pixels: Uint8Array,
            width: number,
            height: number,
        ) => ({ pixels, width, height }),
    });
    const exported = module.exports as {
        createSpriteAtlasFromFrames: (
            engine: object,
            sources: Source[],
            options?: Options,
        ) => Atlas;
    };
    return (sources, options) =>
        exported.createSpriteAtlasFromFrames({}, sources, options);
}

const pixels = Uint8Array.from({ length: 64 }, (_, i) => i + 1);
const scenarios: Array<{ sources: Source[]; options?: Options }> = [
    {
        sources: [
            { pixels, width: 2, height: 2 },
            { pixels, width: 1, height: 1 },
        ],
    },
    {
        sources: [
            {
                pixels: pixels.subarray(4),
                width: 2,
                height: 2,
                srcX: 1,
                srcY: 1,
                srcStrideBytes: 12,
                pivot: [0, 1],
            },
            { pixels, width: 2, height: 1 },
        ],
        options: {
            maxWidthPx: 3,
            capacityPx: [3, 6],
            sampling: "linear",
            premultipliedAlpha: true,
        },
    },
    { sources: [], options: { capacityPx: [2, 3] } },
    { sources: [] },
    { sources: [{ pixels, width: 1, height: 1, srcX: -1 }] },
    { sources: [{ pixels, width: -1, height: 1 }] },
    { sources: [{ pixels: pixels.subarray(0, 5), width: 2, height: 2 }] },
    { sources: [{ pixels, width: 4294967297, height: 1 }] },
    {
        sources: [{ pixels, width: 2, height: 2 }],
        options: { capacityPx: [1, 1] },
    },
];
const optional = (value: number | undefined) =>
    value === undefined ? "std::nullopt" : doubleLiteral(value);
const pair = (value: readonly number[] | undefined) =>
    value === undefined
        ? "std::nullopt"
        : `bbl::Vec2d{${value.map(doubleLiteral).join(", ")}}`;

for (const variant of ["pinned", "changed-padding", "changed-uv"] as const) {
    test(`frame atlas source and generated runtime agree (${variant})`, (t) => {
        const native = optionalNativeFixtureTools(false);
        if (!native) return t.skip("Native fixture compiler unavailable.");
        const context =
            variant === "pinned"
                ? new LoweringContext()
                : variant === "changed-padding"
                  ? doctoredContext(
                        packerModule,
                        "options.paddingPx ?? 1",
                        "options.paddingPx ?? 2",
                    )
                  : doctoredContext(
                        packerModule,
                        "placement.xs[i]! / atlasWidth",
                        "placement.xs[i]! / (atlasWidth + 1)",
                    );
        const sourceFactory = pinnedFactory(context);
        const checks = scenarios
            .map(({ sources, options }, index) => {
                let expected: Atlas | undefined;
                let error: string | undefined;
                try {
                    expected = sourceFactory(sources, options);
                } catch (failure) {
                    error = String((failure as Error).message);
                }
                const declarations = sources
                    .map(
                        (source, frame) =>
                            `bbl::js::U8Array pixels_${frame}(bbl::js::ArrayBuffer(std::vector<std::uint8_t>{${[...source.pixels].join(",")}}));`,
                    )
                    .join("\n");
                const inputs = sources
                    .map(
                        (source, frame) =>
                            `{&pixels_${frame}, ${doubleLiteral(source.width)}, ${doubleLiteral(source.height)}, ${optional(source.srcX)}, ${optional(source.srcY)}, ${optional(source.srcStrideBytes)}, ${pair(source.pivot)}}`,
                    )
                    .join(",");
                const named = options ?? {};
                const call = `bbl::upstream::pack_sprite_atlas(atlas, engine, {${inputs}}, {${optional(named.paddingPx)}, ${optional(named.maxWidthPx)}, ${named.sampling ? stringLiteral(named.sampling) : "std::nullopt"}, ${named.premultipliedAlpha === undefined ? "std::nullopt" : String(named.premultipliedAlpha)}, ${pair(named.capacityPx)}});`;
                return `// scenario ${index}\n{ ${declarations}\nbbl::SpriteAtlasRecord atlas;\n${
                    error !== undefined
                        ? `try { ${call} assert(false); } catch (const std::runtime_error& error) { assert(std::string(error.what()) == ${stringLiteral(error)}); }`
                        : `${call}
                assert(atlas.width == ${expected!.texture.width} && atlas.height == ${expected!.texture.height});
                assert(*atlas.rgba == (std::vector<std::uint8_t>{${[...expected!.texture.pixels].join(",")}}));
                assert(atlas.premultiplied_alpha == ${expected!.premultipliedAlpha});
                assert(atlas.frames.size() == ${expected!.frames.length});
                ${expected!.frames
                    .map((frame, i) =>
                        (
                            [
                                ["uv_min", frame.uvMin],
                                ["uv_max", frame.uvMax],
                                ["source_size_px", frame.sourceSizePx],
                                ["pivot", frame.pivot],
                            ] as const
                        )
                            .map(
                                ([member, values]) =>
                                    `assert(atlas.frames[${i}].${member}.x == ${doubleLiteral(values[0]!)}); assert(atlas.frames[${i}].${member}.y == ${doubleLiteral(values[1]!)});`,
                            )
                            .join("\n"),
                    )
                    .join("\n")}`
                }}`;
            })
            .join("\n");
        const directory = resolve(`artifacts/test-sprite-atlas-${variant}`);
        mkdirSync(directory, { recursive: true });
        const source = resolve(directory, "check.cpp");
        writeFileSync(
            source,
            `#include <bblite/runtime.hpp>\n#include <bblite/pinned_records.hpp>\n#include <cassert>\n${frameSpriteAtlasCpp(context)}\nint main(){ bbl::Engine engine;
    bbl::PackedSpriteAtlasFrameSource frame;
    frame.pixels = bbl::js::TypedArray<std::uint8_t>{1,2,3,4};
    frame.width = frame.height = 1;
    const auto defaulted = bbl::create_sprite_atlas_from_frames(engine, bbl::js::Array<bbl::PackedSpriteAtlasFrameSource>{frame});
    assert(defaulted.frames.size() == 1 && defaulted.texture.pixels.size() == 4);
    ${checks} }`,
        );
        const executable = resolve(directory, "check.exe");
        runNativeFixtureCompiler(native, [
            source,
            `/Fo${resolve(directory, "check.obj")}`,
            `/Fe${executable}`,
        ]);
        assert.equal(execFileSync(executable, [], { encoding: "utf8" }), "");
    });
}

test("frame atlas source comments do not alter emission", () => {
    assert.equal(
        frameSpriteAtlasCpp(
            doctoredContext(
                packerModule,
                "frames[i] =",
                "frames /* source order */ [ i ] =",
            ),
        ),
        frameSpriteAtlasCpp(new LoweringContext()),
    );
});

test("authored frame offsets reach source validation without unsigned coercion", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    const result =
        compileSource(`import {createEngine,createSpriteAtlasFromFrames,type SpriteAtlasFrameSource} from '@babylonjs/lite';
        async function main(){const engine=await createEngine({});
        const sources:SpriteAtlasFrameSource[]=[{pixels:new Uint8Array([1,2,3,4]),width:1,height:1,srcX:-1}];
        let observed=false;
        try {createSpriteAtlasFromFrames(engine,sources,{paddingPx:0,maxWidthPx:2});}
        catch(error){if((error as Error).message!=="#742")throw error;observed=true;}
        if(!observed)throw new Error("negative source offset was accepted");} void main();`);
    const context = new LoweringContext();
    const lowered = new SpriteLowerer(context).lowerCore();
    const directory = resolve("artifacts/test-sprite-atlas-source");
    const include = resolve(directory, "include");
    mkdirSync(resolve(include, "bblite/upstream"), { recursive: true });
    writeFileSync(
        resolve(include, "bblite/upstream/sprite_layer.hpp"),
        lowered.header,
    );
    const source = resolve(directory, "check.cpp");
    writeFileSync(
        source,
        `${result.cpp}\n${frameSpriteAtlasCpp(context)}\nnamespace bbl { Engine create_engine(EngineOptions){return {};}
        ${cppFunction(lowered.source, "SpriteAtlasHandle create_sprite_atlas_from_frames(")} }`,
    );
    const executable = resolve(directory, "check.exe");
    runNativeFixtureCompiler(native, [
        `/I${include}`,
        source,
        `/Fo${resolve(directory, "check.obj")}`,
        `/Fe${executable}`,
    ]);
    assert.equal(execFileSync(executable, [], { encoding: "utf8" }), "");
});
