import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { floatLiteral } from "../src/cpp-literals.js";
import { LoweringContext } from "../src/lowering/context.js";
import { NodeParticleLowerer, type NodeParticleSystemEmit } from "../src/lowering/node-particle-lowerer.js";
import { SpriteLowerer } from "../src/lowering/sprite-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);

test("frozen sprite bridges keep sheet aliases live and preserve pinned buffer precision", { skip: !tools }, async () => {
    interface Buffer {
        capacity: number; alive: number;
        posX: Float32Array; posY: Float32Array; posZ: Float32Array;
        size: Float32Array; scaleX: Float32Array; scaleY: Float32Array;
        colorR: Float32Array; colorG: Float32Array; colorB: Float32Array; colorA: Float32Array;
        angle: Float32Array; age: Float64Array;
    }
    interface System {
        buffer: Buffer; updateSpeed: number; blendMode: number;
        texture: { width: number; height: number } | null;
        _spriteSheet?: { cellWidth: number; cellHeight: number; cellIndex: Uint16Array; update(i: number): void };
    }
    interface Layer {
        count: number; _instanceData: Float32Array; _savedSize: Float32Array;
        opacity: number; visible: boolean; order: number;
        view: { positionPx: [number, number]; zoom: number; rotation: number };
        pivot: [number, number];
    }
    interface Bridge { layer: Layer }
    const { createParticleSystem } = await importPinnedModule<{
        createParticleSystem(capacity: number): System;
    }>("particle/particle-system.js");
    const { createParticleSprite2DBridge, syncParticleSprite2DBridge } = await importPinnedModule<{
        createParticleSprite2DBridge(system: System, options: { pixelsPerUnit: number; originPx: [number, number] }): Bridge;
        syncParticleSprite2DBridge(bridge: Bridge): void;
    }>("particle/particle-sprite-2d.js");
    const system = createParticleSystem(3);
    system.updateSpeed = 0;
    system.texture = { width: 128, height: 64 };
    const buffer = system.buffer;
    buffer.alive = 1;
    buffer.posX[0] = 0.17;
    buffer.posY[0] = 0.23;
    buffer.size[0] = 0.37;
    buffer.scaleX[0] = 0.61;
    buffer.scaleY[0] = 0.83;
    buffer.angle[0] = 0.29;
    buffer.colorR[0] = 0.7;
    buffer.colorG[0] = 0.5;
    buffer.colorB[0] = 0.3;
    buffer.colorA[0] = 0.9;
    buffer.age[0] = 0.3673999999999999;
    buffer.age[2] = 0.123456789012345;
    const cells = new Uint16Array(3);
    system._spriteSheet = { cellWidth: 64, cellHeight: 64, cellIndex: cells, update: () => undefined };
    const options = { pixelsPerUnit: 177.3, originPx: [96, 96] as [number, number] };
    const bridge = createParticleSprite2DBridge(system, options);
    const snapshots = [0, 1].map((cell) => {
        cells[0] = cell;
        syncParticleSprite2DBridge(bridge);
        assert.equal(bridge.layer.count, 1);
        return Array.from(bridge.layer._instanceData.slice(0, 13));
    });
    const spriteApi = await importPinnedModule<{
        clearSprite2DLayer(layer: Layer): void;
        addSprite2DIndex(layer: Layer, props: { positionPx: [number, number]; sizePx: [number, number] }): number;
        updateSprite2DIndex(layer: Layer, index: number, props: { visible: boolean }): void;
    }>("sprite/sprite-2d.js");
    spriteApi.clearSprite2DLayer(bridge.layer);
    syncParticleSprite2DBridge(bridge);
    assert.equal(bridge.layer.count, 1);
    spriteApi.addSprite2DIndex(bridge.layer, { positionPx: [0, 0], sizePx: [12, 13] });
    spriteApi.updateSprite2DIndex(bridge.layer, 0, { visible: false });
    syncParticleSprite2DBridge(bridge);
    assert.equal(bridge.layer.count, 1);
    assert.deepEqual(Array.from(bridge.layer._instanceData.slice(0, 13)), snapshots[1]);
    assert.deepEqual(Array.from(bridge.layer._savedSize.slice(2, 4)), [0, 0]);
    const exactApi = await importPinnedModule<{
        createParticleSprite2DBridgeWithBlendModes(system: System, mapping: typeof options): Bridge & { layers: Layer[] };
        syncParticleSprite2DBridgeWithBlendModes(bridge: Bridge): void;
    }>("particle/particle-sprite-2d-blend-modes.js");
    system.blendMode = 4;
    const exact = exactApi.createParticleSprite2DBridgeWithBlendModes(system, options);
    exact.layer.opacity = 0.25;
    exact.layer.visible = false;
    exact.layer.order = 7;
    exact.layer.view = { positionPx: [5, 6], zoom: 2, rotation: 0.5 };
    exact.layer.pivot = [0.25, 0.75];
    exactApi.syncParticleSprite2DBridgeWithBlendModes(exact);
    const presentation = (layer: Layer) => [layer.opacity, layer.visible, layer.order, layer.view, layer.pivot];
    assert.deepEqual(presentation(exact.layers[1]!), presentation(exact.layer));
    const entry: NodeParticleSystemEmit = {
        bake: {
            set: 0, system: 0, capacity: 3, blendMode: 2,
            updateSpeed: 0, stepIsIdentity: true,
            texture: { url: "fixture.png", invertY: false, sceneAssigned: false, width: 128, height: 64 },
            spriteSheet: null, alive: 1,
            positions: [buffer.posX[0]!, buffer.posY[0]!, buffer.posZ[0]!],
            sizes: [buffer.size[0]! * buffer.scaleX[0]!, buffer.size[0]! * buffer.scaleY[0]!],
            colors: [buffer.colorR[0]!, buffer.colorG[0]!, buffer.colorB[0]!, buffer.colorA[0]!],
            rotations: [buffer.angle[0]!], frames: null,
            bufferColumns: { age: Array.from(buffer.age) },
        },
        exactBlend: false, textureAsset: "fixture.png",
    };
    const context = new LoweringContext();
    const particle = new NodeParticleLowerer(context).lower([
        entry, { ...entry, bake: { ...entry.bake, system: 1, blendMode: 4 } },
        { ...entry, bake: { ...entry.bake, system: 2, alive: 0,
            positions: [], sizes: [], colors: [], rotations: [], bufferColumns: {} } },
        { ...entry, bake: { ...entry.bake, system: 3 } },
    ], [{
        systems: [{ set: 0, system: 0 }], exact: false, autoStart: false,
        ...options, invertY: true, retainFrozen: true,
    }, {
        systems: [{ set: 0, system: 1 }], exact: true, autoStart: false,
        ...options, invertY: true, retainFrozen: true,
    }, {
        systems: [{ set: 0, system: 2 }], exact: false, autoStart: false,
        ...options, invertY: true, retainFrozen: true,
    }, {
        systems: [{ set: 0, system: 3 }], exact: false, autoStart: false,
        ...options, invertY: true,
    }]);
    const sprite = new SpriteLowerer(context).lowerCore();
    const output = resolve("artifacts/node-particle-frozen-bridge-check");
    const headers = join(output, "bblite/upstream");
    mkdirSync(headers, { recursive: true });
    writeFileSync(join(headers, "node_particles.hpp"), particle.header);
    writeFileSync(join(headers, "sprite_layer.hpp"), sprite.header);
    writeFileSync(join(output, "node_particles.cpp"), particle.source);
    writeFileSync(join(output, "sprite_layer.cpp"), sprite.source);
    writeFileSync(join(output, "expected.hpp"), snapshots.map((row, i) =>
        `const std::vector<float> expected_${i}{${row.map(floatLiteral).join(", ")}};`,
    ).join("\n"));
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2", "/Gy",
        "/I", "native/include", "/I", output, `/Fo:${output}\\`, `/Fe:${executable}`,
        join(output, "node_particles.cpp"), join(output, "sprite_layer.cpp"),
        "test/fixtures/node-particle-frozen-bridge-check.cpp", "/link", "/OPT:REF",
    ]);
    assert.match(execFileSync(executable, { encoding: "utf8" }), /frozen-bridge-check: ok/);
});
