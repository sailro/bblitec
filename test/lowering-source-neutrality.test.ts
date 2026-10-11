import assert from "node:assert/strict";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerDeviceRecovery } from "../src/lowering/device-recovery-lowerer.js";
import { lowerFlowGraphDisposal } from "../src/lowering/gltf/flow-graph-lifecycle.js";
import { lowerGpuTaskTimer } from "../src/lowering/gpu-task-timer-lowerer.js";
import { PhysicsLowerer } from "../src/lowering/physics-lowerer.js";
import { doctoredContext } from "./doctored-store.js";

test("GPU timer transport selection ignores formatting and comment lookalikes", () => {
    const original = lowerGpuTaskTimer(new LoweringContext());
    for (const [from, to] of [
        ["timer.records.slice()", "timer /* snapshot */ . records . slice ( )"],
        [
            "const taskCount = records.length;",
            "const taskCount = records.length; // timer.records is already copied",
        ],
    ]) {
        assert.equal(
            lowerGpuTaskTimer(
                doctoredContext("src/engine/gpu-task-timer.ts", from!, to!),
            ),
            original,
        );
    }
    assert.throws(
        () =>
            lowerGpuTaskTimer(
                doctoredContext(
                    "src/engine/gpu-task-timer.ts",
                    "const taskCount = records.length;",
                    "const taskCount = timer /* changed access */ . records.length;",
                ),
            ),
        /Unrepresented GPU task timer operation/,
    );
});

test("device recovery locates loss and import continuations by AST", () => {
    const original = lowerDeviceRecovery(new LoweringContext()).source;
    for (const [from, to] of [
        ["device.lost.then", "device /* device generation */ . lost . then"],
        [
            'import("./device-lost-recovery-run.js")',
            "import /* asynchronous recovery */ ('./device-lost-recovery-run.js')",
        ],
        [
            "const registrations = [...state._registrations];",
            "const registrations = [ ...state /* snapshot */ . _registrations ];",
        ],
    ]) {
        assert.equal(
            lowerDeviceRecovery(
                doctoredContext(
                    "src/engine/device-lost-recovery.ts",
                    from!,
                    to!,
                ),
            ).source,
            original,
        );
    }
    assert.throws(
        () =>
            lowerDeviceRecovery(
                doctoredContext(
                    "src/engine/device-lost-recovery.ts",
                    "state._requiredFeatures = Array.from(engine._device.features) as GPUFeatureName[];",
                    "state._requiredFeatures = Array.from(engine._device.features) as GPUFeatureName[]; registration._onLost?.();",
                ),
            ),
        /Recovery device features statement 1 changed/,
    );
});

test("physics case and parameter selection ignores source formatting", () => {
    const original = new PhysicsLowerer(new LoweringContext()).lowerPhysics();
    for (const [from, to] of [
        [
            "case PhysicsShapeType.SPHERE:",
            "case (PhysicsShapeType /* shape */ . SPHERE):",
        ],
        ["params.radius =", "params /* bound */ . radius ="],
    ]) {
        assert.deepEqual(
            new PhysicsLowerer(
                doctoredContext("src/physics/havok.ts", from!, to!),
            ).lowerPhysics(),
            original,
        );
    }
});

test("flow disposal binding contracts ignore comments and retain binding semantics", () => {
    const original = lowerFlowGraphDisposal(new LoweringContext(), ["slot"]);
    const opening =
        "export function disposeFlowGraph(rt: FgRuntime): void {\n    ";
    assert.equal(
        lowerFlowGraphDisposal(
            doctoredContext(
                "src/flow-graph/runtime.ts",
                opening + "const { context: ctx, env } = rt;",
                opening + "const { context: /* context */ ctx, env } = (rt);",
            ),
            ["slot"],
        ),
        original,
    );
    assert.throws(
        () =>
            lowerFlowGraphDisposal(
                doctoredContext(
                    "src/flow-graph/runtime.ts",
                    opening + "const { context: ctx, env } = rt;",
                    opening +
                        "const { context: ctx, env = createEnvironment() } = rt;",
                ),
                ["slot"],
            ),
        /Flow disposal context binding statement 1 changed/,
    );
});
