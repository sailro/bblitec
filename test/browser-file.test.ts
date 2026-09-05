import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { CompileError, compileSource } from "../src/compiler.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

function compileFileBody(body: string): ReturnType<typeof compileSource> {
    return compileSource(
        `
        import { createEngine, startEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            ${body}
            await startEngine(engine);
        }

        void main();
        `,
        { fileName: "examples/browser-file-fixture.ts" },
    );
}

test("lowers Blob string and byte parts with static MIME options", () => {
    const result = compileFileBody(`
        const bytes = new Uint8Array([0, 255]);
        const blob = new Blob(["left", bytes, "right"], {
            type: "Application/JSON",
        });
        const size = blob.size;
        const type = blob.type;
        engine.canvas.width = size + type.length;
    `);

    assert.ok(result.manifest.features.includes("browser:file"));
    assert.ok(result.manifest.runtimeSources.includes("src/pal_file.cpp"));
    assert.match(result.cpp, /#include <bblite\/js_file\.hpp>/);
    assert.match(result.cpp, /bbl::js::blob_part_string\("left"\)/);
    assert.match(result.cpp, /bbl::js::blob_part_bytes\(v_bytes\)/);
    assert.match(result.cpp, /"application\/json"/);
    assert.match(result.cpp, /\.size\(\)/);
    assert.match(result.cpp, /\.type\(\)/);
});

test("refuses unsupported Blob parts and options by name", () => {
    const refusal = (source: string, pattern: RegExp): void => {
        assert.throws(
            () => compileFileBody(source),
            (error: unknown) =>
                error instanceof CompileError &&
                pattern.test(error.message),
        );
    };
    refusal(
        `const blob = new Blob([42], { type: "text/plain" });`,
        /BlobPart type 'number'.*strings, Uint8Array, and ArrayBuffer/,
    );
    refusal(
        `const blob = new Blob(["x"], { endings: "native" });`,
        /Blob option 'endings' is not lowered/,
    );
    refusal(
        `const parts = ["x"]; const blob = new Blob(parts);`,
        /Blob parts require an array literal/,
    );
    refusal(
        `const blob = new Blob([new Float32Array([1])]);`,
        /BlobPart type 'Float32Array'/,
    );
});

test("lowers object URLs and retained anchor downloads without navigation", () => {
    const result = compileFileBody(`
        const blob = new Blob(["{}"], { type: "application/json" });
        const first = URL.createObjectURL(blob);
        const second = URL.createObjectURL(blob);
        const distinct = first !== second;
        const anchor = document.createElement("a");
        anchor.href = first;
        anchor.download = "map.json";
        anchor.click();
        URL.revokeObjectURL(first);
        URL.revokeObjectURL(first);
        URL.revokeObjectURL(second);
        engine.canvas.height = distinct ? 1 : 0;
    `);

    assert.match(result.cpp, /bbl::js::create_object_url/);
    assert.match(result.cpp, /bbl::ui_set_download_url/);
    assert.match(result.cpp, /bbl::ui_set_download_name/);
    assert.match(result.cpp, /bbl::ui_click/);
    assert.match(result.cpp, /v_first != v_second/);
    assert.equal(
        (result.cpp.match(/bbl::js::revoke_object_url/g) ?? []).length,
        3,
    );
    assert.doesNotMatch(result.cpp, /URL\.createObjectURL|href|download =/);

    assert.throws(
        () =>
            compileFileBody(`
                const anchor = document.createElement("a");
                anchor.href = "https://example.invalid/";
                anchor.download = "map.json";
                anchor.click();
            `),
        (error: unknown) =>
            error instanceof CompileError &&
            /Expected object-url, received string/.test(error.message),
    );
});

test("lowers one-file input, change dispatch, files[0], and File.text", () => {
    const result = compileFileBody(`
        let imports = 0;
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json,.json";
        input.addEventListener("change", () => {
            const file = input.files?.[0];
            if (!file) return;
            void file.text().then((text) => {
                let json: unknown;
                try {
                    json = JSON.parse(text);
                } catch {
                    console.warn("bad json");
                    return;
                }
                if (json) imports += 1;
            });
        });
        input.click();
        engine.canvas.width = imports;
    `);

    assert.match(result.cpp, /bbl::ui_set_file_input/);
    assert.match(result.cpp, /bbl::ui_set_file_accept/);
    assert.match(result.cpp, /bbl::ui_on_file_change/);
    assert.match(result.cpp, /bbl::js::input_files/);
    assert.match(result.cpp, /bbl::js::file_at/);
    assert.match(result.cpp, /static_cast<bool>\(v_[^)]+file[^)]*\)/);
    assert.match(result.cpp, /bbl::js::file_text/);
    assert.match(result.cpp, /bbl::js::json_parse/);
    assert.match(
        result.cpp,
        /auto v_imports = bbl::js::make_gc_shared<double>\(0\.0\)/,
        "mutable outer listener state uses a shared closure cell",
    );
    assert.match(
        result.cpp,
        /make_closure\(std::tuple\{v_input, std::ref\(v_engine\), v_imports\}, \[\]\(\[\[maybe_unused\]\] auto& \w+\) \{[\s\S]*bbl::js::file_text[\s\S]*\(\*v_imports\)/,
        "owned callback-local handles are copied while shared state stays live",
    );
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) => id === "native-browser-file-bridge",
        ),
    );
});

