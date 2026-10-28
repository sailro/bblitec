import type { LoweringContext } from "./context.js";

/**
 * Full AST contracts for the render-task protocol `pal_external_renderables.hpp`
 * transcribes for a scene pass's external renderables: binding generations
 * and their update batches (`_buildBindings`, `collectBatches`,
 * `releaseBatches`), the pre-pass update (`prepareRenderTaskPass`) and the
 * transparent draw (`executePassBody`, `drawList`). A pinned change to any
 * of them refuses generation until the native seam is re-read. The
 * transparent comparator and sort distance are lowered
 * (`transparent-order-lowerer.ts`), not restated.
 */
export function assertExternalRenderableContracts(
    context: LoweringContext,
): void {
    const check = (module: string, name: string, source: string): void =>
        context.assertFunctionContract(
            module,
            name,
            source,
            `${module}#${name} external-renderable contract`,
        );
    check(
        "src/render/draw-update-batches.ts",
        "enableDrawBatchCollection",
        `
export function enableDrawBatchCollection(signature: RenderTargetSignature): void {
    signature._collectBatches = collectBatches;
}
`,
    );
    check(
        "src/render/draw-update-batches.ts",
        "collectBatches",
        `
function collectBatches(state: DrawBatchState | undefined, binding: DrawBinding): DrawBatchState | undefined {
    if (!binding._updateBatches?.length) {
        return state;
    }
    if (state?._reset !== resetBatches) {
        state = { _batches: state?._batches.slice() ?? [], _reset: resetBatches, _flush: flushBatches, _select: selectBatches, _release: releaseBatches };
    }
    for (const batch of binding._updateBatches) {
        if (!state._batches.includes(batch)) {
            state._batches.push(batch);
        }
    }
    return state;
}
`,
    );
    check(
        "src/render/draw-update-batches.ts",
        "resetBatches",
        `
function resetBatches(this: DrawBatchState): void {
    for (const batch of this._batches) {
        batch.reset();
    }
}
`,
    );
    check(
        "src/render/draw-update-batches.ts",
        "flushBatches",
        `
function flushBatches(this: DrawBatchState, engine: EngineContext): void {
    for (const batch of this._batches) {
        batch.flush(engine);
    }
}
`,
    );
    check(
        "src/render/draw-update-batches.ts",
        "releaseBatches",
        `
function releaseBatches(this: DrawBatchState, engine?: EngineContext, retained?: readonly (DrawBatchState | undefined)[]): void {
    const removed = this._batches.filter((batch) => !batch._retired && !retained?.some((state) => state?._batches.includes(batch)));
    if (!removed.length) {
        return;
    }
    for (const batch of removed) {
        if (batch._retired !== undefined) {
            batch._retired = true;
        }
    }
    if (engine) {
        retireGpuResources(engine, () => runGpuResourceDisposers(removed));
    } else {
        runGpuResourceDisposers(removed);
    }
}
`,
    );
    check(
        "src/frame-graph/render-task-base.ts",
        "_buildBindings",
        `
export function _buildBindings(
    task: RenderTaskBase,
    renderables = task._renderables,
    record = false,
    publish = true,
    retainedOnFailure?: readonly (DrawBatchState | undefined)[]
): RenderTaskBindingGeneration {
    const config = task._config;
    const rt = config.rt;
    const previousBatchState = task._batchState;
    const generation = createBindingGeneration(renderables, task.scene._renderableVersion);
    if (record) {
        const buildTarget = (target: RenderTarget | undefined, always?: boolean): void => {
            if (target && (always || task._ownsTargets || target._eager)) {
                buildRenderTarget(target, task.engine);
            }
        };
        buildTarget(rt);
        if (rt._descriptor.samples > 1) {
            buildTarget(config.rst);
        }
        buildTarget(config.depth, true);
    }
    const { _opaqueBindings: opaque, _directBindings: direct, _transparentBindings: transparent } = generation;
    try {
        for (const renderable of renderables) {
            const binding = renderable.bind(task.engine, task._targetSignature);
            generation._batchState = task._targetSignature._collectBatches?.(generation._batchState, binding);
            if (renderable.isTransparent || renderable._transmissive) {
                transparent.push(binding);
            } else if (renderable._direct) {
                direct.push(binding);
            } else {
                opaque.push(binding);
            }
        }
        opaque.sort(compareBindingOrder);
        direct.sort(compareBindingOrder);
        if (record) {
            refreshTaskSceneBindGroup(task, task.engine, false);
        }
    } catch (error) {
        generation._batchState?._release(undefined, retainedOnFailure ?? [previousBatchState]);
        throw error;
    }
    if (record) {
        buildRenderPassDescriptor(task, rt);
        task._updateContext.targetWidth = rt._width;
        task._updateContext.targetHeight = rt._height;
    }
    if (publish) {
        Object.assign(task, generation);
        previousBatchState?._release(task.engine, [generation._batchState]);
    }
    return generation;
}
`,
    );
    check(
        "src/frame-graph/render-task-base.ts",
        "prepareRenderTaskPass",
        `
function prepareRenderTaskPass(task: RenderTaskBase, eng: EngineContext, targetSignature: RenderTargetSignature): void {
    const sc = task.scene as SceneContext;
    if (task._config.autoMirror !== false && task._lastVersion !== sc._renderableVersion) {
        _buildBindings(task, sc._renderables.slice());
    }

    refreshTaskSceneBindGroup(task, eng);
    const context = task._updateContext;
    const camera = task._config.cam ?? sc.camera;
    if (targetSignature._colorFormat) {
        if (!task._config._skipClusteredLights) {
            sc._clusteredLightUpdater?.(camera, context.targetWidth, context.targetHeight);
        }
        refreshSceneLightsUBO(eng, sc);
    }
    _writePassSceneUBO(task, eng, sc, camera);
    (context as MutableDrawUpdateContext)._camera = camera;
    task._batchState?._reset();
    updateBindings(task._opaqueBindings, context);
    updateBindings(task._directBindings, context);
    updateBindings(task._transparentBindings, context);
    task._batchState?._flush(eng);
    sortTransparentBindings(task, camera);
}
`,
    );
    check(
        "src/frame-graph/render-task-base.ts",
        "executePassBody",
        `
function executePassBody(task: RenderTaskBase, pass: GPURenderPassEncoder): number {
    const eng = task.engine as EngineContext;
    const cfg = task._config;
    const rt = cfg.rt;
    const scene = task.scene as SceneContext;
    const opaqueBindings = task._opaqueBindings;
    const opaqueBundles = task._ob;
    const sceneBG = task._sceneBG!;

    const camera = cfg.cam ?? scene.camera;
    _applyCameraViewport(pass, camera, rt._width, rt._height);
    pass.setBindGroup(0, sceneBG);

    if (task._lastVis !== _vis || !opaqueBundles.length) {
        const desc = rt._descriptor;
        const be = eng._device.createRenderBundleEncoder({
            colorFormats: desc.format ? [desc.format] : [],
            depthStencilFormat: task._targetSignature._depthStencilFormat,
            sampleCount: desc.samples,
        });
        be.setBindGroup(0, sceneBG);
        drawList(be, opaqueBindings, eng);
        opaqueBundles[0] = be.finish();
        task._lastVis = _vis;
    }
    let draws = opaqueBindings.length;
    pass.executeBundles(opaqueBundles);
    pass.setBindGroup(0, sceneBG);
    draws += drawList(pass, task._directBindings, eng);
    draws += drawList(pass, task._transparentBindings, eng);
    return draws;
}
`,
    );
    check(
        "src/frame-graph/render-task-base.ts",
        "updateBindings",
        `
function updateBindings(list: readonly DrawBinding[], context: DrawUpdateContext): void {
    for (const binding of list) {
        binding.update?.(context);
    }
}
`,
    );
    check(
        "src/frame-graph/render-task-base.ts",
        "drawList",
        `
export function drawList(enc: GPURenderPassEncoder | GPURenderBundleEncoder, list: readonly DrawBinding[], engine: EngineContext): number {
    let lp: GPURenderPipeline | null = null;
    let draws = 0;
    for (const b of list) {
        const mesh = b.renderable.mesh;
        if (mesh && mesh.visible === false) {
            continue;
        }
        if (b.pipeline !== lp) {
            enc.setPipeline(b.pipeline);
            lp = b.pipeline;
        }
        draws += b.draw(enc, engine);
    }
    return draws;
}
`,
    );
}
