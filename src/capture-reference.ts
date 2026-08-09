#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";

interface CaptureReferenceOptions {
    output: string;
    url?: string;
    browserPath?: string;
    force?: boolean;
}

function browserCandidates(): string[] {
    if (process.platform === "win32") {
        return [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        ];
    }
    if (process.platform === "darwin") {
        return [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ];
    }
    return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}

function resolveBrowserPath(explicit?: string): string {
    const candidates = [explicit, process.env.CHROME_PATH, ...browserCandidates()].filter((value): value is string => !!value);
    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) {
        throw new Error("No Chromium browser found. Pass --browser or set CHROME_PATH.");
    }
    return found;
}

export async function captureBabylonReference(options: CaptureReferenceOptions): Promise<void> {
    const output = resolve(options.output);
    if (existsSync(output) && !options.force) {
        console.log(`Reusing ${output}`);
        return;
    }

    const url = options.url ?? "https://playground.babylonjs.com/#QCU8DJ#800";
    const browser = await chromium.launch({
        executablePath: resolveBrowserPath(options.browserPath),
        headless: true,
    });
    try {
        const context = await browser.newContext({
            viewport: { width: 1280, height: 720 },
            deviceScaleFactor: 1,
        });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
        await page.waitForFunction(
            () => {
                const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
                const runtime = globalThis as typeof globalThis & {
                    engine?: { scenes?: Array<{ meshes?: unknown[] }> };
                };
                return !!canvas && (runtime.engine?.scenes?.[0]?.meshes?.length ?? 0) > 1;
            },
            undefined,
            { timeout: 120_000 },
        );
        await page.evaluate(async () => {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            Object.assign(document.documentElement.style, {
                margin: "0",
                width: "100%",
                height: "100%",
                overflow: "hidden",
            });
            Object.assign(document.body.style, {
                margin: "0",
                width: "100%",
                height: "100%",
                overflow: "hidden",
            });
            Object.assign(canvas.style, {
                position: "fixed",
                inset: "0",
                width: "1280px",
                height: "720px",
                zIndex: "2147483647",
                display: "block",
            });
            window.dispatchEvent(new Event("resize"));
            const runtime = globalThis as typeof globalThis & { engine?: { resize?: () => void } };
            runtime.engine?.resize?.();
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 2500));
        });

        mkdirSync(dirname(output), { recursive: true });
        await page.locator("#renderCanvas").screenshot({ path: output });
        writeFileSync(
            output.replace(/\.png$/i, ".json"),
            `${JSON.stringify(
                {
                    source: url,
                    capturedAt: new Date().toISOString(),
                    browser: await browser.version(),
                    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
                },
                null,
                2,
            )}\n`,
        );
        console.log(`Captured ${output}`);
    } finally {
        await browser.close();
    }
}

function parseArguments(arguments_: string[]): CaptureReferenceOptions {
    let output = "reference/boombox/babylon-ref-golden.png";
    let url: string | undefined;
    let browserPath: string | undefined;
    let force = false;
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (argument === "--output") output = arguments_[++index] ?? output;
        else if (argument === "--url") url = arguments_[++index];
        else if (argument === "--browser") browserPath = arguments_[++index];
        else if (argument === "--force") force = true;
        else throw new Error(`Unknown argument '${argument}'.`);
    }
    return { output, ...(url ? { url } : {}), ...(browserPath ? { browserPath } : {}), force };
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
    captureBabylonReference(parseArguments(process.argv.slice(2))).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
