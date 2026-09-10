import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import {BinaryBuilder} from "../src/glb-binary-builder.js";
import {asRecords, type JsonObject} from "../src/gltf-document.js";
import {gltfMeshPlan, packageGltfMeshPlan, packagedGltfMeshPlan} from "../src/gltf-mesh-plan.js";
import {readAnimationReceipt, type CaptureValue} from "../src/gltf-animation-pointers.js";
import {LoweringContext} from "../src/lowering/context.js";
import {doctoredContext} from "./doctored-store.js";
import {readPackedGltfAttribute} from "./gltf-mesh-fixture.js";

const animationModule = "src/loader-gltf/gltf-animation.ts";
const pointerModule = "src/loader-gltf/animation-pointer.ts";

function fixture(channels: JsonObject[], pointers = true) {
    const binary = new BinaryBuilder(Buffer.alloc(0)), accessors: JsonObject[] = [], bufferViews: JsonObject[] = [];
    const append = (data: Float32Array, type: string, components: number): number => {
        bufferViews.push({buffer: 0, byteOffset: binary.append(data), byteLength: data.byteLength});
        accessors.push({bufferView: bufferViews.length - 1, componentType: 5126, count: data.length / components, type});
        return accessors.length - 1;
    };
    const position = append(new Float32Array([0,0,0, 1,0,0, 0,1,0]), "VEC3", 3);
    const time = append(new Float32Array([0, 2]), "SCALAR", 1);
    const scalar = append(new Float32Array([0, .75]), "SCALAR", 1);
    const vector = append(new Float32Array([0,0,0, 1.123456789,2,3]), "VEC3", 3);
    const color = append(new Float32Array([0,0,0,1, 1,.5,.25,1]), "VEC4", 4);
    const document: JsonObject = {asset: {version: "2.0"}, buffers: [{byteLength: binary.byteLength}], accessors, bufferViews,
        materials: [{}], meshes: [{primitives: [{attributes: {POSITION: position}, material: 0}]}],
        nodes: [{mesh: 0, name: "Animated node"}], scenes: [{nodes: [0]}],
        animations: [{name: "clip", channels, samplers: [
            {input: time, output: vector}, {input: time, output: scalar}, {input: time, output: color},
        ]}], ...(pointers ? {extensionsUsed: ["KHR_animation_pointer"]} : {})};
    const bytes = binary.build();
    return {document, bin: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)};
}
const pointer = (path: string, sampler = 1): JsonObject => ({sampler, target: {path: "pointer", extensions: {KHR_animation_pointer: {pointer: path}}}});
const trs = (path = "translation", node = 0): JsonObject => ({sampler: 0, target: {node, path}});
function closure(value: CaptureValue | undefined): Extract<CaptureValue, {kind: "closure"}> {
    assert.equal(value?.kind, "closure");
    return value as Extract<CaptureValue, {kind: "closure"}>;
}

test("source terminal null and writable-node gates determine accepted animation data", async () => {
    const input = fixture([trs()], false);
    const plan = await gltfMeshPlan(input.document, input.bin);
    assert.equal(plan.animation?.accepted, true);
    assert.deepEqual(plan.animation!.clips[0]!.controller.nodeTrsBindings, [{target: 0, off: 0, mask: 1}]);
    assert.deepEqual(plan.animation!.nodeNames, ["Animated node"]);
    const absent = fixture([pointer("/nodes/9/extensions/KHR_node_visibility/visible")]);
    assert.deepEqual((await gltfMeshPlan(absent.document, absent.bin)).animation, {accepted: false, materialState: [], nodeNames: [], clips: []});
    const rejected = await gltfMeshPlan(input.document, input.bin, doctoredContext(animationModule,
        "!hasWritableNodeChannel(clips, nodeTargets, excludedNodeIndices)", "true"));
    assert.equal(rejected.animation?.accepted, false);
    assert.deepEqual(rejected.animation?.clips, []);
    assert.equal((await gltfMeshPlan({...input.document, animations: []}, input.bin)).animation, null);
});

