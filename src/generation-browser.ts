// One Chromium per generation and launch configuration.
//
// A compile is one generation; so is every generation child it runs
// (`compiler/generation-child.ts`), which inherits the generation through the
// environment. Every generation bake (`browser-harness.ts`, `shared`) of one
// generation, whichever of those processes runs it, opens its own browser
// context in the generation's browser for its launch configuration. A
// detached host process (`generation-browser-host.ts`) owns that browser and
// closes it once the generation process exits, so no bake waits on a close
// and no generation leaves a browser behind.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
    closeSync,
    mkdirSync,
    openSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The environment variable a generation child inherits its generation by. */
export const generationEnvironmentVariable = "BBLITE_GENERATION";

let ownGeneration: string | undefined;

/**
 * The generation this process belongs to: its own, or the one of the
 * process that started it as a generation child. It begins with the
 * generation process's pid, which a browser host watches; the token after
 * it keeps a reused pid from finding a previous generation's browser.
 */
export function generationIdentity(): string {
    const inherited = process.env[generationEnvironmentVariable];
    if (inherited !== undefined) return inherited;
    ownGeneration ??= `${process.pid}-${randomUUID()}`;
    return ownGeneration;
}

/** What a Chromium launch is: two bakes share a browser only when they
 *  would have launched the same one. */
export interface GenerationBrowserLaunch {
    executablePath: string;
    headless: boolean;
    args: string[];
    ignoreDefaultArgs: string[];
}

/** What a generation's browser host is asked to run, and where it
 *  publishes itself. */
export interface GenerationBrowserHostRequest {
    /** The generation process; the host closes the browser when it exits. */
    generation: number;
    launch: GenerationBrowserLaunch;
    /** Created exclusively by the process that starts the host. */
    claim: string;
    /** Written by the host: its pid and endpoint, or why it could not launch. */
    endpoint: string;
}

/** A launch configuration as Playwright's launch options. */
export function launchOptions(launch: GenerationBrowserLaunch): {
    executablePath: string;
    headless: boolean;
    args?: string[];
    ignoreDefaultArgs?: string[];
} {
    return {
        executablePath: launch.executablePath,
        headless: launch.headless,
        ...(launch.ignoreDefaultArgs.length > 0
            ? { ignoreDefaultArgs: [...launch.ignoreDefaultArgs] }
            : {}),
        ...(launch.args.length > 0 ? { args: [...launch.args] } : {}),
    };
}

/** The environment variable a browser host receives its request in. */
export const generationBrowserHostVariable = "BBLITE_GENERATION_BROWSER_HOST";

/** Whether a process is still running. */
export function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "EPERM"
        );
    }
}

type GenerationBrowserPublication =
    { host: number; wsEndpoint: string } | { host: number; error: string };

function readPublication(
    path: string,
): GenerationBrowserPublication | undefined {
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
    if (typeof value !== "object" || value === null || !("host" in value))
        return undefined;
    const host = value.host;
    if (typeof host !== "number") return undefined;
    if ("wsEndpoint" in value && typeof value.wsEndpoint === "string")
        return { host, wsEndpoint: value.wsEndpoint };
    if ("error" in value && typeof value.error === "string")
        return { host, error: value.error };
    return undefined;
}

/** Create `path` only if nothing has; true when this call created it. */
function claimFile(path: string): boolean {
    try {
        closeSync(openSync(path, "wx"));
        return true;
    } catch (error) {
        if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "EEXIST"
        )
            return false;
        throw error;
    }
}

/** A claim whose host died, or that never named a host within ten seconds. */
function claimAbandoned(path: string): boolean {
    let text: string;
    let modified: number;
    try {
        text = readFileSync(path, "utf8").trim();
        modified = statSync(path).mtimeMs;
    } catch {
        return false;
    }
    const host = Number(text);
    return text !== "" && Number.isInteger(host)
        ? !processAlive(host)
        : Date.now() - modified > 10_000;
}

/** Start the detached host process that owns the shared browser. */
function startGenerationBrowserHost(
    request: GenerationBrowserHostRequest,
): void {
    const host = spawn(
        process.execPath,
        [
            fileURLToPath(
                new URL("./generation-browser-host.js", import.meta.url),
            ),
        ],
        {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
            env: {
                ...process.env,
                [generationBrowserHostVariable]: JSON.stringify(request),
            },
        },
    );
    host.unref();
    if (host.pid === undefined) {
        rmSync(request.claim, { force: true });
        throw new Error("Unable to start the generation's browser host.");
    }
    writeFileSync(request.claim, String(host.pid));
}

/**
 * The endpoint of this generation's shared Chromium for `launch`, starting
 * its host if no process of the generation has.
 *
 * One browser per generation and launch configuration serves every bake of
 * that generation, whichever process runs the bake: the compile itself or a
 * generation child. A detached host process owns it and closes it once the
 * generation process exits, so no bake waits on a close and no generation
 * leaves a browser behind. A host that died without cleaning up is
 * replaced; a launch the host could not make fails the bake that waited on
 * it and leaves the next bake to try again.
 */
export async function generationBrowserEndpoint(
    launch: GenerationBrowserLaunch,
): Promise<string> {
    const generation = generationIdentity();
    const configuration = createHash("sha256")
        .update(JSON.stringify(launch))
        .digest("hex")
        .slice(0, 16);
    const directory = join(tmpdir(), "bblite-generation-browsers");
    mkdirSync(directory, { recursive: true });
    const stem = join(directory, `${generation}-${configuration}`);
    const request: GenerationBrowserHostRequest = {
        generation: Number.parseInt(generation, 10),
        launch,
        claim: `${stem}.claim`,
        endpoint: `${stem}.json`,
    };
    const deadline = Date.now() + 120_000;
    for (;;) {
        const published = readPublication(request.endpoint);
        if (published && "error" in published) {
            rmSync(request.endpoint, { force: true });
            rmSync(request.claim, { force: true });
            throw new Error(published.error);
        }
        if (published && processAlive(published.host))
            return published.wsEndpoint;
        if (published) {
            rmSync(request.endpoint, { force: true });
            rmSync(request.claim, { force: true });
        } else if (claimFile(request.claim)) {
            startGenerationBrowserHost(request);
        } else if (claimAbandoned(request.claim)) {
            rmSync(request.claim, { force: true });
            continue;
        }
        if (Date.now() > deadline) {
            throw new Error(
                "The generation's shared Chromium did not publish an endpoint.",
            );
        }
        await new Promise((done) => setTimeout(done, 20));
    }
}
