import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { JsonToSqlDO } from "./do.js";
import { ProcessingResult } from "./lib/types.js";

// ========================================
// API CONFIGURATION - RCSB PDB Specific
// ========================================
const API_CONFIG = {
	name: "RcsbPdbExplorer",
	version: "0.1.0",
	description: `MCP Server for querying the RCSB Protein Data Bank (PDB) GraphQL API, processes responses into SQLite tables, and returns metadata for subsequent SQL querying.

Before running any specific data queries, it is **strongly recommended** to use GraphQL introspection queries to explore and understand the schema of the RCSB PDB API. Introspection allows you to:

- **Discover all available types, fields, and relationships** in the API, ensuring you know exactly what data you can access and how to structure your queries.
- **Avoid common errors** due to typos or incorrect field names, as you can verify the schema directly before querying.
- **Stay resilient to schema changes**: The RCSB PDB API may evolve, and introspection lets you dynamically adapt to new or deprecated fields.
- **Craft more efficient and precise queries** by understanding which fields are available and how they are nested, reducing unnecessary trial and error.
- **Accelerate development and debugging**: Introspection provides a live, up-to-date contract for the API, making it easier to troubleshoot and optimize your queries.

For large responses, the system automatically stages data into SQLite tables for advanced SQL analysis capabilities.`,
	
	// RCSB PDB GraphQL API settings
	endpoint: 'https://data.rcsb.org/graphql',
	headers: {
		"Accept": 'application/json',
		"User-Agent": "RcsbPdbMCP/0.1.0 (ModelContextProtocol; +https://modelcontextprotocol.io)"
	},
	
	// Tool names and descriptions
	tools: {
		graphql: {
			name: "rcsb_pdb_graphql_query",
			description: `Executes a GraphQL query against the RCSB PDB Data API (https://data.rcsb.org/graphql), processes responses into SQLite tables, and returns metadata for subsequent SQL querying.

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

Returns a data_access_id and schema information for use with the SQL querying tool.`
		},
		sql: {
			name: "rcsb_pdb_query_sql", 
			description: "Execute read-only SQL queries against staged RCSB PDB data. Use the data_access_id from rcsb_pdb_graphql_query to query the SQLite tables. Supports analytical queries, CTEs, temporary tables, and JSON functions for analyzing protein structure data."
		}
	}
};

// In-memory registry of staged datasets
const datasetRegistry = new Map<string, { created: string; table_count?: number; total_rows?: number }>();

// ========================================
// ENVIRONMENT INTERFACE
// ========================================
interface RcsbPdbEnv {
	MCP_HOST?: string;
	MCP_PORT?: string;
	MCP_OBJECT: DurableObjectNamespace;
	JSON_TO_SQL_DO: DurableObjectNamespace;
}

// ========================================
// CORE MCP SERVER CLASS - RCSB PDB Specific
// ========================================

export class RcsbPdbMCP extends McpAgent {
	server = new McpServer({
		name: API_CONFIG.name,
		version: API_CONFIG.version,
		description: API_CONFIG.description,
		capabilities: {
			tools: {}, // Indicates tool support
		}
	});

	async init() {
		console.error("RCSB PDB MCP Server initialized.");

		// Tool #1: GraphQL to SQLite staging
		this.server.tool(
			API_CONFIG.tools.graphql.name,
			API_CONFIG.tools.graphql.description,
			{
				query: z.string().describe(`The GraphQL query string to execute against the RCSB PDB GraphQL API.

**Pro tip:** Use introspection queries like '{ __schema { types { name kind fields { name } } } }' to discover the schema before running other queries. This helps you avoid errors and ensures your queries are valid.

Example data query: '{ entry(entry_id:"4HHB") { struct { title } exptl { method } } }'.`),
				variables: z.record(z.any()).optional().describe("Optional dictionary of variables for the GraphQL query. Example: { \"entry_id\": \"4HHB\" }"),
			},
                        async ({ query, variables }) => {
                                try {
                                        const graphqlResult = await this.executeRcsbPdbGraphQLQuery(query, variables);

                                        if (this.shouldBypassStaging(graphqlResult, query)) {
                                                return {
                                                        content: [{
                                                                type: "text" as const,
                                                                text: JSON.stringify(graphqlResult, null, 2)
                                                        }]
                                                };
                                        }

                                        const stagingResult = await this.stageDataInDurableObject(graphqlResult);
                                        return {
                                                content: [{
                                                        type: "text" as const,
                                                        text: JSON.stringify(stagingResult, null, 2)
                                                }]
                                        };

                                } catch (error) {
                                        return this.createErrorResponse("GraphQL execution failed", error);
                                }
                        }
                );

		// Tool #2: SQL querying against staged data
		this.server.tool(
			API_CONFIG.tools.sql.name,
			API_CONFIG.tools.sql.description,
			{
				data_access_id: z.string().describe("Data access ID from the GraphQL query tool"),
				sql: z.string().describe("SQL SELECT query to execute against the staged PDB data"),
				params: z.array(z.string()).optional().describe("Optional query parameters"),
			},
			async ({ data_access_id, sql }) => {
				try {
					const queryResult = await this.executeSQLQuery(data_access_id, sql);
					return { content: [{ type: "text" as const, text: JSON.stringify(queryResult, null, 2) }] };
				} catch (error) {
					return this.createErrorResponse("SQL execution failed", error);
				}
			}
		);
	}