test("source clip order, converted sampler bytes, controller bindings and group names are transported", async () => {
    const input = fixture([trs(), pointer("/materials/0/pbrMetallicRoughness/baseColorFactor", 2),
        pointer("/nodes/0/scale", 0), pointer("/nodes/0/extensions/KHR_node_visibility/visible")]);
    const bytes = await packageGltfMeshPlan(input.document, input.bin);
    const receipt = packagedGltfMeshPlan(input.document).animation!, clip = receipt.clips[0]!;
    const context = new LoweringContext(), types = context.sourceFile("src/animation/types.ts");
    const path = (name: string) => context.numericValue(ts.factory.createIdentifier(name), types);
    assert.deepEqual(clip.channels.map(channel => channel.path), [path("PATH_TRANSLATION"), path("PATH_POINTER"), path("PATH_SCALE"), path("PATH_POINTER")]);
    assert.deepEqual(clip.channels.map(channel => channel.samplerIdx), [0, 2, 0, 1]);
    assert.deepEqual(clip.targetedAnimations, [{target: 0, targetName: "Animated node", nodeIndex: 0, path: "translation"},
        {path: "pointer"}, {target: 0, targetName: "Animated node", nodeIndex: 0, path: "scale"}, {path: "pointer"}]);
    assert.deepEqual(clip.controller.nodeTrsBindings, [{target: 0, off: 0, mask: 5}]);
    assert.deepEqual(clip.controller.topoOrder, [0]);
    assert.equal(clip.controller.requiresEngine, false);
    assert.deepEqual(readPackedGltfAttribute(input.document, bytes, clip.samplers[0]!.output), [0,0,0, Math.fround(1.123456789),2,3]);
    const named = fixture([trs()]);
    const moved = await gltfMeshPlan(named.document, named.bin, doctoredContext("src/animation/animation-group.ts",
        "targetName: nodeIndex !== undefined ? nodeNames[nodeIndex] : undefined,", 'targetName: "source name",'));
    assert.equal(moved.animation!.clips[0]!.targetedAnimations[0]!.targetName, "source name");
});

test("pointer resolution records physical material owners after the source map's later replay overwrite", async () => {
    const input = fixture([pointer("/materials/0/pbrMetallicRoughness/baseColorFactor", 2)]);
    input.document.nodes = [{mesh: 0}, {mesh: 0}];
    input.document.scenes = [{nodes: [0, 1]}];
    const ordinary = await gltfMeshPlan(input.document, input.bin);
    assert.deepEqual(closure(ordinary.animation!.clips[0]!.channels[0]!.writer).values.mat, {kind: "material", index: 0, path: []});
    const distinct = await gltfMeshPlan(input.document, input.bin, doctoredContext("src/loader-gltf/load-gltf.ts",
        "let cached = builtMaterialCache.get(mat);", "let cached = undefined;"));
    assert.deepEqual(distinct.meshes.map(mesh => mesh.material), [0, 1]);
    assert.deepEqual(closure(distinct.animation!.clips[0]!.channels[0]!.writer).values.mat, {kind: "material", index: 1, path: []});
    const nullWriter = await gltfMeshPlan(input.document, input.bin, doctoredContext(pointerModule,
        "if (!mat?.baseColorFactor)", "if (true)"));
    assert.equal(nullWriter.animation!.accepted, false);
    assert.deepEqual(nullWriter.baseColorDefinitions, [0], "source material preparation remains selected when the terminal writer is rejected");
    assert.equal(nullWriter.baseColorModule, true);
});

