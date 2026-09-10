import ts from "typescript";
import {asIndex, asObject, areGltfIndices, type JsonObject} from "./gltf-document.js";
import {GltfGeometryPacker} from "./gltf-mesh-geometry.js";
import type {RecordedMeshDeformation} from "./gltf-mesh-deformation.js";
import {LoweringContext} from "./lowering/context.js";
import {pinnedModuleTextUrl} from "./pinned-shader-composer.js";
import {transpileForBrowser} from "./typescript-transpile.js";

export interface GltfAnimationBindings {
    /** Source replay ordinals, which can differ from extraction's actual node ownership. */
    nodeMeshes: Array<{node: number; meshes: number[]}>;
    skeletons: Array<{meshes: number[]; joints: number[]; inverseBindMatrices: number; invMeshWorld: number}>;
    morphs: Array<{meshes: number[]; node: number; count: number}>;
    nodeTargets: Array<number | null>;
    excludedNodes: number[];
}

export interface SourceBindings {
    nodeToMeshIndices: Map<number, number[]>;
    skeletons: Array<{jointNodes: number[]; inverseBindMatrices: Float32Array; invMeshWorld: Float32Array;
        boneTexture: object; boneCount: number; boneMatrices: Float32Array; runtimeSkeleton: NonNullable<RecordedMeshDeformation["skeleton"]>}>;
    morphBindings: Array<{nodeIdx: number; weightsBuffer: object; weights: Float32Array; targetCount: number;
        runtimeMorphTargets: NonNullable<RecordedMeshDeformation["morphTargets"]>}>;
    nodeTargets: readonly (object | undefined)[];
    excludedNodeIndices: Set<number>;
}

export interface SourceAnimationBindings {
    __animationBindings(json: JsonObject, bin: DataView, meshes: RecordedMeshDeformation[], parents: Map<number, number>,
        worlds: Map<number, Float32Array>, nodes: readonly (object | undefined)[]): SourceBindings;
}

/** Execute the complete target construction section, independently of clip/pointer terminal gating. */
export function gltfAnimationBindingsSourceUrl(context: LoweringContext, bridge?: string): string {
    const module = "src/loader-gltf/gltf-animation.ts";
    const {file, declaration} = context.functionDeclaration(module, "parseAnimationData");
    const statements = declaration.body!.statements;
    const declares = (statement: ts.Statement, name: string): boolean => ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(variable => ts.isIdentifier(variable.name) && variable.name.text === name);
    const nodeCount = statements.find(statement => declares(statement, "nodeCount"));
    const start = statements.findIndex(statement => declares(statement, "nodeToMeshIndices"));
    const end = statements.findIndex((statement, index) => index > start && ts.isIfStatement(statement));
    if (!nodeCount || start < 0 || end < start || !statements.slice(start, end).some(statement => declares(statement, "excludedNodeIndices")))
        context.contractError(declaration, "Expected the complete animation binding section before the terminal clip predicate.");
    const names = ["json", "binChunk", "meshes", "parentMap", "worldMatrixCache", "nodeMap"];
    names.forEach((name, index) => {
        const parameter = declaration.parameters[index]?.name;
        if (!parameter || !ts.isIdentifier(parameter) || parameter.text !== name)
            context.contractError(declaration, "Unrepresented animation binding parameter.");
    });
    const body = [nodeCount, ...statements.slice(start, end)].map(statement => statement.getText(file)).join("\n");
    let sourceText = file.text;
    if (bridge) {
        const terminal = statements[end]!;
        const fields = ["clips", "nodes", "nodeToMeshIndices", "skeletons", "morphBindings", "nodeTargets", "excludedNodeIndices", "pointerChannelCount"];
        const transform = ts.transform(file, [visitorContext => root => {
            const visit: ts.Visitor = node => node === declaration
                ? ts.factory.updateFunctionDeclaration(declaration, declaration.modifiers, declaration.asteriskToken,
                    declaration.name, declaration.typeParameters, declaration.parameters, declaration.type,
                    ts.factory.updateBlock(declaration.body!, statements.flatMap(statement => statement === terminal ? [
                        ts.factory.createExpressionStatement(ts.factory.createCallExpression(
                            ts.factory.createIdentifier("__recordTerminalInputs"), undefined,
                            [ts.factory.createIdentifier("json"), ts.factory.createObjectLiteralExpression(
                                fields.map(field => ts.factory.createShorthandPropertyAssignment(field)))])), statement,
                    ] : [statement])))
                : ts.visitEachChild(node, visit, visitorContext);
            return ts.visitNode(root, visit, ts.isSourceFile)!;
        }]);
        sourceText = `import {recordTerminalInputs as __recordTerminalInputs} from ${JSON.stringify(bridge)};\n` +
            ts.createPrinter().printFile(transform.transformed[0]!);
        transform.dispose();
    }
    const source = `${sourceText}\nexport function __animationBindings(${names.join(", ")}) {\n${body}\n` +
        "return {nodeToMeshIndices, skeletons, morphBindings, nodeTargets, excludedNodeIndices};\n}";
    return pinnedModuleTextUrl("loader-gltf/gltf-animation.js", transpileForBrowser(source, module));
}

/** Translate only identities and storage; source loops select every binding and exclusion. */
export function packageAnimationBindings(source: SourceAnimationBindings, document: JsonObject, bin: DataView,
    meshes: RecordedMeshDeformation[], parents: Map<number, number>, worlds: Map<number, Float32Array>,
    nodes: readonly (object | undefined)[], packer: GltfGeometryPacker): GltfAnimationBindings {
    const result = source.__animationBindings(document, bin, meshes, parents, worlds, nodes);
    return packSourceAnimationBindings(result, meshes, nodes, packer);
}

