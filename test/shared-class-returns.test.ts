import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const source = `
    import { createEngine, createBox, type Mesh } from "@babylonjs/lite";
    const engine = await createEngine({});
    class Entity {
        constructor(public mesh: Mesh, readonly tag: string, public shift: number) {}
        move(): void { this.mesh.position.x += this.shift; }
        below(limit: number): boolean { return this.mesh.position.y < limit; }
    }
    function make(size: number): Entity {
        if (size < 0) throw new Error("shared class factory");
        const mesh = createBox(engine, {size});
        mesh.position.x = size;
        return new Entity(mesh, "function", size + 1);
    }
    class Builder {
        make(size: number): Entity {
            if (size < 0) throw new Error("shared class method");
            const mesh = createBox(engine, {size});
            mesh.position.x = size;
            return new Entity(mesh, "method", size * 2);
        }
    }
    let size = 2;
    const first = make(size), second = make(++size);
    const builder = new Builder();
    const third = builder.make(4), fourth = builder.make(5);
    first.move(); second.move(); third.move(); fourth.move();
    if (first === second || first.mesh === second.mesh || third === fourth || third.mesh === fourth.mesh)
        throw new Error("class factory identity");
    if (first.mesh.position.x !== 5 || second.mesh.position.x !== 7 ||
        third.mesh.position.x !== 12 || fourth.mesh.position.x !== 15)
        throw new Error("class result owns its fields");
    function select(flag: boolean): Entity | null { return flag ? make(6) : null; }
    const absent = select(false), present = select(true);
    if (absent || !present || present.tag !== "function") throw new Error("nullable class return");
    const laterA = () => make(7), laterB = () => make(8);
    const fifth = laterA(), sixth = laterB();
    if (fifth === sixth || fifth.shift !== 8 || sixth.shift !== 9) throw new Error("class factory captures");
    let steps = 0;
    while (fifth.below(3)) {
        fifth.mesh.position.y += 1;
        if (++steps > 3) throw new Error("stale shared loop condition");
    }
    if (steps !== 3) throw new Error("shared loop evaluation");
`;

test("eligible class-returning helpers and methods share bodies across callback scopes", () => {
    const result = compileSource(source);
    for (const marker of ["shared class factory", "shared class method"])
        assert.equal(result.cpp.split(marker).length - 1, 1, marker);
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 2);
    assert.equal(result.manifest.sceneMeshes.length, 2);
    assert.ok(result.manifest.sceneMeshes.every(mesh => mesh.runtimeInstances));
});

const tools = optionalNativeFixtureTools(false);
test("shared class returns keep independent handles, fields, identity and nullable presence", { skip: !tools }, () => {
    const output = resolve("artifacts/shared-class-returns");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "program.hpp"), compileSource(source).cpp);
    const file = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(file, `
        #define main generated_main
        #include "program.hpp"
        #undef main
        #include <cassert>
        namespace { unsigned constructions = 0; }
        namespace bbl {
            Engine create_engine(EngineOptions) { return {}; }
            MeshHandle create_box(Engine& engine, BoxOptions options) {
                assert(options.width == static_cast<float>(2 + constructions++));
                engine.meshes.emplace_back();
                return {static_cast<std::uint32_t>(engine.meshes.size() - 1)};
            }
            void mark_mesh_dirty(Engine&, MeshHandle) {}
        }
        int main() { assert(generated_main() == 0); assert(constructions == 7); }
    `);
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", output, "/I", "native/include", file]);
    execFileSync(executable, { stdio: "pipe" });
});
