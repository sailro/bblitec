import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

test(
    "platform locals remain visible through shared and retained closures",
    { skip: !tools },
    () => {
        const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        function hidden(): boolean { return document.hidden; }
        async function main(): Promise<void> {
            await createEngine({});
            const button = document.createElement("button");
            const snapshot = button.getBoundingClientRect();
            button.addEventListener("pointermove", event => {
                function offset(): number { return event.clientX - snapshot.left; }
                button.textContent = String(offset() / snapshot.width);
            });
            document.addEventListener("visibilitychange", () => {
                button.textContent = String(hidden());
            });
            document.addEventListener("visibilitychange", () => {
                button.hidden = hidden();
            });
            document.body.appendChild(button);
        }
        void main();
    `);
        const rect = /const auto (\w+) = bbl::ui_get_client_rect\(/.exec(
            result.cpp,
        )?.[1];
        assert.ok(rect);
        assert.match(
            result.cpp,
            new RegExp(`auto& ${rect} = \\w+\\.capture\\d+`),
        );
        const output = resolve("artifacts/platform-local-capture-check");
        mkdirSync(output, { recursive: true });
        const source = join(output, "check.cpp");
        writeFileSync(source, result.cpp);
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            "/c",
            "/DBBLITE_HAS_UI=1",
            `/Fo:${output}\\`,
            "/I",
            "native/include",
            source,
        ]);
    },
);

test(
    "stored closures retain copied nullable handles and their presence storage",
    { skip: !tools },
    () => {
        const result = compileSource(`
        import { createEngine, createBox } from "@babylonjs/lite";
        import type { Mesh } from "@babylonjs/lite";
        async function main(canvas: HTMLCanvasElement): Promise<void> {
            const engine = await createEngine(canvas);
            const callbacks = new Set<() => void>();
            let second: HTMLCanvasElement | null = null;
            if (Math.random() > 0.5) {
                second = document.createElement("canvas");
                const copied = second;
                callbacks.add(() => copied.remove());
            }
            let mesh: Mesh | null = null;
            if (Math.random() > 0.5) mesh = createBox(engine);
            const copiedMesh = mesh;
            callbacks.add(() => { if (copiedMesh) copiedMesh.position.x += 1; });
            for (const callback of callbacks) callback();
        }
        main(document.createElement("canvas"));
    `);
        assert.ok(
            (result.cpp.match(/bbl::js::make_closure\(/g)?.length ?? 0) >= 2,
        );
        const output = resolve("artifacts/closure-capture-scope-check");
        mkdirSync(output, { recursive: true });
        const source = join(output, "check.cpp");
        writeFileSync(source, result.cpp);
        // Compile the generated closures themselves; text assertions cannot prove
        // that all native identifiers resolve inside an explicit environment.
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            "/c",
            "/DBBLITE_HAS_UI=1",
            `/Fo:${output}\\`,
            "/I",
            "native/include",
            source,
        ]);
    },
);
