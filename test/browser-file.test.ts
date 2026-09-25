import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { CompileError, compileSource } from "../src/compiler.js";
import {
    cppFunction,
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
                error instanceof CompileError && pattern.test(error.message),
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
        /make_closure\(bblscene::bbl_environment_\w+\{v_input, std::ref\(v_engine\), v_imports\}, bblscene::\w+/,
        "owned callback-local handles are copied while shared state stays live",
    );
    assert.ok(
        result.manifest.adaptations.some(
            ({ id }) => id === "native-browser-file-bridge",
        ),
    );
});

test("lowers a file input's onchange handler property and FileReader handlers", () => {
    const result = compileFileBody(`
        let loaded = 0;
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                if (typeof reader.result === "string") loaded += reader.result.length;
            };
            reader.onerror = () => {
                loaded = -1;
            };
            reader.readAsText(file);
        };
        input.click();
        engine.canvas.width = loaded;
    `);
    assert.match(result.cpp, /bbl::ui_on_file_change\(v_engine, v_input,/);
    assert.match(result.cpp, /bbl::js::FileReader\{\}/);
    assert.match(result.cpp, /\.set_onload\(/);
    assert.match(result.cpp, /\.set_onerror\(/);
    assert.match(result.cpp, /\.read_as_text\(v_engine, /);
    // The reader's null result is typeof "object", as the browser's is.
    assert.match(
        result.cpp,
        /\.result\(\)\.has_value\(\) \? "string" : "object"/,
    );

    const refusal = (source: string, pattern: RegExp): void =>
        assert.throws(
            () => compileFileBody(source),
            (error: unknown) =>
                error instanceof CompileError && pattern.test(error.message),
        );
    refusal(
        `const button = document.createElement("button");
         button.onclick = () => {};`,
        /event handler property 'onclick' is not lowered/,
    );
    refusal(
        `const input = document.createElement("input");
         input.type = "file";
         input.onchange = () => {};
         input.onchange = () => {};`,
        /onchange handler is assigned once/,
    );
    refusal(
        `const reader = new FileReader();
         reader.readAsText(new Blob(["x"]));
         reader.onload = () => {};`,
        /assigned before readAsText/,
    );
    refusal(
        `const reader = new FileReader();
         reader.readAsDataURL(new Blob(["x"]));`,
        /FileReader method 'readAsDataURL' is not lowered/,
    );
});

test("FileReader decodes a Blob as the Encoding Standard does, natively", async (t) => {
    const program = `
        function readText(blob: Blob): Promise<string> {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
                reader.onerror = () => reject(new Error("read"));
                reader.readAsText(blob);
            });
        }

        async function main(): Promise<void> {
            const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, 0x63, 0x61, 0x66, 0xc3, 0xa9, 0xff]);
            const first = await readText(new Blob([utf8]));
            if (first !== "caf\\u00e9\\ufffd") throw new Error("UTF-8 with BOM: " + first);
            const utf16 = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x3d, 0xd8, 0x00, 0xde, 0x3d]);
            const second = await readText(new Blob([utf16]));
            if (second !== "A\\u{1F600}\\ufffd") throw new Error("UTF-16LE with BOM: " + second);
            const big = new Uint8Array([0xfe, 0xff, 0x00, 0x42]);
            if ((await readText(new Blob([big, "!"]))) !== "B\\ufffd") throw new Error("UTF-16BE with BOM");
            if ((await readText(new Blob(["plain"]))) !== "plain") throw new Error("plain text");
        }
    `;
    const directory = resolve("artifacts/file-reader-check");
    mkdirSync(directory, { recursive: true });
    const result = compileSource(`${program}\nvoid main();\n`, {
        fileName: join(directory, "entry.ts"),
    });
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const cpp = join(directory, "check.cpp");
    const exe = join(directory, "check.exe");
    writeFileSync(cpp, result.cpp);
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/DBBLITE_HAS_UI=0",
        "/DBBLITE_HAS_BROWSER_FILE=1",
        "/I",
        "native/include",
        `/Fo:${directory}/`,
        `/Fe:${exe}`,
        cpp,
    ]);
    const execution = execFileSync(exe, { encoding: "utf8" });
    assert.equal(execution, "");
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
        /bbl::on_pointer_lock_change\(v_engine, \d+u, bbl::js::make_closure\(bblscene::bbl_environment_\w+\{v_transitions\}, bblscene::\w+/,
    );
    assert.doesNotMatch(
        result.cpp,
        /event_once|(?:std::make_shared|bbl::js::make_gc_shared)<bool>\(false\)/,
    );
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
        "serializeWorld",
    ]) {
        assert.match(result.cpp, new RegExp(symbol));
    }
    assert.match(result.cpp, /World\{1\.0, v_\w*parts\}/);
});

test("refuses multiple, directories, and unsupported accept syntax", () => {
    const refusal = (source: string, pattern: RegExp): void => {
        assert.throws(
            () => compileFileBody(source),
            (error: unknown) =>
                error instanceof CompileError && pattern.test(error.message),
        );
    };
    refusal(
        `const input=document.createElement('input');input.type='file';input.type='text';`,
        /without changing a file input/,
    );
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
    assert.match(compiler, /libraryGlobal/);
    assert.match(compiler, /BlobPart type/);

    const shim = readFileSync(
        resolve("native/include/bblite/js_file.hpp"),
        "utf8",
    );
    const runtime = readFileSync(
        resolve("native/include/bblite/runtime.hpp"),
        "utf8",
    );
    assert.doesNotMatch(
        shim,
        /<filesystem>|<fstream>|GetOpenFileName|MoveFile/,
    );
    assert.match(shim, /pal::save_file/);
    assert.doesNotMatch(shim, /read_selected_file_text/);
    const browserFileRecord = cppFunction(
        runtime,
        "struct BrowserFileRecord {",
    );
    assert.match(browserFileRecord, /std::vector<std::uint8_t> bytes/);
    assert.match(browserFileRecord, /std::string display_name/);
    assert.doesNotMatch(browserFileRecord, /\bpath\b/);
    assert.match(
        runtime,
        /class BrowserFileHandle[\s\S]*std::shared_ptr<BrowserFileRecord> record_/,
    );
    assert.match(
        runtime,
        /maximum_browser_file_snapshot_bytes[\s\S]*256u \* 1024u \* 1024u/,
    );
    assert.doesNotMatch(
        runtime,
        /std::vector<BrowserFileRecord> browser_files/,
    );
    assert.match(
        shim,
        /BrowserFileRecord\* current = destination\.get\(\)[\s\S]{0,180}destination\.unique\(\)[\s\S]{0,180}current->replace/,
        "an unshared current selection is reused instead of appended",
    );
    assert.match(
        shim,
        /click_download_anchor\(\s*Engine& engine,\s*UiElementHandle/,
    );
    assert.match(shim, /bytes = payload\.bytes/);
    assert.match(shim, /browser_file_ui_element\(engine, handle\)/);
    const ui = readFileSync(resolve("native/src/pal_ui_rml.cpp"), "utf8");
    assert.match(
        cppFunction(ui, "void ui_click("),
        /dispatch_ui_click\(engine, element, trusted, true\)/,
        "programmatic clicks use the shared listener and default-action dispatch",
    );
    assert.match(
        cppFunction(ui, "bool dispatch_ui_click("),
        /const auto callbacks = ui_element\(engine, element\)\.click_callbacks;[\s\S]*dispatch_dom_pointer[\s\S]*callback\(\);[\s\S]*const std::string tag = ui_element\(engine, element\)\.tag;[\s\S]*tag == "a"/,
        "programmatic and projected clicks dispatch listeners before the default action",
    );
    assert.match(
        cppFunction(ui, "void ui_remove("),
        /release_browser_file_subtree\(engine, element\)/,
        "element removal releases its browser-file ownership",
    );
    assert.match(
        cppFunction(ui, "void ui_replace_children("),
        /release_browser_file_subtree\(engine, child\)/,
        "subtree removal releases descendant browser-file ownership",
    );
    assert.match(
        cppFunction(ui, "void ProcessEvent(Rml::Event& event) override"),
        /event_type == "click"[\s\S]*dispatch_ui_click\(engine, element, true, first_listener\)/,
        "projected clicks use the same listener and default-action dispatch",
    );

    const projection = readFileSync(
        resolve("src/compiler/output-projection.ts"),
        "utf8",
    );
    assert.match(projection, /"browser:file": \["src\/pal_file\.cpp"\]/);
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
    const iosFile = readFileSync(resolve("native/src/pal_file_ios.mm"), "utf8");
    assert.match(iosFile, /initForOpeningContentTypes:types\s+asCopy:NO/);
    assert.match(
        iosFile,
        /initForExportingURLs:@\[\s*export_url\s*\]\s+asCopy:YES/,
    );
    assert.match(iosFile, /startAccessingSecurityScopedResource/);
    assert.match(
        iosFile,
        /@finally[\s\S]{0,130}stopAccessingSecurityScopedResource/,
    );
    assert.match(iosFile, /coordinateReadingItemAtURL/);
    assert.match(iosFile, /SDL_RunOnMainThread/);
    assert.doesNotMatch(iosFile, /SDL_PollEvent/);
    const platformEvents = readFileSync(
        resolve("native/src/pal_platform_events.hpp"),
        "utf8",
    );
    assert.match(
        platformEvents,
        /dispatch_pointer_lock_change[\s\S]{0,120}pointer_lock_change_callbacks\.dispatch\(\)/,
        "dialog-induced pointer-lock dispatch tolerates listener growth",
    );
    const fileIo = readFileSync(resolve("native/src/pal_file_io.hpp"), "utf8");
    assert.match(fileIo, /random_staging_token/);
    assert.match(fileIo, /CREATE_NEW/);
    assert.match(fileIo, /O_CREAT \| O_EXCL \| O_NOFOLLOW/);
    assert.match(fileIo, /FILE_FLAG_OPEN_REPARSE_POINT/);
    assert.match(fileIo, /FlushFileBuffers/);
    assert.match(fileIo, /::fsync/);
    const cmake = readFileSync(resolve("native/CMakeLists.txt"), "utf8");
    assert.doesNotMatch(cmake, /comdlg32/);
    assert.match(
        cmake,
        /if\(IOS AND "browser:file" IN_LIST BBLITE_RUNTIME_FEATURES\)[\s\S]{0,600}pal_file_ios\.mm/,
    );
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
                "/DBBLITE_PHYSICS_VIEWER=1",
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
