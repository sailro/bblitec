import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { suiteBrowserModule } from "./capture-suite-reference.js";
import { getScene } from "./scene-registry.js";
import { readBabylonLiteCorpus } from "./upstream-corpus.js";
import { findRepositoryRoot, readUpstreamPin } from "./upstream-source.js";

/**
 * Rewrites `reference/exact-corpus-manifest.json` after an upstream pin bump.
 *
 * The manifest is golden PROVENANCE: per registered scene it records the corpus
 * source digest, the golden's own bytes, the digest of the module the capture
 * harness builds, and the query the golden was captured at. A bump moves
 * exactly one of those columns, for exactly one reason — the browser module
 * embeds the pin in curated asset URLs (the BRDF LUT's URL carries the source
 * commit), so `moduleSha256` moves for every scene that fetches one.
 *
 * That is why this is a command rather than a hand edit. Rewriting the column
 * blindly would launder a real change into the provenance record: a digest that
 * moved because the SCENE moved, or because the harness composes something
 * different, is indistinguishable from pin churn once the new value is written.
 * So every move must be EXPLAINED — reverting the pin strings has to reproduce
 * the committed digest, or the scene's own `sourceSha256` moved with the bump
 * (upstream edited a registered scene; the corpus manifest that carries the
 * new digest is itself re-derived from the upstream tree by `corpus:verify`)
 * — and the columns a bump must not touch refuse rather than being
 * rewritten:
 *
 * - `referenceSha256` is the golden's own bytes. A golden that moved is a
 *   behaviour change to investigate; recapturing one is its own deliberate
 *   operation (`parity <id> --recapture-reference`), and a scene whose
 *   source moved is named so that operation is not forgotten.
 * - `capturedAt` records when the goldens were captured, not when this file
 *   was written.
 */

/** One scene's row, as the manifest stores it. */
interface ExactCorpusReference {
    id: string;
    sourceSha256: string;
    reference: string;
    referenceSha256: string;
    moduleSha256: string;
    referenceSearch?: string;
}

interface ExactCorpusDocument {
    sourceVersion: string;
    capturedAt: string;
    scenes: ExactCorpusReference[];
}

/** The pinned pair a set of rows was written under. */
export interface UpstreamPinPair {
    version: string;
    sourceVersion: string;
}

const MANIFEST_PATH = "reference/exact-corpus-manifest.json";

/** The manifest's own serialization, which round-trips byte-for-byte. */
function serialize(document: ExactCorpusDocument): string {
    return `${JSON.stringify(document, null, 4)}\n`;
}

function sha256(bytes: Buffer | string): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/** What a rewrite moved, for the caller to report. */
export interface ManifestRewrite {
    /** The serialized document, whether or not it was written. */
    content: string;
    /** True when it differs from what is on disk. */
    changed: boolean;
    /** Scenes whose `moduleSha256` moved, each explained by the pin or by its own source. */
    movedModules: string[];
    /**
     * The subset whose SOURCE moved with the bump: upstream edited the
     * registered scene, so the module carries new text beside the new pin.
     * Their goldens must be recaptured under the new source, which is a
     * separate deliberate operation the report names them for.
     */
    movedSources: string[];
    /** How many rows were considered. */
    rows: number;
    /** The pin the rows now describe. */
    sourceVersion: string;
}

/**
 * Re-derives every column a bump may move and refuses the ones it may not.
 *
 * `previous` is the pin the committed rows were written under, which is what
 * makes "explained by the pin" checkable at all.
 */
