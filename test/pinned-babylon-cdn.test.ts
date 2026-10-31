import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";
import { cachedDownloadPath } from "../src/asset-download-cache.js";
import { withBrowserPage } from "../src/browser-harness.js";
import {
    pinnedBabylonCdnUrl,
    pinnedBabylonCdnVersion,
} from "../src/pinned-babylon-cdn.js";
import { htmlPageServer } from "./html-page-server.js";

test("browser pages read cdn.babylonjs.com from the pinned release", async () => {
    const version = pinnedBabylonCdnVersion();
    // A cached file of the release: the page never reaches the network.
    const file = cachedDownloadPath(
        pinnedBabylonCdnUrl("bblite-test/sentinel.js"),
    );
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "pinned");
    try {
        const read = await withBrowserPage(
            htmlPageServer("<!doctype html><title>CDN pin</title>"),
            { serverName: "CDN pin server" },
            async (page, origin) => {
                await page.goto(origin);
                return page.evaluate(
                    (urls) =>
                        Promise.all(
                            urls.map((url) =>
                                fetch(url).then(
                                    (response) => response.text(),
                                    () => "refused",
                                ),
                            ),
                        ),
                    [
                        "https://cdn.babylonjs.com/bblite-test/sentinel.js",
                        `https://cdn.babylonjs.com/v${version}/bblite-test/sentinel.js`,
                        "https://cdn.babylonjs.com/v1.0.0/bblite-test/sentinel.js",
                    ],
                );
            },
        );
        assert.deepEqual(read, ["pinned", "pinned", "refused"]);
    } finally {
        rmSync(file, { force: true });
    }
});
