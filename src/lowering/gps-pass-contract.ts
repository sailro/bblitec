import ts from "typescript";
import { soleBindingName } from "../compiler/syntax.js";
import { PinnedNumericLowerer } from "./pinned-numeric-lowerer.js";
import type { LoweringContext } from "./context.js";
import { GPS_PASS } from "./splat-stream-library.js";

/** The predicate of the pin's task search and the decision on that task. The native
 * scene has one representable pass; a device signature is its identity, not a name. */
export function gpsPassPolicy(context: LoweringContext): string {
    const { file } = context.functionDeclaration(GPS_PASS, "gpsRenderTask");
    const find = context.returnedExpression(GPS_PASS, "gpsRenderTask");
    if (
        !ts.isCallExpression(find) ||
        find.arguments.length !== 1 ||
        !context.expressionMatchesShape(
            find.expression,
            "scene._frameGraph?._tasks.find",
        )
    )
        return context.contractError(
            find,
            "Expected a search of the scene's tasks.",
        );
    const predicate = find.arguments[0]!;
    if (
        !ts.isArrowFunction(predicate) ||
        ts.isBlock(predicate.body) ||
        predicate.parameters.length !== 1 ||
        soleBindingName(predicate.parameters[0]!.name) !== "task"
    )
        return context.contractError(
            predicate,
            "Expected a task selection predicate.",
        );
    const lowerer = new PinnedNumericLowerer(file, {
        bindings: new Map([
            ["task._targetSignature", { type: "opaque", cpp: "candidate" }],
            ["signature", { type: "opaque", cpp: "signature" }],
        ]),
        calls: new Map(),
        expression(node) {
            if (
                context.expressionMatchesShape(
                    node,
                    "task?._targetSignature._depthStencilFormat",
                )
            )
                return "(task && task->depth_stencil_format.has_value())";
            if (
                context.expressionMatchesShape(
                    node,
                    "owners?.get(scene)?.tasks.has(task)",
                )
            )
                return "(task && !scene->pass_controllers.empty())";
            if (
                context.expressionMatchesShape(
                    node,
                    '"_targetSignature" in task',
                )
            )
                return "true";
            return undefined;
        },
    });
    const selected = lowerer.expression(predicate.body);
    const defers = context.functionDeclaration(
        GPS_PASS,
        "gpsDefersDraw",
    ).declaration;
    const statements = defers.body?.statements;
    if (
        statements?.length !== 2 ||
        !ts.isVariableStatement(statements[0]!) ||
        !ts.isReturnStatement(statements[1]!) ||
        !statements[1].expression
    )
        return context.contractError(
            defers,
            "Expected gpsDefersDraw to decide on the selected task.",
        );
    context.assertExpressionShape(
        context.variableInitializer(defers, "task"),
        "gpsRenderTask(scene, signature)",
        "GPS task lookup",
    );
    return `#pragma once
#include <bblite/library_runtime.hpp>
namespace bbl::library {
// ${context.provenance(GPS_PASS, "gpsRenderTask")}
[[nodiscard]] inline const GpuRenderTargetSignature* gps_selected_task(const LibraryScene& scene, const LibraryTargetSignature& signature) {
    const auto& candidate = scene->pausable_pass;
    return candidate && (${selected}) ? candidate.get() : nullptr;
}
[[nodiscard]] inline js::Nullable<RenderTaskView> gps_render_task(const LibraryScene& scene, const LibraryTargetSignature& signature) {
    if (gps_selected_task(scene, signature)) return scene_pass_view(scene, scene->pausable_pass);
    return std::nullopt;
}
// ${context.provenance(GPS_PASS, "gpsDefersDraw")}
[[nodiscard]] inline bool gps_defers_draw(const LibraryScene& scene, const LibraryTargetSignature& signature) {
    if (!scene->pass_controllers.empty() && signature && signature->depth_stencil_format && scene->pausable_pass != signature)
        throw std::runtime_error("Pausing a render task's pass is not lowered.");
    const auto* task = gps_selected_task(scene, signature);
    return ${lowerer.expression(statements[1].expression)};
}
} // namespace bbl::library
`;
}

