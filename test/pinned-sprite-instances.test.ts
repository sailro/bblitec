import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { doubleCpp } from "../src/cpp-literals.js";
import {
    sharedPinnedContext,
    type LoweringContext,
} from "../src/lowering/context.js";
import { lowerSpriteInstances } from "../src/lowering/pinned-sprite-instances.js";
import { SpriteLowerer } from "../src/lowering/sprite-lowerer.js";
import {
    createJavaScriptFunction,
    transpileCommonJs,
} from "../src/typescript-transpile.js";
import { doctoredContext } from "./doctored-store.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const modulePath = "src/sprite/sprite-2d.ts";
interface Frame {
    uvMin: number[];
    uvMax: number[];
    sourceSizePx: number[];
}
interface Props {
    positionPx?: number[];
    sizePx?: number[];
    frame?: number;
    rotation?: number;
    color?: number[];
    flipX?: boolean;
    flipY?: boolean;
    visible?: boolean;
    z?: number;
}
interface State {
    atlas: { frames: Frame[] };
    count: number;
    depth: "none" | "test" | "test-write";
    layerZ: number;
    _instanceFloatsPerSprite: number;
    _instanceData: Float32Array;
    _savedSize: Float32Array;
    _version: number;
}
interface Reference {
    writeInstance(
        layer: State,
        index: number,
        props: Props,
        previous: Float32Array | null,
    ): void;
    setSprite2DFrameIndex(layer: State, index: number, frame: number): void;
}
function reference(context: LoweringContext): Reference {
    const declarations = ["writeInstance", "setSprite2DFrameIndex"].map(
        (name) =>
            context.functionDeclaration(modulePath, name).declaration.getText(),
    );
    const source = context.sourceFile(modulePath);
    const savedStride = context.numericValue(
        context.variableInitializer(source, "SAVED_SIZE_FLOATS_PER_SPRITE"),
        source,
    );
    const resolver = context
        .functionDeclaration(
            "src/sprite/shared/sprite-atlas.ts",
            "resolveSpriteFrame",
        )
        .declaration.getText();
    const exports = {} as Reference;
    createJavaScriptFunction(
        "exports",
        "ThrowLiteError",
        "markDirty",
        transpileCommonJs(
            [
                `const SAVED_SIZE_FLOATS_PER_SPRITE = ${savedStride};`,
                resolver,
                ...declarations,
                "export { writeInstance };",
            ].join("\n"),
            modulePath,
        ),
    )(
        exports,
        (code: number) => {
            throw new Error(`#${code}`);
        },
        (layer: State) => {
            layer._version++;
        },
    );
    return exports;
}
const tuple = (values: readonly number[]): string =>
    `{${values.map(doubleCpp).join(", ")}}`;
function propsCpp(props: Props): string {
    const fields: string[] = [];
    for (const [key, field] of [
        ["positionPx", "position_px"],
        ["sizePx", "size_px"],
        ["frame", "frame"],
        ["rotation", "rotation"],
        ["color", "color"],
        ["flipX", "flip_x"],
        ["flipY", "flip_y"],
        ["visible", "visible"],
        ["z", "z"],
    ] as const) {
        const value = props[key];
        if (value === undefined) continue;
        fields.push(
            `props.${field} = ${Array.isArray(value) ? tuple(value) : typeof value === "number" ? doubleCpp(value) : String(value)}; props.has_${field} = true;`,
        );
    }
    return `Sprite2DProps props{}; ${fields.join("\n")}`;
}
function checkState(state: State): string {
    const check = (native: string, values: ArrayLike<number>) =>
        `same_vector(${native}, {${Array.from(values, doubleCpp).join(", ")}});`;
    return `${check("layer.instance_data", state._instanceData)}
    ${check("layer.saved_size", state._savedSize)}
    assert(layer.version == ${state._version}u);`;
}

