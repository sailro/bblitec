import { isAbsolute, relative, resolve, sep } from "node:path";

export interface DeploymentOptions {
    /** Local directory served at the deployment URL. */
    publicDir?: string;
    /**
     * Absolute HTTP(S) URL that serves the public directory's contents:
     * a root-relative asset no public directory holds loads from beneath it.
     */
    publicUrl?: string;
    /** Absolute HTTP(S) URL of the application's base directory. */
    siteUrl?: string;
    /** Explicit client-visible build strings; absent custom keys are undefined. */
    environment?: Readonly<Record<string, string>>;
}

export function deploymentEnvironment(
    options: DeploymentOptions,
): Readonly<Record<string, string>> {
    const entries = Object.entries(options.environment ?? {});
    for (const [name, value] of entries) {
        if (
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
            typeof value !== "string"
        ) {
            throw new Error(
                "Build environment entries require identifier names and string values.",
            );
        }
        if (["BASE_URL", "MODE", "PROD", "DEV", "SSR"].includes(name)) {
            throw new Error(
                `Build environment '${name}' is a built-in deployment constant.`,
            );
        }
    }
    return Object.freeze(Object.fromEntries(entries));
}

export function deploymentUrl(options: DeploymentOptions): URL {
    const url = new URL(options.siteUrl ?? "http://localhost/");
    if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    ) {
        throw new Error(
            "The deployment URL must be an HTTP(S) base URL without credentials, a query, or a fragment.",
        );
    }
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url;
}

/** The public URL as a directory URL; anything but a plain HTTP(S) URL refuses. */
export function deploymentPublicUrl(publicUrl: string): string {
    const url = URL.canParse(publicUrl) ? new URL(publicUrl) : undefined;
    if (
        !url ||
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    ) {
        throw new Error(
            "The public URL must be an absolute HTTP(S) URL without credentials, a query, or a fragment.",
        );
    }
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.href;
}

/**
 * A root-relative URL beneath the application's base, served from the public
 * URL: the path below the base is appended as written, so the served URL
 * names the same file the public directory would.
 */
export function deploymentPublicAsset(
    source: string,
    options: DeploymentOptions,
): string | undefined {
    if (!options.publicUrl || !source.startsWith("/")) return undefined;
    const base = deploymentUrl(options).pathname;
    return source.startsWith(base)
        ? deploymentPublicUrl(options.publicUrl) + source.slice(base.length)
        : undefined;
}

/** Map URLs beneath the application's base to its public files. */
export function deploymentAssetSource(
    source: string,
    options: DeploymentOptions,
): string | undefined {
    if (!options.publicDir || (isAbsolute(source) && !source.startsWith("/")))
        return undefined;
    const base = deploymentUrl(options);
    const url = new URL(source, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
        return undefined;
    const directory = resolve(options.publicDir);
    const target = resolve(
        directory,
        decodeURIComponent(url.pathname.slice(base.pathname.length)),
    );
    const path = relative(directory, target);
    if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
        throw new Error(
            "The asset URL escapes the configured public directory.",
        );
    }
    return target;
}
