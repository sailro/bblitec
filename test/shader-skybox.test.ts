import assert from "node:assert/strict";
import test from "node:test";
import { extractPackagedStringLiteral, readPinnedLibraryModule } from "../src/pinned-shader-composer.js";
import { parseWgslModule, statementUsesPath } from "../src/shader-ir.js";
import { specializeImageSkybox } from "../src/shader-skybox.js";
import { emitWgslModule } from "../src/shader-wgsl-emitter.js";

const module = readPinnedLibraryModule("material/standard/skybox-cubemap.js");
const vertex = extractPackagedStringLiteral(module, "skyVertSrc");
const fragment = extractPackagedStringLiteral(module, "skyFragSrc");

test("skybox specialization transforms typed bindings, stage interfaces and fog expressions", () => {
    const result = specializeImageSkybox(vertex, fragment);
    assert.deepEqual(result.vertex.bindings?.map(({ group, binding }) => [group, binding]), [[1, 0]]);
    assert.deepEqual(result.fragment.bindings?.map(({ group, binding }) => [group, binding]), [[2, 0], [2, 1], [3, 0]]);
    assert.equal(result.vertex.entryPoint.parameters.length, 1);
    assert.deepEqual(result.vertex.structs[0]?.members, result.fragment.structs[0]?.members);
    for (const stage of [result.vertex, result.fragment]) {
        assert.ok(!stage.entryPoint.statements.some((statement) => statementUsesPath(statement,
            (parts) => ["mesh", "scene"].includes(parts[0]!) || parts.includes("vFogDistance"))));
        assert.deepEqual(parseWgslModule(emitWgslModule(stage), stage.entryPoint.stage), stage);
    }
    const branch = result.fragment.entryPoint.statements.find((statement) => statement.kind === "if");
    assert.equal(branch?.kind, "if");
    assert.deepEqual(branch?.statements[0], {
        kind: "let", name: "f", value: {
            kind: "call", name: "bblCalcFogFactor", arguments: [{
                kind: "member", member: "xyz", expression: {
                    kind: "binary", operator: "*", left: { kind: "path", parts: ["uniforms", "view"] },
                    right: { kind: "construct", type: "vec4<f32>", arguments: [
                        { kind: "path", parts: ["b", "vPositionW"] }, { kind: "number", value: "1.0" },
                    ] },
                },
            }],
        },
    });
});

test("formatting and minifier renaming preserve skybox specialization", () => {
    const format = (source: string): string => source.replace(/([{}:;,])/g, " /* outer /* nested */ */ $1 \n");
    assert.deepEqual(specializeImageSkybox(format(vertex), format(fragment)), specializeImageSkybox(vertex, fragment));
    const rename = (source: string): string => source.replace(/\b[a-g]\b/g, (name) => `renamed_${name}`)
        .replaceAll("mesh", "meshBinding").replaceAll("normal", "normalInput");
    const renamed = specializeImageSkybox(rename(vertex), rename(fragment));
    assert.equal(renamed.vertex.entryPoint.parameters[0]?.name, "renamed_c");
    assert.equal(renamed.fragment.bindings?.[0]?.name, "renamed_c");
    assert.deepEqual(renamed.vertex.structs[0]?.members, renamed.fragment.structs[0]?.members);
    for (const stage of [renamed.vertex, renamed.fragment]) {
        assert.deepEqual(parseWgslModule(emitWgslModule(stage), stage.entryPoint.stage), stage);
    }
});

test("skybox specialization refuses semantic changes its native interface cannot carry", () => {
    for (const [from, to, reason] of [
        ["a.vPositionLocal=c", "a.vPositionLocal=normal", /unused normal/],
        ["vec4<f32>(c,1.0)", "vec4<f32>(c,2.0)", /homogeneous position/],
        ["(scene.view*b).xyz", "normalize((scene.view*b).xyz)", /affine fog transform/],
        ["a.vPositionW=b.xyz", "a.vPositionW=c", /world varying value/],
    ] as const) {
        assert.ok(vertex.includes(from));
        assert.throws(() => specializeImageSkybox(vertex.replace(from, to), fragment), reason);
    }
    assert.throws(() => specializeImageSkybox(vertex,
        fragment.replace("scene.vFogColor.rgb", "scene.unmappedColor.rgb")), /unmapped/);
});
