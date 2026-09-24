import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withBrowserPage } from "../src/browser-harness.js";
import { generationIdentity } from "../src/generation-browser.js";

const page = (): ReturnType<typeof createServer> =>
    createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>Generation bake</title>");
    });

/** The pid of the host each published endpoint of this generation names. */
function hosts(): number[] {
    const directory = join(tmpdir(), "bblite-generation-browsers");
    return readdirSync(directory)
        .filter(
            (name) =>
                name.startsWith(`${generationIdentity()}-`) &&
                name.endsWith(".json"),
        )
        .map((name) => {
            const published: unknown = JSON.parse(
                readFileSync(join(directory, name), "utf8"),
            );
            assert.ok(
                typeof published === "object" &&
                    published !== null &&
                    "host" in published &&
                    typeof published.host === "number",
            );
            return published.host;
        });
}

test("generation bakes share one browser and keep a failure to their own page", async () => {
    const options = {
        serverName: "generation bake server",
        shared: true,
    } as const;
    const title = (): Promise<string> =>
        withBrowserPage(page(), options, async (bake, origin) => {
            await bake.goto(origin);
            return bake.title();
        });
    assert.equal(await title(), "Generation bake");
    const [host] = hosts();
    assert.ok(host !== undefined);
    await assert.rejects(
        withBrowserPage(page(), options, async (bake) => {
            await bake.goto("chrome://crash").catch(() => undefined);
            throw new Error("The bake failed.");
        }),
        /The bake failed\./,
    );
    assert.equal(await title(), "Generation bake");
    assert.deepEqual(hosts(), [host]);
});
