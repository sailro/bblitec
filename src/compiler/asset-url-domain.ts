import { readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type ts from "typescript";
import { resolveBundledAsset } from "./assets.js";
import { deploymentUrl } from "./deployment.js";
import type { LoweringServices } from "./lowering-services.js";
import { stringDomain, type StringDomainContext } from "./string-domain.js";

type Context = StringDomainContext & Pick<LoweringServices, "options">;

/**
 * Fetch-local discovery follows the selected value's closed string domain
 * (`stringDomain`). Unknown filename fragments can select only existing files
 * matching an authored pattern in one fixed, non-root local directory. This is
 * a package inventory, not a constant value: the original expression still
 * runs and the response lookup rejects every key outside that inventory.
 */
export function assetUrlDomain(
    context: Context,
    expression: ts.Expression,
    unpackaged: (url: string) => boolean = () => false,
): readonly string[] | undefined {
    const domain = stringDomain(context, expression, {
        label: "Packaged URL",
        fragments: (parts) => packagedFiles(context, expression, parts),
    })?.filter((url) => !unpackaged(url));
    const base = deploymentUrl(context.options);
    const safe = domain?.every((source) => {
        if (/%2f|%5c|\\/i.test(source)) return false;
        const path = source.split(/[?#]/, 1)[0]!;
        let decoded: string;
        try {
            decoded = decodeURIComponent(path);
        } catch {
            return false;
        }
        if (decoded.split("/").some((part) => part === "." || part === ".."))
            return false;
        let url: URL;
        try {
            url = new URL(source, base);
        } catch {
            return false;
        }
        return (
            url.origin === base.origin &&
            !url.username &&
            !url.password &&
            !url.pathname.endsWith("/")
        );
    });
    if (domain && !safe)
        context.fail(
            expression,
            "Packaged URL provenance requires local URLs without traversal or encoded separators.",
        );
    return domain;
}

/** The packaged files a URL with unknown fragments (undefined parts) can name. */
function packagedFiles(
    context: Context,
    site: ts.Node,
    parts: readonly (string | undefined)[],
): readonly string[] | undefined {
    const first = parts.indexOf(undefined);
    const prefix = parts.slice(0, first).join("");
    const slash = prefix.lastIndexOf("/");
    if (slash < 1 || prefix.includes("?") || prefix.includes("#"))
        return undefined;
    const logicalDirectory = prefix.slice(0, slash + 1);
    const base = deploymentUrl(context.options);
    const logicalUrl = new URL(logicalDirectory, base);
    if (
        logicalUrl.origin !== base.origin ||
        logicalUrl.pathname === base.pathname ||
        /%2f|%5c|\\/i.test(parts.filter((part) => part !== undefined).join(""))
    )
        return undefined;
    let decoded: string;
    try {
        decoded = decodeURIComponent(logicalDirectory);
    } catch {
        return undefined;
    }
    if (decoded.split("/").some((part) => part === "." || part === ".."))
        return undefined;
    let source: string;
    // Root-path arguments may be prefixed by the deployment base in a
    // helper. Discovery is provisional; final keys resolve through the
    // normal deployment resolver after the helper's transformations.
    const discovery =
        logicalDirectory.startsWith("/") && context.options.publicDir
            ? { ...context.options, siteUrl: base.origin + "/" }
            : context.options;
    try {
        source = resolveBundledAsset(
            logicalDirectory,
            context.options.fileName,
            discovery,
        );
    } catch {
        return undefined;
    }
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(source)) return undefined;
    const directory = resolve(
        dirname(resolve(context.options.fileName)),
        source,
    );
    // The authored directory must stay below its deployment or entry root.
    const root = resolve(
        context.options.publicDir ?? dirname(resolve(context.options.fileName)),
    );
    const path = relative(root, directory);
    if (
        !path ||
        isAbsolute(path) ||
        path === ".." ||
        path.startsWith("..\\") ||
        path.startsWith("../")
    )
        return undefined;
    const pattern = parts
        .map((part) =>
            part === undefined
                ? "[^/?#\\\\]*"
                : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("");
    const query =
        parts
            .slice(first + 1)
            .join("")
            .match(/[?#].*$/)?.[0] ?? "";
    // A dynamic query is not a finite packaged URL domain.
    let inQuery = false;
    for (const part of parts) {
        if (part === undefined && inQuery) return [];
        if (part !== undefined && /[?#]/.test(part)) inQuery = true;
    }
    const match = new RegExp(`^${pattern}$`);
    let files;
    try {
        files = readdirSync(directory, { withFileTypes: true });
    } catch {
        return undefined;
    }
    if (files.length > 4096)
        context.fail(
            site,
            "Packaged URL directory exceeds the discovery budget.",
        );
    // The domain's union bounds and deduplicates the candidates.
    return files
        .filter((file) => file.isFile())
        .flatMap((file) =>
            [
                logicalDirectory + file.name + query,
                logicalDirectory + encodeURIComponent(file.name) + query,
            ].filter((value) => match.test(value)),
        );
}
