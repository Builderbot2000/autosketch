import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resourceRegistrar } from "../../../src/server/server.js";

async function serve(setup: (r: ReturnType<typeof resourceRegistrar>) => void) {
  const server = new McpServer({ name: "t", version: "0" });
  setup(resourceRegistrar(server));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe("resource registrar", () => {
  it("serves a fixed resource and a listed template", async () => {
    const docs: Record<string, string> = { gothic: "# Gothic", roofs: "# Roofs" };
    const client = await serve((resource) => {
      resource("readme", { title: "Readme", description: "fixed", uri: "autosketch://readme", mimeType: "text/plain" }, () => ({ text: "hello" }));
      resource(
        "knowledge",
        {
          title: "Knowledge",
          description: "packs",
          uri: "autosketch://knowledge/{name}",
          mimeType: "text/markdown",
          list: () => Object.keys(docs).map((n) => ({ uri: `autosketch://knowledge/${n}`, name: n })),
        },
        (_uri, vars) => {
          const t = docs[vars.name!];
          if (!t) throw new Error(`no pack ${vars.name}`);
          return { text: t };
        },
      );
    });

    const listed = (await client.listResources()).resources.map((r) => r.uri).sort();
    expect(listed).toEqual(["autosketch://knowledge/gothic", "autosketch://knowledge/roofs", "autosketch://readme"]);
    const templates = (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
    expect(templates).toEqual(["autosketch://knowledge/{name}"]);

    const fixed = await client.readResource({ uri: "autosketch://readme" });
    expect(fixed.contents).toEqual([{ uri: "autosketch://readme", text: "hello", mimeType: "text/plain" }]);
    const pack = await client.readResource({ uri: "autosketch://knowledge/roofs" });
    expect(pack.contents).toEqual([{ uri: "autosketch://knowledge/roofs", text: "# Roofs", mimeType: "text/markdown" }]);
    await expect(client.readResource({ uri: "autosketch://knowledge/nope" })).rejects.toThrow(/no pack nope/);
  });
});
