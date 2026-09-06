/**
 * A `let` written from a callback the runtime retains lives in one shared
 * cell, whatever retains the callback: a stored closure's environment owns
 * its captures by value, so a binding it writes must be the same cell the
 * entry scope and every other closure read.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

const sharedCell = (name: string, type: string, initial: string): RegExp =>
    new RegExp(`auto v_${name} = bbl::js::make_gc_shared<${type}>\\(${initial}\\);`);

/** The entry shape shared by the countdown tests: a flag the frame callback
 * reads, flipped by a helper's callback argument. */
const countdownEntry = (helperImport: string, helper: string): string => `
    import { createEngine, createSceneContext, onBeforeRender } from "@babylonjs/lite";
    ${helperImport}
    ${helper}
    async function main(): Promise<void> {
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        let countdownActive = true;
        let distance = 0;
        onBeforeRender(scene, () => {
            if (!countdownActive) {
                distance += 1;
            }
        });
        startCountdown(() => {
            countdownActive = false;
        });
    }
    main();
`;

const assertFlipped = (cpp: string): void => {
    assert.match(cpp, sharedCell("countdownActive", "bool", "true"));
    assert.match(cpp, /\(\*v_countdownActive\) = false;/);
    assert.doesNotMatch(cpp, /bool v_countdownActive/);
};

test("a let flipped from a timer-retained recursive callback shares one cell", () => {
    const result = compileSource(countdownEntry("", `
        function startCountdown(onGo: () => void): void {
            let count = 0;
            const tick = (): void => {
                count++;
                if (count === 3) {
                    onGo();
                }
                if (count < 4) {
                    setTimeout(tick, 700);
                }
            };
            tick();
        }
    `));
    assertFlipped(result.cpp);
    // The helper's own counter is written by the stored closure too.
    assert.match(result.cpp, /auto v_\w*count = bbl::js::make_gc_shared<double>\(0\.0\);/);
});

test("a helper in another module retaining its parameter through a timer shares the caller's cell", () => {
    const result = compileSource(
        countdownEntry(
            `import { startCountdown } from "../examples/regression-timer-callback-cells-countdown.js";`,
            "",
        ),
        { fileName: "test/compiler-countdown-entry.ts" },
    );
    assertFlipped(result.cpp);
});

test("a let flipped from an inline interval callback shares one cell", () => {
    const result = compileSource(`
        import { createEngine, createSceneContext, onBeforeRender } from "@babylonjs/lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            let paused = false;
            let frames = 0;
            setInterval(() => {
                paused = true;
            }, 500);
            onBeforeRender(scene, () => {
                if (!paused) {
                    frames += 1;
                }
            });
        }
        main();
    `);
    assert.match(result.cpp, sharedCell("paused", "bool", "false"));
    assert.match(result.cpp, /\(\*v_paused\) = true;/);
});

test("a named local function handed to a listener-installing helper shares the cell it writes", () => {
    const result = compileSource(`
        import { createEngine, createSceneContext, onBeforeRender } from "@babylonjs/lite";

        function installControls(canvas: HTMLCanvasElement, onClick?: (x: number) => void): void {
            canvas.addEventListener("pointerup", (e) => {
                if (onClick) {
                    onClick(e.clientX);
                }
            });
        }

        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            let destination: number | null = null;
            let travelled = 0;
            const onMapClick = (x: number): void => {
                destination = x;
            };
            installControls(canvas, onMapClick);
            onBeforeRender(scene, () => {
                if (destination !== null) {
                    travelled += 1;
                }
            });
        }
        main();
    `);
    assert.match(result.cpp, /auto v_destination = bbl::js::make_gc_shared<bbl::js::Nullable<double>>\(std::nullopt\);/);
    assert.match(result.cpp, /bbl::on_mouse_up\(v_engine, \d+u, bbl::js::make_closure\(std::tuple\{v_destination\}/);
    assert.match(result.cpp, /\(\*v_destination\) = bbl::js::Nullable<double>\{v_\w+_x\};/);
});

test("a closure pushed into a container shares the let it writes", () => {
    const result = compileSource(`
        import { createEngine, createSceneContext, onBeforeRender } from "@babylonjs/lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const handlers: Array<() => void> = [];
            let pushed = 0;
            let seen = 0;
            handlers.push(() => {
                pushed += 1;
            });
            onBeforeRender(scene, () => {
                for (const handler of handlers) {
                    handler();
                }
                if (pushed > 0) {
                    seen += 1;
                }
            });
        }
        main();
    `);
    assert.match(result.cpp, sharedCell("pushed", "double", "0\\.0"));
    assert.match(result.cpp, /\(\*v_pushed\) \+= 1\.0;/);
});

test("a callback registered from inside a frame callback shares the let it writes", () => {
    const result = compileSource(`
        import { createEngine, createSceneContext, onBeforeRender, startEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            let hit = false;
            let armed = false;
            onBeforeRender(scene, () => {
                if (!armed) {
                    armed = true;
                    requestAnimationFrame(() => {
                        hit = true;
                    });
                }
            });
            await startEngine(engine);
        }
        main();
    `);
    assert.match(result.cpp, sharedCell("hit", "bool", "false"));
    assert.match(result.cpp, /\(\*v_hit\) = true;/);
});

test("a closure re-armed by its own timer keeps its own locals plain", () => {
    const result = compileSource(`
        import { createEngine, createSceneContext, onBeforeRender } from "@babylonjs/lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            let ticks = 0;
            const tick = (): void => {
                let inner = 1;
                inner += 1;
                ticks += inner;
                if (ticks < 9) {
                    setTimeout(tick, 100);
                }
            };
            tick();
            onBeforeRender(scene, () => {
                if (ticks > 3) {
                    ticks = 0;
                }
            });
        }
        main();
    `);
    assert.match(result.cpp, sharedCell("ticks", "double", "0\\.0"));
    assert.match(result.cpp, /double v_\w*inner = 1\.0;/);
    assert.doesNotMatch(result.cpp, /make_gc_shared<double>\(1\.0\)/);
});

test("a named frame loop handed to requestAnimationFrame shares the counter it writes", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            let frames = 0;
            function loop(): void {
                frames += 1;
                requestAnimationFrame(loop);
            }
            requestAnimationFrame(loop);
        }
        main();
    `);
    assert.match(result.cpp, sharedCell("frames", "double", "0\\.0"));
    assert.match(result.cpp, /\(\*v_frames\) \+= 1\.0;/);
});

test("an inline entry-level animation-frame callback borrows the entry scope", () => {
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";

        async function main(): Promise<void> {
            const engine = await createEngine({});
            let frames = 0;
            requestAnimationFrame(() => {
                frames += 1;
            });
        }
        main();
    `);
    assert.match(result.cpp, /double v_frames = 0\.0;/);
    assert.doesNotMatch(result.cpp, /make_gc_shared<double>/);
});
