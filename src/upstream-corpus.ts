import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findRepositoryRoot } from "./upstream-source.js";

export interface CorpusFile {
    upstreamPath: string;
    /** Origin for reached bytes that the Babylon Lite repository downloads
     * rather than stores, such as the pinned Freedoom release. */
    origin?: string;
    source: string;
    sha256: string;
}

export interface CorpusScene extends CorpusFile {
    id: string;
}

export interface CorpusApplication {
    id: string;
    entry: string;
    reference: { source: string; sha256: string };
    files: CorpusFile[];
}

export interface BabylonLiteCorpusManifest {
    package: string;
    version: string;
    repository: string;
    sourceVersion: string;
    scenes: CorpusScene[];
    modules?: CorpusFile[];
    applications: CorpusApplication[];
}

/** The exact upstream source catalog shared by scenes and full demos. */
export function readBabylonLiteCorpus(
    repositoryRoot = findRepositoryRoot(),
): BabylonLiteCorpusManifest {
    const path = resolve(
        repositoryRoot,
        "upstream/babylon-lite-corpus.json",
    );
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`Invalid Babylon Lite corpus manifest: ${path}.`);
    }
    const manifest = value as Partial<BabylonLiteCorpusManifest>;
    if (
        typeof manifest.package !== "string" ||
        typeof manifest.version !== "string" ||
        typeof manifest.repository !== "string" ||
        typeof manifest.sourceVersion !== "string" ||
        !Array.isArray(manifest.scenes) ||
        !Array.isArray(manifest.applications)
    ) {
        throw new Error(`Incomplete Babylon Lite corpus manifest: ${path}.`);
    }
    return manifest as BabylonLiteCorpusManifest;
}
