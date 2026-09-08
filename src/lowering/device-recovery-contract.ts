import type { LoweringContext } from "./context.js";

/** Full AST contracts for the pinned lifecycle represented by native resource ownership. */
export function assertDeviceRecoveryContracts(context: LoweringContext): void {
    const check = (module: string, name: string, source: string): void => {
        const { file, declaration } = context.functionDeclaration(`src/engine/${module}.ts`, name);
        context.assertStatementShapes(file, [declaration], source, `${module}.${name} native recovery contract`);
    };

    // Registration defaults, disabled ownership, loss snapshot and callback/re-arm order map to DeviceRecoveryState and the renderer restart dispatcher.
    check("device-lost-recovery", "getState", `
function getState(engine: EngineContext): DeviceLostRecoveryState {
    return (engine._deviceLostRecovery ??= {
        _forceNextLoss: false,
        _requiredFeatures: [],
        _armedDevice: null,
        _registrations: [],
        _samplerDescriptors: new WeakMap(),
        _captureRefs: 0,
        _meshCaptureRefs: 0,
        _textures: new Set(),
        _texturesPruneAt: 64,
    });
}
`);
    check("device-lost-recovery", "_enableDeviceLostRecovery", `
export function _enableDeviceLostRecovery(engine: EngineContext, registration: DeviceLostRecoveryRegistration): DeviceLostRecoveryHandle {
    const state = getState(engine);
    const registrations = state._registrations;
    if (registrations.length === 0) {
        state._requiredFeatures = Array.from(engine._device.features) as GPUFeatureName[];
    }
    if (!registrations.some((current) => current._kind === registration._kind)) {
        registration._enable?.(engine);
    }
    registrations.push(registration);
    arm(engine, state);
    let disabled = false;
    return {
        disable(): void {
            if (disabled) {
                return;
            }
            disabled = true;
            const index = registrations.indexOf(registration);
            if (index >= 0) {
                registrations.splice(index, 1);
            }
            if (!registrations.some((current) => current._kind === registration._kind)) {
                registration._disable?.(engine);
            }
        },
    };
}
`);
    check("device-lost-recovery", "markNextDeviceLossForRecovery", `
export function markNextDeviceLossForRecovery(engine: EngineContext): boolean {
    const state = engine._deviceLostRecovery;
    return !!state?._registrations.length && (state._forceNextLoss = true);
}
`);
    check("device-lost-recovery", "arm", `
function arm(engine: EngineContext, state: DeviceLostRecoveryState): void {
    const device = engine._device;
    if (state._armedDevice === device || state._recovering) {
        return;
    }
    state._armedDevice = device;
    void device.lost.then((info) => {
        if (state._registrations.length === 0 || state._armedDevice !== device) {
            return;
        }
        if (info.reason === "destroyed" && !state._forceNextLoss) {
            return;
        }
        state._forceNextLoss = false;
        state._recovering = true;
        const registrations = [...state._registrations];
        for (const registration of registrations) {
            registration._onLost?.(info);
        }
        void import("./device-lost-recovery-run.js")
            .then(({ runDeviceLostRecovery }) => runDeviceLostRecovery(engine, state, registrations))
            .then(() => {
            state._recovering = false;
            arm(engine, state);
            for (const registration of registrations) {
                registration._onRecovered?.();
            }
        }, (error) => {
            state._recovering = false;
            for (const registration of registrations) {
                registration._onRecoveryFailed?.(error);
            }
        });
    });
}
`);

    // The PAL destroys the old native device when the active frame returns.
    check("device-lost-recovery-testing", "forceWebGpuDeviceLossForTesting", `
export function forceWebGpuDeviceLossForTesting(engine: EngineContext): void {
    if (!markNextDeviceLossForRecovery(engine)) {
        throw new Error("forceWebGpuDeviceLossForTesting requires a device-lost recovery handler to be enabled first");
    }
    engine._device.destroy();
}
`);

    // One scene strategy uses the existing retained CPU owners; the compiler refuses other context kinds.
    check("device-lost-scene-recovery", "enableDeviceLostSceneRecovery", `
export function enableDeviceLostSceneRecovery(engine: EngineContext, options: DeviceLostRecoveryCallbacks = {}): DeviceLostRecoveryHandle {
    return _enableDeviceLostRecovery(engine, {
        _kind: "scene",
        _recoverOrder: 100,
        _enable(currentEngine): void {
            _retainDeviceLostRecoveryCapture(currentEngine, true);
        },
        _disable(currentEngine): void {
            _releaseDeviceLostRecoveryCapture(currentEngine, true);
        },
        async _recover(currentEngine): Promise<void> {
            const { rebuildRegisteredScenes } = await import("./recovery-rebuild.js");
            await rebuildRegisteredScenes(currentEngine);
        },
        _onLost: options.onLost,
        _onRecovered: options.onRecovered,
        _onRecoveryFailed: options.onRecoveryFailed,
    });
}
`);

    // Adapter/device acquisition, surface configuration and texture ownership settlement use synchronous backend teardown/reconstruction over retained owners.
    check("device-lost-recovery-run", "runDeviceLostRecovery", `
export async function runDeviceLostRecovery(engine: EngineContext, state: DeviceLostRecoveryState, registrations: readonly DeviceLostRecoveryRegistration[]): Promise<void> {
    const handlers = new Map<string, DeviceLostRecoveryRegistration>();
    for (const registration of registrations) {
        handlers.set(registration._kind, registration);
    }
    const wasRunning = engine._renderFn !== null;
    stopEngine(engine);
    assertEveryActiveContextKindIsRecoverable(engine, handlers);
    disposeGpuResourceRetirements(engine);
    const adapter = await runRecoveryStep("requesting a replacement adapter", () => navigator.gpu.requestAdapter({ powerPreference: "high-performance", ..._getAdapterOptions() }));
    if (!adapter) {
        throw new Error("WebGPU adapter not available during device recovery");
    }
    const missingFeatures = state._requiredFeatures.filter((feature) => !adapter.features.has(feature));
    if (missingFeatures.length) {
        throw new Error(\`WebGPU device recovery missing required features: \${missingFeatures.join(", ")}\`);
    }
    engine._device = await runRecoveryStep("requesting a replacement device", () => adapter.requestDevice({
        requiredFeatures: state._requiredFeatures,
        requiredLimits: { ...engine._options?.requiredLimits, ...engine._storageRequiredLimits },
    }));
    await runRecoveryStep("rebuilding engine storage buffers", () => engine._rebuildStorageBuffers?.());
    await runRecoveryStep("reconfiguring rendering surfaces", () => {
        for (const surface of engine.surfaces) {
            const usage = surface._swapchainCopySrc ? TU.RENDER_ATTACHMENT | TU.COPY_SRC : TU.RENDER_ATTACHMENT;
            surface._context.configure({
                device: engine._device,
                format: surface._configureFormat,
                alphaMode: surface._alphaMode,
                usage,
                viewFormats: [surface.format],
            });
            _refreshScRT(surface);
        }
    });
    await runRecoveryStep("resizing rendering surfaces", () => resizeEngine(engine));
    const settleTextureOwnership = await rebuildRecoverableTextures(engine, state);
    const orderedHandlers = Array.from(handlers.values()).sort((a, b) => (a._recoverOrder ?? 0) - (b._recoverOrder ?? 0));
    try {
        for (const handler of orderedHandlers) {
            await runRecoveryStep(\`running "\${handler._kind}" recovery\`, () => handler._recover(engine));
        }
    }
    finally {
        settleTextureOwnership?.();
    }
    if (wasRunning) {
        await runRecoveryStep("restarting rendering", () => startEngine(engine));
    }
}
`);
    check("device-lost-recovery-run", "rebuildRecoverableTextures", `
async function rebuildRecoverableTextures(engine: EngineContext, state: DeviceLostRecoveryState): Promise<(() => void) | undefined> {
    const tracked = state._textures;
    const textures: Texture2D[] = [];
    for (const ref of tracked) {
        const texture = ref.deref();
        if (texture) {
            textures.push(texture);
        }
        else {
            tracked.delete(ref);
        }
    }
    if (textures.length === 0) {
        return undefined;
    }
    const { rebuildTexture2D, settleRebuiltTextureOwnership } = await import("../texture/texture-recovery.js");
    try {
        await runRecoveryStep("rebuilding recoverable textures", async () => {
            const results = await Promise.allSettled(textures.map((texture) => rebuildTexture2D(engine, texture)));
            const failed = results.find((result) => result.status === "rejected");
            if (failed) {
                throw failed.reason;
            }
        });
    }
    catch (error) {
        settleRebuiltTextureOwnership(state);
        throw error;
    }
    return () => settleRebuiltTextureOwnership(state);
}
`);
    check("device-lost-recovery-run", "assertEveryActiveContextKindIsRecoverable", `
function assertEveryActiveContextKindIsRecoverable(engine: EngineContext, handlers: ReadonlyMap<string, DeviceLostRecoveryRegistration>): void {
    const unrecoverable = new Set<string>();
    for (const surface of engine.surfaces) {
        for (const context of surface._renderingContexts) {
            if (!handlers.has(context._kind)) {
                unrecoverable.add(context._kind);
            }
        }
    }
    if (unrecoverable.size) {
        throw new Error(\`Device-lost recovery cannot rebuild registered rendering contexts of kind: \${Array.from(unrecoverable).sort().join(", ")}. \` +
            \`Recovering around them would leave them bound to the lost device and crash the browser's renderer process on the next frame. \` +
            \`Enable that kind's device-lost recovery before the device is lost, or unregister the context.\`);
    }
}
`);
    check("device-lost-recovery-run", "runRecoveryStep", `
async function runRecoveryStep<T>(description: string, action: () => T | Promise<T>): Promise<T> {
    try {
        return await action();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(\`Device-lost recovery failed while \${description}: \${message}\`, { cause: error });
    }
}
`);

    // The backend replays generated mesh/material/environment/shadow/frame-graph uploads and publishes replacement identities only after a completed frame.
    check("recovery-rebuild", "rebuildRegisteredScenes", `
export async function rebuildRegisteredScenes(engine: EngineContext): Promise<void> {
    clearSceneBGLCache();
    engine._pbrFallbackTex = undefined;
    for (const surface of engine.surfaces) {
        for (const ctx of surface._renderingContexts) {
            if (ctx._kind !== "scene") {
                continue;
            }
            const scene = ctx as SceneContext;
            if (!isRenderingContextRegistered(surface, scene) || scene._z) {
                continue;
            }
            await rebuildSceneGpu(engine, scene);
        }
    }
}
`);
    check("recovery-rebuild", "rebuildSceneGpu", `
async function rebuildSceneGpu(engine: EngineContext, scene: SceneContext): Promise<void> {
    if (scene._envTextures) {
        const { rebuildSceneEnvironment } = await import("../loader-env/environment-recovery.js");
        await runRecoveryStep("rebuilding environment textures", () => rebuildSceneEnvironment(engine, scene));
    }
    await runRecoveryStep("rebuilding material textures", () => rebuildSceneTextures(engine, scene));
    await runRecoveryStep("rebuilding meshes", () => _rebuildMeshes(engine, scene));
    if (scene._z) {
        return;
    }
    if (scene.shadowGenerators.length > 0 || scene.lights.some((light) => light.shadowGenerator)) {
        const { rebuildSceneShadowGenerators } = await import("../shadow/shadow-recovery.js");
        await runRecoveryStep("rebuilding shadows", () => rebuildSceneShadowGenerators(engine, scene));
    }
    if (scene._z) {
        return;
    }
    const rebuilds = scene._renderables.filter((r) => !!r._rebuild).map((r) => r._rebuild!);
    scene._renderables.length = scene._uniformUpdaters.length = 0;
    scene._meshDisposables.clear();
    scene._meshAuxDisposables.clear();
    if (scene._lightGpuState) {
        scene._lightGpuState = undefined;
    }
    for (const [build, meshes] of scene._groups) {
        const result = await runRecoveryStep("rebuilding material groups", () => build(scene, meshes));
        if (scene._z) {
            return;
        }
        meshes.r = scene._runtimeBuilds?.base(build, result.rebuildSingle) ?? result.rebuildSingle;
        meshes.o = result.renderables;
        scene._renderables.push(...result.renderables);
        if (result.updater) {
            scene._uniformUpdaters.push(result.updater);
        }
    }
    if (rebuilds.length > 0) {
        scene._renderables.push(...(await runRecoveryStep("rebuilding renderables", () => rebuildRenderables(rebuilds))));
    }
    scene._renderables.sort((a, b) => a.order - b.order);
    scene._renderableVersion++;
    resetFrameGraphTasks(engine, scene);
    scene._frameGraph.build();
}
`);
    check("recovery-rebuild", "rebuildRenderables", `
export async function rebuildRenderables(rebuilds: readonly NonNullable<Renderable["_rebuild"]>[]): Promise<Renderable[]> {
    const rebuilt: Renderable[] = [];
    for (const rebuild of rebuilds) {
        rebuilt.push(await rebuild());
    }
    return rebuilt;
}
`);
    check("recovery-rebuild", "runRecoveryStep", `
async function runRecoveryStep<T>(description: string, action: () => Promise<T>): Promise<T> {
    try {
        return await action();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(\`Device-lost Scene recovery failed while \${description}: \${message}\`, { cause: error });
    }
}
`);
    check("recovery-rebuild", "resetFrameGraphTasks", `
function resetFrameGraphTasks(engine: EngineContext, scene: SceneContext): void {
    for (const task of scene._frameGraph._tasks) {
        if (!("_sceneUBO" in task && "_sceneBG" in task && "_opaqueBindings" in task)) {
            continue;
        }
        const rt = task as unknown as RecoverableRenderTask;
        rt._sceneUBO = createEmptyUniformBuffer(engine, SCENE_UBO_BYTES);
        rt._lightsUBO = ensureSceneLightState(engine, scene)._buffer;
        rt._sceneBG = engine._device.createBindGroup({
            layout: getSceneBindGroupLayout(engine),
            entries: [
                { binding: 0, resource: { buffer: rt._sceneUBO } },
                { binding: 1, resource: { buffer: rt._lightsUBO } },
            ],
        });
        rt._opaqueBindings.length = 0;
        rt._directBindings.length = 0;
        rt._transparentBindings.length = 0;
        rt._ob.length = 0;
        rt._lastVersion = -1;
        rt._sceneUboCacheKey.length = 0;
    }
}
`);
    check("recovery-rebuild", "_rebuildMeshes", `
export async function _rebuildMeshes(engine: EngineContext, scene: SceneContext): Promise<void> {
    let skeletonFactory: typeof createSkeleton | null = null;
    let morphFactory: typeof createMorphTargets | null = null;
    for (const mesh of scene.meshes) {
        if (mesh._cpuPositions && mesh._cpuNormals && mesh._cpuIndices) {
            const recoverShared = mesh._gpu._recoverShared;
            mesh._gpu = recoverShared ? recoverShared(engine, mesh, uploadRetainedMesh) : uploadRetainedMesh(engine, mesh);
        }
        if (mesh.skeleton) {
            skeletonFactory ??= (await import("../skeleton/create-skeleton.js")).createSkeleton;
            const old = mesh.skeleton;
            const rebuilt = skeletonFactory(engine, old.joints, old.weights, old.boneCount, old.boneMatrices, old.joints1, old.weights1);
            Object.assign(old as MutableSkeleton, rebuilt);
        }
        if (mesh.morphTargets) {
            morphFactory ??= (await import("../morph/create-morph-targets.js")).createMorphTargets;
            const old = mesh.morphTargets;
            const rebuilt = morphFactory(engine, old.targets.map((t) => ({ positions: t.positions, normals: t.normals })), mesh._cpuPositions ? mesh._cpuPositions.length / 3 : 0, Array.from(old.weights));
            Object.assign(old as MutableMorphTargets, rebuilt);
        }
    }
}
`);
    check("recovery-rebuild", "uploadRetainedMesh", `
function uploadRetainedMesh(engine: EngineContext, mesh: Mesh): MeshGPU {
    const positions = mesh._cpuPositions!;
    const normals = mesh._cpuNormals!;
    const uvs = mesh._cpuUvs;
    const indices = mesh._cpuGpuIndices ?? mesh._cpuIndices!;
    const device = engine._device;
    let uvBuffer: GPUBuffer;
    if (uvs && uvs.length > 0) {
        uvBuffer = createMappedBuffer(engine, uvs, BU.VERTEX);
    }
    else {
        uvBuffer = device.createBuffer({ size: (positions.length / 3) * 8, usage: BU.VERTEX, mappedAtCreation: true });
        uvBuffer.unmap();
    }
    return {
        positionBuffer: createMappedBuffer(engine, positions, BU.VERTEX),
        normalBuffer: createMappedBuffer(engine, normals, BU.VERTEX),
        tangentBuffer: mesh._cpuTangents ? createMappedBuffer(engine, mesh._cpuTangents, BU.VERTEX) : null,
        uvBuffer,
        uv2Buffer: mesh._cpuUv2s ? createMappedBuffer(engine, mesh._cpuUv2s, BU.VERTEX) : null,
        colorBuffer: mesh._cpuColors ? createMappedBuffer(engine, mesh._cpuColors, BU.VERTEX) : null,
        hasUv: !!uvs && uvs.length > 0,
        hasUv2: !!mesh._cpuUv2s && mesh._cpuUv2s.length > 0,
        hasTangent: !!mesh._cpuTangents && mesh._cpuTangents.length > 0,
        hasColor: !!mesh._cpuColors && mesh._cpuColors.length > 0,
        indexBuffer: createMappedBuffer(engine, indices, BU.INDEX),
        indexCount: indices.length,
        indexFormat: mesh._cpuIndexFormat ?? mesh._gpu.indexFormat,
    };
}
`);
    check("recovery-rebuild", "rebuildSceneTextures", `
async function rebuildSceneTextures(engine: EngineContext, scene: SceneContext): Promise<void> {
    const seen = new Set<Texture2D>();
    const visited = new WeakSet<object>();
    const textures: Texture2D[] = [];
    const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") {
            return;
        }
        const obj = value as Record<string, unknown>;
        if (obj.texture && obj.view && obj.sampler && typeof obj.width === "number" && typeof obj.height === "number") {
            const tex = obj as unknown as Texture2D;
            if (!seen.has(tex)) {
                seen.add(tex);
                textures.push(tex);
            }
            return;
        }
        if (visited.has(value)) {
            return;
        }
        visited.add(value);
        for (const child of Object.values(obj)) {
            visit(child);
        }
    };
    for (const mesh of scene.meshes) {
        visit(mesh.material);
    }
    if (textures.length === 0) {
        return;
    }
    const { rebuildTexture2D } = await import("../texture/texture-recovery.js");
    await Promise.all(textures.map((texture) => rebuildTexture2D(engine, texture)));
}
`);

    // Native scene and texture owners retain upload inputs directly; enabling/disabling recovery changes registrations without introducing a second capture cache.
    const capture = context.sourceFile("src/engine/device-lost-recovery-capture.ts");
    context.assertExpressionShape(context.variableInitializer(capture, "TEXTURE_PRUNE_FLOOR"), "64", "capture pruning floor");
    context.assertExpressionShape(context.variableInitializer(capture, "_sourceOwners"), "null", "capture source ownership default");
    check("device-lost-recovery-capture", "stampTexture", `
function stampTexture(state: DeviceLostRecoveryState, tex: Texture2D, source: Texture2DRecoverySource): void {
    tex._recoverySource = source;
    const textures = state._textures;
    if (textures.size >= state._texturesPruneAt) {
        for (const ref of textures) {
            if (!ref.deref()) {
                textures.delete(ref);
            }
        }
        state._texturesPruneAt = Math.max(TEXTURE_PRUNE_FLOOR, textures.size * 2);
    }
    textures.add(new WeakRef(tex));
}
`);
    check("device-lost-recovery-capture", "trackDerivedTexture", `
function trackDerivedTexture(base: Texture2D, derived: Texture2D): void {
    const source = base._recoverySource;
    if (!source) {
        return;
    }
    const state = _sourceOwners?.get(source)?.deref();
    if (state) {
        stampTexture(state, derived, source);
    }
}
`);
    check("device-lost-recovery-capture", "attachRecoveryCapture", `
function attachRecoveryCapture(engine: EngineContext): void {
    const state = engine._deviceLostRecovery!;
    const owner = new WeakRef(state);
    const stamp = (tex: Texture2D, source: Texture2DRecoverySource): void => {
        (_sourceOwners ??= new WeakMap()).set(source, owner);
        stampTexture(state, tex, source);
    };
    _setDerivedTexture2DHook(trackDerivedTexture);
    engine._dlr = {
        t: stamp,
        d: trackDerivedTexture,
        u(tex: Texture2D, url: string, opts: Texture2DOptions): void {
            stamp(tex, { kind: "url", url, opts: { ...opts } });
        },
        s(tex: Texture2D, r: number, g: number, b: number, a: number): void {
            stamp(tex, { kind: "solid", rgba: [r, g, b, a] });
        },
        b(tex: Texture2D, bitmap: ImageBitmap | null, srgb: boolean, mipMaps: boolean, fallback?: Uint8Array): void {
            stamp(tex, {
                kind: "bitmap",
                bitmap,
                srgb,
                mipMaps,
                fallback,
            });
        },
        p(tex: Texture2D, data: Uint8Array, options: PixelsTexture2DOptions): void {
            stamp(tex, {
                kind: "pixels",
                data: data.slice(0, tex.width * tex.height * 4),
                width: tex.width,
                height: tex.height,
                options: { ...options },
            });
        },
        r(tex: Texture2D, width: number, height: number, format: GPUTextureFormat, samplerDesc: GPUSamplerDescriptor): void {
            stamp(tex, { kind: "render", width, height, format, samplerDesc });
        },
        w(tex: Texture2D, data: Uint8Array, x: number, y: number, width: number, height: number, dataOffset = 0, bytesPerRow = width * 4): void {
            const source = tex._recoverySource;
            if (source?.kind !== "pixels") {
                return;
            }
            const rowBytes = width * 4;
            for (let row = 0; row < height; row++) {
                const srcStart = dataOffset + row * bytesPerRow;
                const dstStart = ((y + row) * source.width + x) * 4;
                source.data.set(data.subarray(srcStart, srcStart + rowBytes), dstStart);
            }
        },
        m(mesh: Mesh, uv2s: Float32Array | null | undefined, tangents: Float32Array | null | undefined, colors: Float32Array | null | undefined, gpuIndices: Uint16Array | Uint32Array, indexFormat: GPUIndexFormat): void {
            if (!engine._deviceLostRecovery?._meshCaptureRefs) {
                return;
            }
            mesh._cpuUv2s = uv2s ?? null;
            mesh._cpuTangents = tangents ?? null;
            mesh._cpuColors = colors ?? null;
            mesh._cpuGpuIndices = gpuIndices;
            mesh._cpuIndexFormat = indexFormat;
        },
        e(scene: SceneContext, url: string, brdfUrl: string): void {
            if (state._meshCaptureRefs) {
                scene._envRecoverySource = { kind: "env", url, brdfUrl };
            }
        },
        h(scene: SceneContext, url: string, faceSize: number): void {
            if (state._meshCaptureRefs) {
                scene._envRecoverySource = { kind: "hdr", url, faceSize };
            }
        },
    };
}
`);
    check("device-lost-recovery-capture", "_retainDeviceLostRecoveryCapture", `
export function _retainDeviceLostRecoveryCapture(engine: EngineContext, includeMeshes = false): void {
    const state = engine._deviceLostRecovery;
    if (!state) {
        throw new Error("Device-lost recovery capture requires an enabled recovery coordinator");
    }
    state._captureRefs++;
    if (includeMeshes) {
        state._meshCaptureRefs++;
    }
    if (state._captureRefs === 1) {
        attachRecoveryCapture(engine);
    }
}
`);
    check("device-lost-recovery-capture", "_releaseDeviceLostRecoveryCapture", `
export function _releaseDeviceLostRecoveryCapture(engine: EngineContext, includeMeshes = false): void {
    const state = engine._deviceLostRecovery;
    if (!state || state._captureRefs === 0) {
        return;
    }
    state._captureRefs--;
    if (includeMeshes && state._meshCaptureRefs > 0) {
        state._meshCaptureRefs--;
    }
    if (state._captureRefs === 0) {
        engine._dlr = undefined;
    }
}
`);

    // Backend resource owners drain queued work and release outgoing GPU leases before rebuilding replacements.
    check("gpu-resource-retirement", "runBatch", `
function runBatch(batch: GpuResourceRetirement[]): void {
    for (const retire of batch.splice(0)) {
        try {
            retire();
        }
        catch {
        }
    }
}
`);
    check("gpu-resource-retirement", "disposeGpuResourceRetirements", `
export function disposeGpuResourceRetirements(engine: EngineContext): void {
    const batch = engine._retirements;
    const inFlight = engine._retiring;
    engine._retirements = null;
    engine._retiring = null;
    if (batch) {
        runBatch(batch);
    }
    inFlight?.forEach(runBatch);
}
`);
}
