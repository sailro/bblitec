import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    sharedGpuSource,
} from "./native-fixture.js";

function program(slot: string): string {
    return `
    import { createEngine, startEngine } from "babylon-lite";
    async function main() {
        const engine = await createEngine({});
        await startEngine(engine);
        let frames = 0;
        const internals = engine as unknown as { _renderFn?: ${slot} };
        const drawFrame = internals._renderFn;
        if (drawFrame)
            internals._renderFn = (now: number): void => {
                drawFrame(now);
                frames++;
            };
        if (frames < 0) throw new Error("frames");
    }
`;
}

test("an application wraps the engine's frame function", () => {
    const { cpp } = compileSource(program("(now: number) => void"));
    assert.match(
        cpp,
        /bbl::js::Callback<void\(double\)> \w+ = bbl::engine_render_function\(/,
    );
    assert.match(cpp, /bbl::set_engine_render_function\(/);
    assert.throws(
        () => compileSource(program("(now: number) => number")),
        /engine\._renderFn holds the engine's \(now: number\) => void frame function/,
    );
});

const tools = optionalNativeFixtureTools(false);
test(
    "the conductor runs a replaced frame function between the frame's RAF phases",
    { skip: !tools },
    () => {
        const output = resolve("artifacts/render-function-conductor");
        mkdirSync(output, { recursive: true });
        const shared = sharedGpuSource();
        const dispatch = [
            /\nvoid run_animation_frame_callbacks\(Engine& engine\) \{[\s\S]*?\n\}/,
            /\nstd::optional<double> begin_animation_turn\([\s\S]*?\n\}/,
            /\nvoid finish_animation_turn\(Engine& engine\) \{[\s\S]*?\n\}/,
            /\nvoid finish_frame\(Engine& engine\) \{[\s\S]*?\n\}/,
        ].map((pattern) => {
            const body = shared.match(pattern)?.[0];
            assert.ok(
                body,
                `The actual PAL body ${pattern} must be exercised.`,
            );
            return body;
        });
        writeFileSync(join(output, "dispatch.hpp"), dispatch.join("\n"));
        const executable = join(output, "check.exe");
        runNativeFixtureCompiler(tools!, [
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            output,
            "/I",
            "native/src",
            "test/fixtures/render-function-conductor-check.cpp",
        ]);
        assert.match(
            execFileSync(executable, { encoding: "utf8" }),
            /render-function-conductor-check: ok/,
        );
    },
);