/** Reuse full parse's actual target objects without executing their construction a second time. */
export function packSourceAnimationBindings(result: SourceBindings, meshes: RecordedMeshDeformation[],
    nodes: readonly (object | undefined)[], packer: GltfGeometryPacker): GltfAnimationBindings {
    const nodeIndices = new Map(nodes.flatMap((node, index) => node ? [[node, index] as const] : []));
    const skeletonOwners = new Map<object, number[]>(), morphOwners = new Map<object, number[]>();
    meshes.forEach((mesh, index) => {
        for (const [resource, owners] of [[mesh.skeleton, skeletonOwners], [mesh.morphTargets, morphOwners]] as const) {
            if (!resource) continue;
            const slots = owners.get(resource) ?? [];
            slots.push(index);
            owners.set(resource, slots);
        }
    });
    const finiteFloat32 = (values: Float32Array, length: number): boolean => values instanceof Float32Array &&
        values.length === length && values.every(Number.isFinite);
    const plan: GltfAnimationBindings = {
        nodeMeshes: [...result.nodeToMeshIndices].map(([node, slots]) => ({node, meshes: slots})),
        skeletons: result.skeletons.map(binding => {
            const owners = skeletonOwners.get(binding.runtimeSkeleton);
            if (!owners || binding.boneTexture !== binding.runtimeSkeleton.boneTexture ||
                binding.boneMatrices !== binding.runtimeSkeleton.boneMatrices || binding.boneCount !== binding.runtimeSkeleton.boneCount ||
                binding.jointNodes.length !== binding.boneCount || !areGltfIndices(binding.jointNodes, nodes.length) ||
                !finiteFloat32(binding.inverseBindMatrices, binding.boneCount * 16) || !finiteFloat32(binding.invMeshWorld, 16))
                throw new Error("Unrepresented source animation skeleton identity or storage.");
            return {meshes: owners, joints: binding.jointNodes, inverseBindMatrices: packer.float32(binding.inverseBindMatrices, 4),
                invMeshWorld: packer.float32(binding.invMeshWorld, 4)};
        }),
        morphs: result.morphBindings.map(binding => {
            const owners = morphOwners.get(binding.runtimeMorphTargets);
            if (!owners || binding.weightsBuffer !== binding.runtimeMorphTargets.weightsBuffer ||
                binding.weights !== binding.runtimeMorphTargets.weights || binding.targetCount !== binding.runtimeMorphTargets.count)
                throw new Error("Unrepresented source animation morph identity or storage.");
            return {meshes: owners, node: binding.nodeIdx, count: binding.targetCount};
        }),
        nodeTargets: Array.from(result.nodeTargets, node => {
            if (node === undefined) return null;
            const index = nodeIndices.get(node);
            if (index === undefined) throw new Error("Unrepresented source animation node target identity.");
            return index;
        }),
        excludedNodes: [...result.excludedNodeIndices],
    };
    return readAnimationBindings(plan, meshes.length, nodes.length, packer.accessors.length);
}

export function readAnimationBindings(value: unknown, meshCount: number, nodeCount: number, accessorCount: number): GltfAnimationBindings {
    const plan = asObject(value);
    if (!plan || !Array.isArray(plan.nodeMeshes) || !Array.isArray(plan.skeletons) || !Array.isArray(plan.morphs) ||
        !Array.isArray(plan.nodeTargets) || !plan.nodeTargets.every(node => node === null || (asIndex(node) !== undefined && node < nodeCount)) ||
        !areGltfIndices(plan.excludedNodes, nodeCount)) throw new Error("Invalid packaged glTF animation targets.");
    const nodeMeshes = plan.nodeMeshes.map(value => {
        const entry = asObject(value), node = asIndex(entry?.node);
        if (!entry || node === undefined || node >= nodeCount || !areGltfIndices(entry.meshes, Number.MAX_SAFE_INTEGER))
            throw new Error("Invalid packaged glTF animation replay ordinals.");
        return {node, meshes: entry.meshes};
    });
    const skeletons = plan.skeletons.map(value => {
        const entry = asObject(value), inverseBindMatrices = asIndex(entry?.inverseBindMatrices), invMeshWorld = asIndex(entry?.invMeshWorld);
        if (!entry || !areGltfIndices(entry.meshes, meshCount) || !entry.meshes.length || !areGltfIndices(entry.joints, nodeCount) ||
            inverseBindMatrices === undefined || inverseBindMatrices >= accessorCount || invMeshWorld === undefined || invMeshWorld >= accessorCount)
            throw new Error("Invalid packaged glTF animation skeleton binding.");
        return {meshes: entry.meshes, joints: entry.joints, inverseBindMatrices, invMeshWorld};
    });
    const morphs = plan.morphs.map(value => {
        const entry = asObject(value), node = asIndex(entry?.node), count = asIndex(entry?.count);
        if (!entry || !areGltfIndices(entry.meshes, meshCount) || !entry.meshes.length || node === undefined || node >= nodeCount || count === undefined)
            throw new Error("Invalid packaged glTF animation morph binding.");
        return {meshes: entry.meshes, node, count};
    });
    return {nodeMeshes, skeletons, morphs, nodeTargets: plan.nodeTargets as Array<number | null>, excludedNodes: plan.excludedNodes};
}
