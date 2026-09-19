#!/usr/bin/env node
// A project-local acceptance ledger, not a percentage inferred from source size.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [ledgerPath, markdownPath] = process.argv.slice(2);
if (!ledgerPath || process.argv.length > 4) {
    throw new Error(
        "Usage: node tools/project-progress.mjs <ledger.json> [report.md]",
    );
}
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
const root = dirname(resolve(ledgerPath));
const evidenceDigests = new Map();
function evidenceDigest(path) {
    const absolute = resolve(root, path);
    if (!evidenceDigests.has(absolute))
        evidenceDigests.set(
            absolute,
            createHash("sha256").update(readFileSync(absolute)).digest("hex"),
        );
    return evidenceDigests.get(absolute);
}
const fail = (message) => {
    throw new Error(`Invalid progress ledger: ${message}`);
};
if (
    ledger.schemaVersion !== 1 ||
    !Array.isArray(ledger.packages) ||
    !ledger.packages.length
)
    fail("expected nonempty version 1 packages");
if (typeof ledger.baseline !== "string" || !ledger.baseline.trim())
    fail("baseline name is required");
const packages = new Map();
for (const item of ledger.packages) {
    if (!item.id || packages.has(item.id))
        fail(`duplicate/missing package id ${item.id}`);
    if (!["open", "complete"].includes(item.status))
        fail(`${item.id}: invalid status`);
    if (
        !Array.isArray(item.acceptance) ||
        !item.acceptance.length ||
        item.acceptance.some(
            (check) => typeof check.text !== "string" || !check.text.trim(),
        )
    )
        fail(`${item.id}: no acceptance criteria`);
    if (item.status === "complete") {
        if (item.blockers?.length)
            fail(`${item.id}: completed with open blockers`);
        for (const check of item.acceptance) {
            if (check.status !== "passed" || !check.evidence?.length)
                fail(`${item.id}: completion lacks passing evidence`);
            for (const evidence of check.evidence) {
                const digest = evidenceDigest(evidence.path);
                if (digest !== evidence.sha256)
                    fail(`${item.id}: evidence changed: ${evidence.path}`);
            }
        }
    }
    packages.set(item.id, item);
}
if (!ledger.baselinePackageIds?.length || !ledger.integrationGateIds?.length)
    fail("baseline and integration gates are required");
if (
    new Set(ledger.baselinePackageIds).size !== ledger.baselinePackageIds.length
)
    fail("duplicate baseline ids");
for (const gate of ["generate", "build", "run", "validate"]) {
    if (
        !ledger.endToEnd?.[gate] ||
        !ledger.integrationGateIds.includes(ledger.endToEnd[gate])
    )
        fail(`missing ${gate} integration gate`);
}
if (
    new Set(
        ["generate", "build", "run", "validate"].map(
            (gate) => ledger.endToEnd[gate],
        ),
    ).size !== 4
)
    fail("integration stages require distinct gates");
for (const id of [...ledger.baselinePackageIds, ...ledger.integrationGateIds]) {
    if (!packages.has(id)) fail(`baseline package/gate removed: ${id}`);
}
const additions = new Set(
    (ledger.scopeChanges ?? []).flatMap((change) => {
        if (
            !change.reason ||
            !change.date ||
            !Array.isArray(change.addedPackageIds)
        )
            fail("scope additions require a dated reason");
        return change.addedPackageIds;
    }),
);
for (const item of packages.values()) {
    if (!ledger.baselinePackageIds.includes(item.id) && !additions.has(item.id))
        fail(`undocumented scope addition: ${item.id}`);
    for (const id of item.dependencies ?? []) {
        if (!packages.has(id)) fail(`${item.id}: missing dependency ${id}`);
        if (
            item.status === "complete" &&
            packages.get(id).status !== "complete"
        )
            fail(`${item.id}: dependency ${id} remains open`);
    }
}
if (ledger.inventory) {
    const bytes = readFileSync(resolve(root, ledger.inventory.path));
    if (
        createHash("sha256").update(bytes).digest("hex") !==
        ledger.inventory.sha256
    )
        fail("requirements inventory changed");
    const requirements = JSON.parse(bytes).requirements;
    const owners = new Set();
    for (const item of packages.values())
        for (const id of item.requirementIds ?? []) {
            if (owners.has(id)) fail(`requirement assigned twice: ${id}`);
            owners.add(id);
        }
    if (
        requirements.length !== owners.size ||
        requirements.some((row) => !owners.has(row.id))
    )
        fail("requirements inventory is not fully assigned");
}
const visiting = new Set(),
    visited = new Set();
function visit(id) {
    if (visiting.has(id)) fail(`dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of packages.get(id).dependencies ?? [])
        visit(dependency);
    visiting.delete(id);
    visited.add(id);
}
for (const id of packages.keys()) visit(id);
const complete = ledger.packages.filter(
    (item) => item.status === "complete",
).length;
const total = ledger.packages.length;
const summary = {
    baseline: ledger.baseline,
    metric: "Verified integration acceptance: completed groups / all baselined groups",
    percent: Math.floor((complete / total) * 1000) / 10,
    complete,
    total,
    remaining: total - complete,
    integrationGates: ledger.integrationGateIds.map((id) => ({
        id,
        status: packages.get(id).status,
    })),
};
console.log(JSON.stringify(summary, null, 2));
if (markdownPath) {
    const safe = (value) =>
        String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
    writeFileSync(
        markdownPath,
        `# Integration acceptance progress\n\n` +
            `**${summary.percent}% — ${complete}/${total} acceptance groups complete; ${total - complete} remain.**\n\n` +
            `Baseline: ${ledger.baseline}. Equal credit per closed acceptance group; partial work earns no group credit. ` +
            `This is a coarse delivery measure, not an effort or remaining-time estimate. ` +
            `100% requires every group, including complete unchanged generation, both native builds, launch and validation. ` +
            `Scope changes need a dated reason; splitting implementation tasks does not earn credit.\n\n` +
            `| Package | Status | Required result |\n| --- | --- | --- |\n` +
            ledger.packages
                .map(
                    (item) =>
                        `| ${item.id} ${safe(item.title)} | ${item.status} | ${safe(item.acceptance.map((check) => check.text).join("; "))} |`,
                )
                .join("\n") +
            "\n",
    );
}
