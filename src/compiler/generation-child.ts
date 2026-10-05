// A short-lived Node child process, for generation work that is only
// available asynchronously.
//
// Entry compilation is synchronous by design, so anything the compiler needs
// mid-emit that has no synchronous form -- a fetch, a browser evaluation, a
// module the suite server has to transpile -- crosses this boundary instead.
// Four call sites had grown their own copy of the same twenty lines: the
// spawn, the `--input-type=module` script, the maxBuffer, and the throw that
// prefers stderr over an errno. They are one function now, so a fix to the
// error text or the buffer size lands on all of them at once.
//
// The child inherits the parent's environment and its generation, so a bake
// it runs shares the generation's browser (`browser-harness.ts`); each
// caller adds whatever it needs to address its own work. Callers that hand
// over a large payload use `input` rather than the environment, since a
// command line and an environment block both have limits a serialized scene
// document can reach.
import { spawnSync } from "node:child_process";
import {
    generationEnvironmentVariable,
    generationIdentity,
} from "../generation-browser.js";

interface GenerationChildOptions {
    /** ESM source run with `--input-type=module`; must write its own stdout. */
    script: string;
    /** What to say the child was doing, when it fails. */
    label: string;
    /** Extra environment for the child, merged over the parent's. */
    env?: Record<string, string>;
    /** Payload on stdin, for a value too large to pass any other way. */
    input?: string;
    /** Default 64 MiB; a baked texture or a scene document needs more. */
    maxBuffer?: number;
}

/** Run the script and return its trimmed stdout, or throw naming `label`. */
export function runGenerationChild(options: GenerationChildOptions): string {
    const child = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", options.script],
        {
            cwd: process.cwd(),
            env: {
                ...process.env,
                ...options.env,
                [generationEnvironmentVariable]: generationIdentity(),
            },
            ...(options.input === undefined ? {} : { input: options.input }),
            encoding: "utf8",
            windowsHide: true,
            maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        },
    );
    if (child.status !== 0) {
        // stderr first: a child that ran and refused explains itself, while
        // `error.message` is only an errno from a spawn that never started.
        throw new Error(
            `${options.label} failed: ` +
                `${(child.stderr || child.error?.message || "no output").trim()}`,
        );
    }
    return child.stdout.trim();
}

interface SharedPageEvaluation {
    /** What the evaluation is, when it fails. */
    label: string;
    /** Names the page server in a failed listen. */
    serverName: string;
    /** Why the caller cannot proceed without Chromium. */
    requirement: string;
    /** Chromium flags; the generation shares one browser per flag set. */
    browserArgs?: readonly string[];
    /**
     * Load the served shell first: an un-navigated page is not a secure
     * context, so it exposes no WebGPU.
     */
    navigate?: boolean;
    /** Source text of a page function from `input` to a string. */
    evaluate: string;
    input: string;
}

/**
 * Run `evaluate(input)` on a fresh page of the generation's shared Chromium
 * and return the string it produced. Unless `navigate` asks for it, the page
 * is not navigated: the served shell exists only because the browser
 * ceremony hosts one.
 */
export function evaluateInSharedPage(options: SharedPageEvaluation): string {
    const harness = new URL("../browser-harness.js", import.meta.url).href;
    const script = `
        import { createServer } from "node:http";
        import { withBrowserPage } from ${JSON.stringify(harness)};
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const input = Buffer.concat(chunks).toString("utf8");
        const server = createServer((_request, response) => {
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end("<!doctype html><title>Generation page</title>");
        });
        const value = await withBrowserPage(
            server,
            {
                serverName: ${JSON.stringify(options.serverName)},
                shared: true,
                browserRequirement: ${JSON.stringify(options.requirement)},
                browserArgs: ${JSON.stringify(options.browserArgs ?? [])},
            },
            async (page, origin) => {
                ${options.navigate ? "await page.goto(origin);" : ""}
                return page.evaluate(${options.evaluate}, input);
            },
        );
        if (typeof value !== "string")
            throw new Error(${JSON.stringify(`${options.label} produced no text.`)});
        process.stdout.write(Buffer.from(value, "utf8").toString("base64"));
    `;
    return Buffer.from(
        runGenerationChild({
            script,
            label: options.label,
            input: options.input,
        }),
        "base64",
    ).toString("utf8");
}
