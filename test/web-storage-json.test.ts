import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    mkdirSync,
    readFileSync,
    rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { CompileError, compileSource } from "../src/compiler.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

/**
 * The Web Storage and JSON bridge. The source shapes here are the ones the
 * pinned Sandblox persistence layer writes -- a static key, a nullable
 * read, a shape-guarded parse and a stringify of the world record -- so a
 * regression shows up as a compile failure or a changed emission rather
 * than as a save that silently does nothing.
 */

const worldModule = `
interface WorldPartData {
    readonly s: [number, number, number];
    readonly p: [number, number, number];
    readonly q: [number, number, number, number];
    readonly c: [number, number, number];
    readonly sh?: number;
}

interface WorldJson {
    readonly version: 1;
    readonly parts: WorldPartData[];
}

function serializeWorld(): WorldJson {
    const parts: WorldPartData[] = [];
    parts.push({ s: [1, 2, 3], p: [4, 5, 6], q: [0, 0, 0, 1], c: [1, 1, 1] });
    return { version: 1, parts };
}

function isVec(v: unknown, n: number): v is number[] {
    return Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

function loadWorld(json: unknown): number {
    const file = json as Partial<WorldJson> | null;
    if (!file || file.version !== 1 || !Array.isArray(file.parts)) {
        return 0;
    }
    let created = 0;
    for (const entry of file.parts) {
        const e = entry as Partial<WorldPartData>;
        if (!isVec(e.s, 3) || !isVec(e.p, 3) || !isVec(e.q, 4) || !isVec(e.c, 3)) {
            continue;
        }
        const size: [number, number, number] = [Math.max(1, e.s[0]!), Math.max(1, e.s[1]!), Math.max(1, e.s[2]!)];
        created += size[0] + (e.sh === 1 ? 1 : 0);
    }
    return created;
}
`;

function compilePersistence(body: string): ReturnType<typeof compileSource> {
    return compileSource(
        `
        import { createEngine } from "@babylonjs/lite";
        ${worldModule}
        const STORAGE_KEY = "sandblox-world";

        async function main() {
            const engine = await createEngine({});
            ${body}
            engine.canvas.width = 1;
        }
        `,
        { fileName: "examples/web-storage-fixture.ts" },
    );
}

