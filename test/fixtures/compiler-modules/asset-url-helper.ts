export function moduleAssetUrl(path: string, moduleUrl: string): string {
    const url = new URL(path, moduleUrl);
    url.pathname = url.pathname.replace("/lite/bundle/demos/", "/bundle/demos/");
    return url.href;
}
