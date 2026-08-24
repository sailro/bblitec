import assert from "node:assert/strict";
import test from "node:test";
import { CompileError, compileSource } from "../src/compiler.js";

/**
 * The three contracts a physics scene's own freeze needs, and the two
 * refusals that keep them sound.
 *
 * Every corpus physics scene pins its measured pose the same way: it
 * counts steps in `onPhysicsAfterStep` and, at the step its
 * `?captureFrame=` query names, calls `stopEngine` from a zero-delay
 * `setTimeout`. Without all three lowered the two sides stop at different
 * physics steps and no pixel comparison between them means anything, so
 * these are what make a physics scene measurable at all.
 */

const IMPORTS = `import {
    addToScene,
    createEngine,
    createFreeCamera,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    onBeforeRender,
    registerScene,
    startEngine,
    stopEngine,
} from "@babylonjs/lite";`;

function sceneWith(body: string, search?: string): string {
    return compileSource(
        `${IMPORTS}
        function readFrames(): number | null {
            const params = new URLSearchParams(window.location.search);
            const value = params.get("captureFrame");
            return value === null ? null : Number(value);
        }
        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            scene.camera = createFreeCamera({ x: 0, y: 5, z: -10 }, { x: 0, y: 0, z: 0 });
            const sphere = createSphere(engine, { diameter: 2, segments: 32 });
            sphere.material = createStandardMaterial();
            addToScene(scene, sphere);
            const captureAfterFrames = readFrames();
            let simulatedFrames = 0;
            ${body}
            await registerScene(scene);
            await startEngine(engine);
            canvas.dataset.ready = "true";
        }`,
        { fileName: "examples/freeze.ts", ...(search ? { search } : {}) },
    ).cpp;
}

function refuses(body: string, message: string, search?: string): void {
    assert.throws(
        () => sceneWith(body, search),
        (error: unknown) => {
            assert.ok(error instanceof CompileError);
            assert.match(
                error.message,
                new RegExp(
                    message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                ),
            );
            return true;
        },
    );
}

test("a scene freezes itself: setTimeout defers, stopEngine stops", () => {
    const main = sceneWith(
        `onBeforeRender(scene, () => {
            simulatedFrames++;
            if (captureAfterFrames !== null && simulatedFrames >= captureAfterFrames) {
                window.setTimeout(() => {
                    canvas.dataset.captureReady = "true";
                    stopEngine(engine);
                }, 0);
            }
        });`,
        "?captureFrame=120",
    );
    // The zero-delay timeout is a deferred callback the conductor drains,
    // and the engine stop inside it survives; the canvas write does not.
    assert.match(main, /bbl::defer_callback\(v_engine, \[&\]\(\) \{/);
    assert.match(main, /bbl::stop_engine\(v_engine\)/);
    assert.doesNotMatch(main, /captureReady/);
    // The guarded nullable reads as the number the checker narrowed it to.
    assert.match(main, /v_captureAfterFrames\.has_value\(\)/);
    assert.match(main, /v_simulatedFrames >= \(\*v_captureAfterFrames\)/);
});

test("a non-zero setTimeout delay refuses rather than becoming next frame", () => {
    // Four corpus scenes (44, 48, 156, 173) pass a real wait. Rounding one
    // to the next frame would be a different scene, so it refuses.
    refuses(
        `onBeforeRender(scene, () => {
            window.setTimeout(() => { stopEngine(engine); }, 1000);
        });`,
        "Only a zero-delay setTimeout is lowered",
    );
});

test("a deferred callback cannot capture the frame that queued it", () => {
    // The emitted lambda captures by reference and runs after the frame
    // callback has returned, so naming one of its locals would read dead
    // storage. It compiles clean in C++, which is why it refuses here.
    refuses(
        `onBeforeRender(scene, (deltaMs) => {
            const scratch = deltaMs * 2;
            window.setTimeout(() => {
                sphere.position.set(0, scratch, 0);
            }, 0);
        });`,
        "A deferred callback cannot name 'scratch'",
    );
});

test("an early return refuses instead of dropping its own guard", () => {
    // A bare `return` used to be dropped silently. Harmless until a
    // narrowed optional made the statements it guarded reachable: the
    // guard vanished and left an unguarded dereference of an empty
    // optional behind it.
    refuses(
        `onBeforeRender(scene, () => {
            if (captureAfterFrames === null) { return; }
            sphere.position.set(0, captureAfterFrames, 0);
        });`,
        "An early `return` is not lowered",
    );
});

test("an unguarded nullable still refuses rather than dereferencing", () => {
    refuses(
        `onBeforeRender(scene, () => {
            sphere.position.set(0, captureAfterFrames, 0);
        });`,
        "Expected number, received data",
    );
});