test("actual pointer preparation supplies material initialization and base-color definition identities", async () => {
    const input = fixture([pointer("/materials/0/pbrMetallicRoughness/baseColorFactor", 2),
        pointer("/materials/0/extensions/KHR_materials_transmission/transmissionFactor")]);
    const plan = await gltfMeshPlan(input.document, input.bin);
    assert.deepEqual(plan.baseColorDefinitions, [0]);
    assert.equal(plan.baseColorModule, true);
    const patches = plan.animation!.materialState[0]!.patches;
    assert.ok(patches.some(patch => patch.path.join(".") === "baseColorFactor" && patch.operation === "set"));
    assert.ok(patches.some(patch => patch.path.join(".") === "_subsurface" && patch.operation === "set"));
    const moved = await gltfMeshPlan(input.document, input.bin, doctoredContext("src/loader-gltf/animation-pointer-basecolor.ts",
        "if (def) {", "if (def && false) {"));
    assert.deepEqual(moved.baseColorDefinitions, []);
    assert.equal(moved.baseColorModule, true);
    const noPointer = fixture([trs()], false);
    const ordinary = await gltfMeshPlan(noPointer.document, noPointer.bin);
    assert.deepEqual(ordinary.baseColorDefinitions, []); assert.equal(ordinary.baseColorModule, false);
});

test("source private texture selection and late light lookup captures remain distinct", async () => {
    const input = fixture([pointer("/materials/0/pbrMetallicRoughness/baseColorTexture/extensions/KHR_texture_transform/rotation"),
        pointer("/extensions/KHR_lights_punctual/lights/7/intensity")]);
    input.document.textures = [{source: 0}]; input.document.images = [{}];
    asRecords(input.document.materials)[0]!.pbrMetallicRoughness = {baseColorTexture: {index: 0}};
    const plan = await gltfMeshPlan(input.document, input.bin), channels = plan.animation!.clips[0]!.channels;
    assert.equal(channels.length, 2, "an absent light still has a source writer and counts toward terminal acceptance");
    const uv = closure(channels[0]!.writer);
    assert.deepEqual(uv.values.mat, {kind: "material", index: 0, path: []});
    assert.deepEqual(uv.values.tex, {kind: "material", index: 0, path: ["baseColorTexture"]});
    const light = closure(channels[1]!.writer), lookup = closure(light.values.getLight);
    assert.deepEqual(lookup.lightLookups, [7]);
    assert.deepEqual(lookup.values.lightIdx, {kind: "literal", value: 7});
    assert.deepEqual(light.values.field, {kind: "literal", value: "intensity"});
});

test("source resolver arity/quaternion and controller construction mutations move receipts", async () => {
    const input = fixture([pointer("/nodes/0/extensions/KHR_node_visibility/visible")]);
    const altered = await gltfMeshPlan(input.document, input.bin, doctoredContext(pointerModule,
        "arity: 1,\n                writer: (out, off) => {\n                    setSubtreeVisible", "arity: 2,\n                writer: (out, off) => {\n                    setSubtreeVisible"));
    assert.equal(altered.animation!.clips[0]!.channels[0]!.pointerArity, 2);
    const quaternion = await gltfMeshPlan(input.document, input.bin, doctoredContext("src/loader-gltf/gltf-feature-animation-pointer.ts",
        "pointerArity: resolved.arity,", "pointerArity: resolved.arity, pointerQuaternion: true,"));
    assert.equal(quaternion.animation!.clips[0]!.channels[0]!.pointerQuaternion, true);
    const standard = fixture([trs()], false);
    const changed = await gltfMeshPlan(standard.document, standard.bin, doctoredContext("src/skeleton/skeleton-updater.ts",
        "maskByNode.set(ni, (maskByNode.get(ni) ?? 0) | bit);", "maskByNode.set(ni, 7);"));
    assert.equal(changed.animation!.clips[0]!.controller.nodeTrsBindings[0]!.mask, 7);
    assert.throws(() => readAnimationReceipt({...changed.animation, clips: [{...changed.animation!.clips[0], channels: [{samplerIdx: 99, nodeIdx: 0, path: 0}]}]},
        {nodes: 1, materials: 1, accessors: 999, skeletons: 0, morphs: 0}), /animation receipt/);
});