	// ========================================
	// RCSB PDB GRAPHQL CLIENT - Reused from original
	// ========================================
        private async executeRcsbPdbGraphQLQuery(query: string, variables?: Record<string, any>): Promise<any> {
		try {
			const headers = {
				"Content-Type": "application/json",
				...API_CONFIG.headers
			};

			const bodyData: Record<string, any> = { query };
			if (variables && Object.keys(variables).length > 0) {
				bodyData.variables = variables;
			}

			console.error(`Making GraphQL request to: ${API_CONFIG.endpoint}`);

			const response = await fetch(API_CONFIG.endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify(bodyData),
			});

			console.error(`RCSB PDB API response status: ${response.status}`);

			// RCSB PDB GraphQL API always returns 200 OK, with errors in the JSON body.
			if (!response.ok) {
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

        private isIntrospectionQuery(query: string): boolean {
                if (!query) return false;
                
                // Remove comments and normalize whitespace for analysis
                const normalizedQuery = query
                        .replace(/\s*#.*$/gm, '') // Remove comments
                        .replace(/\s+/g, ' ')     // Normalize whitespace
                        .trim()
                        .toLowerCase();
                
                // Check for common introspection patterns
                const introspectionPatterns = [
                        '__schema',           // Schema introspection
                        '__type',            // Type introspection
                        '__typename',        // Typename introspection
                        'introspectionquery', // Named introspection queries
                        'getintrospectionquery'
                ];
                
                return introspectionPatterns.some(pattern => 
                        normalizedQuery.includes(pattern)
                );
        }

        private shouldBypassStaging(result: any, originalQuery?: string): boolean {
                if (!result) return true;

                // Bypass if this was an introspection query
                if (originalQuery && this.isIntrospectionQuery(originalQuery)) {
                        return true;
                }

                // Bypass if GraphQL reported errors
                if (result.errors) {
                        return true;
                }

                // Check if response contains introspection-like data structure
                if (result.data) {
                        // Common introspection response patterns
                        if (result.data.__schema || result.data.__type) {
                                return true;
                        }
                        
                        // Check for schema metadata structures
                        const hasSchemaMetadata = Object.values(result.data).some((value: any) => {
                                if (value && typeof value === 'object') {
                                        // Look for typical schema introspection fields
                                        const keys = Object.keys(value);
                                        const schemaFields = ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'];
                                        const typeFields = ['name', 'kind', 'description', 'fields', 'interfaces', 'possibleTypes', 'enumValues', 'inputFields'];
                                        
                                        return schemaFields.some(field => keys.includes(field)) ||
                                               typeFields.filter(field => keys.includes(field)).length >= 2;
                                }
                                return false;
                        });
                        
                        if (hasSchemaMetadata) {
                                return true;
                        }
                }

                // Check if response has multiple entities or complex structure that would benefit from staging
                if (result.data) {
                        const dataSize = JSON.stringify(result.data).length;
                        
                        // Always stage if data is substantial (> 2KB)
                        if (dataSize > 2000) {
                                return false; // Don't bypass = trigger staging
                        }
                        
                        // Check for arrays of entities that should be staged
                        const hasMultipleEntities = this.detectMultipleEntities(result.data);
                        if (hasMultipleEntities) {
                                return false; // Don't bypass = trigger staging
                        }
                        
                        // Check for complex nested structures
                        const hasComplexNesting = this.detectComplexNesting(result.data);
                        if (hasComplexNesting) {
                                return false; // Don't bypass = trigger staging
                        }
                }

                // Detect mostly empty data objects
                if (result.data) {
                        const values = Object.values(result.data);
                        const hasContent = values.some((v) => {
                                if (v === null || v === undefined) return false;
                                if (Array.isArray(v)) return v.length > 0;
                                if (typeof v === "object") return Object.keys(v).length > 0;
                                return true;
                        });
                        if (!hasContent) return true;
                }

                return false; // Default to staging for most queries
        }
        
        private detectMultipleEntities(data: any): boolean {
                if (!data || typeof data !== 'object') return false;
                
                // Look for arrays of entities
                for (const value of Object.values(data)) {
                        if (Array.isArray(value) && value.length > 1) {
                                // Check if array contains entity-like objects
                                const firstItem = value[0];
                                if (firstItem && typeof firstItem === 'object' && 
                                    (firstItem.id || firstItem.rcsb_id || Object.keys(firstItem).length >= 3)) {
                                        return true;
                                }
                        }
                }
                
                return false;
        }
        
        private detectComplexNesting(data: any, depth: number = 0): boolean {
                if (!data || typeof data !== 'object' || depth > 3) return false;
                
                // Count nested objects and arrays
                let complexityScore = 0;
                
                for (const value of Object.values(data)) {
                        if (Array.isArray(value)) {
                                complexityScore += value.length > 0 ? 2 : 1;
                        } else if (value && typeof value === 'object') {
                                complexityScore += 1;
                                if (this.detectComplexNesting(value, depth + 1)) {
                                        complexityScore += 2;
                                }
                        }
                }
                
                return complexityScore >= 4; // Arbitrary threshold for complexity
        }

	// ========================================
	// DURABLE OBJECT INTEGRATION - Use this.env directly
	// ========================================
	private async stageDataInDurableObject(graphqlResult: any): Promise<any> {
		const env = this.env as RcsbPdbEnv;
		if (!env?.JSON_TO_SQL_DO) {
			throw new Error("JSON_TO_SQL_DO binding not available");
		}
		
		const accessId = crypto.randomUUID();
		const doId = env.JSON_TO_SQL_DO.idFromName(accessId);
		const stub = env.JSON_TO_SQL_DO.get(doId);
		
		const response = await stub.fetch("http://do/process", {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonData: graphqlResult })
		});
		
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`DO staging failed: ${errorText}`);
		}
		
