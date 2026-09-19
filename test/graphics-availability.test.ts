import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("a native graphics availability guard retains the intended scene compilation", () => {
    const directory = resolve("artifacts/graphics-availability/scene");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const scene = readFileSync("examples/primitives.ts", "utf8").replace(
        "    const canvas =",
        "    if (!navigator.gpu) return;\n    const canvas =",
    );
    const result = compileSource(
        'const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();' +
            scene,
        { fileName: join(directory, "entry.ts") },
    );
    assert.ok(result.manifest.features.includes("renderer:scene"));
    assert.ok(result.manifest.features.includes("mesh:box"));
    assert.ok(result.manifest.features.includes("platform:window"));
});

for (const present of [false, true])
    test(`graphics capability is ${present ? "present" : "absent"} on the realm and its workers`, (t) => {
        const directory = resolve(
            "artifacts/graphics-availability",
            present ? "present" : "absent",
        );
        mkdirSync(directory, { recursive: true });
        writeFileSync(
            join(directory, "worker.ts"),
            `self.addEventListener("message",()=>{const status:{available:boolean;kind:string}={available:!!navigator.gpu,kind:typeof navigator.gpu};self.postMessage(status);});`,
        );
        const result = compileSource(
            `
        const expected=${present};
        function inspect(value:GPU){return typeof value;}
        const host=navigator;const graphics=host.gpu;
        const kind=expected?"object":"undefined";
        if(!!graphics!==expected||typeof graphics!==kind||inspect(graphics)!==kind)throw new Error("capability presence/type");
        if(graphics!==navigator.gpu||(graphics==null)===expected||(graphics===undefined)===expected)throw new Error("capability identity/absence");
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});
        worker.addEventListener("message",(event:MessageEvent<{available:boolean;kind:string}>)=>{
            if(event.data.available!==expected||event.data.kind!==kind)throw new Error("inherited worker capability");
            globalThis.close();
        });
        worker.postMessage(0);
    `,
            { fileName: join(directory, "entry.ts") },
        );
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        let program = result.cpp;
        if (present) {
            const declaration = "int main() {",
                realm = "bbl::pal::WorkerRealm realm(loop);";
            assert.ok(program.includes(declaration) && program.includes(realm));
            program = program
                .replace(
                    declaration,
                    `struct GraphicsFixtureServices final:bbl::pal::HostServices{const void* graphics_identity()const override{return this;}};\n${declaration}`,
                )
                .replace(
                    realm,
                    'bbl::pal::WorkerRealm realm(loop,"",std::make_shared<GraphicsFixtureServices>());',
                );
        }
        const cpp = join(directory, "check.cpp"),
            exe = join(directory, "check.exe");
        writeFileSync(cpp, program);
        runNativeFixtureCompiler(tools, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            "/MD",
            "/DBBLITE_WORKERS=1",
            "/I",
            "native/include",
            `/Fo:${directory}/`,
            `/Fe:${exe}`,
            cpp,
        ]);
        const execution = spawnSync(exe, { encoding: "utf8", timeout: 10000 });
        assert.equal(execution.stdout, "");
        assert.equal(execution.stderr, "");
        assert.ifError(execution.error);
        assert.equal(execution.status, 0);
    });
