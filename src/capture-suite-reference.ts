import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import ts from "typescript";
import { chromium } from "playwright-core";

function browserCandidates(): string[] {
    if (process.platform === "win32") {
        return [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ];
    }
    if (process.platform === "darwin") {
        return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
    }
    return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];
}

function resolveBrowserPath(): string {
    const candidates = [process.env.CHROME_PATH, ...browserCandidates()]
        .filter((value): value is string => !!value);
    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) throw new Error("No Chromium browser found. Set CHROME_PATH.");
    return found;
}

function mimeType(path: string): string {
    switch (extname(path).toLowerCase()) {
        case ".html":
            return "text/html; charset=utf-8";
        case ".js":
            return "text/javascript; charset=utf-8";
        default:
            return "application/octet-stream";
    }
}

function browserModule(sourcePath: string): string {
    const source = readFileSync(resolve(sourcePath), "utf8")
        .replaceAll('"@babylonjs/lite"', '"/node_modules/@babylonjs/lite/lib/index.js"')
        .replaceAll('"babylon-lite"', '"/node_modules/@babylonjs/lite/lib/index.js"')
        .replaceAll(
            '"/brdf-lut.png"',
            '"https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/master/packages/babylon-lite/assets/brdf-lut.png"',
        );
    const readySource = source.includes("dataset.ready")
        ? source
        : source.replace(
              "await startEngine(engine);",
              'await startEngine(engine); canvas.dataset.ready = "true";',
          );
    return ts.transpileModule(readySource, {
        compilerOptions: {
            module: ts.ModuleKind.ES2022,
            target: ts.ScriptTarget.ES2022,
        },
        fileName: sourcePath,
    }).outputText;
}

export async function captureSuiteReference(
    sourcePath: string,
    referencePath: string,
    force: boolean,
): Promise<void> {
    if (existsSync(referencePath) && !force) return;
    const root = resolve(".");
    const moduleSource = browserModule(sourcePath);
    const html = `<!doctype html><html><head><style>
html,body,canvas{margin:0;width:1280px;height:720px;overflow:hidden;display:block}
</style></head><body><canvas id="renderCanvas" width="1280" height="720"></canvas>
<script type="module" src="/scene.js"></script></body></html>`;
    const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/scene.html") {
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(html);
            return;
        }
        if (url.pathname === "/scene.js") {
            response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
            response.end(moduleSource);
            return;
        }
        const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
        const path = resolve(root, relative);
        if (!path.startsWith(`${root}${sep}`) || !existsSync(path) || !statSync(path).isFile()) {
            response.writeHead(404);
            response.end("Not found");
            return;
        }
        response.writeHead(200, { "Content-Type": mimeType(path) });
        response.end(readFileSync(path));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to start parity server.");
    const browser = await chromium.launch({
        executablePath: resolveBrowserPath(),
        headless: true,
        args: ["--force-color-profile=srgb", "--enable-unsafe-webgpu"],
    });
    try {
        const page = await browser.newPage({
            viewport: { width: 1280, height: 720 },
            deviceScaleFactor: 1,
        });
        await page.goto(`http://127.0.0.1:${address.port}/scene.html`, {
            waitUntil: "domcontentloaded",
            timeout: 120_000,
        });
        await page.waitForFunction(
            () => document.getElementById("renderCanvas")?.dataset.ready === "true",
            undefined,
            { timeout: 120_000 },
        );
        await page.waitForTimeout(500);
        mkdirSync(resolve(referencePath, ".."), { recursive: true });
        await page.locator("#renderCanvas").screenshot({ path: referencePath });
    } finally {
        await browser.close();
        await new Promise<void>((done) => server.close(() => done()));
    }
}
