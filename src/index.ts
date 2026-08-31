// SPDX-License-Identifier: MIT
// Derived from pi-searxng (https://github.com/jcha0713/pi-searxng), MIT licensed.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { search, type SearchResult } from "./search.js";
import { fetchContent } from "./extract.js";
import { isGitHubUrl, cloneRepo } from "./github.js";
import { recordUseful } from "./useful-list.js";

const searchCache = new Map<
  string,
  { query: string; results: SearchResult[]; engines: string[] }
>();

function generateId(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  );
}

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";
  return results
    .map((r, i) => {
      const snippet = r.snippet.slice(0, 200);
      const ellipsis = r.snippet.length > 200 ? "..." : "";
      return `${i + 1}. **${r.title}**\n   ${r.url}\n   ${snippet}${ellipsis}`;
    })
    .join("\n\n");
}

function formatRepoFiles(files: { path: string }[]): string {
  return (
    files
      .slice(0, 30)
      .map((f) => `- ${f.path}`)
      .join("\n") +
    (files.length > 30 ? `\n... and ${files.length - 30} more files` : "")
  );
}

interface WebSearchParams {
  query: string;
  limit?: number;
  engines?: string[];
}

interface FetchContentParams {
  url: string;
}

interface GetSearchResultsParams {
  searchId: string;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using independent engines (mwmbl, Mojeek, marginalia), with a SearXNG meta-engine as final fallback. Pass engines (e.g. [\"mwmbl\",\"searxng\"]) to query exactly those engines and merge their results -- useful when default results are thin or stale",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(
        Type.Number({ description: "Max results", default: 10 }),
      ),
      engines: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Query exactly these engines (any of: mwmbl, mojeek, marginalia, searxng) and merge their results instead of running the fallback chain. Default: fallback chain (mwmbl, then mojeek, then marginalia, then searxng)",
        }),
      ),
    }),

    async execute(_id, params, signal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Aborted" }] };
      }

      try {
        const limit = params.limit ?? 10;
        const { results, engines } = await search(params.query, {
          limit,
          signal,
          engines: params.engines,
        });
        const searchId = generateId();
        searchCache.set(searchId, {
          query: params.query,
          results,
          engines,
        });

        return {
          content: [
            { type: "text", text: formatSearchResults(results) },
          ],
          details: {
            searchId,
            resultCount: results.length,
            query: params.query,
            engines,
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: { error: String(err) },
        };
      }
    },

    renderCall(args, theme, _context) {
      const q = (args as WebSearchParams).query || "";
      const display = q.length > 50 ? q.slice(0, 47) + "..." : q;
      return new Text(
        theme.fg("toolTitle", "search ") + theme.fg("accent", `"${display}"`),
        0,
        0,
      );
    },

    renderResult(result, _opts, theme, _context) {
      const count = (result.details as any)?.resultCount || 0;
      return new Text(theme.fg("success", `${count} results`), 0, 0);
    },
  });

  pi.registerTool({
    name: "fetch_content",
    label: "Fetch Content",
    description: "Fetch URL content. Automatically clones GitHub repos.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
    }),

    async execute(_id, params, signal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Aborted" }] };
      }

      if (isGitHubUrl(params.url)) {
        const repo = await cloneRepo(params.url);

        if (!repo) {
          return {
            content: [{ type: "text", text: "Failed to clone repository" }],
            details: { error: "Clone failed" },
          };
        }

        const output =
          `## Repository Cloned\n\n**Path:** \`${repo.localPath}\`\n\n` +
          `**Files (${repo.files.length}):**\n${formatRepoFiles(repo.files)}` +
          `\n\n---\n\nUse \`read\` tool to explore files.`;

        return {
          content: [{ type: "text", text: output }],
          details: {
            localPath: repo.localPath,
            fileCount: repo.files.length,
            files: repo.files.slice(0, 10).map((f) => f.path),
          },
        };
      }

      const result = await fetchContent(params.url, signal);

      if (result.error) {
        return {
          content: [{ type: "text", text: `Error: ${result.error}` }],
          details: { error: result.error },
        };
      }

      // A successfully fetched URL is a hit that was actually used: record its
      // domain for later batch submission to an independent index.
      recordUseful(params.url);

      const truncated = result.content.length > 30000;
      const content = truncated
        ? result.content.slice(0, 30000) + "\n\n[Content truncated...]"
        : result.content;

      return {
        content: [{ type: "text", text: content }],
        details: {
          title: result.title,
          url: result.url,
          truncated,
          length: result.content.length,
        },
      };
    },

    renderCall(args, theme, _context) {
      const url = (args as FetchContentParams).url || "";
      const isGH = isGitHubUrl(url);
      const display = url.length > 50 ? url.slice(0, 47) + "..." : url;
      const prefix = isGH ? "clone " : "fetch ";
      const color = isGH ? "warning" : "accent";
      return new Text(theme.fg("toolTitle", prefix) + theme.fg(color, display), 0, 0);
    },

    renderResult(result, _opts, theme, _context) {
      const details = result.details as any;
      if (details?.localPath) {
        return new Text(
          theme.fg("success", "cloned") +
            theme.fg("muted", ` ${details.fileCount} files`),
          0,
          0,
        );
      }
      const length = details?.length || 0;
      return new Text(
        theme.fg("success", `${length} chars`) +
          (details?.truncated
            ? theme.fg("warning", " [truncated]")
            : ""),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "get_search_results",
    label: "Get Search Results",
    description: "Retrieve previous search results by ID",
    parameters: Type.Object({
      searchId: Type.String(),
    }),

    async execute(_id, params) {
      const cached = searchCache.get((params as GetSearchResultsParams).searchId);
      if (!cached) {
        return { content: [{ type: "text", text: "Search not found." }] };
      }
      return {
        content: [
          {
            type: "text",
            text: `Query: "${cached.query}"\n${cached.engines.length ? `Engines: ${cached.engines.join(", ")}\n\n` : "\n"}${formatSearchResults(cached.results)}`,
          },
        ],
      };
    },
  });
}