test("registers one-shot pointer-lock listeners in the native registry", () => {
    const result = compileFileBody(`
        let transitions = 0;
        document.addEventListener("pointerlockchange", () => {
            transitions += 1;
        }, { once: true });
        engine.canvas.width = transitions;
    `);

    assert.match(
        result.cpp,
        /bbl::on_pointer_lock_change\(v_engine, \d+u, bbl::js::make_closure\(std::tuple\{v_transitions\}, \[\]\([^]*?\}\), true\);/,
    );
    assert.doesNotMatch(result.cpp, /event_once|(?:std::make_shared|bbl::js::make_gc_shared)<bool>\(false\)/);
});

test("lowers the complete map export/import browser source shape", () => {
    const result = compileSource(
        `
        import { createEngine, startEngine } from "@babylonjs/lite";

        interface World {
            readonly version: number;
            readonly parts: number[];
        }

        function serializeWorld(parts: number[]): World {
            return { version: 1, parts };
        }

        function loadWorld(value: unknown): number {
            const world = value as Partial<World> | null;
            return world && world.version === 1 &&
                Array.isArray(world.parts) ? world.parts.length : 0;
        }

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const workspace = { parts: [1, 2, 3] };
            let imported = 0;

            const exportButton = document.createElement("button");
            exportButton.addEventListener("click", () => {
                const json = JSON.stringify(
                    serializeWorld(workspace.parts),
                    null,
                    2,
                );
                const blob = new Blob([json], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = "map.json";
                anchor.click();
                URL.revokeObjectURL(url);
            });

            const importButton = document.createElement("button");
            importButton.addEventListener("click", () => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = "application/json,.json";
                input.addEventListener("change", () => {
                    const file = input.files?.[0];
                    if (!file) return;
                    void file.text().then((text) => {
                        let json: unknown;
                        try {
                            json = JSON.parse(text);
                        } catch {
                            return;
                        }
                        for (const part of [...workspace.parts]) {
                            imported += part;
                        }
                        imported += loadWorld(json);
                    });
                });
                input.click();
            });

            document.body.append(exportButton, importButton);
            engine.canvas.width = imported;
            await startEngine(engine);
        }

        void main();
        `,
        { fileName: "examples/browser-map-io-fixture.ts" },
    );

    for (const symbol of [
        "json_stringify",
        "create_object_url",
        "ui_set_download_url",
        "ui_on_file_change",
        "input_files",
        "file_text",
        "json_parse",
        "array_from_iterable",
    ]) {
        assert.match(result.cpp, new RegExp(symbol));
    }
});

test("refuses multiple, directories, and unsupported accept syntax", () => {
    const refusal = (source: string, pattern: RegExp): void => {
        assert.throws(
            () => compileFileBody(source),
            (error: unknown) =>
                error instanceof CompileError &&
                pattern.test(error.message),
        );
    };
    refusal(
        `
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        `,
        /property 'multiple'.*one file and no directories/,
    );
    refusal(
        `
        const input = document.createElement("input");
        input.type = "file";
        input.webkitdirectory = true;
        `,
        /property 'webkitdirectory'.*one file and no directories/,
    );
    refusal(
        `
        const input = document.createElement("input");
        input.setAttribute("type", "file");
        input.setAttribute("multiple", "");
        `,
        /attribute 'multiple'.*one file and no directories/,
    );
    refusal(
        `
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        `,
        /accept entry 'image\/\*' is not supported/,
    );
    refusal(
        `
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/x-unknown";
        `,
        /accept entry 'application\/x-unknown' cannot be mapped/,
    );
    refusal(
        `
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/x-unknown,.json";
        `,
        /accept entry 'application\/x-unknown' cannot be mapped/,
    );
});

