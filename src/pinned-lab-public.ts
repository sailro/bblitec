import { readUpstreamPin } from "./upstream-source.js";

/** Checkout paths of the pinned lab and the files it serves at `/`. */
export const LAB_ROOT = "corpus/babylon-lite/lab";
export const LAB_PUBLIC_ROOT = `${LAB_ROOT}/public`;

/**
 * The pinned Babylon Lite lab application's public directory, as the URL
 * that serves it. Every registry scene is deployed beside these files: the
 * browser reference serves them at the page root, and generation passes
 * this URL as the scene's `--public-url`.
 */
export function pinnedLabPublicUrl(): string {
    return (
        "https://raw.githubusercontent.com/" +
        `BabylonJS/Babylon-Lite/${readUpstreamPin().sourceVersion}` +
        "/lab/public/"
    );
}
