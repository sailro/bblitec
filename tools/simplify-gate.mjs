#!/usr/bin/env node
// The `/simplify` gate, as a command that exits non-zero.
//
// Gate 3 says the skill runs over the complete body of work before the
// validation sweep, on every branch that becomes a pull request. Stated as
// prose it was skipped twice, both times by judging a change too small — so
// it is stated here instead, in the one form this repository has found to
// hold: a check that fails and names what is missing.
//
// The record is keyed by the CONTENT of the work, not by the branch or the
// commit, for the same reason `parity` refuses a stale binary: a review of
// different bytes is not a review of these ones. Change a line after running
// the skill and the gate fails again.
//
//   node tools/simplify-gate.mjs            # verify, exit non-zero if absent
//   node tools/simplify-gate.mjs --path     # print the record path to write
//
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** The default branch this work is measured against. */
function baseBranch() {
    for (const candidate of ["origin/main", "main"]) {
        try {
            git("rev-parse", "--verify", "--quiet", candidate);
            return candidate;
        } catch {
            // try the next
        }
    }
    throw new Error("Neither origin/main nor main exists; cannot scope the review.");
}

/**
 * What the reviewed body of work IS: every committed change against the base,
 * plus anything still in the working tree. Hashing the diff text rather than
 * the commit means an amend, a rebase or an uncommitted edit all invalidate a
 * stale record, and a pure reordering of commits does not.
 */
export function workHash() {
    const base = baseBranch();
    const committed = git("diff", `${base}...HEAD`);
    const working = git("diff", "HEAD");
    const untracked = git("ls-files", "--others", "--exclude-standard")
        .split("\n")
        .filter((line) => line.trim())
        .map((path) => {
            try {
                return `${path}\n${readFileSync(join(root, path))}`;
            } catch {
                return path;
            }
        })
        .join("\n");
    return {
        base,
        empty: committed.trim() === "" && working.trim() === "" && untracked === "",
        hash: createHash("sha256")
            .update(committed)
            .update(working)
            .update(untracked)
            .digest("hex")
            .slice(0, 32),
    };
}

export function recordPath(hash) {
    return join(root, "artifacts", "simplify", `${hash}.json`);
}

/**
 * A record is only evidence if it says what was found and what happened to
 * each finding. "Ran it, nothing to do" is a real answer; a record with no
 * angles or a finding with no disposition is not.
 */
function validate(record) {
    const problems = [];
    const angles = record.angles;
    if (!Array.isArray(angles) || angles.length < 3) {
        problems.push(
            "`angles` must list at least three review angles actually run " +
                "(reuse, simplification, efficiency, altitude).",
        );
    }
    if (!Array.isArray(record.findings)) {
        problems.push("`findings` must be an array, empty if nothing was found.");
    } else {
        for (const [index, finding] of record.findings.entries()) {
            const where = `findings[${index}]`;
            if (!finding || typeof finding.summary !== "string" || !finding.summary.trim()) {
                problems.push(`${where}.summary is required.`);
            }
            const applied = finding.applied;
            if (applied !== true && applied !== false) {
                problems.push(`${where}.applied must be true or false.`);
            }
            if (applied === false) {
                const reason = finding.blockedBy;
                if (typeof reason !== "string" || reason.trim().length < 12) {
                    problems.push(
                        `${where} was not applied, so \`blockedBy\` must say what ` +
                            "genuinely blocks it — a capability that does not exist " +
                            "yet, or a measurement nobody has taken. \"Outside the " +
                            "scope of this change\" is not a blocker.",
                    );
                }
                if (typeof finding.filedIn !== "string" || !finding.filedIn.trim()) {
                    problems.push(
                        `${where} was not applied, so \`filedIn\` must name where it ` +
                            "is recorded — a PR body disappears on merge, so this is " +
                            "TODO.md or a docs page.",
                    );
                }
            }
        }
    }
    return problems;
}

const work = workHash();
const path = recordPath(work.hash);

if (process.argv.includes("--path")) {
    mkdirSync(dirname(path), { recursive: true });
    process.stdout.write(`${path}\n`);
    process.exit(0);
}

if (work.empty) {
    console.log("simplify gate: nothing to review (no diff against " + work.base + ").");
    process.exit(0);
}

if (!existsSync(path)) {
    console.error(
        [
            "simplify gate: FAILED — no review record for this body of work.",
            "",
            `  work against ${work.base}, content hash ${work.hash}`,
            `  expected     ${path}`,
            "",
            "Gate 3 runs `/simplify` over the complete body of work BEFORE the",
            "validation sweep, on every branch that becomes a pull request,",
            "whatever its size. It has been skipped twice by judging a change too",
            "small; both times it had a real defect to find.",
            "",
            "Run the skill, apply what it finds, then record it:",
            `  node tools/simplify-gate.mjs --path`,
            "",
            "The record is keyed by the diff's content, so re-running it after",
            "applying the findings is expected — that final record is the one",
            "that counts.",
        ].join("\n"),
    );
    process.exit(1);
}

let record;
try {
    record = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
    console.error(`simplify gate: FAILED — ${path} is not readable JSON: ${error}`);
    process.exit(1);
}

const problems = validate(record);
if (problems.length > 0) {
    console.error(
        [`simplify gate: FAILED — ${path} is not usable evidence:`, "", ...problems.map((p) => `  - ${p}`)].join("\n"),
    );
    process.exit(1);
}

const skipped = record.findings.filter((finding) => finding.applied === false);
console.log(
    `simplify gate: ok — ${record.angles.length} angle(s), ` +
        `${record.findings.length} finding(s), ` +
        `${record.findings.length - skipped.length} applied` +
        (skipped.length > 0 ? `, ${skipped.length} filed with a stated blocker` : ""),
);
