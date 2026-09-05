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
        function readFramesUnsettled(): number | null {
            let frames: number | null = null;
            const params = new URLSearchParams(window.location.search);
            if (params.get("captureFrame") !== null) {
                frames = 120;
            }
            return frames;
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
            // The two readers differ only in whether browser erasure can
            // settle them. readFrames is the corpus's own shape and folds
            // to the query's answer; readFramesUnsettled reaches a let the
            // fold does not model, so its result stays a run-time nullable
            // and the guard contracts below still have one to narrow.
            const unsettledFrames = readFramesUnsettled();
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
    assert.match(main, /bbl::defer_callback\(v_engine, \[=, &v_engine\]\(\) mutable \{/);
    assert.match(main, /bbl::stop_engine\(v_engine\)/);
    assert.doesNotMatch(main, /captureReady/);
    // The step the capture is pinned at is the query's own answer: the
    // reader folds, so the guard over its result and the dereference both
    // go with it and the frame counter compares against the number.
    assert.doesNotMatch(main, /v_captureAfterFrames/);
    assert.match(main, /v_simulatedFrames >= 120\.0/);
});

test("a non-zero setTimeout delay uses the elapsed-time queue", () => {
    const main = sceneWith(
        `onBeforeRender(scene, () => {
            window.setTimeout(() => { stopEngine(engine); }, 1000);
        });`,
    );
    assert.match(
        main,
        /bbl::set_timeout\(v_engine, \[=, &v_engine\]\(\) mutable \{\s*bbl::stop_engine\(v_engine\);\s*\}, 1000\)/,
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

test("an early return preserves its guard before a narrowed optional use", () => {
    const main = sceneWith(
        `onBeforeRender(scene, () => {
            if (unsettledFrames === null) { return; }
            sphere.position.set(0, unsettledFrames, 0);
        });`,
    );
    assert.match(
        main,
        /if \(!v_unsettledFrames\.has_value\(\)\) \{\s*return;\s*\}/,
    );
    assert.match(main, /\*v_unsettledFrames/);
});

test("a settled guard ends the callback body it returns from", () => {
    // The other side of the same guard. Once the reader folds, the early
    // return is taken at generation and what follows is unreachable, so it
    // must not be lowered: a narrowed optional past a guard the query
    // already answered has no native value to read.
    const main = sceneWith(
        `onBeforeRender(scene, () => {
            if (captureAfterFrames === null) { return; }
            sphere.position.set(0, captureAfterFrames, 0);
        });`,
    );
    assert.doesNotMatch(main, /v_captureAfterFrames/);
    assert.doesNotMatch(main, /position\.set|\.position =/);
});

test("an unguarded nullable still refuses rather than dereferencing", () => {
    refuses(
        `onBeforeRender(scene, () => {
            sphere.position.set(0, unsettledFrames, 0);
        });`,
        "Expected number, received data",
    );
});
