import type { BrowserContext } from "playwright-core";
import { downloadCachedResource } from "./asset-download-cache.js";
import { jsonValue } from "./json-fields.js";
import { readPinFile } from "./upstream-source.js";

/** The CDN the pinned Babylon Lite reads run-time decoders from, at its latest release. */
const CDN_ORIGIN = "https://cdn.babylonjs.com";

/** A release path segment: `9.32.1`, as a version or behind `v` in a URL path. */
const RELEASE = "\\d+\\.\\d+\\.\\d+";

let pinnedVersion: string | undefined;

/** The Babylon.js release `upstream/babylon-cdn.json` pins. */
export function pinnedBabylonCdnVersion(): string {
    return (pinnedVersion ??= jsonValue(
        readPinFile("upstream/babylon-cdn.json").version,
        (value): value is string =>
            typeof value === "string" && new RegExp(`^${RELEASE}$`).test(value),
        "upstream/babylon-cdn.json requires a release version string.",
    ));
}

/**
 * The pinned release's URL of a CDN path. The asset download cache keys the
 * file's bytes by it, so a run is offline after the first fetch and a bump
 * cannot reuse another release's file.
 */
export function pinnedBabylonCdnUrl(path: string): string {
    return `${CDN_ORIGIN}/v${pinnedBabylonCdnVersion()}/${path}`;
}

/**
 * Serves every cdn.babylonjs.com request of `context` from the pinned
 * release, whatever release the CDN's unversioned paths name today.
 */
export async function routePinnedBabylonCdn(
    context: BrowserContext,
): Promise<void> {
    const release = `v${pinnedBabylonCdnVersion()}/`;
    const versioned = new RegExp(`^v${RELEASE}/`);
    await context.route(`${CDN_ORIGIN}/**`, async (route) => {
        const requested = new URL(route.request().url()).pathname.slice(1);
        try {
            // A pinned file asks for its siblings under its own release.
            if (versioned.test(requested) && !requested.startsWith(release))
                throw new Error(
                    `${requested} is not of the pinned Babylon.js release.`,
                );
            const resource = await downloadCachedResource(
                pinnedBabylonCdnUrl(
                    requested.startsWith(release)
                        ? requested.slice(release.length)
                        : requested,
                ),
            );
            await route.fulfill({
                status: 200,
                body: Buffer.from(resource.bytes),
                ...(resource.contentType
                    ? { contentType: resource.contentType }
                    : {}),
                headers: { "access-control-allow-origin": "*" },
            });
        } catch (error) {
            console.error(
                error instanceof Error ? error.message : String(error),
            );
            await route.abort("failed");
        }
    });
}
