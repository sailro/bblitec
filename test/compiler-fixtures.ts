/** Fixtures shared by the `compiler-*.test.ts` topic files. */

import assert from "node:assert/strict";
import { readUpstreamPin } from "../src/upstream-source.js";
import { pinnedLabPublicUrl } from "../src/pinned-lab-public.js";

export const labDeployment = { publicUrl: pinnedLabPublicUrl() };

export function assertCameraScalarWrite(
    cpp: string,
    field: string,
    value: RegExp,
): void {
    const stores = [
        ...cpp.matchAll(
            new RegExp(
                `const double (\\w+) = (${value.source});\\s+bbl::write_camera_scalar\\([^\\n]+&bbl::CameraRecord::${field}, \\1\\);`,
                "g",
            ),
        ),
    ];
    assert.ok(
        stores.length > 0,
        `Expected camera.${field} write of ${value.source}`,
    );
}

/** A curated asset URL served from the pinned upstream tree; derived from
 *  the pin so a version bump does not churn these assertions. */
export function pinnedAssetUrl(path: string): string {
    return (
        "https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/" +
        `${readUpstreamPin().sourceVersion}/${path}`
    );
}
