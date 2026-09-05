import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
    readValidationCheckpoint,
    shaderDirectoryFingerprints,
    validationShaderInput,
    writeValidationCheckpoint,
} from "../src/validation-resume.js";

function write(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
}

test("the shader stage keys its sources and its products apart", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bblitec-resume-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const output = resolve(root, "generated/scene");
    const dxc = resolve(root, "dxc.exe");
    const tint = resolve(root, "tint.exe");
    write(resolve(root, "tools/compile-shaders.ps1"), "# compiler\n");
    write(dxc, "dxc");
    write(tint, "tint");
    write(resolve(output, "main.cpp"), "int main() {}\n");
    write(
        resolve(output, "upstream/shaders/pbr.frag.native.wgsl"),
        "@fragment fn main() {}\n",
    );
    const scenes = [{ id: "scene", output }];

    const before = shaderDirectoryFingerprints(scenes);
    write(resolve(output, "upstream/shaders/pbr.frag.dxil"), "DXBC");
    const withProduct = shaderDirectoryFingerprints(scenes);
    assert.equal(
        withProduct.sources,
        before.sources,
        "a shader product does not move the sources digest",
    );
    assert.notEqual(withProduct.products, before.products);
    write(resolve(output, "upstream/shaders/pbr.frag.dxil"), "DXBC-longer");
    assert.notEqual(
        shaderDirectoryFingerprints(scenes).products,
        withProduct.products,
    );

    const shaderInput = validationShaderInput(
        before.sources,
        "d3d12",
        { dxc, tint },
        root,
    );
    assert.notEqual(
        validationShaderInput(before.sources, "all", { dxc, tint }, root),
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
        shaders: { input: "shader-input", output: "shader-output" },
    };
    writeValidationCheckpoint(path, checkpoint);
    assert.deepEqual(readValidationCheckpoint(path), checkpoint);
    assert.equal(readValidationCheckpoint(path).shaders?.input, "shader-input");
    writeFileSync(path, "not json");
    assert.deepEqual(readValidationCheckpoint(path), { version: 1 });
});

test("shader checkpoints follow DXC's codegen DLLs only for DXC targets", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bblitec-shader-tools-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dxc = resolve(root, "dxc.exe");
    const tint = resolve(root, "tint.exe");
    write(dxc, "dxc");
    write(tint, "tint");
    const fingerprint = (target: string): string =>
        validationShaderInput("sources", target, { dxc, tint }, root);
    const metal = fingerprint("metal");
    for (const name of ["dxcompiler.dll", "dxil.dll"]) {
        const before = fingerprint("d3d12");
        const path = resolve(root, name);
        write(path, "installed");
        assert.notEqual(fingerprint("d3d12"), before, `${name} installation`);
        const installed = fingerprint("vulkan");
        write(path, "replacement compiler");
        assert.notEqual(fingerprint("vulkan"), installed, `${name} replacement`);
        assert.equal(fingerprint("metal"), metal);
    }
});
