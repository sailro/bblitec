#!/usr/bin/env node

// Check the corpus digests against the upstream tree, not only against
// their own manifest.
//
// Every digest in `upstream/babylon-lite-corpus.json` is written from the
// corpus file it describes, so a file edited together with its digest
// passes every hash suite without any check having seen an upstream byte,
// and `reference/exact-corpus-manifest.json` hand-writes a second copy of
// the scene digests, which closes nothing. This command re-derives each
// digest from where the bytes came from: the Babylon Lite tree at the
// pinned commit for rows with no third-party `origin`, the pinned origin
// URL for rows with one, and the members of the pinned release archives
// for rows whose origin is an archive. The archive rows do not name their
// member -- the LibreQuake corpus files live inside `.pak` containers the
// release zip carries -- so an archive is verified by content: every
// member is hashed, one level of `.pak` nesting included, and a row
// matches when its digest names bytes the pinned archive holds.
//
// It lives beside `status:verify` in the `verify-*` family rather than in
// the unit suite because the published package ships no `lab/` sources --
// only the network, or the download cache a previous run filled, can
// serve the comparison. `--offline` reports uncached rows as unverifiable
// instead of failing; cache-served rows still verify.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
    downloadCached,
    readCachedDownload,
} from "./asset-download-cache.js";
import { runConcurrently } from "./run-concurrently.js";
import type {
    BabylonLiteCorpusManifest,
    CorpusFile,
} from "./upstream-corpus.js";
import { readBabylonLiteCorpus } from "./upstream-corpus.js";
import { findRepositoryRoot } from "./upstream-source.js";

export type CorpusCheckKind =
    | "upstream-tree"
    | "origin-file"
    | "archive-member"
    | "generated-file";

/** One manifest digest and the pinned bytes it must agree with. */
export interface CorpusCheck {
    /** Manifest section and upstream path, for the printed verdict. */
    label: string;
    kind: CorpusCheckKind;
    /** The URL fetched: a raw upstream path, an origin file, the archive
     * whose members are searched for the digest, or — for a generated
     * row — the pinned script that renders the file. */
    url: string;
    sha256: string;
    /** generated-file only: the output filename the fetched generator
     * must name, which is what ties the pinned script to this row. */
    generatedOutputName?: string;
}

export interface ExactCorpusScene {
    id: string;
    sourceSha256: string;
}

export interface ExactCorpusManifest {
    sourceVersion: string;
    scenes: ExactCorpusScene[];
}

/** The hand-written second digest copy beside the reference goldens. Its
 * golden and module digests describe local captures with no upstream
 * counterpart; only the `sourceSha256` column is upstream-checkable. */
function readExactCorpusManifest(
    repositoryRoot = findRepositoryRoot(),
): ExactCorpusManifest {
    const path = resolve(
        repositoryRoot,
        "reference/exact-corpus-manifest.json",
    );
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`Invalid exact corpus manifest: ${path}.`);
    }
    const manifest = value as Partial<ExactCorpusManifest>;
    if (
        typeof manifest.sourceVersion !== "string" ||
        !Array.isArray(manifest.scenes) ||
        manifest.scenes.some(
            (scene) =>
                typeof scene.id !== "string" ||
                typeof scene.sourceSha256 !== "string",
        )
    ) {
        throw new Error(`Incomplete exact corpus manifest: ${path}.`);
    }
    return {
        sourceVersion: manifest.sourceVersion,
        scenes: manifest.scenes.map(({ id, sourceSha256 }) => ({
            id,
            sourceSha256,
        })),
    };
}

function rawUpstreamUrl(
    sourceVersion: string,
    upstreamPath: string,
): string {
    return `https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/${sourceVersion}/${upstreamPath}`;
}

