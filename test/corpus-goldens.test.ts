import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

interface GoldenFile {
    upstreamPath: string;
    /** Where a file that is NOT from the application's own repository came
     *  from. Doom's IWAD and its two Freedoom licence files are the reached
     *  case: upstream gitignores them and downloads a pinned, checksum-verified
     *  Freedoom release instead, so the application's `sourceVersion` says
     *  nothing about their bytes and this names the release that does. */
    origin?: string;
    source: string;
    sha256: string;
}

interface GoldenApplication {
    id: string;
    repository: string;
    sourceVersion: string;
    entry: string;
    reference: { source: string; sha256: string };
    files: GoldenFile[];
}

const manifest = JSON.parse(
    readFileSync(resolve("upstream/babylon-lite-goldens.json"), "utf8"),
) as { applications: GoldenApplication[] };

function sha256(path: string): string {
    return createHash("sha256")
        .update(readFileSync(resolve(path)))
        .digest("hex");
}

test("keeps external golden applications byte-identical to their manifests", () => {
    const ids = new Set<string>();
    for (const application of manifest.applications) {
        assert.ok(!ids.has(application.id), `Duplicate golden '${application.id}'.`);
        ids.add(application.id);
        assert.match(application.repository, /^https:\/\//);
        assert.match(application.sourceVersion, /^[0-9a-f]{40}$/);
        assert.ok(
            application.files.some(({ source }) => source === application.entry),
            `${application.id} entry is not part of its immutable file set.`,
        );

        const paths = new Set<string>();
        for (const file of application.files) {
            assert.ok(
                !paths.has(file.source),
                `${application.id} repeats '${file.source}'.`,
            );
            paths.add(file.source);
            if (file.origin !== undefined) {
                assert.match(
                    file.origin,
                    /^https:\/\//,
                    `${file.upstreamPath} names an origin that is not a URL.`,
                );
            }
            assert.equal(
                sha256(file.source),
                file.sha256,
                `${file.upstreamPath} differs from its recorded upstream bytes.`,
            );
        }
        assert.equal(
            sha256(application.reference.source),
            application.reference.sha256,
            `${application.id} reference image differs from its recorded bytes.`,
        );
    }
});
