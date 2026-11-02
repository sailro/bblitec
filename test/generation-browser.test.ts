import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    canvasBakeBrowserArgs,
    withBrowserPage,
} from "../src/browser-harness.js";
import { generationIdentity } from "../src/generation-browser.js";
import { htmlPageServer } from "./html-page-server.js";

const page = (): ReturnType<typeof htmlPageServer> =>
    htmlPageServer("<!doctype html><title>Generation bake</title>");

/** The pid of the host each published endpoint of this generation names. */
function hosts(): number[] {
    const directory = join(tmpdir(), "bblite-generation-browsers");
    if (!existsSync(directory)) return [];
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
        headless: true,
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

test(
    "headed Linux generation bakes overlap with isolated cookies and failures without a shared host",
    { skip: process.platform !== "linux", timeout: 60_000 },
    async () => {
        const previousHosts = hosts();
        const options = {
            serverName: "headed generation bake server",
            shared: true,
            headless: false,
            browserArgs: canvasBakeBrowserArgs,
        } as const;
        let release: () => void;
        const bothReady = new Promise<void>((done) => {
            release = done;
        });
        let closedFailure: () => void;
        const failureClosed = new Promise<void>((done) => {
            closedFailure = done;
        });
        let arrived = 0;
        const runBake = (index: number): Promise<string> =>
            withBrowserPage(page(), options, async (bake, origin) => {
                await bake.goto(origin);
                await bake
                    .context()
                    .addCookies([
                        { name: "bake", value: String(index), url: origin },
                    ]);
                if (++arrived === 2) release();
                await bothReady;
                assert.equal(arrived, 2);
                assert.equal(
                    (await bake.context().cookies(origin)).find(
                        (cookie) => cookie.name === "bake",
                    )?.value,
                    String(index),
                );
                if (index === 0) throw new Error("The isolated bake failed.");
                await failureClosed;
                assert.equal(
                    await bake.evaluate(() => document.cookie),
                    `bake=${index}`,
                );
                return bake.title();
            }).finally(() => {
                // A launch failure must also release the other bake's wait.
                release();
                if (index === 0) closedFailure();
            });
        await Promise.all([
            assert.rejects(runBake(0), /The isolated bake failed\./),
            runBake(1).then((title) => assert.equal(title, "Generation bake")),
        ]);
        assert.deepEqual(hosts(), previousHosts);
    },
);