test("source normalized sampler converter and variant construction share the completed material schedule", async () => {
    const input = fixture([pointer("/materials/0/pbrMetallicRoughness/baseColorFactor", 2), pointer("/nodes/0/extensions/KHR_node_visibility/visible")]);
    const binary = new BinaryBuilder(Buffer.from(input.bin.buffer, input.bin.byteOffset, input.bin.byteLength));
    const data = new Uint8Array([0, 255]);
    const views = asRecords(input.document.bufferViews), accessors = asRecords(input.document.accessors);
    views.push({buffer: 0, byteOffset: binary.append(data), byteLength: data.byteLength});
    accessors.push({bufferView: views.length - 1, componentType: 5121, count: 2, type: "SCALAR", normalized: true});
    input.document.bufferViews = views; input.document.accessors = accessors;
    asRecords(asRecords(input.document.animations)[0]!.samplers)[1]!.output = accessors.length - 1;
    input.document.extensionsUsed = ["KHR_animation_pointer", "KHR_materials_variants"];
    input.document.extensions = {KHR_materials_variants: {variants: [{name: "alternate"}]}};
    input.document.materials = [{}, {pbrMetallicRoughness: {baseColorFactor: [.2,.3,.4,1]}}];
    asRecords(asRecords(input.document.meshes)[0]!.primitives)[0]!.extensions = {
        KHR_materials_variants: {mappings: [{material: 1, variants: [0]}]},
    };
    const source = binary.build();
    const bytes = await packageGltfMeshPlan(input.document, new DataView(source.buffer, source.byteOffset, source.byteLength));
    const plan = packagedGltfMeshPlan(input.document), clip = plan.animation!.clips[0]!;
    assert.deepEqual(readPackedGltfAttribute(input.document, bytes, clip.samplers[1]!.output), [0, 1]);
    assert.deepEqual(closure(clip.channels[0]!.writer).values.mat, {kind: "material", index: 0, path: []},
        "variant construction does not retarget a pointer captured against the base material owner");
});

test("each source controller selects only skeletons reached by that clip's joint ancestors", async () => {
    const input = fixture([trs("translation", 1)], false);
    const binary = new BinaryBuilder(Buffer.from(input.bin.buffer, input.bin.byteOffset, input.bin.byteLength));
    const views = asRecords(input.document.bufferViews), accessors = asRecords(input.document.accessors);
    const append = (data: Uint8Array | Float32Array) => {
        views.push({buffer: 0, byteOffset: binary.append(data), byteLength: data.byteLength});
        accessors.push({bufferView: views.length - 1, componentType: data instanceof Uint8Array ? 5121 : 5126, count: 3, type: "VEC4"});
        return accessors.length - 1;
    };
    const primitive = asRecords(asRecords(input.document.meshes)[0]!.primitives)[0]!;
    primitive.attributes = {...primitive.attributes as object, JOINTS_0: append(new Uint8Array(12)),
        WEIGHTS_0: append(new Float32Array([1,0,0,0, 1,0,0,0, 1,0,0,0]))};
    input.document.bufferViews = views; input.document.accessors = accessors;
    input.document.nodes = [{mesh: 0, skin: 0}, {name: "joint"}, {name: "plain"}];
    input.document.scenes = [{nodes: [0, 1, 2]}]; input.document.skins = [{joints: [1]}];
    const first = asRecords(input.document.animations)[0]!;
    input.document.animations = [first, {...first, name: "plain", channels: [trs("translation", 2)]}];
    const bytes = binary.build(), bin = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const plan = await gltfMeshPlan(input.document, bin);
    assert.deepEqual(plan.animation!.clips.map(clip => clip.controller.clipSkeletons), [[0], []]);
    assert.deepEqual(plan.animation!.clips.map(clip => clip.controller.requiresEngine), [true, false]);
    assert.deepEqual(plan.animation!.clips.map(clip => clip.controller.nodeTrsBindings), [[], [{target: 2, off: 24, mask: 1}]]);
});