test("keeps scenes without browser files header- and link-neutral", () => {
    const result = compileFileBody(`
        const button = document.createElement("button");
        button.textContent = "ordinary UI";
        document.body.appendChild(button);
    `);

    assert.ok(!result.manifest.features.includes("browser:file"));
    assert.ok(!result.manifest.runtimeSources.includes("src/pal_file.cpp"));
    assert.doesNotMatch(result.cpp, /js_file\.hpp|create_object_url|file_text/);
});

test("browser file ownership stays generic and PAL-isolated", () => {
    const compiler = readFileSync(
        resolve("src/compiler/browser-file.ts"),
        "utf8",
    );
    assert.doesNotMatch(
        compiler,
        /sandblox|map-io-ui|createMapIoUi/i,
        "the compiler is keyed on browser globals and value kinds, not an app",
    );
    assert.match(compiler, /isDefaultLibraryIdentifier/);
    assert.match(compiler, /BlobPart type/);

    const shim = readFileSync(
        resolve("native/include/bblite/js_file.hpp"),
        "utf8",
    );
    const runtime = readFileSync(
        resolve("native/include/bblite/runtime.hpp"),
        "utf8",
    );
    const voxelShim = readFileSync(
        resolve("native/include/bblite/js_voxel_file.hpp"),
        "utf8",
    );
    assert.doesNotMatch(shim, /<filesystem>|<fstream>|GetOpenFileName|MoveFile/);
    assert.doesNotMatch(
        voxelShim,
        /<filesystem>|<fstream>|GetOpenFileName|MoveFile/,
    );
    assert.match(shim, /pal::choose_save_file/);
    assert.doesNotMatch(shim, /read_selected_file_text/);
    const browserFileRecord = runtime.slice(
        runtime.indexOf("struct BrowserFileRecord {"),
        runtime.indexOf(
            "#endif",
            runtime.indexOf("struct BrowserFileRecord {"),
        ),
    );
    assert.match(browserFileRecord, /std::vector<std::uint8_t> bytes/);
    assert.match(browserFileRecord, /std::string display_name/);
    assert.doesNotMatch(browserFileRecord, /\bpath\b/);
    assert.match(
        runtime,
        /class BrowserFileHandle[\s\S]*std::shared_ptr<BrowserFileRecord> record_/,
    );
    assert.match(runtime, /maximum_browser_file_snapshot_bytes[\s\S]*256u \* 1024u \* 1024u/);
    assert.doesNotMatch(runtime, /std::vector<BrowserFileRecord> browser_files/);
    assert.match(
        shim,
        /BrowserFileRecord\* current = destination\.get\(\)[\s\S]{0,180}destination\.unique\(\)[\s\S]{0,180}current->replace/,
        "an unshared current selection is reused instead of appended",
    );
    assert.match(shim, /click_download_anchor\(\s*Engine& engine,\s*UiElementHandle/);
    assert.match(shim, /bytes = payload\.bytes/);
    assert.match(shim, /browser_file_ui_element\(engine, handle\)/);
    const ui = readFileSync(
        resolve("native/src/pal_ui_rml.cpp"),
        "utf8",
    );
    assert.match(
        ui,
        /const auto callbacks = ui_element\(engine, element\)\.click_callbacks;[\s\S]{0,160}callback\(\);[\s\S]{0,300}const std::string tag = ui_element\(engine, element\)\.tag;[\s\S]{0,80}tag == "a"/,
        "programmatic and projected clicks dispatch listeners before the default action",
    );
    assert.match(
        ui,
        /void ui_remove\([\s\S]{0,300}release_browser_file_subtree\(engine, element\)/,
        "element removal releases its browser-file ownership",
    );
    assert.match(
        ui,
        /void ui_replace_children\([\s\S]{0,300}release_browser_file_subtree\(engine, child\)/,
        "subtree removal releases descendant browser-file ownership",
    );
    assert.match(ui, /event_type == "click"[\s\S]{0,80}ui_click\(engine, element\)/);

    const projection = readFileSync(
        resolve("src/compiler/output-projection.ts"),
        "utf8",
    );
    assert.match(
        projection,
        /"browser:file": \["src\/pal_file\.cpp"\]/,
    );
    const textureExecutor = readFileSync(
        resolve("src/compiler/browser-texture-function.ts"),
        "utf8",
    );
    assert.match(
        textureExecutor,
        /object URL/,
        "browser-produced texture object URLs remain in their Chromium path",
    );

    const palFile = readFileSync(resolve("native/src/pal_file.cpp"), "utf8");
    assert.match(palFile, /SDL_ShowFileDialogWithProperties/);
    assert.match(palFile, /SDL_PumpEvents\(\)/);
    assert.doesNotMatch(
        palFile,
        /SDL_PollEvent|GetOpenFileName|GetSaveFileName|CommDlg|_WIN32/,
        "Windows, Linux, and macOS share SDL's dialog path without app-event dispatch",
    );
    const platformEvents = readFileSync(
        resolve("native/src/pal_platform_events.hpp"),
        "utf8",
    );
    assert.match(
        platformEvents,
        /dispatch_pointer_lock_change[\s\S]{0,120}pointer_lock_change_callbacks\.dispatch\(\)/,
        "dialog-induced pointer-lock dispatch tolerates listener growth",
    );
    const fileIo = readFileSync(
        resolve("native/src/pal_file_io.hpp"),
        "utf8",
    );
    assert.match(fileIo, /random_staging_token/);
    assert.match(fileIo, /CREATE_NEW/);
    assert.match(fileIo, /O_CREAT \| O_EXCL \| O_NOFOLLOW/);
    assert.match(fileIo, /FILE_FLAG_OPEN_REPARSE_POINT/);
    assert.match(fileIo, /FlushFileBuffers/);
    assert.match(fileIo, /::fsync/);
    const cmake = readFileSync(resolve("native/CMakeLists.txt"), "utf8");
    assert.doesNotMatch(cmake, /comdlg32/);
});

const nativeTools = optionalNativeFixtureTools();

test(
    "native Blob, object URL, picker, File.text, and atomic IO hold",
    { skip: !nativeTools },
    () => {
        const output = resolve("artifacts/browser-file-check");
        rmSync(output, { recursive: true, force: true });
        mkdirSync(output, { recursive: true });
        const generatedListener = compileFileBody(`
            let imports = 0;
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "application/json,.json";
            input.addEventListener("change", () => {
                const file = input.files?.[0];
                if (!file) return;
                void file.text().then((text) => {
                    if (text) imports += 1;
                });
            });
            document.addEventListener("pointerlockchange", () => {
                imports += 1;
            }, { once: true });
            input.click();
            engine.canvas.width = imports;
        `);
        writeFileSync(
            join(output, "generated-listener.cpp"),
            generatedListener.cpp,
            "utf8",
        );
        const common = [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/permissive-",
            "/EHsc",
        ];
        try {
            runNativeFixtureCompiler(nativeTools!, [
                ...common,
                "/DBBLITE_HAS_UI=0",
                "/DBBLITE_HAS_BROWSER_FILE=1",
                `/Fo:${output}\\blob-only.obj`,
                "/I",
                "native/include",
                "test/fixtures/js-file/browser-file-blob-only.cpp",
                "/c",
            ]);
            runNativeFixtureCompiler(nativeTools!, [
                ...common,
                "/DBBLITE_HAS_UI=1",
                "/DBBLITE_HAS_BROWSER_FILE=1",
                `/Fo:${output}\\generated-listener.obj`,
                "/I",
                "native/include",
                join(output, "generated-listener.cpp"),
                "/c",
            ]);
            runNativeFixtureCompiler(nativeTools!, [
                ...common,
                "/DBBLITE_HAS_UI=1",
                "/DBBLITE_HAS_BROWSER_FILE=1",
                `/Fo:${output}\\`,
                `/Fe:${output}\\browser-file-check.exe`,
                "/I",
                "native/include",
                "/I",
                "native/src",
                "test/fixtures/js-file/browser-file-check.cpp",
            ]);
            runNativeFixtureCompiler(nativeTools!, [
                ...common,
                "/DBBLITE_HAS_UI=0",
                "/DBBLITE_HAS_BROWSER_FILE=1",
                `/Fo:${output}\\`,
                `/Fe:${output}\\browser-file-pal-check.exe`,
                "/I",
                "native/include",
                "/I",
                "native/src",
                "/I",
                `${nativeFixtureVcpkgRoot}\\include`,
                "test/fixtures/js-file/browser-file-pal-check.cpp",
                "native/src/pal_file.cpp",
                "/link",
                `/LIBPATH:${nativeFixtureVcpkgRoot}\\lib`,
                "SDL3.lib",
            ]);
            const root = join(output, "root");
            mkdirSync(root, { recursive: true });
            const result = execFileSync(
                join(output, "browser-file-check.exe"),
                [root],
                { stdio: "pipe" },
            ).toString();
            assert.match(result, /browser-file-check: ok/);
            const palResult = execFileSync(
                join(output, "browser-file-pal-check.exe"),
                [root],
                {
                    env: {
                        ...process.env,
                        PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${process.env["PATH"] ?? ""}`,
                    },
                    stdio: "pipe",
                },
            ).toString();
            assert.match(palResult, /browser-file-pal-check: ok/);
        } finally {
            rmSync(output, { recursive: true, force: true });
        }
    },
);
