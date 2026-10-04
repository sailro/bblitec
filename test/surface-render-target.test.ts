import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { RenderTargetLowerer } from "../src/lowering/render-target-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const setup = `import {createEngine, createRenderTargetTexture, createSurfaceRenderTargetTexture, withSampledDepthTexture} from "@babylonjs/lite";
async function main() {
const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
`;

test("unreached asynchronous resource helpers do not activate a realm", () => {
    const result = compileSource(`${setup}
        function unused() { createSurfaceRenderTargetTexture(engine, {format: engine.format, samples: 1, size: engine}); }
        } void main();`);
    assert.ok(!result.manifest.features.includes("frame-graph:surface-target"));
    assert.doesNotMatch(result.cpp, /run_window_application/);
});

test("a canvas created before its engine activates the owning document realm", () => {
    const result = compileSource(`
        import {createEngine, createSurfaceRenderTargetTexture} from "@babylonjs/lite";
        async function main() {
            const canvas = document.createElement("canvas");
            document.body.appendChild(canvas);
            const engine = await createEngine(canvas);
            createSurfaceRenderTargetTexture(engine, {format: engine.format, samples: 1, size: engine});
        }
        void main();`);
    assert.ok(result.manifest.features.includes("platform:window"));
    assert.match(result.cpp, /window_document_engine/);
});

test("host document queries before engine setup retain nullable elements", () => {
    const result = compileSource(
        `
        import {createEngine} from "@babylonjs/lite";
        async function main() {
            const direct = document.querySelector<HTMLElement>(".controls");
            const elements = [direct, document.querySelector<HTMLElement>(".badge")]
                .filter((element): element is HTMLElement => element !== null);
            for (const element of elements) element.hidden = true;
            await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
        }
        void main();`,
        {
            nativeHostUi: {
                sourcePath: "fixture.json",
                elements: [],
                styleRules: [],
            },
        },
    );
    assert.ok(result.manifest.features.includes("platform:window"));
    assert.match(result.cpp, /ui_query_element/);
});

test("surface render targets retain sampled depth and validate descriptor ownership", () => {
    const result = compileSource(`${setup}
        const target = createSurfaceRenderTargetTexture(engine, {format: engine.format, dFormat: "depth32float", samples: 1, size: {surface: engine, scale: 0.5}}, withSampledDepthTexture);
        if (!target.depthTexture) throw new Error("missing depth");
        } void main();`);
    assert.match(result.cpp, /render_target_options_\d+\.sampled_depth = true/);
    assert.match(
        result.cpp,
        /options\.depth_format = bbl::DepthTextureFormat::depth32_float/,
    );
    assert.match(
        result.cpp,
        /options\.resolve_surface_size = bbl::resolve_surface_render_target_size/,
    );
    assert.match(
        result.cpp,
        /depth_texture\.target\.value != bbl::invalid_handle/,
    );
    for (const [factory, size, expected] of [
        ["createRenderTargetTexture", "engine", /fixed pixel dimensions/],
        [
            "createSurfaceRenderTargetTexture",
            "{width: 64, height: 64}",
            /surface-backed dimensions/,
        ],
    ] as const) {
        assert.throws(
            () =>
                compileSource(
                    `${setup} ${factory}(engine, {format: engine.format, samples: 1, size: ${size}}); } void main();`,
                ),
            expected,
        );
    }
    assert.throws(
        () =>
            compileSource(
                `${setup} createSurfaceRenderTargetTexture(engine, {format: engine.format, dFormat: "depth32float", samples: 4, size: engine}, withSampledDepthTexture); } void main();`,
            ),
        /single-sample depth attachment/,
    );
});

test("optional depth providers preserve conditional selection and argument effects", () => {
    const source = `
        import {createEngine,createRenderTargetTexture,withSampledDepthTexture} from "@babylonjs/lite";
        async function main() {
            const engine=await createEngine({});
            const alias=withSampledDepthTexture;
            let width=4, selected=0, absent=0;
            function provider(){selected++;width=9;return alias;}
            function none():undefined{absent++;return undefined;}
            const sampled=createRenderTargetTexture(engine,{format:"rgba8unorm",dFormat:"depth32float",samples:1,size:{width:width,height:8}},Math.random()<2?provider():none());
            if(!sampled.depthTexture||selected!==1||absent!==0)throw new Error("selected provider");
            const plain=createRenderTargetTexture(engine,{format:"rgba8unorm",samples:4,size:{width:width,height:8}},Math.random()>2?provider():none());
            if(plain.depthTexture||selected!==1||absent!==1)throw new Error("absent provider");
            const explicit=createRenderTargetTexture(engine,{format:"rgba8unorm",samples:4,size:{width:8,height:8}},undefined);
            if(explicit.depthTexture)throw new Error("explicit undefined");
            const settled=createRenderTargetTexture(engine,{format:"rgba8unorm",dFormat:"depth32float",samples:1,size:{width:8,height:8}},true?alias:undefined);
            if(!settled.depthTexture)throw new Error("settled alias");
        }
        void main();
    `;
    const result = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(
        tools,
        "optional-depth-provider",
        `
        #define main generated_main
        ${result.cpp}
        #undef main
        #include <cassert>
        namespace { unsigned int created=0; }
        namespace bbl {
            Engine create_engine(EngineOptions) {return {};}
            std::uint32_t render_target_dimension(double value){assert(value>0);return static_cast<std::uint32_t>(value);}
            RenderTargetTexture create_render_target_texture(Engine&,RenderTargetOptions options,bool surface_sized){
                assert(!surface_sized);
                ++created;
                assert(options.width==(created==1?4u:created==2?9u:8u));
                assert(options.sampled_depth==(created==1||created==4));
                RenderTargetHandle target{created};
                RenderTextureRef color; color.target=target;
                RenderTextureRef depth; if(options.sampled_depth){depth.target=target;depth.depth_only=true;}
                return {target,color,depth};
            }
        }
        int main(){assert(generated_main()==0);assert(created==4);}
    `,
        { expectedOutput: "" },
    );
    const surface = compileSource(`${setup}
        createSurfaceRenderTargetTexture(engine,{format:engine.format,dFormat:"depth32float",samples:1,size:engine},Math.random()<0.5?withSampledDepthTexture:undefined);
        } void main();`);
    assert.match(
        surface.cpp,
        /render_target_options_\d+\.sampled_depth = .*\?/,
    );
    assert.throws(
        () =>
            compileSource(`${setup}
        function withSampledDepthTexture(){throw new Error("authored provider");}
        createRenderTargetTexture(engine,{format:engine.format,samples:1,size:{width:8,height:8}},withSampledDepthTexture);
        } void main();`),
        /requires withSampledDepthTexture or an absent provider/,
    );
});

test("render targets retain explicit color formats and double precision scales", () => {
    const result = compileSource(`${setup}
        createSurfaceRenderTargetTexture(engine, {format: "rgba16float", dFormat: "depth16unorm", samples: 1, size: {surface: engine, scale: 0.3333333333333333}});
        } void main();`);
    assert.match(
        result.cpp,
        /options\.format = bbl::TextureFormatClass::rgba16_float/,
    );
    assert.match(result.cpp, /options\.has_format = true/);
    assert.match(
        result.cpp,
        /options\.depth_format = bbl::DepthTextureFormat::depth16_unorm/,
    );
    assert.match(result.cpp, /const double scale = 0\.3333333333333333;/);
    assert.throws(
        () =>
            compileSource(`${setup}
        createSurfaceRenderTargetTexture(engine, {format: "invalid", samples: 1, size: engine});
        } void main();`),
        /Unsupported render target color format/,
    );
});

test("surface extent arithmetic matches the pin and sampled facades retain distinct aspects", async (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const { _resolveRenderTargetSize: size } = await importPinnedModule<{
        _resolveRenderTargetSize(
            this: void,
            desc: {
                size: {
                    surface: { canvas: { width: number; height: number } };
                    scale: number;
                };
            },
        ): { width: number; height: number };
    }>("engine/render-target.js");
    const cases = [
        [301, 201, 0.5],
        [2, 3, 0.001],
        [1920, 1080, 1.5],
        [0, 0, 2],
    ];
    const checks = cases.map(([width, height, scale]) => {
        const expected = size({
            size: {
                surface: { canvas: { width: width!, height: height! } },
                scale: scale!,
            },
        });
        return `{ const auto size = bbl::resolve_surface_render_target_size(${width}, ${height}, ${scale}); assert(size[0] == ${expected.width} && size[1] == ${expected.height}); }`;
    });
    for (const scale of [0, -1, NaN, Infinity]) {
        assert.throws(() =>
            size({
                size: { surface: { canvas: { width: 10, height: 10 } }, scale },
            }),
        );
    }
    const directory = resolve("artifacts/surface-render-target-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        `${new RenderTargetLowerer(new LoweringContext()).lower().source}
        #include <cassert>
        #include <limits>
        int main() {
            ${checks.join("\n")}
            for (double scale : {0.0, -1.0, std::numeric_limits<double>::quiet_NaN(), std::numeric_limits<double>::infinity()}) {
                bool failed = false;
                try { (void)bbl::resolve_surface_render_target_size(10, 10, scale); }
                catch (const std::runtime_error&) { failed = true; }
                assert(failed);
            }
            bbl::Engine engine;
            bbl::RenderTargetOptions options;
            options.has_depth = true;
            options.sampled_depth = true;
            const auto sampled = bbl::create_render_target_texture(engine, options, true);
            assert(sampled.rt.value == sampled.texture.target.value);
            assert(sampled.rt.value == sampled.depth_texture.target.value);
            assert(!sampled.texture.depth_only && sampled.depth_texture.depth_only);
            assert(engine.render_targets[sampled.rt.value].sampled_depth);
            options.sampled_depth = false;
            const auto plain = bbl::create_render_target_texture(engine, options, true);
            assert(plain.depth_texture.target.value == bbl::invalid_handle);
            assert(plain.rt.value != sampled.rt.value);
        }
    `,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        `/I${resolve("native/include")}`,
        cpp,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});
