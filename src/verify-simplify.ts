/**
 * The `/simplify` gate, as a check that fails and names what is missing.
 *
 * Gate 3 runs the skill over the complete body of work before the validation
 * sweep, on every branch that becomes a pull request, whatever its size.
 * Stated as prose it was skipped by judging a change too small, and the run
 * that followed had real defects to find — so it is stated here instead, in
 * the form this repository already trusts for `docs/status.md`.
 *
 * The record is keyed by the CONTENT of the work, not by the branch or the
 * commit, for the same reason `parity` refuses a stale binary: a review of
 * different bytes is not a review of these ones. Applying what the skill
 * found changes the content, so the final record — written after the fixes —
 * is the one that counts.
 *
 * The record lives under `docs/reviews/`, which is tracked, so it travels
 * with the branch and a reviewer can read what was found. Its own path is
 * excluded from the hash; otherwise writing it would invalidate it.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";

/** Where a record lives, relative to the repository root. */
export const reviewDirectory = "docs/reviews";

/** One finding, and what happened to it. */
export interface SimplifyFinding {
    summary: string;
    /** Whether the fix landed on this branch. */
    applied: boolean;
    /**
     * What genuinely blocks an unapplied one: a capability that does not
     * exist yet, or a measurement nobody has taken. Required when
     * `applied` is false.
     */
    blockedBy?: string;
    /** Where an unapplied one is recorded, so it outlives the pull request. */
    filedIn?: string;
}

export interface SimplifyRecord {
    /** The review angles actually run. */
    angles: string[];
    findings: SimplifyFinding[];
}

/** What the reviewed body of work is, and its content hash. */
export interface SimplifyWork {
    base: string;
    /** True when there is nothing to review. */
    empty: boolean;
    hash: string;
}

function gitText(root: string, ...args: string[]): string {
    return execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 1024,
    });
}

/** The default branch this work is measured against. */
export function baseBranch(root: string): string {
    for (const candidate of ["origin/main", "main"]) {
        try {
            gitText(root, "rev-parse", "--verify", "--quiet", candidate);
            return candidate;
        } catch {
            // try the next
        }
    }
    throw new Error(
        "Neither origin/main nor main exists; cannot scope the review.",
    );
}

/**
 * Every committed change against the base, plus anything still in the
 * working tree.
 *
 * Hashing the diff TEXT rather than the commit means an amend, a rebase or
 * an uncommitted edit all invalidate a stale record, while a pure reordering
 * of commits does not. Untracked files are hashed as bytes — a golden
 * capture is a PNG, and decoding one to a string would let two different
 * images hash the same.
 */
export function workHash(root: string): SimplifyWork {
    const base = baseBranch(root);
    const hash = createHash("sha256");
    const reviewedPaths = [
        "--",
        ".",
        `:(exclude)${reviewDirectory}/**`,
    ];
    const committed = gitText(
        root,
        "diff",
        `${base}...HEAD`,
        ...reviewedPaths,
    );
    const working = gitText(
        root,
        "diff",
        "HEAD",
        ...reviewedPaths,
    );
    hash.update(committed).update(working);
    const untracked = gitText(
        root,
        "ls-files",
        "--others",
        "--exclude-standard",
    )
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        // A record written for this very hash must not change it.
        .filter((path) => !path.startsWith(`${reviewDirectory}/`));
    for (const path of untracked) {
        hash.update(path);
        try {
            hash.update(readFileSync(join(root, path)));
        } catch {
            // A path that cannot be read still counts as present.
        }
    }
    return {
        base,
        empty:
            committed.trim() === "" &&
            working.trim() === "" &&
            untracked.length === 0,
        hash: hash.digest("hex").slice(0, 32),
    };
}

export function recordPath(root: string, hash: string): string {
    return join(root, ...reviewDirectory.split("/"), `${hash}.json`);
}

/**
 * A record is evidence only if it says what was found and what happened to
 * each finding. "Ran it, nothing to do" is a real answer; a record with no
 * angles, or a finding with no disposition, is not.
 */
