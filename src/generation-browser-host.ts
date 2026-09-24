// The shared Chromium of one generation, for one launch configuration.
//
// `generation-browser.ts` starts this detached process the first time a bake of
// a generation asks for a browser the generation has not launched. It
// launches that browser once, publishes its endpoint for every later bake of
// the generation -- in the compile process or in a generation child -- and
// closes it once the generation process exits or the browser itself dies.
// The endpoint listens on the loopback interface only.
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import {
    generationBrowserHostVariable,
    launchOptions,
    processAlive,
    type GenerationBrowserHostRequest,
} from "./generation-browser.js";

function hostRequest(text: string | undefined): GenerationBrowserHostRequest {
    const value: unknown = JSON.parse(text ?? "null");
    if (
        typeof value !== "object" ||
        value === null ||
        !("generation" in value) ||
        typeof value.generation !== "number" ||
        !("claim" in value) ||
        typeof value.claim !== "string" ||
        !("endpoint" in value) ||
        typeof value.endpoint !== "string" ||
        !("launch" in value) ||
        typeof value.launch !== "object" ||
        value.launch === null
    ) {
        throw new Error("The generation browser host received no request.");
    }
    const launch = value.launch;
    const strings = (field: unknown): string[] | undefined =>
        Array.isArray(field) &&
        field.every((entry): entry is string => typeof entry === "string")
            ? field
            : undefined;
    const args = "args" in launch ? strings(launch.args) : undefined;
    const ignoreDefaultArgs =
        "ignoreDefaultArgs" in launch
            ? strings(launch.ignoreDefaultArgs)
            : undefined;
    if (
        !("executablePath" in launch) ||
        typeof launch.executablePath !== "string" ||
        !("headless" in launch) ||
        typeof launch.headless !== "boolean" ||
        !args ||
        !ignoreDefaultArgs
    ) {
        throw new Error("The generation browser host received no launch.");
    }
    return {
        generation: value.generation,
        claim: value.claim,
        endpoint: value.endpoint,
        launch: {
            executablePath: launch.executablePath,
            headless: launch.headless,
            args,
            ignoreDefaultArgs,
        },
    };
}

const request = hostRequest(process.env[generationBrowserHostVariable]);

function publish(publication: Record<string, unknown>): void {
    const temporary = `${request.endpoint}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(publication), { mode: 0o600 });
    renameSync(temporary, request.endpoint);
}

let server: Awaited<ReturnType<typeof chromium.launchServer>>;
try {
    server = await chromium.launchServer({
        ...launchOptions(request.launch),
        host: "127.0.0.1",
    });
} catch (error) {
    publish({
        host: process.pid,
        error: `The generation's shared Chromium did not launch: ${
            error instanceof Error ? error.message : String(error)
        }`,
    });
    process.exit(0);
}

let closing = false;
async function shutdown(): Promise<void> {
    if (closing) return;
    closing = true;
    clearInterval(watch);
    rmSync(request.endpoint, { force: true });
    rmSync(request.claim, { force: true });
    const closed = server.close();
    const timeout = new Promise<"timeout">((done) =>
        setTimeout(() => done("timeout"), 10_000).unref(),
    );
    if ((await Promise.race([closed, timeout])) === "timeout")
        await server.kill();
}

const watch = setInterval(() => {
    if (!processAlive(request.generation)) void shutdown();
}, 250);
server.on("close", () => void shutdown());
publish({ host: process.pid, wsEndpoint: server.wsEndpoint() });
