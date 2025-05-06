import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Define our RCSB PDB MCP agent
export class RcsbPdbMCP extends McpAgent {
	server = new McpServer({
		name: "RcsbPdbExplorer",
		version: "0.1.0",
		description:
			`MCP Server for querying the RCSB Protein Data Bank (PDB) GraphQL API.

Before running any specific data queries, it is **strongly recommended** to use GraphQL introspection queries to explore and understand the schema of the RCSB PDB API. Introspection allows you to:

- **Discover all available types, fields, and relationships** in the API, ensuring you know exactly what data you can access and how to structure your queries.
- **Avoid common errors** due to typos or incorrect field names, as you can verify the schema directly before querying.
- **Stay resilient to schema changes**: The RCSB PDB API may evolve, and introspection lets you dynamically adapt to new or deprecated fields.
- **Craft more efficient and precise queries** by understanding which fields are available and how they are nested, reducing unnecessary trial and error.
- **Accelerate development and debugging**: Introspection provides a live, up-to-date contract for the API, making it easier to troubleshoot and optimize your queries.

**Example introspection query:**
\`\`\`
{
  __schema {
    queryType { name }
    types { name kind description fields { name type { name kind } } }
  }
}
\`\`\`
Use introspection to map out the schema, then construct targeted queries for entries, polymer entities, assemblies, chemical components, and more.

Refer to the RCSB PDB Data API documentation and the GraphiQL tool (available at the API endpoint) for further schema exploration and query examples. If a query fails, always consider using introspection to verify field names and types before retrying.`,

		// MCP Spec: "servers that emit log message notifications MUST declare the `logging` capability"
		// By default, McpServer might enable logging capability. If explicit:
		capabilities: {
			tools: {}, // Indicates tool support
			// logging: {}, // Enable if server sends log notifications via MCP
		}
	});

	// RCSB PDB API Configuration
	private readonly RCSB_PDB_GRAPHQL_ENDPOINT = "https://data.rcsb.org/graphql";

	async init() {
		console.error("RCSB PDB MCP Server initialized.");

		// Register the GraphQL execution tool
		this.server.tool(
			"rcsb_pdb_graphql_query",
			`Executes a GraphQL query against the RCSB PDB Data API (https://data.rcsb.org/graphql).

**Tip:** For best results, start by using GraphQL introspection queries to explore the schema before running other queries. Introspection helps you discover all available types, fields, and relationships, prevents errors, and ensures your queries are accurate and up-to-date.

**Why use introspection?**
- See exactly what data is available and how to access it.
- Avoid errors from incorrect field names or outdated assumptions.
- Adapt quickly to schema changes.
- Write more efficient, targeted queries.

**Example introspection query:**
\`\`\`
{ __schema { types { name kind fields { name } } } }
\`\`\`

After exploring the schema, you can query for specific entries, polymer entities, assemblies, chemical components, etc.

**Example data queries:**
- Experimental method for PDB entry 4HHB:
  \`{ entry(entry_id:"4HHB") { exptl { method } } }\`
- Details for multiple entries:
  \`{ entries(entry_ids: ["4HHB", "12CA"]) { rcsb_id struct { title } } }\`
- Taxonomy for polymer entities (e.g., 4HHB_1 where 1 is entity_id):
  \`{ polymer_entity(entry_id: "4HHB", entity_id:"1") { rcsb_entity_source_organism { ncbi_scientific_name } } }\`

Refer to the RCSB PDB Data API documentation and GraphiQL tool (at the API endpoint) for more examples and schema details. If a query fails, use introspection to verify field names and types.`,
			{
				query: z.string().describe(
					`The GraphQL query string to execute against the RCSB PDB GraphQL API.

**Pro tip:** Use introspection queries like '{ __schema { types { name kind fields { name } } } }' to discover the schema before running other queries. This helps you avoid errors and ensures your queries are valid.

Example data query: '{ entry(entry_id:"4HHB") { struct { title } exptl { method } } }'.`
				),
				variables: z
					.record(z.any())
					.optional()
					.describe(
						"Optional dictionary of variables for the GraphQL query. Example: { \"id\": \"4HHB\" }"
					),
			},
			async ({ query, variables }: { query: string; variables?: Record<string, any> }) => {
				console.error(`Executing rcsb_pdb_graphql_query with query: ${query.slice(0, 150)}...`);
				if (variables) {
					console.error(`With variables: ${JSON.stringify(variables).slice(0, 100)}...`);
				}

				const result = await this.executeRcsbPdbGraphQLQuery(query, variables);

				return {
					content: [
						{
							type: "text",
							// Pretty print JSON for easier reading by humans, and parsable by LLMs.
							text: JSON.stringify(result, null, 2),
						},
					],
				};
			}
		);
	}

