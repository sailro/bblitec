import { findRepositoryRoot, readPinFile } from "./upstream-source.js";

export interface CorpusFile {
    upstreamPath: string;
    /** Origin for reached bytes that the Babylon Lite repository downloads
     * rather than stores, such as the pinned Freedoom release. */
    origin?: string;
    /** The pinned upstream script that GENERATES this file at lab build
     * time — the upstreamPath then names the script's output, which exists
     * in no tree. The digest is the adoption-time render of the pinned
     * template, re-verified by rendering it whenever the row is audited;
     * `corpus:verify` checks the generator itself is pinned tree content
     * that names this output. */
    generatedBy?: string;
    source: string;
    sha256: string;
}

interface CorpusScene extends CorpusFile {
    id: string;
}

interface CorpusApplication {
    id: string;
    entry: string;
    reference: {
        source: string;
        sha256: string;
        /** Immutable capture recipe and source/host fingerprints. */
        provenance?: { source: string; sha256: string };
        capture?: {
            frame: number;
            independentEngines: number;
            moduleSha256: string;
            adapterSha256: string;
            hostPage: string;
            hostPageSha256: string;
        };
    };
    files: CorpusFile[];
}

export interface BabylonLiteCorpusManifest {
    package: string;
    version: string;
    repository: string;
    sourceVersion: string;
    scenes: CorpusScene[];
    modules?: CorpusFile[];
    /**
     * Corpus files held as immutable evidence ahead of any registration:
     * numbered scenes, their debug helpers, application source/host graphs
     * and the upstream LICENSE. They carry the same byte pin as everything
     * else so a drift cannot sit unnoticed until the file is integrated;
     * a row moves to `scenes` when its scene registers.
     */
    staged?: CorpusFile[];
    /**
     * Pinned build scripts generation EXECUTES (`pinned-wgsl-build.ts`
     * says why); they ride the git-blob pin like every other row.
     */
    tooling?: CorpusFile[];
    applications: CorpusApplication[];
}

/** The exact upstream source catalog shared by scenes and full demos. */
export function readBabylonLiteCorpus(
    repositoryRoot = findRepositoryRoot(),
): BabylonLiteCorpusManifest {
    const path = "upstream/babylon-lite-corpus.json";
    const manifest = readPinFile(
        path,
        repositoryRoot,
    ) as Partial<BabylonLiteCorpusManifest>;
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
