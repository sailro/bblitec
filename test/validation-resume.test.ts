import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
    readValidationCheckpoint,
    validationCompileInput,
    validationCompileOutput,
    validationShaderInput,
    validationShaderOutput,
    writeValidationCheckpoint,
} from "../src/validation-resume.js";

function write(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
}

test("validation resume keys generation and shaders independently", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bblitec-resume-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = resolve(root, "corpus/scene/index.ts");
    const output = resolve(root, "generated/scene");
    const browser = resolve(root, "browser.exe");
    const dxc = resolve(root, "dxc.exe");
    const tint = resolve(root, "tint.exe");
    write(source, "export const scene = 1;\n");
    write(resolve(root, "dist/.build-stamp"), "compiler-v1\n");
    write(resolve(root, "package-lock.json"), "{}\n");
    write(resolve(root, "upstream/pin.json"), "{}\n");
    write(resolve(root, "tools/compile-shaders.ps1"), "# compiler\n");
    write(browser, "browser");
    write(dxc, "dxc");
    write(tint, "tint");
    write(resolve(output, "main.cpp"), "int main() {}\n");
    write(
        resolve(output, "upstream/shaders/pbr.frag.native.wgsl"),
        "@fragment fn main() {}\n",
    );
    const scenes = [{ id: "scene", output, source, title: "Scene" }];

    const input = validationCompileInput(scenes, browser, root);
    assert.equal(validationCompileInput(scenes, browser, root), input);
    write(source, "export const scene = 2;\n");
    assert.notEqual(validationCompileInput(scenes, browser, root), input);

    const generated = validationCompileOutput(scenes);
    write(resolve(output, "upstream/shaders/pbr.frag.dxil"), "DXBC");
    assert.equal(
        validationCompileOutput(scenes),
        generated,
        "shader products do not invalidate generation",
    );
    const shaderOutput = validationShaderOutput(scenes);
    write(resolve(output, "upstream/shaders/pbr.frag.dxil"), "DXBC-longer");
    assert.notEqual(validationShaderOutput(scenes), shaderOutput);

    const shaderInput = validationShaderInput(
        generated,
        "d3d12",
        { dxc, tint },
        root,
    );
    assert.notEqual(
        validationShaderInput(generated, "all", { dxc, tint }, root),
        shaderInput,
    );
});

test("validation checkpoints are atomic and malformed files restart cleanly", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bblitec-resume-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = resolve(root, "artifacts/validate/all.json");
    assert.deepEqual(readValidationCheckpoint(path), { version: 1 });
    const checkpoint = {
        version: 1 as const,
        compile: { input: "input", output: "output" },
    };
    writeValidationCheckpoint(path, checkpoint);
    assert.deepEqual(readValidationCheckpoint(path), checkpoint);
    writeValidationCheckpoint(path, {
        ...checkpoint,
        shaders: { input: "shader-input", output: "shader-output" },
    });
    assert.equal(readValidationCheckpoint(path).shaders?.input, "shader-input");
    writeFileSync(path, "not json");
    assert.deepEqual(readValidationCheckpoint(path), { version: 1 });
});
