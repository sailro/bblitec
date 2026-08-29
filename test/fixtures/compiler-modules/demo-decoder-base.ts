export async function configureDemoDecoderBases(moduleUrl: string): Promise<void> {
    const base = new URL("./", moduleUrl).href;
    const [{ setDracoBaseUrl }, { setMeshoptBaseUrl }] = await Promise.all([
        import("./decoder-a.js"),
        import("./decoder-b.js"),
    ]);
    setDracoBaseUrl(base);
    setMeshoptBaseUrl(base);
}
