/* Serves the built SPA (apps/web/dist) from the same origin as the API, so a
   deployment is one public service and the client's relative `/api` paths keep
   working with no configuration.

   Ported from the old repo's static.ts. `/api` and the socket paths are matched
   before this ever runs, so the only fallback needed is the app shell. */
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, extname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
}

/** Where `npm run build` puts the client, relative to this file. */
export function webDistDir(): string {
  if (process.env.ELAINE_WEB_DIST) return resolve(process.env.ELAINE_WEB_DIST)
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist")
}

export const hasWebDist = (distDir: string): boolean => existsSync(join(distDir, "index.html"))

export function serveWebFile(distDir: string, pathname: string): Response {
  let relative: string
  try {
    relative = decodeURIComponent(pathname).replace(/^\/+/, "")
  } catch {
    relative = ""
  }
  const root = resolve(distDir)
  let file = relative ? resolve(root, relative) : join(root, "index.html")
  /* Anything that escapes dist, does not exist, or is a directory falls back to
     the shell rather than leaking a path or a 404 the SPA could have handled. */
  if (!file.startsWith(root + sep) && file !== root) file = join(root, "index.html")
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html")

  const body = readFileSync(file)
  const type = MIME[extname(file)] ?? "application/octet-stream"
  /* Vite fingerprints everything under /assets, so those can be cached forever;
     index.html must revalidate or a deploy never reaches anyone. */
  const cache = file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache"
  return new Response(new Uint8Array(body), {
    headers: { "content-type": type, "cache-control": cache, "x-content-type-options": "nosniff" },
  })
}