function fileCheck(
    section: string,
    file: CorpusFile,
    sourceVersion: string,
): CorpusCheck {
    const label = `${section} ${file.upstreamPath}`;
    if (file.generatedBy !== undefined) {
        // The upstreamPath names a script OUTPUT that exists in no tree;
        // what is checkable online is the generator itself, so the row
        // verifies as "the pinned script exists and names this output",
        // with the digest remaining the adoption-time render.
        const generatedOutputName = file.upstreamPath.split("/").at(-1);
        if (!generatedOutputName) {
            // An empty name would verify vacuously -- every generator
            // "names" the empty string -- so a row that cannot name its
            // output refuses instead of passing.
            throw new Error(
                `Corpus row '${label}' declares generatedBy but its ` +
                    "upstreamPath names no output file.",
            );
        }
        return {
            label,
            kind: "generated-file",
            url: rawUpstreamUrl(sourceVersion, file.generatedBy),
            sha256: file.sha256,
            generatedOutputName,
        };
    }
    if (file.origin === undefined) {
        return {
            label,
            kind: "upstream-tree",
            url: rawUpstreamUrl(sourceVersion, file.upstreamPath),
            sha256: file.sha256,
        };
    }
    if (file.origin.toLowerCase().endsWith(".zip")) {
        return {
            label,
            kind: "archive-member",
            url: file.origin,
            sha256: file.sha256,
        };
    }
    return {
        label,
        kind: "origin-file",
        url: file.origin,
        sha256: file.sha256,
    };
}

/**
 * Every upstream-checkable digest and the URL that decides it.
 *
 * Corpus rows without an `origin` resolve against the pinned Babylon Lite
 * tree, rows with one against the origin itself, and a `.zip` origin marks
 * the row a member of that archive. The exact-manifest rows reuse the
 * corpus scene's upstream path -- the two files pin the same commit, and a
 * disagreement there is refused rather than resolved -- with the
 * conventional `lab/lite/src/lite/<id>.ts` covering a scene the corpus
 * manifest does not carry.
 */
export function classifyCorpusChecks(
    manifest: BabylonLiteCorpusManifest,
    exact: ExactCorpusManifest,
): CorpusCheck[] {
    if (exact.sourceVersion !== manifest.sourceVersion) {
        throw new Error(
            "reference/exact-corpus-manifest.json pins " +
                `${exact.sourceVersion} while upstream/babylon-lite-corpus.json pins ${manifest.sourceVersion}; ` +
                "the two copies must describe one upstream commit.",
        );
    }
    const checks: CorpusCheck[] = [];
    for (const scene of manifest.scenes) {
        checks.push(fileCheck("scenes", scene, manifest.sourceVersion));
    }
    for (const module of manifest.modules ?? []) {
        checks.push(fileCheck("modules", module, manifest.sourceVersion));
    }
    for (const file of manifest.staged ?? []) {
        checks.push(fileCheck("staged", file, manifest.sourceVersion));
    }
    for (const application of manifest.applications) {
        for (const file of application.files) {
            checks.push(
                fileCheck(application.id, file, manifest.sourceVersion),
            );
        }
    }
    const scenePaths = new Map(
        manifest.scenes.map((scene) => [scene.id, scene.upstreamPath]),
    );
    for (const scene of exact.scenes) {
        checks.push({
            label: `exact ${scene.id}`,
            kind: "upstream-tree",
            url: rawUpstreamUrl(
                manifest.sourceVersion,
                scenePaths.get(scene.id) ??
                    `lab/lite/src/lite/${scene.id}.ts`,
            ),
            sha256: scene.sourceSha256,
        });
    }
    return checks;
}

