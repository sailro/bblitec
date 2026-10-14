import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { recordAt } from "../compiler/record-access.js";
import { taskDisposedCpp } from "./frame-graph-task-disposal.js";

const module = "src/mesh/mesh-dispose.ts";

/**
 * `disposeMeshGpu`: the pin's once-only guard, then the claims a mesh
 * holds. `retire_mesh_record` is the native release `removeFromScene`
 * already disposes a mesh through: the shared geometry by its owner count,
 * the thin-instance pool through its lowered subtree. Skeleton, VAT and
 * morph records are shared engine records whose GPU images live with the
 * backend rows of the meshes drawing them, so a mesh no scene or task
 * lists holds none of their GPU objects.
 *
 * The pin destroys the buffers a scene or task may still submit; a mesh
 * still listed refuses, since drawing destroyed buffers is not represented.
 */
export function lowerMeshGpuDisposal(
    context: LoweringContext,
    thinBindings: boolean,
): string {
    const { file, declaration } = context.functionDeclaration(
        module,
        "disposeMeshGpu",
    );
    const statements = declaration.body!.statements;
    context.assertStatementShapes(
        declaration.body!,
        statements,
        `
        if (mesh._disposed) {
            return;
        }
        mesh._disposed = true;
        _retirementObserver?.(mesh);
        const g = mesh._gpu;
        if (release(g)) {
            if (_borrowAwareDisposer) {
                _borrowAwareDisposer(g, disposeVertexBuffers);
            } else {
                disposeVertexBuffers(g);
                g.indexBuffer.destroy();
            }
            g._shaderColorFallback?.destroy();
        }
        const ti = mesh.thinInstances;
        if (ti && release(ti)) {
            _detachThinInstanceLodMesh(mesh);
            ti._gpuBuffer?.destroy();
            ti._colorGpuBuffer?.destroy();
            ti._drawArgsBuffer?.destroy();
        }
        const sk = mesh.skeleton;
        if (sk && release(sk)) {
            sk._disposed = true;
            sk.boneTexture.destroy();
            if (release(sk._skinBuffers)) {
                sk.jointsBuffer.destroy();
                sk.weightsBuffer.destroy();
                sk.joints1Buffer?.destroy();
                sk.weights1Buffer?.destroy();
            }
        }
        const vat = mesh.vat;
        if (vat && release(vat)) {
            vat.settingsBuffer.destroy();
            vat.instanceTexture?.destroy();
            if (release(vat._textureResource)) {
                vat._textureResource.texture.destroy();
            }
            if (release(vat._skinBuffers)) {
                vat.jointsBuffer.destroy();
                vat.weightsBuffer.destroy();
                vat.joints1Buffer?.destroy();
                vat.weights1Buffer?.destroy();
            }
        }
        const mt = mesh.morphTargets;
        if (mt && release(mt)) {
            mt._disposed = true;
            mt.deltasBuffer.destroy();
            mt.weightsBuffer.destroy();
        }
    `,
        "Mesh GPU disposal",
    );
    // Only the storage-borrowing factories install these hooks, and no
    // admitted program reaches them.
    context.assertWrittenOnlyBy(
        "_retirementObserver",
        module,
        "_installMeshRetirementObserver",
    );
    context.assertWrittenOnlyBy(
        "_borrowAwareDisposer",
        module,
        "_installBorrowAwareGeometryDisposer",
    );
    const guard = lowerPinnedBody(file, [statements[0]!], {
        bindings: new Map([
            ["mesh._disposed", { cpp: "record.retired", type: "bool" }],
        ]),
        calls: new Map(),
    });
    return `// ${context.provenance(module, "disposeMeshGpu")}
void dispose_mesh_gpu(Engine& engine, MeshHandle mesh) {
    // A handle whose slot a later mesh took names a mesh already disposed.
    if (!mesh_handle_current(engine, mesh)) return;
    const MeshRecord& record = ${recordAt("engine.meshes", "mesh")};
${guard}
    const auto owners = engine.mesh_material_scenes.find(mesh.value);
    const bool scene_member = owners != engine.mesh_material_scenes.end() && owners->second &&
        std::any_of(owners->second->begin(), owners->second->end(),
                    [](const auto& owner) { return !owner.expired(); });
    const bool task_member = std::any_of(
        engine.frame_tasks.begin(), engine.frame_tasks.end(), [mesh](const FrameTaskRecord& task) {
            return task.kind == FrameTaskKind::render && !${taskDisposedCpp("task", false)} &&
                std::any_of(task.render_meshes.begin(), task.render_meshes.end(),
                            [mesh](const RenderTaskMesh& entry) { return entry.mesh == mesh; });
        });
    if (scene_member || task_member)
        throw std::runtime_error("disposeMeshGpu: mesh '" + record.name +
                                 "' is still listed by a scene or render task, which would draw its "
                                 "destroyed buffers; remove it first.");
    retire_mesh_record(engine, mesh${thinBindings ? ", dispose_thin_instance_gpu" : ""});
}
`;
}