/**
 * Full AST contracts for gps-pass.ts, which the point renderer's pass
 * adapters transcribe (splat-stream-library.ts `gpsPassAdapters`): the
 * renderer's scene pass is the task it instruments, split on a frame a
 * renderer renders (runtime.hpp `scene_pass_split`, `isRendering`), its
 * draws reported (`hasDraws`, cleared by a depth-clearing begin) and its
 * pause resuming with load and the dynamic state and group 0 replayed
 * (both backends' `pause_pass`), with `gps_*` in library_runtime.hpp. A
 * pinned change to any of them refuses generation until the native seam
 * is re-read.
 */
export function assertGpsPassContracts(context: LoweringContext): void {
    const check = (name: string, source: string): void =>
        context.assertFunctionContract(
            GPS_PASS,
            name,
            source,
            `${GPS_PASS}#${name} point renderer pass contract`,
        );
    check(
        "gpsRefreshPasses",
        `
export function gpsRefreshPasses(scene: SceneContext): void {
    owners?.get(scene)?.scan();
}
`,
    );
    check(
        "gpsPassHasDraws",
        `
export function gpsPassHasDraws(pass: GPURenderPassEncoder | GPURenderBundleEncoder): boolean | undefined {
    return passes?.get(pass)?.hasDraws();
}
`,
    );
    check(
        "gpsWithPassDepth",
        `
export function gpsWithPassDepth(pass: GPURenderPassEncoder | GPURenderBundleEncoder, work: () => void): boolean {
    const control = passes?.get(pass);
    if (!control) {
        return false;
    }
    control.pause(work);
    return true;
}
`,
    );
    check(
        "loadDescriptor",
        `
function loadDescriptor(descriptor: GPURenderPassDescriptor): GPURenderPassDescriptor {
    const depth = descriptor.depthStencilAttachment;
    return {
        ...descriptor,
        timestampWrites: undefined,
        colorAttachments: Array.from(descriptor.colorAttachments, (attachment) => attachment && { ...attachment, loadOp: "load", storeOp: "store" }),
        depthStencilAttachment: depth && {
            ...depth,
            depthLoadOp: depth.depthReadOnly ? undefined : "load",
            depthStoreOp: depth.depthReadOnly ? undefined : "store",
            stencilLoadOp: depth.stencilLoadOp && !depth.stencilReadOnly ? "load" : undefined,
            stencilStoreOp: depth.stencilStoreOp && !depth.stencilReadOnly ? "store" : undefined,
        },
    };
}
`,
    );
    check(
        "wrapPass",
        `
function wrapPass(task: RenderTask, begin: GPUCommandEncoder["beginRenderPass"], descriptor: GPURenderPassDescriptor, frame: { drawn: boolean }): GPURenderPassEncoder {
    if (descriptor.depthStencilAttachment?.depthLoadOp === "clear") {
        frame.drawn = false;
    }
    let current = begin(descriptor);
    const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
    const dynamic = new Map<PropertyKey, unknown[]>();
    let group: unknown[] | undefined;
    const proxy = new Proxy(current, {
        get(_target, key) {
            const value: unknown = Reflect.get(current, key, current);
            if (typeof value !== "function") {
                return value;
            }
            let method = methods.get(key);
            if (!method) {
                method = (...args) => {
                    if (key === "setViewport" || key === "setScissorRect" || key === "setStencilReference" || key === "setBlendConstant" || key === "setPipeline") {
                        dynamic.set(key, args);
                    } else if (key === "setBindGroup" && args[0] === 0) {
                        group = args;
                    } else if (key === "executeBundles") {
                        dynamic.delete("setPipeline");
                        group = undefined;
                        const bundles = Array.from(args[0] as Iterable<GPURenderBundle>);
                        args[0] = bundles;
                        if (bundles.some((bundle) => task._opaqueBindings.length > 0 || !task._ob.includes(bundle))) {
                            frame.drawn = true;
                        }
                    } else if (key === "draw" || key === "drawIndexed" || key === "drawIndirect" || key === "drawIndexedIndirect") {
                        frame.drawn = true;
                    }
                    return Reflect.apply(Reflect.get(current, key, current), current, args);
                };
                methods.set(key, method);
            }
            return method;
        },
    });
    (passes ??= new WeakMap()).set(proxy, {
        hasDraws: () => frame.drawn,
        pause(work) {
            current.end();
            work();
            current = begin(loadDescriptor(descriptor));
            dynamic.forEach((args, key) => Reflect.apply(Reflect.get(current, key, current), current, args));
            if (group) {
                Reflect.apply(current.setBindGroup, current, group);
            }
        },
    });
    return proxy;
}
`,
    );
    check(
        "hasRendering",
        `
function hasRendering(predicates: ReadonlySet<() => boolean>): boolean {
    for (const predicate of predicates) {
        if (predicate()) {
            return true;
        }
    }
    return false;
}
`,
    );
    check(
        "execute",
        `
function execute(task: RenderTask, engine: EngineContext, original: NonNullable<RenderTask["execute"]>): number {
    const encoder = engine._currentEncoder;
    const descriptor = Object.getOwnPropertyDescriptor(encoder, "beginRenderPass");
    const begin = encoder.beginRenderPass.bind(encoder);
    const frame = { drawn: false };
    const wrapped = (pass: GPURenderPassDescriptor): GPURenderPassEncoder => {
        const depth = (task._config.depth ?? task._config.rt)._depthView;
        return depth && pass.depthStencilAttachment?.view === depth ? wrapPass(task, begin, pass, frame) : begin(pass);
    };
    if (!Reflect.set(encoder, "beginRenderPass", wrapped, encoder)) {
        throw new Error("Gaussian point sampling could not instrument the consuming render pass");
    }
    try {
        return original.call(task);
    } finally {
        if (encoder.beginRenderPass === wrapped) {
            if (descriptor) {
                Object.defineProperty(encoder, "beginRenderPass", descriptor);
            } else {
                Reflect.deleteProperty(encoder, "beginRenderPass");
            }
        }
    }
}
`,
    );
    check(
        "installGpsPasses",
        `
export function installGpsPasses(scene: SceneContext, isRendering?: () => boolean): () => void {
    let owner = owners?.get(scene);
    if (!owner) {
        const tasks: PassOwner["tasks"] = new Map();
        const rendering: PassOwner["rendering"] = new Set();
        owner = {
            rendering,
            tasks,
            scan() {
                const current = new Set(scene._frameGraph?._tasks ?? []);
                tasks.forEach((patch, task) => {
                    if (!current.has(task)) {
                        patch.active = false;
                        if (task.execute === patch.wrapped) {
                            task.execute = patch.original;
                        }
                        tasks.delete(task);
                    }
                });
                for (const task of scene._frameGraph?._tasks ?? []) {
                    if (!("_targetSignature" in task)) {
                        continue;
                    }
                    const renderTask = task as RenderTask;
                    if (tasks.get(renderTask)?.wrapped === renderTask.execute) {
                        continue;
                    }
                    const previous = tasks.get(renderTask);
                    if (previous) {
                        previous.active = false;
                    }
                    const original = renderTask.execute;
                    if (!original) {
                        continue;
                    }
                    const patch: TaskPatch = {
                        original,
                        active: true,
                        wrapped: () => (patch.active && hasRendering(rendering) ? execute(renderTask, scene.surface.engine, original) : original.call(renderTask)),
                    };
                    tasks.set(renderTask, patch);
                    renderTask.execute = patch.wrapped;
                }
            },
        };
        (owners ??= new WeakMap()).set(scene, owner);
        scene._beforeRender.push(owner.scan);
    }
    const rendering = (): boolean => isRendering?.() ?? true;
    owner.rendering.add(rendering);
    owner.scan();
    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        owner.rendering.delete(rendering);
        if (owner.rendering.size !== 0) {
            return;
        }
        owner.tasks.forEach((patch, task) => {
            patch.active = false;
            if (task.execute === patch.wrapped) {
                task.execute = patch.original;
            }
        });
        const index = scene._beforeRender.indexOf(owner.scan);
        if (index >= 0) {
            scene._beforeRender.splice(index, 1);
        }
        owners?.delete(scene);
    };
}
`,
    );
}
