/**
 * `scene -- observe <id>`: the browser half of a declared check.
 *
 * Serves the scene's corpus source through the same harness the golden
 * capture uses — the pinned package, the registry host page and host UI,
 * the seeded random stub — with the check's source hooks injected, plays
 * the declared page actions, and records each step's state and
 * screenshot into `artifacts/check/<id>/browser/`. The provenance triple
 * (source, served module, golden) is written once, so the native check
 * can refuse observations of a scene that has since moved.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import {
    gotoScenePage,
    screenshotCaptureBrowserArgs,
    waitForSceneReady,
    withBrowserPage,
} from "../browser-harness.js";
import {
    createSuiteSceneServer,
    suiteBrowserModule,
} from "../capture-suite-reference.js";
import { readNativeHostUi } from "../native-host-ui.js";
import { usesSeededRandom } from "../parity-scene.js";
import { compareImages } from "../parity.js";
import type { SceneDefinition } from "../scene-registry.js";
import { defaultCheckDirectory } from "./artifacts.js";
import type { ObserveAction, ObserveSpec } from "./check-spec.js";
import { writeReport } from "./reports.js";
import { observationsPath } from "./check-run.js";

export interface ObserveRunOptions {
    checkId: string;
    scene: SceneDefinition;
    spec: ObserveSpec;
    /** Show the browser window (a cadence measurement needs the display). */
    headed?: boolean;
}

const sha256 = (bytes: Buffer | string): string =>
    createHash("sha256").update(bytes).digest("hex");

/** Apply the check's source hooks; each marker must occur exactly once. */
export function applyObserveHooks(
    source: string,
    hooks: ObserveSpec["hooks"],
): string {
    let result = source;
    for (const hook of hooks ?? []) {
        const occurrences = result.split(hook.marker).length - 1;
        if (occurrences !== 1) {
            throw new Error(
                `observe hook marker occurs ${occurrences} time(s), expected once: ${hook.marker}`,
            );
        }
        result = result.replace(
            hook.marker,
            hook.position === "before"
                ? `${hook.inject}\n${hook.marker}`
                : `${hook.marker}\n${hook.inject}`,
        );
    }
    return result;
}

const DEFAULT_STATE_EXPRESSION =
    "typeof window.__observe === 'function' ? window.__observe() : " +
    "(() => { const canvas = document.getElementById('renderCanvas'); " +
    "return { dataset: { ...canvas.dataset }, viewport: { width: canvas.width, height: canvas.height } }; })()";

async function letFramesPass(page: Page, count: number): Promise<void> {
    await page.evaluate(async (frames: number) => {
        for (let index = 0; index < frames; index += 1) {
            await new Promise((done) => requestAnimationFrame(done));
        }
    }, count);
}

async function playAction(
    page: Page,
    action: ObserveAction,
    extras: Record<string, unknown>,
): Promise<void> {
    if ("click" in action) {
        await page.mouse.click(action.click[0], action.click[1]);
    } else if ("move" in action) {
        await page.mouse.move(action.move[0], action.move[1]);
    } else if ("down" in action) {
        await page.mouse.down();
    } else if ("up" in action) {
        await page.mouse.up();
    } else if ("drag" in action) {
        const [x0, y0, x1, y1] = action.drag;
        await page.mouse.move(x0, y0);
        await page.mouse.down();
        await page.mouse.move(x1, y1, { steps: action.steps ?? 1 });
        await page.mouse.up();
    } else if ("wheel" in action) {
        await page.mouse.wheel(0, action.wheel);
    } else if ("resize" in action) {
        await page.setViewportSize({ width: action.resize[0], height: action.resize[1] });
    } else if ("fill" in action) {
        await page.locator(action.fill.selector).fill(action.fill.text);
    } else if ("style" in action) {
        await page.addStyleTag({ content: action.style });
    } else if ("wait" in action) {
        await page.waitForTimeout(action.wait);
    } else if ("frames" in action) {
        await letFramesPass(page, action.frames);
    } else if ("evaluate" in action) {
        const value: unknown = await page.evaluate(action.evaluate);
        if (action.as !== undefined) extras[action.as] = value;
    } else if ("workerEvaluate" in action) {
        const worker = page.workers()[0];
        if (worker === undefined) throw new Error("the page started no worker to evaluate in");
        const value: unknown = await worker.evaluate(action.workerEvaluate);
        if (action.as !== undefined) extras[action.as] = value;
    } else {
        await page.waitForFunction(action.waitFor, undefined, {
            timeout: action.timeoutMs ?? 60_000,
        });
    }
}