test("localStorage lowers to the PAL store behind its own feature", () => {
    const result = compilePersistence(`
        let hydrated = 0;
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                hydrated = loadWorld(JSON.parse(raw));
            }
        } catch {
            hydrated = 0;
        }
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeWorld()));
        } catch {
            /* quota */
        }
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch {
            /* unavailable */
        }
        hydrated += 0;
    `);
    assert.ok(result.manifest.features.includes("storage:local"));
    assert.ok(result.manifest.features.includes("data:json"));
    assert.ok(
        result.manifest.runtimeSources.includes("src/pal_storage.cpp"),
        "the storage feature brings its own PAL translation unit",
    );
    assert.match(result.cpp, /#include <bblite\/js_storage\.hpp>/);
    assert.match(result.cpp, /#include <bblite\/js_json\.hpp>/);
    assert.match(
        result.cpp,
        /bbl::js::local_storage_get_item\("sandblox-world"\)/,
    );
    assert.match(
        result.cpp,
        /bbl::js::local_storage_set_item\("sandblox-world", bbl::js::json_stringify\(/,
    );
    assert.match(
        result.cpp,
        /bbl::js::local_storage_remove_item\("sandblox-world"\)/,
    );
    // The reads and writes are inside the source's own try/catch, so a PAL
    // failure takes the arm the browser's quota error takes.
    assert.match(result.cpp, /try \{[\s\S]*local_storage_set_item[\s\S]*\} catch \(\.\.\.\) \{/);
    assert.deepEqual(
        result.manifest.adaptations
            .map(({ id }) => id)
            .filter((id) => id === "native-web-storage" || id === "json-data-bridge"),
        ["json-data-bridge", "native-web-storage"],
    );
});

test("getItem answers a nullable string with JavaScript falsiness", () => {
    const result = compilePersistence(`
        const raw = localStorage.getItem(STORAGE_KEY);
        let found = 0;
        if (raw) {
            found = raw.length;
        }
        found += 0;
    `);
    assert.match(
        result.cpp,
        /bbl::js::Nullable<std::string> \w+ = bbl::js::local_storage_get_item/,
    );
    // Absent AND empty are both falsy, which `has_value()` alone is not.
    assert.match(
        result.cpp,
        /if \(\(\w+\.has_value\(\) && !\w+\.value\(\)\.empty\(\)\)\)/,
    );
});

test("a shadowed localStorage is not the Web Storage global", () => {
    const result = compilePersistence(`
        const localStorage = { getItem: (k: string) => k };
        const raw = localStorage.getItem(STORAGE_KEY);
        engine.canvas.height = raw.length;
    `);
    assert.ok(
        !result.manifest.features.includes("storage:local"),
        "a lexical shadow is the scene's own object, not the host store",
    );
    assert.doesNotMatch(result.cpp, /local_storage_get_item/);
});

test("an unimplemented Web Storage method refuses by name", () => {
    assert.throws(
        () =>
            compilePersistence(`
                localStorage.clear();
            `),
        (error: unknown) =>
            error instanceof CompileError &&
            /localStorage\.clear is not lowered/.test(error.message),
    );
});

test("JSON.stringify emits codecs for the records it reaches, in order", () => {
    const result = compilePersistence(`
        const text = JSON.stringify(serializeWorld());
        engine.canvas.height = text.length;
    `);
    // One codec per reached record, declarations first so either order of
    // reference resolves.
    assert.match(
        result.cpp,
        /inline void json_write\(bbl::js::JsonWriter& writer, const WorldJson& value\);/,
    );
    assert.match(
        result.cpp,
        /inline void json_write\(bbl::js::JsonWriter& writer, const WorldPartDataData& value\);/,
    );
    const codec = /inline void json_write\(bbl::js::JsonWriter& writer, const WorldPartDataData& value\) \{([\s\S]*?)\n\}/.exec(
        result.cpp,
    );
    assert.ok(codec, "the part codec is emitted");
    const keys = [...codec[1]!.matchAll(/writer\.key\("([^"]+)"\)/g)].map(
        (match) => match[1],
    );
    assert.deepEqual(
        keys,
        ["s", "p", "q", "c", "sh"],
        "keys are written in the record's declaration order, not sorted",
    );
    assert.match(
        codec[1]!,
        /if \(value\.sh\.has_value\(\)\) \{/,
        "a property the source declared optional is omitted when absent",
    );
    assert.match(result.cpp, /bbl::js::json_stringify\(bblscene::serializeWorld\(\)\)/);
});

test("JSON.stringify carries a generation-known indent and refuses a replacer", () => {
    const pretty = compilePersistence(`
        const text = JSON.stringify(serializeWorld(), null, 2);
        engine.canvas.height = text.length;
    `);
    assert.match(
        pretty.cpp,
        /bbl::js::json_stringify\(bblscene::serializeWorld\(\), 2\)/,
    );
    assert.throws(
        () =>
            compilePersistence(`
                const text = JSON.stringify(serializeWorld(), (k: string, v: number) => v);
                engine.canvas.height = text.length;
            `),
        (error: unknown) =>
            error instanceof CompileError &&
            /JSON\.stringify lowers with no replacer/.test(error.message),
    );
    assert.throws(
        () =>
            compilePersistence(`
                let width = 2;
                width += 1;
                const text = JSON.stringify(serializeWorld(), null, width);
                engine.canvas.height = text.length;
            `),
        (error: unknown) =>
            error instanceof CompileError &&
            /indentation must be a generation-known/.test(error.message),
    );
});

test("JSON.stringify refuses a record that reaches itself", () => {
    assert.throws(
        () =>
            compileSource(
                `
                import { createEngine } from "@babylonjs/lite";

                interface Node {
                    readonly name: string;
                    readonly child?: Node;
                }

                async function main() {
                    const engine = await createEngine({});
                    const root: Node = { name: "root", child: { name: "leaf" } };
                    const text = JSON.stringify(root);
                    engine.canvas.height = text.length;
                }
                `,
                { fileName: "examples/json-cycle-fixture.ts" },
            ),
        (error: unknown) =>
            error instanceof CompileError &&
            /reaches a cycle/.test(error.message),
    );
});

test("JSON.parse answers a dynamic document the source's guards decide over", () => {
    const result = compilePersistence(`
        const raw = localStorage.getItem(STORAGE_KEY);
        let count = 0;
        if (raw) {
            count = loadWorld(JSON.parse(raw));
        }
        count += 0;
    `);
    assert.match(result.cpp, /bbl::js::json_parse\(/);
    // `!file` is JavaScript truthiness over the whole document.
    assert.match(result.cpp, /\.truthy\(\)/);
    // `file.version !== 1` is a strict comparison, not a coercion.
    assert.match(result.cpp, /\.get\("version"\)\.strict_equals\(1\.0\)/);
    // `Array.isArray(file.parts)` asks the document.
    assert.match(result.cpp, /\.get\("parts"\)\.is_array\(\)/);
    // `for (const entry of file.parts)` walks the document's own elements.
    assert.match(result.cpp, /\.get\("parts"\)\.elements\(\)/);
    // `typeof x === "number"` and `Number.isFinite(x)` over an element.
    assert.match(result.cpp, /\.type_of\(\)/);
    assert.match(result.cpp, /std::isfinite\(\w+\.to_number\(\)\)/);
    // `.length === n` and the indexed reads inside the guard.
    assert.match(result.cpp, /\.length\(\)/);
    assert.match(result.cpp, /\.get\("s"\)\.at\(0\.0\)\.to_number\(\)/);
    // The optional `sh` is a strict comparison over a possibly-absent key.
    assert.match(result.cpp, /\.get\("sh"\)\.strict_equals\(1\.0\)/);
});

test("JSON.parse refuses a reviver rather than ignoring one", () => {
    assert.throws(
        () =>
            compilePersistence(`
                const parsed = JSON.parse("{}", (k: string, v: number) => v);
                engine.canvas.height = parsed ? 1 : 0;
            `),
        (error: unknown) =>
            error instanceof CompileError &&
            /JSON\.parse lowers with no reviver/.test(error.message),
    );
});

test("a scene that reaches neither carries neither", () => {
    const result = compileSource(
        `
        import { createEngine, createHemisphericLight } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const light = createHemisphericLight();
            light.diffuseColor = [0.25, 0.5, 0.75];
        }
        `,
        { fileName: "examples/no-json-fixture.ts" },
    );
    assert.ok(!result.manifest.features.includes("data:json"));
    assert.ok(!result.manifest.features.includes("storage:local"));
    assert.ok(!result.manifest.runtimeSources.includes("src/pal_storage.cpp"));
    assert.doesNotMatch(result.cpp, /js_json\.hpp|js_storage\.hpp/);
    assert.doesNotMatch(result.cpp, /json_write|json_stringify|local_storage_/);
    assert.deepEqual(
        result.manifest.adaptations
            .map(({ id }) => id)
            .filter((id) => id === "native-web-storage" || id === "json-data-bridge"),
        [],
    );
});

test("nlohmann is linked only where a loader or the JSON bridge reaches it", () => {
    const cmake = readFileSync(resolve("native/CMakeLists.txt"), "utf8");
    const gate =
        /if\(\s*"loader:gltf" IN_LIST BBLITE_RUNTIME_FEATURES OR\s*"loader:babylon" IN_LIST BBLITE_RUNTIME_FEATURES OR\s*"data:json" IN_LIST BBLITE_RUNTIME_FEATURES\s*\)\s*find_package\(nlohmann_json CONFIG REQUIRED\)/;
    assert.match(cmake, gate);
});

test("the Web Storage PAL keeps its file work behind an encoded key", () => {
    const source = readFileSync(resolve("native/src/pal_storage.cpp"), "utf8");
    // SDL owns "where may this program write"; nothing here names a path.
    assert.match(source, /SDL_GetPrefPath\(kPrefOrganisation, kPrefApplication\)/);
    assert.match(source, /SDL_free\(preferences\)/);
    // A key becomes a file name through an injective encoding: every byte
    // outside [A-Za-z0-9-] is escaped, and the escape character too.
    assert.match(source, /byte == '-'/);
    assert.match(source, /encoded\.push_back\('_'\)/);
    // The shared PAL helper stages beside the destination and atomically
    // replaces it, so Web Storage and selected-file downloads cannot drift.
    assert.match(source, /detail::write_file_atomically/);
    const fileIo = readFileSync(
        resolve("native/src/pal_file_io.hpp"),
        "utf8",
    );
    assert.match(fileIo, /random_staging_token/);
    assert.match(fileIo, /CREATE_NEW/);
    assert.match(fileIo, /O_CREAT \| O_EXCL \| O_NOFOLLOW/);
    assert.match(fileIo, /FlushFileBuffers/);
    assert.match(fileIo, /::fsync/);
    assert.match(fileIo, /MoveFileExW|std::filesystem::rename/);
    // Reads are bounded and removing an absent key is not a failure.
    assert.match(source, /kMaximumEntryBytes/);
    assert.match(
        source,
        /error == std::errc::no_such_file_or_directory/,
    );
    // A test root keeps the user's own preferences out of a run.
    assert.match(source, /BBLITE_LOCAL_STORAGE_ROOT/);
    // No OS API outside PAL: the header the scene includes is a thin shim.
    const shim = readFileSync(
        resolve("native/include/bblite/js_storage.hpp"),
        "utf8",
    );
    assert.doesNotMatch(shim, /filesystem|fstream|SDL_/);
    assert.match(shim, /pal::read_local_storage/);
});

test("the JSON runtime is included only by the scenes that reach it", () => {
    const projection = readFileSync(
        resolve("src/compiler/output-projection.ts"),
        "utf8",
    );
    assert.match(projection, /features\.includes\("data:json"\)[\s\S]{0,120}js_json\.hpp/);
    assert.match(projection, /features\.includes\("storage:local"\)[\s\S]{0,120}js_storage\.hpp/);
    const runtime = readFileSync(
        resolve("native/include/bblite/js_json.hpp"),
        "utf8",
    );
    // Object key order is the writer's call order, so nothing sorts it:
    // the parsed value keeps the document's order and the writer keeps the
    // record's, which is why neither side is a sorted associative map.
    assert.match(runtime, /nlohmann::ordered_json::parse/);
    assert.match(runtime, /using Object = std::vector<Entry>;/);
});

/**
 * The native half, when a toolchain and the vcpkg install are present:
 * compile the emission shape and the storage PAL and run their contract
 * against a scratch root. Skipped rather than failed where neither exists,
 * because the compiler tests above are the portable half.
 */
const nativeTools = optionalNativeFixtureTools();

test(
    "the native JSON bridge and storage PAL hold their contract",
    { skip: !nativeTools },
    () => {
        const output = resolve("artifacts/js-json-check");
        rmSync(output, { recursive: true, force: true });
        mkdirSync(output, { recursive: true });
        runNativeFixtureCompiler(nativeTools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/permissive-",
            "/EHsc",
            `/Fo:${output}\\`,
            `/Fe:${output}\\js-json-check.exe`,
            "/I",
            "native/include",
            "/I",
            `${nativeFixtureVcpkgRoot}\\include`,
            "test/fixtures/js-json/js-json-storage-check.cpp",
            "test/fixtures/js-json/pal-environment-stub.cpp",
            "native/src/pal_storage.cpp",
            "/link",
            `/LIBPATH:${nativeFixtureVcpkgRoot}\\lib`,
            "SDL3.lib",
        ]);
        const storageRoot = join(output, "storage-root");
        mkdirSync(storageRoot, { recursive: true });
        const result = execFileSync(join(output, "js-json-check.exe"), [], {
            env: {
                ...process.env,
                // Never the user's own preference directory.
                BBLITE_LOCAL_STORAGE_ROOT: storageRoot,
                PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${process.env["PATH"] ?? ""}`,
            },
            stdio: "pipe",
        }).toString();
        assert.match(result, /js-json-storage-check: ok/);
    },
);
