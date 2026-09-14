/** Neutral Window startup checks, also exercised with replay on both renderers. */
export async function checkImageReadiness(): Promise<void> {
    const empty = document.createElement("img");
    if (!empty.decode || !empty.complete || empty.naturalWidth !== 0 || empty.naturalHeight !== 0)
        throw new Error("empty image readiness");
    let rejected = false;
    await empty.decode().catch(() => { rejected = true; });
    if (!rejected) throw new Error("empty decode must reject");
    await empty.decode().catch(() => undefined);
    const image = document.createElement("img");
    image.setAttribute("src", "pixel.png");
    if (image.complete || image.naturalWidth !== 0) throw new Error("pending image readiness");
    await image.decode();
    if (!image.complete || Number(image.naturalWidth) !== 1 || image.naturalHeight !== 1)
        throw new Error("decoded image dimensions");
    await image.decode();
    const pending = image.decode();
    image.removeAttribute("src");
    let changed = false;
    await pending.catch(() => { changed = true; });
    if (!changed || !image.complete || image.naturalWidth !== 0) throw new Error("invalidated image request");
    image.setAttribute("src", "broken.png");
    let broken = false;
    await image.decode().catch(() => { broken = true; });
    if (!broken || !image.complete || image.naturalWidth !== 0) throw new Error("broken image readiness");
    image.setAttribute("src", "pixel.png");
    await image.decode();
    if (image.naturalHeight !== 1) throw new Error("image recovery");
    document.body.appendChild(image);
}
