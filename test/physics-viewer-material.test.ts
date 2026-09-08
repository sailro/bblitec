import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { lowerWgslShaderProgram, parseWgslStages } from "../src/shader-ir.js";
import { emitNativeWgslProgram } from "../src/shader-wgsl-emitter.js";
import { LoweringContext } from "../src/lowering/context.js";
import { physicsViewerMaterialModule, physicsViewerMaterialProgram } from "../src/lowering/physics-viewer-material.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";

function editedContext(from: string, to: string): LoweringContext {
    class EditedStore extends UpstreamSourceStore {
        public override getSourceFile(module: string): ts.SourceFile {
            const source = super.getSource(module);
            if (module === physicsViewerMaterialModule) assert.ok(source.includes(from), "Mutation must reach the pin.");
            return ts.createSourceFile(module, source.replace(from, to), ts.ScriptTarget.Latest, true);
        }
    }
    return new LoweringContext(new EditedStore());
}

test("physics viewer shader preserves separate VP/world products and an always-pass depth pipeline", () => {
    const program = physicsViewerMaterialProgram(new LoweringContext(), [0.2, 0.4, 0.6, 1]);
    const ir = lowerWgslShaderProgram(program);
    assert.deepEqual(ir.reflection.uniformBlocks.map(block => [block.size, block.systemMatrices]), [[128, ["viewProjection", "world"]], [16, []]]);
    assert.deepEqual(program.uniformDefaults, [{ name: "color", values: [0.2, 0.4, 0.6, 1] }]);
    assert.equal(program.depthCompare, "always");
    assert.equal(program.depthWrite, false);
    assert.equal(program.topology, "line-list");
    assert.match(emitNativeWgslProgram(ir, "vertex"), /shaderSystem.viewProjection \* shaderSystem.world/);
    assert.match(emitNativeWgslProgram(ir, "fragment"), /return shaderUniforms.color/);
});

test("physics viewer material refuses changed source bindings and update protocols", () => {
    for (const [from, to] of [
        ['depthCompare: "always"', 'depthCompare: "greater-equal"'],
        ["materialData.set(material.color)", "materialData.set([1, 1, 1, 1])"],
        ["mesh.worldMatrixVersion !== lastWorldVersion", "mesh.worldMatrixVersion === lastWorldVersion"],
        ["binding: 1, visibility: SS.FRAGMENT", "binding: 2, visibility: SS.FRAGMENT"],
    ]) {
        assert.throws(() => physicsViewerMaterialProgram(editedContext(from!, to!), [1, 1, 1, 1]), /Physics debug/);
    }
    const changed = physicsViewerMaterialProgram(editedContext("vec4<f32>(position,1.0)", "vec4<f32>(position,0.5)"), [1, 1, 1, 1]);
    assert.match(changed.vertexSource, /vec4<f32>\(input.position, 0.5\)/);
});

test("strict shared WGSL modules require unique declared entry stages", () => {
    const vertex = "@vertex fn v(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> { return vec4<f32>(p, 1.0); }";
    const fragment = "@fragment fn f() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }";
    assert.deepEqual(parseWgslStages(vertex + fragment).map(module => module.entryPoint.stage), ["vertex", "fragment"]);
    assert.throws(() => parseWgslStages(vertex + vertex), /Duplicate @vertex/);
    assert.throws(() => parseWgslStages(vertex + "fn helper() -> f32 { return 0.0; }"), /Expected/);
});