		const processingResult = await response.json() as ProcessingResult;
		
		// Register the dataset for tracking
		datasetRegistry.set(accessId, {
			created: new Date().toISOString(),
			table_count: processingResult.table_count,
			total_rows: processingResult.total_rows
		});
		
		// Return the format expected by the test framework
		return {
			data_access_id: accessId,
			processing_details: processingResult
		};
	}

        private async executeSQLQuery(dataAccessId: string, sql: string): Promise<any> {
		const env = this.env as RcsbPdbEnv;
		if (!env?.JSON_TO_SQL_DO) {
			throw new Error("JSON_TO_SQL_DO binding not available");
		}
		
		const doId = env.JSON_TO_SQL_DO.idFromName(dataAccessId);
		const stub = env.JSON_TO_SQL_DO.get(doId);
		
		const response = await stub.fetch("http://do/query", {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sql })
		});
		
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`SQL execution failed: ${errorText}`);
		}
		
                return await response.json();
        }

        private async deleteDataset(dataAccessId: string): Promise<boolean> {
                const env = this.env as RcsbPdbEnv;
                if (!env?.JSON_TO_SQL_DO) {
                        throw new Error("JSON_TO_SQL_DO binding not available");
                }

                const doId = env.JSON_TO_SQL_DO.idFromName(dataAccessId);
                const stub = env.JSON_TO_SQL_DO.get(doId);

                const response = await stub.fetch("http://do/delete", { method: 'DELETE' });

                return response.ok;
        }

	// ========================================
	// ERROR HANDLING - Reusable
	// ========================================
	private createErrorResponse(message: string, error: unknown) {
		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify({
					success: false,
					error: message,
					details: error instanceof Error ? error.message : String(error)
				}, null, 2)
			}]
		};
	}
}

// ========================================
// CLOUDFLARE WORKERS BOILERPLATE - Updated for RCSB PDB
// ========================================
interface Env {
	MCP_HOST?: string;
	MCP_PORT?: string;
	MCP_OBJECT: DurableObjectNamespace;
	JSON_TO_SQL_DO: DurableObjectNamespace;
}

interface ExecutionContext {
	waitUntil(promise: Promise<any>): void;
	passThroughOnException(): void;
}

export default {
        async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
                const url = new URL(request.url);

                if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
                        // @ts-ignore - SSE transport handling
                        return RcsbPdbMCP.serveSSE("/sse").fetch(request, env, ctx);
                }

                if (url.pathname === "/datasets" && request.method === "GET") {
                        const list = Array.from(datasetRegistry.entries()).map(([id, info]) => ({
                                data_access_id: id,
                                ...info
                        }));
                        return new Response(JSON.stringify({ datasets: list }, null, 2), {
                                headers: { "Content-Type": "application/json" }
                        });
                }

                if (url.pathname.startsWith("/datasets/") && request.method === "DELETE") {
                        const id = url.pathname.split("/")[2];
                        if (!id || !datasetRegistry.has(id)) {
                                return new Response(JSON.stringify({ error: "Dataset not found" }), {
                                        status: 404,
                                        headers: { "Content-Type": "application/json" }
                                });
                        }

                        const doId = env.JSON_TO_SQL_DO.idFromName(id);
                        const stub = env.JSON_TO_SQL_DO.get(doId);
                        const resp = await stub.fetch("http://do/delete", { method: "DELETE" });
                        if (resp.ok) {
                                datasetRegistry.delete(id);
                                return new Response(JSON.stringify({ success: true }), {
                                        headers: { "Content-Type": "application/json" }
                                });
                        }

                        const text = await resp.text();
                        return new Response(JSON.stringify({ success: false, error: text }), {
                                status: 500,
                                headers: { "Content-Type": "application/json" }
                        });
                }

                return new Response(
                        `${API_CONFIG.name} - Available on /sse endpoint\nRCSB PDB GraphQL API with SQLite staging for complex data analysis`,
                        { status: 404, headers: { "Content-Type": "text/plain" } }
                );
        },
};

export { RcsbPdbMCP as MyMCP };
export { JsonToSqlDO };