	// Helper function to execute RCSB PDB GraphQL queries
	private async executeRcsbPdbGraphQLQuery(
		query: string,
		variables?: Record<string, any>
	): Promise<any> {
		try {
			const headers = {
				"Content-Type": "application/json",
				"Accept": "application/json", // Ensure we ask for JSON
				"User-Agent": "RcsbPdbMCP/0.1.0 (ModelContextProtocol; +https://modelcontextprotocol.io)",
			};

			const bodyData: Record<string, any> = { query };
			if (variables && Object.keys(variables).length > 0) {
				bodyData.variables = variables;
			}

			console.error(`Making GraphQL request to: ${this.RCSB_PDB_GRAPHQL_ENDPOINT}`);
			// console.error(`Request body: ${JSON.stringify(bodyData)}`); // Can be very verbose

			const response = await fetch(this.RCSB_PDB_GRAPHQL_ENDPOINT, {
				method: "POST",
				headers,
				body: JSON.stringify(bodyData),
			});

			console.error(`RCSB PDB API response status: ${response.status}`);

			// RCSB PDB GraphQL API always returns 200 OK, with errors in the JSON body.
			if (!response.ok) {
				// This case might not be hit often if API strictly follows "always 200 OK"
				let errorText = `RCSB PDB API HTTP Error ${response.status}`;
				try {
					const errorBody = await response.text();
					errorText += `: ${errorBody.slice(0, 500)}`;
				} catch (e) {
					// ignore if can't read body
				}
				console.error(errorText);
				return {
					errors: [
						{
							message: `RCSB PDB API HTTP Error ${response.status}`,
							extensions: {
								statusCode: response.status,
								responseText: errorText, 
							},
						},
					],
				};
			}

			// Try to parse JSON.
			let responseBody: any;
			try {
				responseBody = await response.json();
			} catch (e) {
				const errorText = await response.text(); // Get text if JSON parsing fails
				console.error(
					`RCSB PDB API response is not JSON. Status: ${response.status}, Body: ${errorText.slice(0,500)}`
				);
				return {
					errors: [
						{
							message: `RCSB PDB API Error: Non-JSON response.`,
							extensions: {
								statusCode: response.status,
								responseText: errorText.slice(0, 1000),
							},
						},
					],
				};
			}
			
			// The responseBody contains the GraphQL result, which might include `data` and/or `errors` fields.
			// Log if there are GraphQL-specific errors in the response body
			if (responseBody.errors) {
				console.error(`RCSB PDB API GraphQL errors: ${JSON.stringify(responseBody.errors).slice(0, 500)}`);
			}
			return responseBody;

		} catch (error) {
			// This catch block handles network errors or other issues with the fetch call itself
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error(
				`Client-side error during RCSB PDB GraphQL request: ${errorMessage}`
			);
			return {
				errors: [
					{
						message: `Client-side error: ${errorMessage}`,
					},
				],
			};
		}
	}
}

// Define the Env interface for environment variables, if any.
// For this server, no specific environment variables are strictly needed for RCSB PDB API access.
interface Env {
	MCP_HOST?: string;
	MCP_PORT?: string;
}

// Dummy ExecutionContext for type compatibility, usually provided by the runtime environment.
interface ExecutionContext {
	waitUntil(promise: Promise<any>): void;
	passThroughOnException(): void;
}

// Export the fetch handler, standard for environments like Cloudflare Workers or Deno Deploy.
export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
		const url = new URL(request.url);

		// SSE transport is primary as requested
		if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
			// The `RcsbPdbMCP.serveSSE` static method (inherited or implemented in McpAgentBase)
			// is expected to return an object with a `fetch` method.
			// @ts-ignore
			return RcsbPdbMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		// Fallback for unhandled paths
		console.error(
			`RCSB PDB MCP Server. Requested path ${url.pathname} not found. Listening for SSE on /sse.`
		);

		return new Response(
			`RCSB PDB MCP Server - Path not found.\nAvailable MCP paths:\n- /sse (for Server-Sent Events transport)`,
			{
				status: 404,
				headers: { "Content-Type": "text/plain" },
			}
		);
	},
};

// Export the Agent class if it needs to be used by other modules or for testing.
export { RcsbPdbMCP as MyMCP };