export function validateRecord(record: unknown): string[] {
    const problems: string[] = [];
    const entry = record as Partial<SimplifyRecord> | null;
    const angles = entry?.angles;
    if (!Array.isArray(angles) || angles.length < 3) {
        problems.push(
            "`angles` must list at least three review angles actually run " +
                "(reuse, simplification, efficiency, altitude).",
        );
    }
    const findings = entry?.findings;
    if (!Array.isArray(findings)) {
        problems.push(
            "`findings` must be an array, empty if nothing was found.",
        );
        return problems;
    }
    for (const [index, finding] of findings.entries()) {
        const where = `findings[${index}]`;
        if (
            !finding ||
            typeof finding.summary !== "string" ||
            finding.summary.trim() === ""
        ) {
            problems.push(`${where}.summary is required.`);
        }
        if (finding?.applied !== true && finding?.applied !== false) {
            problems.push(`${where}.applied must be true or false.`);
            continue;
        }
        if (finding.applied) continue;
        const blockedBy = finding.blockedBy;
        if (typeof blockedBy !== "string" || blockedBy.trim().length < 12) {
            problems.push(
                `${where} was not applied, so \`blockedBy\` must say what ` +
                    "genuinely blocks it -- a capability that does not exist " +
                    "yet, or a measurement nobody has taken. \"Outside the " +
                    "scope of this change\" is not a blocker.",
            );
        }
        if (
            typeof finding.filedIn !== "string" ||
            finding.filedIn.trim() === ""
        ) {
            problems.push(
                `${where} was not applied, so \`filedIn\` must name where it ` +
                    "is recorded -- a pull-request body disappears on merge, " +
                    "so this is TODO.md or a docs page.",
            );
        }
    }
    return problems;
}

/** What the gate found, as lines to print, and whether it passed. */
export function verifySimplify(root: string): {
    ok: boolean;
    lines: string[];
} {
    const work = workHash(root);
    const path = recordPath(root, work.hash);
    if (work.empty) {
        return {
            ok: true,
            lines: [
                `simplify gate: nothing to review (no diff against ${work.base}).`,
            ],
        };
    }
    if (!existsSync(path)) {
        return {
            ok: false,
            lines: [
                "simplify gate: FAILED -- no review record for this body of work.",
                "",
                `  work against ${work.base}, content hash ${work.hash}`,
                `  expected     ${posix.join(reviewDirectory, `${work.hash}.json`)}`,
                "",
                "Gate 3 runs `/simplify` over the complete body of work BEFORE",
                "the validation sweep, on every branch that becomes a pull",
                "request, whatever its size.",
                "",
                "Run the skill, apply what it finds, then record it:",
                "  npm run simplify:record",
                "",
                "The record is keyed by the diff's content, so re-running this",
                "after applying the findings is expected -- the final record is",
                "the one that counts.",
            ],
        };
    }
    let record: unknown;
    try {
        record = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        return {
            ok: false,
            lines: [
                `simplify gate: FAILED -- ${path} is not readable JSON: ${String(error)}`,
            ],
        };
    }
    const problems = validateRecord(record);
    if (problems.length > 0) {
        return {
            ok: false,
            lines: [
                `simplify gate: FAILED -- ${path} is not usable evidence:`,
                "",
                ...problems.map((problem) => `  - ${problem}`),
            ],
        };
    }
    const entry = record as SimplifyRecord;
    const skipped = entry.findings.filter((finding) => !finding.applied);
    return {
        ok: true,
        lines: [
            `simplify gate: ok -- ${entry.angles.length} angle(s), ` +
                `${entry.findings.length} finding(s), ` +
                `${entry.findings.length - skipped.length} applied` +
                (skipped.length > 0
                    ? `, ${skipped.length} filed with a stated blocker`
                    : ""),
        ],
    };
}

function main(): void {
    const root = join(dirname(new URL(import.meta.url).pathname.slice(1)), "..", "..");
    if (process.argv.includes("--path")) {
        const path = recordPath(root, workHash(root).hash);
        mkdirSync(dirname(path), { recursive: true });
        process.stdout.write(`${path}\n`);
        return;
    }
    const { ok, lines } = verifySimplify(root);
    for (const line of lines) {
        if (ok) console.log(line);
        else console.error(line);
    }
    if (!ok) process.exitCode = 1;
}

if (
    process.argv[1] &&
    import.meta.url ===
        new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href
) {
    main();
}
