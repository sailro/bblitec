import { createServer, type Server } from "node:http";

/** A server answering every request with one HTML document. */
export function htmlPageServer(html: string): Server {
    return createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(html);
    });
}
