import ts from "typescript";
import type { CompiledShaderProgram } from "../compiler/types.js";
import { mapShaderStatements, parseWgslStages, type ShaderModule } from "../shader-ir.js";
import { emitWgslModule } from "../shader-wgsl-emitter.js";
import { type LoweringContext } from "./context.js";

export const physicsViewerMaterialModule = "src/physics/physics-debug-line-material.ts";

/** The dedicated pinned pipeline, transported through the ordinary shader program ABI. */
export function physicsViewerMaterialProgram(context: LoweringContext, color: readonly [number, number, number, number]): CompiledShaderProgram {
    const file = context.sourceFile(physicsViewerMaterialModule);
    for (const name of ["_cachedDevice", "_meshBGL", "_pipelineCache"]) {
        context.assertExpressionShape(context.variableInitializer(file, name), "null", `Physics debug ${name} initial state`);
    }
    for (const [name, body] of [
        ["ensureDevice", `if (_cachedDevice !== engine._device) { _cachedDevice = engine._device; _meshBGL = null; _pipelineCache = null; }`],
        ["getPipelineCache", `if (!_pipelineCache) { _pipelineCache = new Map(); } return _pipelineCache;`],
        ["clearPhysicsDebugLinePipelineCache", `_pipelineCache = null; _meshBGL = null; _cachedDevice = null;`],
    ]) {
        const declaration = context.functionDeclaration(physicsViewerMaterialModule, name!).declaration;
        context.assertStatementShapes(declaration, declaration.body!.statements, body!, `Physics debug ${name} cache lifetime`);
    }
    const builder = context.variableInitializer(file, "physicsDebugLineGroupBuilder");
    if (!ts.isArrowFunction(builder) || !ts.isBlock(builder.body)) context.contractError(builder, "Physics debug group builder changed.");
    context.assertStatementShapes(builder, builder.body.statements, `
        const rebuildSingle = (s: SceneContext, mesh: Mesh, materialOverride?: Material): Renderable => buildLineRenderable(s, mesh, materialOverride);
        physicsDebugLineGroupBuilder._rebuildSingle = rebuildSingle;
        scene._disposables.push(clearPhysicsDebugLinePipelineCache);
        return { renderables: meshes.map((mesh) => rebuildSingle(scene, mesh)), rebuildSingle };
    `, "Physics debug group membership, rebuilding and disposal");
    const factory = context.functionDeclaration(physicsViewerMaterialModule, "createPhysicsDebugLineMaterial").declaration;
    context.assertStatementShapes(factory, factory.body!.statements, `
        return { _buildGroup: physicsDebugLineGroupBuilder, _uboVersion: 0, color: [color[0], color[1], color[2], color[3]] };
    `, "Physics debug material values");
    const pipeline = context.functionDeclaration(physicsViewerMaterialModule, "getOrCreateLinePipeline").declaration;
    context.assertStatementShapes(pipeline, pipeline.body!.statements, `
        ensureDevice(engine);
        const key = targetSignatureKey(sig);
        const cache = getPipelineCache();
        const cached = cache.get(key);
        if (cached) { return cached; }
        if (!sig._colorFormat) { throw new Error("Physics debug lines require a color render target."); }
        const device = engine._device;
        const module = device.createShaderModule({ code: LINE_WGSL });
        const pipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [getSceneBindGroupLayout(engine), getMeshBindGroupLayout(engine)] }),
            vertex: { module, entryPoint: "vsMain", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
            fragment: { module, entryPoint: "fsMain", targets: [{ format: sig._colorFormat }] },
            depthStencil: sig._depthStencilFormat ? { format: sig._depthStencilFormat, depthCompare: "always", depthWriteEnabled: false } : undefined,
            multisample: { count: sig._sampleCount }, primitive: { topology: "line-list" },
        });
        cache.set(key, pipeline);
        return pipeline;
    `, "Physics debug pipeline state and target inputs");
    const bindings = context.functionDeclaration(physicsViewerMaterialModule, "getMeshBindGroupLayout").declaration;
    context.assertStatementShapes(bindings, bindings.body!.statements, `
        ensureDevice(engine);
        if (!_meshBGL) {
            _meshBGL = engine._device.createBindGroupLayout({ label: "physics-debug-line-mesh", entries: [
                { binding: 0, visibility: SS.VERTEX, buffer: { type: "uniform" } },
                { binding: 1, visibility: SS.FRAGMENT, buffer: { type: "uniform" } },
            ] });
        }
        return _meshBGL;
    `, "Physics debug material buffer bindings");
    const renderable = context.functionDeclaration(physicsViewerMaterialModule, "buildLineRenderable").declaration;
    context.assertStatementShapes(renderable, renderable.body!.statements, `
        const engine = scene.surface.engine;
        const material = (materialOverride ?? mesh.material) as PhysicsDebugLineMaterial;
        const meshData = new F32(16);
        packMat4IntoF32(meshData, mesh.worldMatrix);
        const meshUBO = createUniformBuffer(engine, meshData);
        const materialData = new F32(4);
        materialData.set(material.color);
        const materialUBO = createUniformBuffer(engine, materialData);
        const bindGroup = engine._device.createBindGroup({ layout: getMeshBindGroupLayout(engine), entries: [
            { binding: 0, resource: { buffer: meshUBO } }, { binding: 1, resource: { buffer: materialUBO } },
        ] });
        let lastWorldVersion = mesh.worldMatrixVersion;
        const update = (): void => {
            if (mesh.worldMatrixVersion !== lastWorldVersion) {
                packMat4IntoF32(meshData, mesh.worldMatrix);
                engine._device.queue.writeBuffer(meshUBO, 0, meshData);
                lastWorldVersion = mesh.worldMatrixVersion;
            }
        };
        const renderable: Renderable = {
            order: mesh.renderOrder ?? 1000, isTransparent: false, _direct: true, mesh,
            bind(eng, sig) { return { renderable, pipeline: getOrCreateLinePipeline(eng as EngineContext, sig), update,
                draw(pass) {
                    const gpu = mesh._gpu;
                    pass.setVertexBuffer(0, gpu.positionBuffer);
                    pass.setIndexBuffer(gpu.indexBuffer, gpu.indexFormat);
                    pass.setBindGroup(1, bindGroup);
                    pass.drawIndexed(gpu.indexCount);
                    return 1;
                },
            }; },
        };
        renderable._worldCenter = [mesh.worldMatrix[12]!, mesh.worldMatrix[13]!, mesh.worldMatrix[14]!];
        return renderable;
    `, "Physics debug material uploads, draw order and live world matrix");
    const text = context.stringValue(context.variableInitializer(file, "LINE_WGSL"), file);
    const modules = parseWgslStages(text);
    const vertex = modules.find(module => module.entryPoint.stage === "vertex");
    const fragment = modules.find(module => module.entryPoint.stage === "fragment");
    if (modules.length !== 2 || !vertex || !fragment || vertex.entryPoint.name !== "vsMain" || fragment.entryPoint.name !== "fsMain") {
        context.contractError(file, "Physics debug WGSL requires its declared vertex and fragment entry points.");
    }
    const expectedBindings = [
        { name: "scene", type: "SceneUniforms", group: 0, binding: 0, addressSpace: "uniform" },
        { name: "mesh", type: "MeshUniforms", group: 1, binding: 0, addressSpace: "uniform" },
        { name: "mat", type: "MaterialUniforms", group: 1, binding: 1, addressSpace: "uniform" },
    ];
    const expectedStructs = [
        { name: "SceneUniforms", members: [{ name: "viewProjection", type: "mat4x4<f32>" }] },
        { name: "MeshUniforms", members: [{ name: "world", type: "mat4x4<f32>" }] },
        { name: "MaterialUniforms", members: [{ name: "color", type: "vec4<f32>" }] },
    ];
    if (JSON.stringify(vertex.bindings) !== JSON.stringify(expectedBindings) ||
        JSON.stringify(vertex.structs.filter(structure => expectedBindings.some(binding => binding.type === structure.name))) !== JSON.stringify(expectedStructs) ||
        JSON.stringify(vertex.entryPoint.parameters) !== JSON.stringify([{ name: "position", type: "vec3<f32>", attribute: { kind: "location", value: 0 } }]) ||
        fragment.entryPoint.parameters.length !== 0) {
        context.contractError(file, "Physics debug WGSL buffer or vertex interface changed.");
    }
    const replacements: Record<string, string[]> = {
        "scene.viewProjection": ["shaderSystem", "viewProjection"], "mesh.world": ["shaderSystem", "world"],
        "mat.color": ["shaderUniforms", "color"], "position": ["input", "position"],
    };
    const project = (module: ShaderModule): string => emitWgslModule({
        structs: module.structs.filter(structure => !expectedBindings.some(binding => binding.type === structure.name)),
        entryPoint: {
            ...module.entryPoint,
            name: module.entryPoint.stage === "vertex" ? "mainVertex" : "mainFragment",
            parameters: module.entryPoint.stage === "vertex" ? [{ name: "input", type: "VertexInput" }] : [],
            statements: mapShaderStatements(module.entryPoint.statements, expression => {
                if (expression.kind !== "path") return expression;
                return replacements[expression.parts.join(".")] ? { kind: "path", parts: replacements[expression.parts.join(".")]! } : expression;
            }),
        },
    });
    return {
        name: `physics-debug-lines-${color.join("-")}`, vertexSource: project(vertex), fragmentSource: project(fragment),
        attributes: ["position"], uniforms: ["viewProjection", "world", "color:vec4<f32>"], uniformDefaults: [{ name: "color", values: [...color] }],
        samplers: [], samplerDeclarations: [], storageBuffers: [], defines: [],
        needAlphaBlending: false, blendMode: "alpha", needAlphaTesting: false, backFaceCulling: false,
        depthWrite: false, depthCompare: "always", topology: "line-list",
    };
}
