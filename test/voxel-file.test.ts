import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("unreached voxel file helpers do not activate the native file boundary", () => {
    const module = resolve("corpus/babylon-lite/lab/lite/src/demos/minecraft/save-load.ts").replaceAll("\\", "/");
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        import { loadFromFile } from ${JSON.stringify(module)};
        async function unused() { return await loadFromFile(); }
        async function main() { const engine = await createEngine({}); }
    `);
    assert.ok(!result.manifest.features.includes("browser:file"));
    assert.ok(!result.manifest.runtimeSources.includes("src/pal_file.cpp"));
});

test("compiled voxel save/load uses selected files, cancellation and JavaScript number spelling", t => {
    const directory = resolve("artifacts/voxel-file-check");
    mkdirSync(directory, { recursive: true });
    const module = resolve("corpus/babylon-lite/lab/lite/src/demos/minecraft/save-load.ts").replaceAll("\\", "/");
    const data = { v: 1, seed: 9007199254740991, time: 1e-7,
        player: { x: -0, y: 1e21, z: -2.5, yaw: .25, pitch: -.5 }, edits: [1, 2, 3, 4, -1e-7, 1e21] };
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        import { saveToFile, saveToFile as saveWorld, loadFromFile, loadFromFile as loadWorld, type SaveData } from ${JSON.stringify(module)};
        async function main() {
            const engine = await createEngine({});
            const data: SaveData = ${JSON.stringify(data).replace('"x":0', '"x":-0')};
            if (await saveWorld(data)) throw new Error("cancelled save");
            if (!await saveToFile(data)) throw new Error("selected save");
            if (await loadWorld()) throw new Error("cancelled load");
            const loaded = await loadFromFile();
            if (!loaded || loaded.v !== 1 || loaded.seed !== data.seed || loaded.time !== data.time ||
                loaded.player.x !== 0 || loaded.player.y !== data.player.y || loaded.player.z !== data.player.z ||
                loaded.player.yaw !== data.player.yaw || loaded.player.pitch !== data.player.pitch ||
                loaded.edits.length !== data.edits.length || loaded.edits[4] !== data.edits[4] ||
                loaded.edits[5] !== data.edits[5]) throw new Error("loaded values");
            loaded.edits[0] = 99;
            const repeated = await loadFromFile();
            if (!repeated || repeated === loaded || repeated.player === loaded.player || repeated.edits[0] !== 1)
                throw new Error("independent loaded records");
            for (let index = 0; index < 4; ++index) {
                if (await loadFromFile()) throw new Error("invalid document");
            }
            let caught = false;
            try { await saveToFile(data); } catch { caught = true; }
            if (!caught) throw new Error("write failure must propagate");
        }
    `, { fileName: join(directory, "source.ts") });
    assert.ok(result.manifest.features.includes("browser:file"));
    assert.ok(result.manifest.runtimeSources.includes("src/pal_file.cpp"));
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    writeFileSync(join(directory, "expected.hpp"), `const std::string expected_json = ${JSON.stringify(JSON.stringify(data))};\n`);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        "/DBBLITE_HAS_BROWSER_FILE=1", "/I", "native/include", "/I", directory,
        `/Fo:${directory}/`, `/Fe:${executable}`, "test/fixtures/js-file/voxel-file-check.cpp"]);
    execFileSync(executable, { stdio: "pipe" });
});