interface RecordedStep {
    id: string;
    image?: string;
    state?: unknown;
    extras?: Record<string, unknown>;
    /** Page errors raised while the step ran (a pin that throws on resize records its error here). */
    errors?: string[];
}

/**
 * Navigate to the scene page and wait for the readiness flag the check
 * names: `waitForSceneReady`'s ready handshake and settle for the
 * default, a bare navigation for `none`, or another dataset flag.
 */
async function navigateReady(
    page: Page,
    origin: string,
    ready: string | undefined,
    search?: string,
): Promise<void> {
    if (ready === undefined || ready === "ready") {
        await waitForSceneReady(page, origin, false, search);
        return;
    }
    await gotoScenePage(page, origin, search);
    if (ready === "none") return;
    await page.waitForFunction(
        (flag: string) => document.getElementById("renderCanvas")?.dataset[flag] === "true",
        ready,
        { timeout: 120_000 },
    );
}

export async function runObserve(options: ObserveRunOptions): Promise<string> {
    const { checkId, scene, spec } = options;
    const outputDirectory = resolve(defaultCheckDirectory(checkId), "browser");
    mkdirSync(outputDirectory, { recursive: true });
    const source = readFileSync(scene.source, "utf8");
    const module = suiteBrowserModule(scene.source, (text) =>
        applyObserveHooks(text, spec.hooks),
    );
    writeFileSync(resolve(outputDirectory, "module.js"), module);
    const goldenPath = scene.parity?.reference.path;
    const hostPage = spec.hostPage === false ? undefined : scene.parity?.referenceHostPage;
    const server = createSuiteSceneServer(module, {
        sourcePath: scene.source,
        seededRandom: usesSeededRandom(scene),
        ...(hostPage !== undefined ? { hostPage } : {}),
        ...(scene.nativeHostUi ? { hostUi: readNativeHostUi(scene.nativeHostUi) } : {}),
    });
    const viewport = spec.viewport ?? [1280, 720];
    const stateExpression = spec.state ?? DEFAULT_STATE_EXPRESSION;
    const initScript =
        spec.initScriptFile === undefined
            ? undefined
            : readFileSync(resolve(spec.initScriptFile), "utf8");
    const captureFrames: Array<{ frame: number; image: string; state: unknown }> = [];
    const steps: RecordedStep[] = [];
    let goldenComparison: { image: string; mad: number; maxDiff: number } | undefined;
    const checkGolden = async (page: Page, name: string): Promise<void> => {
        if (goldenComparison !== undefined || goldenPath === undefined) return;
        const image = resolve(outputDirectory, name);
        await page.screenshot({ path: image });
        const comparison = compareImages(image, resolve(goldenPath));
        goldenComparison = { image: name, mad: comparison.mad, maxDiff: comparison.maxDiff };
        console.log(
            `observe ${checkId}: hooked page vs golden MAD ${comparison.mad.toFixed(6)}, max ${comparison.maxDiff}`,
        );
        if (spec.golden !== false && comparison.maxDiff !== 0) {
            throw new Error(
                `observe ${checkId}: the hooked page differs from the golden (max ${comparison.maxDiff}); an observer must not change what it observes. Set "golden": false only for a scene whose renderer wobbles between runs.`,
            );
        }
    };
    await withBrowserPage(
        server,
        {
            serverName: `${checkId} observer`,
            browserArgs: screenshotCaptureBrowserArgs,
            viewport: { width: viewport[0], height: viewport[1] },
            headless: !(options.headed ?? spec.headless === false),
            pageErrorPrefix: `observe ${checkId}`,
            consoleErrorPrefix: `observe ${checkId} console`,
        },
        async (page, origin) => {
            if (initScript !== undefined) await page.addInitScript(initScript);
            let pageErrors: string[] = [];
            page.on("pageerror", (error) => {
                pageErrors.push(error.message);
            });
            for (const frame of spec.captureFrames ?? []) {
                await navigateReady(page, origin, spec.ready, `?captureFrame=${frame}`);
                const state: unknown = await page.evaluate(stateExpression);
                const name = `frame-${frame}.png`;
                await checkGolden(page, name);
                if (goldenComparison?.image !== name) {
                    await page.screenshot({ path: resolve(outputDirectory, name) });
                }
                captureFrames.push({ frame, image: name, state });
                console.log(`observe ${checkId}: captureFrame ${frame} observed`);
            }
            let ready = false;
            for (const step of spec.steps) {
                const extras: Record<string, unknown> = {};
                pageErrors = [];
                if (step.startup !== undefined) {
                    const [width, height] = step.startup.viewport;
                    await page.setViewportSize({ width, height });
                    await page.route("**/scene.html", async (route) => {
                        const response = await route.fetch();
                        const html = (await response.text())
                            .replaceAll("width:1280px;height:720px", `width:${width}px;height:${height}px`)
                            .replaceAll('width="1280" height="720"', `width="${width}" height="${height}"`);
                        await route.fulfill({ response, body: html });
                    });
                    await navigateReady(page, origin, spec.ready);
                    await page.unroute("**/scene.html");
                    ready = true;
                } else if (!ready) {
                    await page.setViewportSize({ width: viewport[0], height: viewport[1] });
                    await navigateReady(page, origin, spec.ready);
                    ready = true;
                    await checkGolden(page, "observed.png");
                }
                for (const action of step.actions ?? []) {
                    await playAction(page, action, extras);
                }
                if (step.settleFrames !== undefined) await letFramesPass(page, step.settleFrames);
                const state: unknown =
                    step.state === false ? undefined : await page.evaluate(stateExpression);
                let image: string | undefined;
                if ((step.screenshot ?? "page") !== "none") {
                    image = `${step.id}.png`;
                    const hidden =
                        step.hideStyle === undefined
                            ? undefined
                            : await page.addStyleTag({ content: step.hideStyle });
                    const path = resolve(outputDirectory, image);
                    if (step.screenshot === "canvas") {
                        await page.locator("#renderCanvas").screenshot({ path });
                    } else {
                        await page.screenshot({ path });
                    }
                    if (hidden !== undefined) {
                        await hidden.evaluate((element) => {
                            (element as Element).remove();
                        });
                    }
                }
                steps.push({
                    id: step.id,
                    ...(image !== undefined ? { image } : {}),
                    ...(state !== undefined ? { state } : {}),
                    ...(Object.keys(extras).length > 0 ? { extras } : {}),
                    ...(pageErrors.length > 0 ? { errors: [...pageErrors] } : {}),
                });
                console.log(`observe ${checkId}: step ${step.id} observed`);
            }
        },
    );
    const reportPath = observationsPath(resolve(defaultCheckDirectory(checkId)));
    writeReport(
        reportPath,
        { tool: "observe" },
        {
            check: checkId,
            scene: scene.id,
            sourceSha256: sha256(source),
            moduleSha256: sha256(module),
            ...(goldenPath !== undefined
                ? { referenceSha256: sha256(readFileSync(resolve(goldenPath))) }
                : {}),
            viewport: { width: viewport[0], height: viewport[1] },
            ...(goldenComparison !== undefined ? { goldenComparison } : {}),
            captureFrames,
            steps,
        },
    );
    console.log(`observe ${checkId}: ${captureFrames.length} frame(s), ${steps.length} step(s). Observations: ${reportPath}`);
    return reportPath;
}
