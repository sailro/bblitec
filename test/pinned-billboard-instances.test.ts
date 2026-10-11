import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { doubleCpp } from "../src/cpp-literals.js";
import { BillboardLowerer } from "../src/lowering/billboard-lowerer.js";
import {
    sharedPinnedContext,
    type LoweringContext,
} from "../src/lowering/context.js";
import { lowerBillboardInstances } from "../src/lowering/pinned-billboard-instances.js";
import { SpriteLowerer } from "../src/lowering/sprite-lowerer.js";
import {
    createJavaScriptFunction,
    transpileCommonJs,
} from "../src/typescript-transpile.js";
import { doctoredContext } from "./doctored-store.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const modulePath = "src/sprite/billboard-sprite.ts";
interface Frame {
    uvMin: number[];
    uvMax: number[];
    pivot: number[];
}
interface Props {
    position?: number[];
    sizeWorld?: number[];
    frame?: number;
    rotation?: number;
    pivot?: number[];
    color?: number[];
    flipX?: boolean;
    flipY?: boolean;
    visible?: boolean;
}
interface State {
    atlas: { frames: Frame[] };
    count: number;
    _capacity: number;
    _version: number;
    _dirtyMin: number;
    _dirtyMax: number;
    _instanceData: Float32Array;
    _savedSize: Float32Array;
    _anchor: Float64Array;
}
interface Reference {
    addBillboardSpriteIndex(system: State, props: Props): number;
    updateBillboardSpriteIndex(
        system: State,
        index: number,
        props: Props,
    ): void;
    setBillboardSpriteFrameIndex(
        system: State,
        index: number,
        frame: number,
    ): void;
}
function reference(context: LoweringContext): Reference {
    const names = [
        "growCapacity",
        "writeInstance",
        "markDirty",
        "addBillboardSpriteIndex",
        "updateBillboardSpriteIndex",
        "setBillboardSpriteFrameIndex",
    ];
    const declarations = names.map((name) =>
        context.functionDeclaration(modulePath, name).declaration.getText(),
    );
    const source = context.sourceFile(modulePath);
    const constants = [
        "BILLBOARD_INSTANCE_FLOATS_PER_SPRITE",
        "BILLBOARD_SAVED_SIZE_FLOATS_PER_SPRITE",
        "BILLBOARD_ANCHOR_FLOATS_PER_SPRITE",
    ];
    const definitions = constants.map(
        (name) =>
            `const ${name} = ${context.numericValue(context.variableInitializer(source, name), source)};`,
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
        "F32",
        "F64",
        "ThrowLiteError",
        "setBillboardCount",
        transpileCommonJs(
            [...definitions, resolver, ...declarations].join("\n"),
            modulePath,
        ),
    )(
        exports,
        Float32Array,
        Float64Array,
        (code: number) => {
            throw new Error(`#${code}`);
        },
        (state: State, count: number) => {
            state.count = count;
        },
    );
    return exports;
}
const tuple = (values: readonly number[]): string =>
    `{${values.map(doubleCpp).join(", ")}}`;
function propsCpp(props: Props): string {
    const fields: string[] = [];
    for (const [key, field] of [
        ["position", "position"],
        ["sizeWorld", "size_world"],
        ["frame", "frame"],
        ["rotation", "rotation"],
        ["pivot", "pivot"],
        ["color", "color"],
        ["flipX", "flip_x"],
        ["flipY", "flip_y"],
        ["visible", "visible"],
    ] as const) {
        const value = props[key];
        if (value === undefined) continue;
        fields.push(
            `props.${field} = ${Array.isArray(value) ? tuple(value) : typeof value === "number" ? doubleCpp(value) : String(value)}; props.has_${field} = true;`,
        );
    }
    return `BillboardSpriteProps props{}; ${fields.join("\n")}`;
}
function checkState(state: State): string {
    const check = (native: string, values: ArrayLike<number>) =>
        `same_vector(${native}, {${Array.from(values, doubleCpp).join(", ")}});`;
    return `assert(system.count == ${state.count}u && system.capacity == ${state._capacity}u);
    ${check("system.instance_data", state._instanceData)}
    ${check("system.saved_size", state._savedSize)}
    ${check("system.anchor", state._anchor)}`;
}

