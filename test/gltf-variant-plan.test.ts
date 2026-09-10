import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { gltfVariantNames, GLTF_VARIANT_PLAN, type JsonObject } from "../src/gltf-document.js";
import { gltfVariantPlan, packageVariantPlan } from "../src/gltf-variant-plan.js";
import { packagedGltfMeshPlan } from "../src/gltf-mesh-plan.js";
import { withMeshPlan } from "./gltf-mesh-fixture.js";
import { LoweringContext } from "../src/lowering/context.js";
import { materialSubjects, gltfRenderables } from "../src/pinned-material-arms.js";
import { transpileCommonJs } from "../src/typescript-transpile.js";
import { doctoredContext } from "./doctored-store.js";

const module = "src/loader-gltf/gltf-variants.ts";
const document = (): Promise<JsonObject> => withMeshPlan({
    materials: [{name: "base"}, {name: "red"}, {name: "white"}, {name: "unselected"}, {name: "unused"}],
    nodes: [{mesh: 1}, {}, {mesh: 0}, {mesh: 1}],
    meshes: [{primitives: [{material: 0, attributes: {}}]}, {primitives: [
        {material: 1, attributes: {}, extensions: {KHR_materials_variants: {mappings: [
            {material: 1, variants: [0]}, {material: 2, variants: [0, 2]}, {material: 3, variants: [99]},
        ]}}},
        {attributes: {}, extensions: {KHR_materials_variants: {mappings: [{material: 0, variants: [1]}]}}},
    ]}],
    extensions: {KHR_materials_variants: {variants: [{name: "A"}, {name: "B"}, {name: "A"}]}},
});

interface Material {index: number}
interface Mesh {material: Material}
interface VariantData {originals: Array<{mesh: Mesh; material: Material}>; variants: Record<string, Array<{mesh: Mesh; material: Material}>>}

/** Execute the complete pinned loader function, recording only resource leaves. */
async function sourcePlan(json: JsonObject, context: LoweringContext) {
    const {declaration} = context.functionDeclaration(module, "loadVariantMaterials");
    const source = ts.createSourceFile(module, declaration.getText().replace(/^export\s+/, ""), ts.ScriptTarget.Latest, true);
    const transformed = ts.transform(source, [visitorContext => root => {
        const visit: ts.Visitor = node => ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? ts.factory.createIdentifier("mipmapModule") : ts.visitEachChild(node, visit, visitorContext);
        return ts.visitNode(root, visit, ts.isSourceFile)!;
    }]);
    const text = ts.createPrinter().printFile(transformed.transformed[0]!);
    transformed.dispose();
    const names = gltfVariantNames(json);
    const materials: number[] = [];
    const base = packagedGltfMeshPlan(json);
    const baseCount = base.materials.length;
    const baseMaterials = base.materials.map((_, index) => ({index}));
    const meshes = base.meshes.map(mesh => ({material: baseMaterials[mesh.material]!}));
    const leaves = {
        mipmapModule: {generateMipmaps() {}},
        getOrCreateSampler: () => ({}), makeImageFetcher: () => () => undefined,
        assembleMaterial: async (_json: JsonObject, _bin: DataView, index: number) => ({index}),
        uploadTex() {}, identityTexWrap: (value: unknown) => value,
        buildDefaultPbrTexturesExt: () => ({}),
        assemblePbrPropsExt: (material: Material) => {
            const result = {index: baseCount + materials.length};
            materials.push(material.index);
            return result;
        },
        applyGltfUvTransform() {}, applyGltfOptInPbrFeatures() {},
    };
    const load = new Function(...Object.keys(leaves), transpileCommonJs(`${text}\nreturn loadVariantMaterials;`, module))(...Object.values(leaves)) as
        (json: JsonObject, bin: DataView, base: string, names: string[], meshes: Mesh[], engine: object, features: unknown[], run: () => object) => Promise<VariantData>;
    const data = await load(json, new DataView(new ArrayBuffer(0)), "", names, meshes, {}, [], () => ({}));
    const {declaration: selection} = context.functionDeclaration("src/loader-gltf/material-variants.ts", "selectVariant");
    const select = new Function(transpileCommonJs(`${selection.getText().replace(/^export\s+/, "")}\nreturn selectVariant;`, "selection.ts"))() as
        (container: {materialVariants: VariantData}, name: string) => void;
    const selections: Record<string, number[]> = Object.create(null) as Record<string, number[]>;
    const initialMaterials = meshes.map(mesh => mesh.material);
    for (const name of names) {
        meshes.forEach((mesh, index) => { mesh.material = initialMaterials[index]!; });
        select({materialVariants: data}, name);
        selections[name] = meshes.map(mesh => mesh.material.index);
    }
    return {baseCount, materials, selections};
}

