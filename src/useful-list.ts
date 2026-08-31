// Best-effort "useful hit" recorder: when the assistant actually consumes a
// URL (fetch_content succeeds), we append the site's domain to a flat list so
// it can be batch-submitted to an independent index (e.g. mwmbl) later.
//
// The signal is consumption, not appearance in results -- a URL is only worth
// contributing to the commons if it was actually used. Submitting every result
// a query surfaced would be noise.
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Generic default: the list goes to ./useful-domains.txt in the agent's cwd
// unless USEFUL_LIST_PATH points elsewhere. Production sets USEFUL_LIST_PATH
// to a shared absolute path (see /pi/scripts/agent-setup.sh). Deliberately no
// hardcoded machine/user paths so the source stays portable.
const DEFAULT_PATH = "useful-domains.txt";

function listPath(): string {
  return resolve(process.env.USEFUL_LIST_PATH ?? DEFAULT_PATH);
}

// Strip scheme/path/query, drop a leading "www.", and skip non-web hosts so we
// store *domains*, which is the granularity an independent index crawls at.
function registeredDomain(rawUrl: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return null;
  }
  hostname = hostname.toLowerCase().replace(/^www\./, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ||
    hostname === "[::1]" ||
    hostname.endsWith(".local")
  ) {
    return null;
  }
  return hostname;
}

export function recordUseful(rawUrl: string): void {
  const domain = registeredDomain(rawUrl);
  if (!domain) return;

  try {
    const path = listPath();
    const existing = existsSync(path)
      ? readFileSync(path, "utf8").split("\n")
      : [];
    const seen = new Set(existing.map((l) => l.trim()).filter(Boolean));
    if (seen.has(domain)) return;
    appendFileSync(path, domain + "\n", "utf8");
  } catch {
    // Never let list maintenance break a fetch. Best-effort only.
  }
}