test("billboard add, update, frame and growth execute the pinned bodies and typed stores", (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const context = sharedPinnedContext();
    const declaration = context.functionDeclaration(
        modulePath,
        "writeInstance",
    ).declaration;
    const renamed = ts.transform(declaration, [
        (factory) => {
            const visit: ts.Visitor = (node) => {
                if (
                    ts.isIdentifier(node) &&
                    (node.text === "frame" || node.text === "spriteFrame") &&
                    !(
                        ts.isPropertyAccessExpression(node.parent) &&
                        node.parent.name === node
                    )
                )
                    return factory.factory.createIdentifier("selectedFrame");
                return ts.visitEachChild(node, visit, factory);
            };
            return (node) =>
                ts.visitNode(node, visit) as ts.FunctionDeclaration;
        },
    ]);
    const renamedContext = doctoredContext(
        modulePath,
        declaration.getText(),
        ts
            .createPrinter()
            .printNode(
                ts.EmitHint.Unspecified,
                renamed.transformed[0]!,
                declaration.getSourceFile(),
            ),
    );
    renamed.dispose();
    const variants = [
        context,
        renamedContext,
        doctoredContext(modulePath, "uvMaxX = 1;", "uvMaxX = 0.75;"),
        doctoredContext(
            modulePath,
            "data[base + 3] = visible ? trueWidth : 0;",
            "data[base + 3] = visible ? trueWidth * 1.125 : 0;",
        ),
        doctoredContext(modulePath, "capacity *= 2;", "capacity *= 3;"),
    ];
    const frames: Frame[] = [
        { uvMin: [0.1, 0.2], uvMax: [0.8, 0.9], pivot: [0.125, 0.875] },
        { uvMin: [0.9, 0.8], uvMax: [0.2, 0.1], pivot: [0.7, 0.3] },
        { uvMin: [0.5 + 1e-9, -0], uvMax: [0.5, 1], pivot: [0.4 + 1e-9, -0] },
    ];
    const programs: string[] = [],
        checks: string[] = [];
    for (const [variant, ctx] of variants.entries()) {
        const source = reference(ctx);
        programs.push(
            `namespace bbl::case${variant} { ${lowerBillboardInstances(ctx)} }`,
        );
        const state: State = {
            atlas: { frames },
            count: 0,
            _capacity: 1,
            _version: 0,
            _dirtyMin: 0,
            _dirtyMax: 0,
            _instanceData: new Float32Array(16),
            _savedSize: new Float32Array(2),
            _anchor: new Float64Array(3),
        };
        const steps: string[] = [
            `using namespace bbl; BillboardSystemRecord system; bbl::case${variant}::resize_billboard_storage(system, 1);`,
        ];
        const add = (props: Props) => {
            const index = source.addBillboardSpriteIndex(state, props);
            steps.push(
                `{ ${propsCpp(props)} same(bbl::case${variant}::append_billboard_instance(system, atlas, props), ${index}); }`,
                checkState(state),
            );
        };
        const update = (index: number, props: Props) => {
            source.updateBillboardSpriteIndex(state, index, props);
            steps.push(
                `{ ${propsCpp(props)} bbl::case${variant}::update_billboard_instance(system, atlas, ${index}, props); }`,
                checkState(state),
            );
        };
        for (let frame = -1; frame < frames.length; frame++) {
            for (const flipX of [false, true]) {
                add({
                    position: [1e12 + 0.125, -0, -1e12 - 0.75],
                    sizeWorld: [2.25 + 1e-8, -3.75],
                    ...(frame < 0 ? {} : { frame }),
                    flipX,
                    flipY: !flipX,
                    color: [0.1, NaN, Infinity, -0],
                    rotation: -0,
                });
                const index = state.count - 1;
                update(index, { visible: false });
                update(index, { sizeWorld: [7.1, 9.3] });
                update(index, {
                    frame: 1,
                    flipX: !flipX,
                    rotation: 2.1,
                    pivot: [0, 1],
                });
                update(index, { visible: true });
                update(index, {});
                source.setBillboardSpriteFrameIndex(state, index, 2);
                steps.push(
                    `bbl::case${variant}::set_billboard_instance_frame(system, atlas, ${index}, 2);`,
                    checkState(state),
                );
            }
        }
        checks.push(`{ ${steps.join("\n")} }`);
    }
    const core = new BillboardLowerer(context).lowerCore().source;
    const directory = resolve("artifacts/test-pinned-billboard-instances");
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
inline constexpr std::uint32_t billboard_anchor_floats_per_sprite = 3u;
inline constexpr std::uint32_t billboard_saved_size_floats_per_sprite = 2u;
${new SpriteLowerer(context).lowerFrameResolver()}
}
${programs.join("\n")}
namespace bbl { using namespace case0;
${["double add_billboard_sprite_index(", "BillboardSpriteHandle add_billboard_sprite(", "void update_billboard_sprite(", "void remove_billboard_sprite(", "void clear_billboard_sprites("].map((signature) => cppFunction(core, signature)).join("\n")}
}
void same(double actual, double expected) { static int check=0; ++check; if (std::isnan(expected) ? !std::isnan(actual) : actual != expected || (actual == 0.0 && std::signbit(actual) != std::signbit(expected))) { std::cerr << "numeric check " << check << ": " << actual << " != " << expected << "\\n"; std::exit(1); } }
template<typename T> void same_vector(const std::vector<T>& actual, std::initializer_list<double> expected) { assert(actual.size()==expected.size()); std::size_t index=0; for(double value:expected) same(actual[index++],value); }
int main() {
    bbl::SpriteAtlasRecord atlas;
    atlas.frames = {${frames.map((frame) => `bbl::SpriteFrame{${tuple(frame.uvMin)}, ${tuple(frame.uvMax)}, {}, ${tuple(frame.pivot)}}`).join(", ")}};
    ${checks.join("\n")}
    using namespace bbl;
    for (double invalid : {0.5, std::numeric_limits<double>::quiet_NaN(), -1.0, 3.0}) {
        bool threw = false; try { (void)upstream::resolve_sprite_frame(atlas, invalid); } catch (const std::exception&) { threw = true; } assert(threw);
    }
    BillboardSystemRecord full; full.capacity = 2147483648u;
    bool too_large = false; try { case0::grow_billboard_capacity(full, 2147483649.0); } catch (const std::exception&) { too_large = true; } assert(too_large && full.instance_data.empty());
    Engine engine; engine.sprite_atlases.push_back(atlas); engine.billboard_systems.emplace_back();
    auto& system = engine.billboard_systems[0]; system.atlas = {0}; case0::resize_billboard_storage(system, 1);
    BillboardSpriteProps props; props.position = {1, 2, 3}; props.has_position = true; props.size_world = {6, 7}; props.has_size_world = true;
    auto first = add_billboard_sprite(engine, {0}, props); props.size_world = {8, 9}; auto second = add_billboard_sprite(engine, {0}, props);
    BillboardSpriteProps hide; hide.has_visible = true; hide.visible = false; update_billboard_sprite(engine, second, hide);
    remove_billboard_sprite(engine, first);
    hide.visible = true; update_billboard_sprite(engine, second, hide);
    same(system.instance_data[3], 8); same(system.instance_data[4], 9);
    clear_billboard_sprites(engine, {0}); assert(system.count == 0); for (float size : system.saved_size) same(size, 0);
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

test("billboard compiler admits every source update field at double precision", () => {
    const compiled =
        compileSource(`import {createEngine, loadSpriteAtlas, createFacingBillboardSystem, addBillboardSprite, updateBillboardSprite} from "@babylonjs/lite";
        async function main() { const engine=await createEngine({}); const atlas=await loadSpriteAtlas(engine,"atlas.png",{gridSize:[1,1]});
        const system=createFacingBillboardSystem(atlas); const sprite=addBillboardSprite(system,{position:[1e100,0,0],sizeWorld:[2,3]});
        updateBillboardSprite(sprite,{sizeWorld:[5,6], frame:1, rotation:0.1, pivot:[0,1], color:[1,0,1,1], flipX:true, flipY:false, visible:false}); } main();`);
    assert.match(compiled.cpp, /bbl::Vec2d/);
    assert.match(compiled.cpp, /bbl::Vec4d/);
    assert.match(compiled.cpp, /bbl::update_billboard_sprite/);
});

test("unsupported source record changes refuse at the billboard storage boundary", () => {
    assert.throws(
        () =>
            lowerBillboardInstances(
                doctoredContext(modulePath, "frame.uvMin[0]", "frame.other[0]"),
            ),
        /Unsupported pinned/,
    );
});