for (const [name, context] of [
    ["pinned", new LoweringContext()],
    ["mapping order", doctoredContext(module, "variantExt.mappings as", "[...variantExt.mappings].reverse() as")],
    ["mapping argument", doctoredContext(module, "getMat(mapping.material)", "getMat((mapping.material + 1) % 5)")],
    ["name gate", doctoredContext(module, "if (name)", 'if (name === "B")')],
    ["cache key", doctoredContext(module, "matCache[matIdx]", "matCache[matIdx % 2]")],
    ["selection order", doctoredContext("src/loader-gltf/material-variants.ts", "for (const entry of entries)", "for (const entry of [...entries].reverse())")],
    ["selection without source reset", doctoredContext("src/loader-gltf/material-variants.ts", "for (const entry of data.originals)", "for (const entry of [])")],
] as const) test(`variant material schedule follows ${name} source`, async () => {
    assert.deepEqual(await gltfVariantPlan((await document()), context), await sourcePlan((await document()), context));
});

test("variant slots retain separate base identity and every source-built mapping", async () => {
    const plan = await gltfVariantPlan((await document()));
    assert.equal(plan.baseCount, 3);
    assert.deepEqual(plan.materials, [1, 2, 3, 0]);
    assert.deepEqual(plan.selections.A, [4, 1, 2, 4, 1]);
    assert.deepEqual(plan.selections.B, [0, 6, 2, 0, 6]);
    const subjects = await materialSubjects((await document()));
    assert.deepEqual(subjects.map(subject => subject.index), Array.from({length: 7}, (_, index) => index));
    assert.deepEqual(subjects.map(subject => subject.name), ["red", "default material", "base", "red", "white", "unselected", "base"]);
    for (const name of ["A", "B"]) {
        const renderables = await gltfRenderables((await document()), name);
        assert.deepEqual(renderables.map(renderable => renderable.material), plan.selections[name]);
    }
});

test("variant planning refuses invalid resources and metadata collisions", async () => {
    const packed = (await document());
    await packageVariantPlan(packed);
    assert.deepEqual(packed[GLTF_VARIANT_PLAN], await gltfVariantPlan((await document())));
    const cached = await gltfVariantPlan(packed);
    assert.equal(cached.materials, (packed[GLTF_VARIANT_PLAN] as {materials: number[]}).materials);
    assert.deepEqual(cached, await gltfVariantPlan((await document())));
    await assert.rejects(packageVariantPlan(packed), /already carries/);
    const invalid = (await document());
    invalid.materials = [];
    await assert.rejects(gltfVariantPlan(invalid), /Invalid or missing packaged/);
    await assert.rejects(gltfVariantPlan((await document()), doctoredContext(module,
        "assembleMaterial(json, binChunk, matIdx, baseUrl, imageCache)", "assembleMaterial(json, binChunk, matIdx, 'other', imageCache)")), /resource ownership/);
    for (const plan of [null, {}, {...cached, baseCount: 0}, {...cached, materials: [100]},
        {...cached, selections: {}}, {...cached, selections: {A: [0], B: [0]}},
        {...cached, selections: {A: [99, 99, 99, 99, 99], B: [0, 0, 0, 0, 0]}}]) {
        await assert.rejects(gltfVariantPlan({...(await document()), [GLTF_VARIANT_PLAN]: plan}), /Invalid packaged/);
    }
});
