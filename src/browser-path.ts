// Where the reference browser lives.
//
// Five tools drive a real Chromium -- the golden-suite capture, the
// instrumented diagnostics capture, the exact HDR GGX prefilter, the
// drawn sprite atlas, and the BRDF LUT -- and each once carried its own
// copy of this list. They had drifted: the golden-suite copy had lost
// the 32-bit Edge path and the macOS Edge path the others kept, so a
// machine with only those would have failed to capture goldens while
// the diagnostics capture worked. Today all five launch through
// `browser-harness.ts`, whose one ceremony resolves through here.
//
// The order is the contract, not just the set: `CHROME_PATH` wins, then
// Chrome, then Edge. Anything that resolved a browser before resolves
// the same one.
import { existsSync } from "node:fs";

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
    return [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
    ];
}

/**
 * The first installed Chromium, or a failure naming what needed it.
 * `requirement` explains why the caller cannot proceed without one.
 */
export function resolveBrowserPath(
    requirement = "No Chromium browser found.",
): string {
    const candidates = [
        process.env.CHROME_PATH,
        ...browserCandidates(),
    ].filter((value): value is string => !!value);
    const found = candidates.find((candidate) =>
        existsSync(candidate),
    );
    if (!found) {
        throw new Error(`${requirement} Set CHROME_PATH.`);
    }
    return found;
}
