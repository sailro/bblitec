import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { doubleCpp, floatLiteral } from "../src/cpp-literals.js";
import {
    sharedPinnedContext,
    type LoweringContext,
} from "../src/lowering/context.js";
import {
    particleBillboardSync,
    particleRenderColumns,
    particleRenderColumnsDeclaration,
} from "../src/lowering/particle-sprite-sync.js";
import {
    createJavaScriptFunction,
    transpileCommonJs,
} from "../src/typescript-transpile.js";
import { doctoredContext } from "./doctored-store.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const module = "src/particle/particle-billboard.ts";
type Props = {
    position: number[];
    sizeWorld: number[];
    color: number[];
    rotation: number;
    frame: number;
};
type Buffer = Record<
    (typeof particleRenderColumns)[number][0],
    Float32Array
> & { alive: number };

function reference(
    context: LoweringContext,
): (buffer: Buffer, cells?: Uint16Array) => Props[] {
    const exports = {} as {
        syncParticleBillboard(system: unknown, billboard: Props[]): void;
    };
    const { declaration } = context.functionDeclaration(
        module,
        "syncParticleBillboard",
    );
    createJavaScriptFunction(
        "exports",
        "clearBillboardSprites",
        "addBillboardSpriteIndex",
        transpileCommonJs(declaration.getText(), module),
    )(
        exports,
        (billboard: Props[]) => {
            billboard.length = 0;
        },
        (billboard: Props[], props: Props) => billboard.push(props) - 1,
    );
    return (buffer, cells) => {
        const billboard: Props[] = [
            { position: [], sizeWorld: [], color: [], frame: -1, rotation: -1 },
        ];
        exports.syncParticleBillboard(
            {
                buffer,
                ...(cells ? { _spriteSheet: { cellIndex: cells } } : {}),
            },
            billboard,
        );
        return billboard;
    };
}

test("particle billboard synchronization executes pinned arithmetic and control flow over raw columns", (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const context = sharedPinnedContext();
    const variants = [
        context,
        doctoredContext(
            module,
            "size[i]! * scaleX[i]!",
            "size[i]! + scaleX[i]!",
        ),
        doctoredContext(module, "i < buffer.alive", "i < buffer.alive - 1"),
        doctoredContext(
            module,
            "cellIndex ? cellIndex[i]! : 0",
            "cellIndex ? cellIndex[i]! + 1 : 2",
        ),
    ];
    assert.equal(
        particleBillboardSync(
            doctoredContext(
                module,
                "const posX = buffer.posX;",
                "const posX = buffer /* column */ . posX;",
            ),
        ),
        particleBillboardSync(context),
    );
    const f32 = (...values: number[]): Float32Array => new Float32Array(values);
    const buffer: Buffer = {
        alive: 3,
        posX: f32(0.125, -2, 1e20),
        posY: f32(-0.25, 3, 0),
        posZ: f32(7, 0, -8),
        size: f32(1.0000001192092896, -0.7, 4),
        scaleX: f32(0.3333333432674408, 1.3, 0),
        scaleY: f32(1.0000001192092896, -0.25, 2),
        angle: f32(0.1, -2.7, 1e20),
        colorR: f32(0.1, 0.5, 1),
        colorG: f32(0.3, 0, 0.8),
        colorB: f32(0.2, 0.9, 0),
        colorA: f32(1, 0.2, 0),
    };
    const cells = new Uint16Array([3, 0, 7]);
    const programs: string[] = [];
    const checks: string[] = [];
    for (const [index, pin] of variants.entries()) {
        programs.push(
            `namespace variant_${index} { ${particleBillboardSync(pin)} }`,
        );
        const sync = reference(pin);
        for (const alive of [0, 1, 3])
            for (const hasCells of [false, true]) {
                const expected = sync(
                    { ...buffer, alive },
                    hasCells ? cells : undefined,
                );
                checks.push(
                    `recorded.assign(1, BillboardSpriteProps{}); variant_${index}::sync_particle_billboard(engine, {}, ${alive}.0, columns, cells, ${hasCells}); assert(recorded.size() == ${expected.length});`,
                );
                expected.forEach((props, row) => {
                    for (const [name, native, members] of [
                        ["position", "position", ["x", "y", "z"]],
                        ["sizeWorld", "size_world", ["x", "y"]],
                        ["color", "color", ["x", "y", "z", "w"]],
                    ] as const) {
                        checks.push(`assert(recorded[${row}].has_${native});`);
                        props[name].forEach((value, lane) =>
                            checks.push(
                                `same(recorded[${row}].${native}.${members[lane]}, ${doubleCpp(value)});`,
                            ),
                        );
                    }
                    checks.push(
                        `assert(recorded[${row}].has_rotation && recorded[${row}].has_frame); same(recorded[${row}].rotation, ${doubleCpp(props.rotation)}); same(recorded[${row}].frame, ${doubleCpp(props.frame)});`,
                    );
                });
            }
    }
    const directory = resolve("artifacts/test-node-particle-billboard-sync");
    mkdirSync(directory, { recursive: true });
    const source = join(directory, "check.cpp"),
        executable = join(directory, "check.exe");
    writeFileSync(
        source,
        `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
#include <cmath>
#include <span>
namespace bbl {
std::vector<BillboardSpriteProps> recorded;
void clear_billboard_sprites(Engine&, BillboardSystemHandle) { recorded.clear(); }
double add_billboard_sprite_index(Engine&, BillboardSystemHandle, BillboardSpriteProps props) { recorded.push_back(props); return static_cast<double>(recorded.size() - 1); }
${particleRenderColumnsDeclaration()}
${programs.join("\n")}
void same(double actual, double expected) { assert(actual == expected); if (actual == 0.0) assert(std::signbit(actual) == std::signbit(expected)); }
void check() { Engine engine;
${particleRenderColumns.map(([name, native]) => `const std::array<float, 3> ${native}{${Array.from(buffer[name], floatLiteral).join(", ")}};`).join("\n")}
const ParticleRenderColumns columns{${particleRenderColumns.map(([, native]) => native).join(", ")}};
const std::array<std::uint16_t, 3> cells{3, 0, 7};
${checks.join("\n")}
}
}
int main() { bbl::check(); }
`,
    );
    runNativeFixtureCompiler(tools, [
        "/O2",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        source,
    ]);
    execFileSync(executable, [], { cwd: directory, stdio: "pipe" });
});
