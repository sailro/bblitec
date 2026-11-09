import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    runRmlUiFixture,
} from "./native-fixture.js";

const source = `
    import { createEngine, startEngine } from "@babylonjs/lite";
    async function main() {
        const engine = await createEngine({});
        let cleanups = 0;
        try {
            await startEngine(engine);
            if (cleanups !== 0) throw new Error("finally ran before the continuation");
        } finally {
            cleanups++;
        }
        if (cleanups !== 1) throw new Error("finally did not complete before the following statement");
    }
`;

test("startEngine finally cleanup belongs to the continuation completion", () => {
    const cpp = compileSource(source).cpp;
    assert.match(cpp, /defer_start_continuation/);
    assert.match(cpp, /finally_completion_\d+\.run\(\)/);
});

test("a block that closes after startEngine suspends in the application realm", () => {
    const entry = (body: string, call = "void main();"): string => `
        import { createEngine, startEngine } from "@babylonjs/lite";
        let frames = 0;
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            ${body}
        }
        ${call}
    `;
    const create = "const engine = await createEngine(canvas);";
    const start =
        "await startEngine(engine); requestAnimationFrame(() => { frames++; });";
    const flat = compileSource(entry(`${create} ${start}`));
    assert.ok(!flat.manifest.features.includes("platform:window"));
    assert.match(flat.cpp, /defer_start_continuation/);
    for (const program of [
        // The entry promise's rejection handler.
        entry(
            `${create} ${start}`,
            "void main().catch(() => { frames = -1; });",
        ),
        entry(`try { ${create} ${start} } catch { frames = -1; }`),
        entry(`${create} if (performance.now() >= 0) { ${start} }`),
    ]) {
        const result = compileSource(program);
        assert.ok(result.manifest.features.includes("platform:window"));
        assert.match(result.cpp, /co_await bbl::pal::start_realm_engine\(/);
        assert.doesNotMatch(result.cpp, /defer_start_continuation/);
    }
});

test("finally blocks explicitly refuse an additional suspended frame boundary", () => {
    assert.throws(
        () =>
            compileSource(
                source.replace(
                    "if (cleanups !== 0)",
                    "await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); if (cleanups !== 0)",
                ),
            ),
        /finally block spanning startEngine cannot also span a later frame yield/,
    );
});

test("engine-spanning finally erases browser helper cleanup and retains native writes", () => {
    for (const nativeCleanup of ["", "cleanups++;"]) {
        const result = compileSource(
            source
                .replace(
                    "async function main()",
                    'import { installBrowserHelper } from "./fixtures/compiler-modules/browser-helper.js"; async function main()',
                )
                .replace(
                    "let cleanups = 0;",
                    'let cleanups = 0; const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement; const progress = installBrowserHelper(canvas, { estimatedBytes: 42 });',
                )
                .replace("cleanups++;", `progress.done(); ${nativeCleanup}`),
            { fileName: "test/compiler-multi-file-entry.ts" },
        );
        assert.doesNotMatch(result.cpp, /globalThis|fetch|dataset|progress/);
        assert.match(result.cpp, /defer_start_continuation/);
        assert.equal(
            /finally_completion_\d+\.run\(\)/.test(result.cpp),
            nativeCleanup.length > 0,
        );
    }
});

test("engine-spanning finally refuses direct and indirect cleanup exceptions", () => {
    for (const cleanup of [
        'throw new Error("cleanup");',
        'const fail = (): void => { throw new Error("cleanup"); }; fail();',
        'const fail = (): number => { throw new Error("cleanup"); }; const value = { get current(): number { return fail(); } }; cleanups += value.current;',
        'const fail = (): number => { throw new Error("cleanup"); }; const value = { get current(): number { return fail(); } }; const key = "current"; cleanups += value[key];',
        "performance.now();",
        'const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement; canvas.focus();',
    ]) {
        assert.throws(
            () => compileSource(source.replace("cleanups++;", cleanup)),
            /finally block spanning startEngine requires non-throwing cleanup/,
        );
    }
});

const nativeTools = optionalNativeFixtureTools(false);
test(
    "native continuation runs finally at completion and scope guards run only once",
    { skip: !nativeTools },
    () => {
        const output = resolve("artifacts/engine-finally-check");
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, "finally.hpp"), compileSource(source).cpp);
        const executable = join(output, "check.exe");
        runNativeFixtureCompiler(nativeTools!, [
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            output,
            "test/fixtures/engine-finally-check.cpp",
        ]);
        execFileSync(executable, { encoding: "utf8" });
    },
);

test("a rejection before or after startEngine reaches the entry promise's handler", (t) => {
    const directory = resolve("artifacts/engine-start-rejection");
    mkdirSync(directory, { recursive: true });
    const result = compileSource(`
        import { createEngine, startEngine } from "@babylonjs/lite";
        async function main() {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            if (document.body.dataset.mode === "setup") throw new Error("setup failed");
            await startEngine(engine);
            document.body.dataset.started = "true";
            throw new Error("continuation failed");
        }
        void main().catch((error) => {
            document.body.dataset.failure = error.message;
            globalThis.close();
        });
    `);
    assert.ok(result.manifest.features.includes("platform:window"));
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "engine-start-rejection", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
            BBLITE_HAS_PBR_RENDERER: 0,
        },
    });
});