function sha256Hex(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

interface ArchiveMember {
    path: string;
    bytes: Uint8Array;
}

/**
 * The stored files of a zip, read through the central directory.
 *
 * Node ships an inflate but no zip reader, and both pinned archives are
 * plain 32-bit zips storing entries raw or deflated, so this reads exactly
 * that and refuses anything else by name rather than guessing.
 */
function zipMembers(archive: Buffer, url: string): ArchiveMember[] {
    const eocdSignature = 0x06054b50;
    let eocd = -1;
    const floor = Math.max(0, archive.length - 22 - 65535);
    for (let index = archive.length - 22; index >= floor; index--) {
        if (archive.readUInt32LE(index) === eocdSignature) {
            eocd = index;
            break;
        }
    }
    if (eocd < 0) {
        throw new Error(`No zip end-of-central-directory in ${url}.`);
    }
    const count = archive.readUInt16LE(eocd + 10);
    const directoryOffset = archive.readUInt32LE(eocd + 16);
    if (count === 0xffff || directoryOffset === 0xffffffff) {
        throw new Error(`ZIP64 archives are not supported: ${url}.`);
    }
    const members: ArchiveMember[] = [];
    let cursor = directoryOffset;
    for (let index = 0; index < count; index++) {
        if (archive.readUInt32LE(cursor) !== 0x02014b50) {
            throw new Error(
                `Malformed zip central directory at ${cursor} in ${url}.`,
            );
        }
        const method = archive.readUInt16LE(cursor + 10);
        const compressedSize = archive.readUInt32LE(cursor + 20);
        const nameLength = archive.readUInt16LE(cursor + 28);
        const extraLength = archive.readUInt16LE(cursor + 30);
        const commentLength = archive.readUInt16LE(cursor + 32);
        const localOffset = archive.readUInt32LE(cursor + 42);
        const path = archive.toString(
            "utf8",
            cursor + 46,
            cursor + 46 + nameLength,
        );
        cursor += 46 + nameLength + extraLength + commentLength;
        if (path.endsWith("/")) continue;
        // The local header repeats name and extra with lengths of its
        // own, and its sizes can be deferred to a data descriptor, so the
        // central directory's sizes are the authoritative ones.
        if (archive.readUInt32LE(localOffset) !== 0x04034b50) {
            throw new Error(
                `Malformed zip local header for ${path} in ${url}.`,
            );
        }
        const localNameLength = archive.readUInt16LE(localOffset + 26);
        const localExtraLength = archive.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const raw = archive.subarray(start, start + compressedSize);
        if (method === 0) {
            members.push({ path, bytes: raw });
        } else if (method === 8) {
            members.push({ path, bytes: inflateRawSync(raw) });
        } else {
            throw new Error(
                `Unsupported zip compression method ${method} for ${path} in ${url}.`,
            );
        }
    }
    return members;
}

function isPak(bytes: Uint8Array): boolean {
    return (
        bytes.length >= 12 &&
        bytes[0] === 0x50 && // P
        bytes[1] === 0x41 && // A
        bytes[2] === 0x43 && // C
        bytes[3] === 0x4b // K
    );
}

/** The files of an id-Software PACK container: a 64-byte directory entry
 * per file, 56 bytes of NUL-padded name plus offset and length. */
function pakMembers(pak: Buffer, container: string): ArchiveMember[] {
    const directoryOffset = pak.readUInt32LE(4);
    const directoryLength = pak.readUInt32LE(8);
    const members: ArchiveMember[] = [];
    for (let cursor = directoryOffset;
        cursor + 64 <= directoryOffset + directoryLength;
        cursor += 64) {
        const nameEnd = pak.indexOf(0, cursor);
        const path = pak.toString(
            "latin1",
            cursor,
            nameEnd >= 0 && nameEnd < cursor + 56 ? nameEnd : cursor + 56,
        );
        const offset = pak.readUInt32LE(cursor + 56);
        const length = pak.readUInt32LE(cursor + 60);
        members.push({
            path: `${container}!${path}`,
            bytes: pak.subarray(offset, offset + length),
        });
    }
    return members;
}

/** Every digest the pinned archive can vouch for, mapped to the member
 * path carrying those bytes. */
function indexArchiveContents(
    archive: Uint8Array,
    url: string,
): Map<string, string> {
    const buffer = Buffer.from(
        archive.buffer,
        archive.byteOffset,
        archive.byteLength,
    );
    const index = new Map<string, string>();
    for (const member of zipMembers(buffer, url)) {
        const digest = sha256Hex(member.bytes);
        if (!index.has(digest)) index.set(digest, member.path);
        if (member.path.toLowerCase().endsWith(".pak") &&
            isPak(member.bytes)) {
            const container = Buffer.from(
                member.bytes.buffer,
                member.bytes.byteOffset,
                member.bytes.byteLength,
            );
            for (const inner of pakMembers(container, member.path)) {
                const innerDigest = sha256Hex(inner.bytes);
                if (!index.has(innerDigest)) {
                    index.set(innerDigest, inner.path);
                }
            }
        }
    }
    return index;
}

/**
 * One fetch, classified for every consumer: the bytes when the URL served
 * them, or why it did not. `missing` keeps the fetch error's own message
 * because a 404 is a verdict for a pinned-tree row and a plain failure for
 * an archive origin — the arm that knows which it is words the detail.
 * Everything else (429, 5xx, no network) is retryable and stays `failed`.
 */
type Fetched =
    | { state: "fetched"; bytes: Uint8Array }
    | { state: "uncached" }
    | { state: "missing"; message: string }
    | { state: "failed"; message: string };

async function classifiedFetch(
    url: string,
    offline: boolean,
): Promise<Fetched> {
    try {
        const bytes = offline
            ? readCachedDownload(url)
            : await downloadCached(url);
        if (bytes === undefined) return { state: "uncached" };
        return { state: "fetched", bytes };
    } catch (error) {
        const message =
            error instanceof Error ? error.message : String(error);
        if (message.includes("HTTP 404")) {
            return { state: "missing", message };
        }
        return { state: "failed", message };
    }
}

/** The one wording an uncached row reports, whichever arm hit it. */
function uncachedDetail(url: string): string {
    return `${url} is not in the download cache; rerun without --offline`;
}

interface RowVerdict {
    check: CorpusCheck;
    status: "match" | "mismatch" | "unverifiable";
    detail: string;
}

async function verifyChecks(
    checks: readonly CorpusCheck[],
    offline: boolean,
): Promise<RowVerdict[]> {
    const verdicts: RowVerdict[] = new Array<RowVerdict>(checks.length);

    const generatedRows = checks.flatMap((check, index) =>
        check.kind === "generated-file" ? [{ check, index }] : [],
    );
    await runConcurrently(
        generatedRows,
        8,
        ({ check }) => check.label,
        async ({ check, index }) => {
            // The digest is the adoption-time render of the pinned template
            // (see `CorpusFile.generatedBy`); what is checkable online is
            // that the generator exists at the pin and still names this
            // output. The name is non-empty by classification: `fileCheck`
            // refuses a generated row whose upstreamPath names no file.
            const outputName = check.generatedOutputName!;
            const fetched = await classifiedFetch(check.url, offline);
            switch (fetched.state) {
                case "fetched": {
                    const text = Buffer.from(fetched.bytes).toString("utf8");
                    verdicts[index] = text.includes(outputName)
                        ? {
                            check,
                            status: "match",
                            detail:
                                `the pinned generator names ${outputName} (${check.url})`,
                        }
                        : {
                            check,
                            status: "mismatch",
                            detail:
                                `the pinned generator no longer names ${outputName} (${check.url}); re-render and re-adopt the digest`,
                        };
                    break;
                }
                case "missing":
                    verdicts[index] = {
                        check,
                        status: "mismatch",
                        detail:
                            `the pinned tree serves no generator at ${check.url} (HTTP 404); the row's provenance claim is false`,
                    };
                    break;
                case "uncached":
                    verdicts[index] = {
                        check,
                        status: "unverifiable",
                        detail: uncachedDetail(check.url),
                    };
                    break;
                case "failed":
                    verdicts[index] = {
                        check,
                        status: "unverifiable",
                        detail: fetched.message,
                    };
                    break;
            }
        },
    );

    const fileRows = checks.flatMap((check, index) =>
        check.kind === "archive-member" || check.kind === "generated-file"
            ? []
            : [{ check, index }],
    );
    const digests = new Map<
        string,
        | { state: "hashed"; digest: string }
        | Exclude<Fetched, { state: "fetched" }>
    >();
    await runConcurrently(
        [...new Set(fileRows.map((row) => row.check.url))],
        8,
        (url) => url,
        async (url) => {
            // Hashed at fetch time so the map holds digests, not bytes.
            const fetched = await classifiedFetch(url, offline);
            digests.set(
                url,
                fetched.state === "fetched"
                    ? { state: "hashed", digest: sha256Hex(fetched.bytes) }
                    : fetched,
            );
        },
    );
    for (const { check, index } of fileRows) {
        const fetched = digests.get(check.url)!;
        switch (fetched.state) {
            case "hashed":
                verdicts[index] =
                    fetched.digest === check.sha256.toLowerCase()
                        ? { check, status: "match", detail: check.url }
                        : {
                            check,
                            status: "mismatch",
                            detail: `manifest ${check.sha256}, upstream ${fetched.digest} (${check.url})`,
                        };
                break;
            case "missing":
                verdicts[index] = {
                    check,
                    status: "mismatch",
                    detail:
                        `the pinned tree serves no file at ${check.url} (HTTP 404); ` +
                        "the row's provenance claim is false",
                };
                break;
            case "uncached":
                verdicts[index] = {
                    check,
                    status: "unverifiable",
                    detail: uncachedDetail(check.url),
                };
                break;
            case "failed":
                verdicts[index] = {
                    check,
                    status: "unverifiable",
                    detail: fetched.message,
                };
                break;
        }
    }

    const archiveRows = checks.flatMap((check, index) =>
        check.kind === "archive-member" ? [{ check, index }] : [],
    );
    const archives = new Map<
        string,
        { index: Map<string, string> } | { failure: string }
    >();
    for (const url of new Set(archiveRows.map((row) => row.check.url))) {
        const fetched = await classifiedFetch(url, offline);
        if (fetched.state === "uncached") {
            archives.set(url, { failure: uncachedDetail(url) });
            continue;
        }
        if (fetched.state !== "fetched") {
            // A 404 on an archive origin is a fetch failure like any
            // other -- the URL is a pinned release, not the upstream
            // tree -- so both non-served states report their message.
            archives.set(url, { failure: fetched.message });
            continue;
        }
        try {
            archives.set(url, {
                index: indexArchiveContents(fetched.bytes, url),
            });
        } catch (error) {
            archives.set(url, {
                failure:
                    error instanceof Error ? error.message : String(error),
            });
        }
    }
    for (const { check, index } of archiveRows) {
        const archive = archives.get(check.url)!;
        if ("failure" in archive) {
            verdicts[index] = {
                check,
                status: "unverifiable",
                detail: archive.failure,
            };
            continue;
        }
        const member = archive.index.get(check.sha256.toLowerCase());
        verdicts[index] = member === undefined
            ? {
                check,
                status: "mismatch",
                detail:
                    `manifest ${check.sha256} names bytes none of the ` +
                    `${archive.index.size} hashed members of ${check.url} carry`,
            }
            : { check, status: "match", detail: member };
    }
    return verdicts;
}

async function main(): Promise<void> {
    const offline = process.argv.includes("--offline");
    const root = findRepositoryRoot();
    const manifest = readBabylonLiteCorpus(root);
    const checks = classifyCorpusChecks(
        manifest,
        readExactCorpusManifest(root),
    );
    const verdicts = await verifyChecks(checks, offline);

    for (const verdict of verdicts) {
        console.log(
            `${verdict.status.padEnd(12)} ${verdict.check.label} -- ${verdict.detail}`,
        );
    }
    const kinds: Array<{ kind: CorpusCheckKind; title: string }> = [
        { kind: "upstream-tree", title: "upstream tree" },
        { kind: "origin-file", title: "origin files" },
        { kind: "archive-member", title: "archive members" },
        { kind: "generated-file", title: "generated files" },
    ];
    console.log("");
    for (const { kind, title } of kinds) {
        const rows = verdicts.filter((row) => row.check.kind === kind);
        const count = (status: RowVerdict["status"]): number =>
            rows.filter((row) => row.status === status).length;
        console.log(
            `${title}: ${count("match")} match, ${count("mismatch")} mismatch, ` +
                `${count("unverifiable")} unverifiable (of ${rows.length})`,
        );
    }

    const mismatches = verdicts.filter((row) => row.status === "mismatch");
    const unverifiable = verdicts.filter(
        (row) => row.status === "unverifiable",
    );
    if (mismatches.length > 0) {
        console.error(
            `\n${mismatches.length} corpus digest(s) disagree with the pinned upstream bytes:`,
        );
        for (const row of mismatches) {
            console.error(`  ${row.check.label}: ${row.detail}`);
        }
        process.exitCode = 1;
        return;
    }
    if (unverifiable.length > 0 && !offline) {
        console.error(
            `\n${unverifiable.length} row(s) could not be verified; the fetches above failed.`,
        );
        process.exitCode = 1;
        return;
    }
    if (unverifiable.length > 0) {
        console.log(
            `\nEvery cache-served row matches; ${unverifiable.length} row(s) need the network.`,
        );
        return;
    }
    // A generated row's digest is the adoption-time render, which no
    // fetch re-derives; the closing claim separates what was actually
    // hash-verified from what was checked by provenance alone.
    const provenanceOnly = verdicts.filter(
        (row) => row.check.kind === "generated-file",
    ).length;
    console.log(
        `\nAll ${verdicts.length - provenanceOnly} digest row(s) match the ` +
            `upstream tree at ${manifest.sourceVersion} and the pinned origins` +
            (provenanceOnly > 0
                ? `; the ${provenanceOnly} generated row(s) verify by ` +
                    "provenance only (their digests are adoption-time renders)."
                : "."),
    );
}

if (
    process.argv[1] &&
    import.meta.url ===
        new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href
) {
    await main();
}
