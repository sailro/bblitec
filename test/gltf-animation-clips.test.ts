import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import {BinaryBuilder} from "../src/glb-binary-builder.js";
import type {JsonObject} from "../src/gltf-document.js";
import {packageGltfMeshPlan, packagedGltfMeshPlan} from "../src/gltf-mesh-plan.js";
import {LoweringContext} from "../src/lowering/context.js";
import {doctoredContext} from "./doctored-store.js";
import {readPackedGltfAttribute} from "./gltf-mesh-fixture.js";

const module = "src/loader-gltf/gltf-animation.ts";

function fixture() {
    const binary = new BinaryBuilder(Buffer.alloc(0));
    const accessors: JsonObject[] = [], bufferViews: JsonObject[] = [];
    const append = (data: Float32Array | Int8Array, type: string, width: number, normalized = false) => {
        bufferViews.push({buffer: 0, byteOffset: binary.append(data), byteLength: data.byteLength});
        accessors.push({bufferView: bufferViews.length - 1, componentType: data instanceof Float32Array ? 5126 : 5120,
            type, count: data.length / width, normalized});
        return accessors.length - 1;
    };
    const position = append(new Float32Array([0,0,0, 1,0,0, 0,1,0]), "VEC3", 3);
    const time = append(new Float32Array([0,1]), "SCALAR", 1);
    const translation = append(new Float32Array([1,2,3, 4,5,6]), "VEC3", 3);
    const unusedTime = append(new Float32Array([0,9]), "SCALAR", 1);
    const rotation = append(new Int8Array([-128,-64,0,127, -127,64,32,-32]), "VEC4", 4, true);
    const document: JsonObject = {asset: {version: "2.0"}, accessors, bufferViews, buffers: [{byteLength: binary.byteLength}],
        meshes: [{primitives: [{attributes: {POSITION: position}}]}], nodes: [{mesh: 0}], scenes: [{nodes: [0]}],
        animations: [{samplers: [{input: time, output: translation}, {input: unusedTime, output: rotation, interpolation: "UNKNOWN"}],
            channels: [{sampler: 0, target: {node: 0, path: "translation"}},
                {sampler: 0, target: {path: "translation"}}, {sampler: 0, target: {node: 0, path: "unused"}}]},
        {name: "second", samplers: [{input: time, output: rotation, interpolation: "STEP"}],
            channels: [{sampler: 0, target: {node: 0, path: "rotation"}}]}]};
    const bytes = binary.build();
    return {document, bin: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)};
}

test("packaged clips retain source filtering, order, unused-sampler duration and normalized bits", async () => {
    const cases = [
        {context: new LoweringContext(), duration: 9, name: "", divisor: 127, input: [0,1], step: false},
        {context: doctoredContext(module, "duration = last;", "duration = last + 0.25;"), duration: 9.25, name: "", divisor: 127, input: [0,1], step: false},
        {context: doctoredContext(module, 'name: anim.name ?? ""', 'name: anim.name ?? "unnamed"'), duration: 9, name: "unnamed", divisor: 127, input: [0,1], step: false},
        {context: doctoredContext(module, 's.interpolation ?? "LINEAR"', 's.interpolation ?? "STEP"'), duration: 9, name: "", divisor: 127, input: [0,1], step: true},
        {context: doctoredContext(module, "inputAcc._count, inNorm", "inputAcc._count - 1, inNorm"), duration: 0, name: "", divisor: 127, input: [0], step: false},
        {context: doctoredContext("src/loader-gltf/gltf-sampler-denorm.ts", "src instanceof I8 ? 127", "src instanceof I8 ? 63"), duration: 9, name: "", divisor: 63, input: [0,1], step: false},
    ];
    for (const row of cases) {
        const {document, bin} = fixture();
        const bytes = await packageGltfMeshPlan(document, bin, row.context);
        const animation = packagedGltfMeshPlan(document).animation!;
        assert.equal(animation.accepted, true);
        const [first, second] = animation.clips;
        assert.ok(first && second); assert.equal(animation.clips.length, 2);
        assert.equal(first.name, row.name); assert.equal(second.name, "second");
        assert.equal(first.duration, row.duration);
        const types = row.context.sourceFile("src/animation/types.ts");
        const constant = (name: string) => row.context.numericValue(ts.factory.createIdentifier(name), types);
        assert.deepEqual(first.channels, [{samplerIdx: 0, nodeIdx: 0, path: constant("PATH_TRANSLATION")}]);
        assert.deepEqual(second.channels, [{samplerIdx: 0, nodeIdx: 0, path: constant("PATH_ROTATION")}]);
        assert.equal(first.samplers[0]!.interpolation, constant(row.step ? "INTERP_STEP" : "INTERP_LINEAR"));
        assert.equal(first.samplers[1]!.interpolation, constant("INTERP_LINEAR"));
        assert.equal(second.samplers[0]!.interpolation, constant("INTERP_STEP"));
        assert.deepEqual(readPackedGltfAttribute(document, bytes, first.samplers[0]!.input), row.input);
        assert.deepEqual(readPackedGltfAttribute(document, bytes, first.samplers[0]!.output), [1,2,3,4,5,6]);
        const expected = Float32Array.from([-128,-64,0,127,-127,64,32,-32], value => Math.max(value / row.divisor, -1));
        const actual = Float32Array.from(readPackedGltfAttribute(document, bytes, second.samplers[0]!.output));
        assert.deepEqual(new Uint32Array(actual.buffer), new Uint32Array(expected.buffer));
    }
});