export function rewriteExactCorpusManifest(
    previous: UpstreamPinPair,
    repositoryRoot = findRepositoryRoot(),
): ManifestRewrite {
    const path = resolve(repositoryRoot, MANIFEST_PATH);
    const original = readFileSync(path, "utf8");
    const document = JSON.parse(original) as ExactCorpusDocument;

    // The writer is trustworthy only if it reproduces the committed bytes
    // before changing any of them; otherwise a rewrite reformats the whole
    // file and buries the columns that actually moved.
    if (serialize(document) !== original) {
        throw new Error(
            `${MANIFEST_PATH} does not round-trip through this writer's ` +
                "serialization; refusing rather than reformatting every row.",
        );
    }

    const current = readUpstreamPin(repositoryRoot);
    const corpus = readBabylonLiteCorpus(repositoryRoot);
    const corpusScenes = new Map(
        corpus.scenes.map((entry) => [entry.id, entry.sha256]),
    );

    const movedModules: string[] = [];
    const movedSources: string[] = [];
    document.sourceVersion = corpus.sourceVersion;

    for (const row of document.scenes) {
        const scene = getScene(row.id);
        const parity = scene.parity;
        if (!parity) {
            throw new Error(`${row.id} has no registry parity entry.`);
        }

        const sourceSha256 = corpusScenes.get(row.id);
        if (sourceSha256 === undefined) {
            throw new Error(
                `${row.id} is in ${MANIFEST_PATH} but not in the corpus manifest.`,
            );
        }
        // The scene's own source is the module's other input. A bump that
        // edits a registered scene upstream moves this column through the
        // corpus manifest -- itself re-derived from the upstream tree by
        // `corpus:verify` -- and the module digest with it.
        const sourceMoved = row.sourceSha256 !== sourceSha256;
        row.sourceSha256 = sourceSha256;

        // The golden is evidence, not a row to refresh.
        const golden = sha256(readFileSync(resolve(repositoryRoot, row.reference)));
        if (golden !== row.referenceSha256) {
            throw new Error(
                `${row.id}: the golden at ${row.reference} no longer matches its ` +
                    "recorded digest. Recapturing a reference is a deliberate " +
                    "operation, so this writer refuses rather than adopting the " +
                    "new bytes.",
            );
        }

        const composed = suiteBrowserModule(
            scene.source,
            undefined,
            parity.referenceTimeSeconds,
            parity.referenceAnimationGroups,
            parity.referenceFrame,
        );
        const digest = sha256(composed);
        if (digest !== row.moduleSha256) {
            if (sourceMoved) {
                movedSources.push(row.id);
            } else {
                assertExplainedByPin(row, composed, previous, current);
            }
            row.moduleSha256 = digest;
            movedModules.push(row.id);
        }

        if (parity.referenceSearch === undefined) delete row.referenceSearch;
        else row.referenceSearch = parity.referenceSearch;
    }

    const content = serialize(document);
    return {
        content,
        changed: content !== original,
        movedModules,
        movedSources,
        rows: document.scenes.length,
        sourceVersion: corpus.sourceVersion,
    };
}

/**
 * Whether the pin alone explains a moved module digest.
 *
 * The composed module is the scene source plus the injected pose plus the
 * pinned package's own URLs, so substituting the new version and commit back
 * to the previous pair must reproduce the recorded digest exactly. Anything
 * else means the scene, the pose or the harness moved — a finding, not churn.
 *
 * Kept a predicate over the composed TEXT rather than folded into the caller,
 * so the rule the whole writer rests on is checkable without a repository
 * tree to point it at.
 */
export function moduleMoveExplainedByPin(
    composed: string,
    recordedDigest: string,
    previous: UpstreamPinPair,
    current: UpstreamPinPair,
): boolean {
    const reverted = composed
        .split(current.sourceVersion)
        .join(previous.sourceVersion)
        .split(current.version)
        .join(previous.version);
    return sha256(reverted) === recordedDigest;
}

function assertExplainedByPin(
    row: ExactCorpusReference,
    composed: string,
    previous: UpstreamPinPair,
    current: UpstreamPinPair,
): void {
    if (moduleMoveExplainedByPin(composed, row.moduleSha256, previous, current)) {
        return;
    }
    throw new Error(
        `${row.id}: its capture module moved for a reason the pin does not ` +
            "explain -- reverting the package version and source commit does not " +
            "reproduce the recorded digest. A bump moves this column only through " +
            "the pinned URLs the module embeds, so this is a change to read " +
            "rather than a row to rewrite.",
    );
}

function flag(name: string): string | undefined {
    const at = process.argv.indexOf(name);
    return at >= 0 ? process.argv[at + 1] : undefined;
}

async function main(): Promise<void> {
    const version = flag("--previous-version");
    const sourceVersion = flag("--previous-commit");
    if (!version || !sourceVersion) {
        console.error(
            "usage: corpus:manifest --previous-version <v> --previous-commit <sha> [--write]\n\n" +
                "The previous pin is what makes a moved module digest checkable:\n" +
                "reverting it must reproduce the committed value, or the move is a\n" +
                "finding rather than churn.",
        );
        process.exitCode = 2;
        return;
    }

    const root = findRepositoryRoot();
    const result = rewriteExactCorpusManifest({ version, sourceVersion }, root);
    console.log(
        `${result.movedModules.length} of ${result.rows} capture module digest(s) ` +
            `moved, each explained by the pin at ${result.sourceVersion}` +
            (result.movedSources.length > 0
                ? ` or by its own source (${result.movedSources.join(", ")}: ` +
                  "recapture their goldens under the edited source)."
                : "."),
    );
    if (!result.changed) {
        console.log(`${MANIFEST_PATH} is already current.`);
        return;
    }
    if (!process.argv.includes("--write")) {
        console.log("Dry run: pass --write to rewrite.");
        return;
    }
    writeFileSync(resolve(root, MANIFEST_PATH), result.content);
    console.log(`Wrote ${MANIFEST_PATH}`);
}

if (
    process.argv[1] &&
    import.meta.url ===
        new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href
) {
    await main();
}