test("Sprite2D writers execute pinned bodies across depth and extended layouts", (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const context = sharedPinnedContext();
    const missingPosition: State = {
        atlas: { frames: [] },
        count: 0,
        depth: "none",
        layerZ: 0.5,
        _instanceFloatsPerSprite: 13,
        _instanceData: new Float32Array(13).fill(9.25),
        _savedSize: new Float32Array(2).fill(17.75),
        _version: 0,
    };
    assert.throws(
        () => reference(context).writeInstance(missingPosition, 0, {}, null),
        TypeError,
    );
    assert.deepEqual(
        Array.from(missingPosition._instanceData),
        Array(13).fill(9.25),
    );
    assert.deepEqual(Array.from(missingPosition._savedSize), [17.75, 17.75]);
    const variants = [
        context,
        doctoredContext(modulePath, "uMax = 1;", "uMax = 0.75;"),
        doctoredContext(
            modulePath,
            "data[base + 2] = visible ? trueW : 0;",
            "data[base + 2] = visible ? trueW - 1 : 0;",
        ),
        doctoredContext(
            modulePath,
            "data[base + 8] = rotation;",
            "data[base + 8] = rotation - 1;",
        ),
    ];
    const frames: Frame[] = [
        {
            uvMin: [0.1, 0.2],
            uvMax: [0.8, 0.9],
            sourceSizePx: [1 + 1e-9, 31.25],
        },
        {
            uvMin: [0.9, 0.8],
            uvMax: [0.2, 0.1],
            sourceSizePx: [7.1, 9.3],
        },
        {
            uvMin: [0.5 + 1e-9, -0],
            uvMax: [0.5, 1],
            sourceSizePx: [-0, 17.75],
        },
    ];
    const programs: string[] = [],
        checks: string[] = [];
    for (const [variant, ctx] of variants.entries()) {
        const source = reference(ctx);
        programs.push(
            `namespace bbl::case${variant} { ${lowerSpriteInstances(ctx)} }`,
        );
        for (const depth of ["none", "test", "test-write"] as const) {
            for (const wide of [false, true]) {
                const stride = (depth === "none" ? 13 : 14) + (wide ? 2 : 0);
                for (let frame = -1; frame < frames.length; frame++) {
                    for (const flipX of [false, true]) {
                        const state: State = {
                            atlas: { frames },
                            count: 1,
                            depth,
                            layerZ: 0.375,
                            _instanceFloatsPerSprite: stride,
                            _instanceData: new Float32Array(stride).fill(9.25),
                            _savedSize: new Float32Array(2),
                            _version: 0,
                        };
                        const steps: string[] = [
                            `using namespace bbl; Sprite2DLayerRecord layer;
                            layer.count = 1u; layer.capacity = 1u;
                            layer.depth_mode = Sprite2DDepthMode::${depth.replace("-", "_")};
                            layer.layer_z = 0.375f; layer.instance_floats_per_sprite = ${stride}u;
                            layer.instance_data.assign(${stride}u, 9.25f); layer.saved_size.resize(2);`,
                        ];
                        const write = (props: Props, isAdd = false) => {
                            source.writeInstance(
                                state,
                                0,
                                props,
                                isAdd
                                    ? null
                                    : state._instanceData.subarray(0, stride),
                            );
                            steps.push(
                                `{ ${propsCpp(props)} bbl::case${variant}::write_sprite_instance(layer, atlas, 0u, props, ${isAdd}); }`,
                                checkState(state),
                            );
                        };
                        write(
                            {
                                positionPx: [1 + 1e-9, -0],
                                ...(frame < 0 ? {} : { frame }),
                                flipX,
                                flipY: !flipX,
                                rotation: 1 + 1e-9,
                            },
                            true,
                        );
                        write({ visible: false });
                        write({ sizePx: [1 + 1e-9, -3.75] });
                        write({ visible: true });
                        write({ frame: 1 });
                        write({ flipX: !flipX, flipY: flipX });
                        write({ flipX: !flipX, flipY: flipX });
                        write({
                            color: [0.1, NaN, Infinity, -0],
                            rotation: -0,
                            z: 0.625 + 1e-9,
                        });
                        write({});
                        source.setSprite2DFrameIndex(state, 0, 2);
                        steps.push(
                            `bbl::case${variant}::set_sprite_frame(layer, atlas, 0.0, 2.0);`,
                            checkState(state),
                        );
                        checks.push(`{ ${steps.join("\n")} }`);
                    }
                }
            }
        }
    }
    const directory = resolve("artifacts/test-pinned-sprite-instances");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        executable = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        `#include <bblite/runtime.hpp>
#include <cassert>
#include <cmath>
#include <span>
#include <iostream>
#undef assert
#define assert(value) do { if (!(value)) { std::cerr << "assertion at " << __LINE__ << ": " << #value << "\\n"; std::exit(1); } } while(false)
namespace bbl::upstream {
inline constexpr std::uint32_t sprite_saved_size_floats_per_sprite = 2u;
${new SpriteLowerer(context).lowerFrameResolver()}
}
namespace bbl {
void touch_sprite_instances(Sprite2DLayerRecord& layer, double, double) { ++layer.version; }
}
${programs.join("\n")}
void same(double actual, double expected) { static int check=0; ++check; if (std::isnan(expected) ? !std::isnan(actual) : actual != expected || (actual == 0.0 && std::signbit(actual) != std::signbit(expected))) { std::cerr << "numeric check " << check << ": " << actual << " != " << expected << "\\n"; std::exit(1); } }
void same_vector(const std::vector<float>& actual, std::initializer_list<double> expected) { assert(actual.size()==expected.size()); std::size_t index=0; for(double value:expected) same(actual[index++],value); }
int main() {
    bbl::SpriteAtlasRecord atlas;
    atlas.frames = {${frames.map((frame) => `bbl::SpriteFrame{${tuple(frame.uvMin)}, ${tuple(frame.uvMax)}, ${tuple(frame.sourceSizePx)}, {0.5, 0.5}}`).join(", ")}};
    ${checks.join("\n")}
    bbl::Sprite2DLayerRecord layer; layer.count = 1; layer.instance_data.resize(13); layer.saved_size.resize(2);
    std::fill(layer.instance_data.begin(), layer.instance_data.end(), 9.25f);
    std::fill(layer.saved_size.begin(), layer.saved_size.end(), 17.75f);
    bool missing_position = false;
    try { bbl::case0::write_sprite_instance(layer, atlas, 0u, bbl::Sprite2DProps{}, true); }
    catch (const std::exception&) { missing_position = true; }
    assert(missing_position);
    ${checkState(missingPosition)}
    for (double invalid : {-1.0, 1.0}) {
        bool threw = false; try { bbl::case0::set_sprite_frame(layer, atlas, invalid, 0.0); } catch (const std::exception&) { threw = true; } assert(threw);
    }
}
`,
    );
    runNativeFixtureCompiler(tools, [
        "/O2",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        cpp,
    ]);
    execFileSync(executable, [], { cwd: directory, stdio: "pipe" });
});

test("Sprite2D writer refuses unknown atlas fields at the storage boundary", () => {
    assert.throws(
        () =>
            lowerSpriteInstances(
                doctoredContext(
                    modulePath,
                    "frame.sourceSizePx[0]",
                    "frame.unknownSize[0]",
                ),
            ),
        /Unsupported pinned/,
    );
});
