import { DurableObject } from "cloudflare:workers";

import { SchemaInferenceEngine } from "./lib/SchemaInferenceEngine.js";
import { DataInsertionEngine } from "./lib/DataInsertionEngine.js";
import { PaginationAnalyzer } from "./lib/PaginationAnalyzer.js";
import { TableSchema, ProcessingResult, PaginationInfo, DiscoveryGuidance } from "./lib/types.js";

// Main Durable Object class - enhanced with discovery-driven design
export class JsonToSqlDO extends DurableObject {
	private processingStats = {
		queriesExecuted: 0,
		tablesCreated: 0,
		lastProcessedAt: null as Date | null,
		successfulPatterns: [] as string[]
	};

	constructor(ctx: DurableObjectState, env: any) {
		super(ctx, env);
	}

	async processAndStoreJson(jsonData: any, sourceQuery?: string): Promise<ProcessingResult> {
		try {
			let dataToProcess = jsonData?.data ? jsonData.data : jsonData;
			const paginationInfo = PaginationAnalyzer.extractInfo(dataToProcess);

			// Enhanced validation with helpful feedback
			if (!dataToProcess || (Array.isArray(dataToProcess) && dataToProcess.length === 0)) {
				return this.createEnhancedError(
					"No processable data found",
					"validation_error",
					[
						"Check if your GraphQL query returned data",
						"Verify the response structure contains a 'data' field",
						"Try a simpler query first to test connectivity"
					]
				);
			}

			const schemaEngine = new SchemaInferenceEngine();
			const schemas = schemaEngine.inferFromJSON(dataToProcess);
			
			if (Object.keys(schemas).length === 0) {
				return this.createEnhancedError(
					"Could not infer any table schemas from the data",
					"schema_inference_error",
					[
						"Try querying for data with more structured fields",
						"Check if your data contains nested objects or arrays",
						"Consider using introspection to understand the API schema first"
					]
				);
			}
			
			// Create tables with enhanced error handling
			const tableResults = await this.createTablesWithValidation(schemas);
			if (!tableResults.success) {
				return tableResults as ProcessingResult;
			}
			
			// Insert data with progress tracking
			const dataInsertionEngine = new DataInsertionEngine();
			await dataInsertionEngine.insertData(dataToProcess, schemas, this.ctx.storage.sql);
			
			// Update stats
			this.processingStats.tablesCreated += Object.keys(schemas).length;
			this.processingStats.lastProcessedAt = new Date();
			if (sourceQuery) {
				this.processingStats.successfulPatterns.push(sourceQuery);
			}
			
			// Generate enhanced metadata with guidance
			const metadata = await this.generateEnhancedMetadata(schemas, sourceQuery);
			
			// Build the complete response with all required fields
			const result: ProcessingResult = {
				success: true,
				message: "Data processed successfully",
				table_count: Object.keys(schemas).length,
				total_rows: metadata.total_rows || 0,
				schemas: metadata.schemas,
				processing_guidance: this.generateProcessingGuidance(schemas),
				query_guidance: metadata.query_guidance
			};
			
			// Add pagination if available
			if (paginationInfo.hasNextPage) {
				result.pagination = paginationInfo;
			}
			
			return result;
			
		} catch (error) {
			return this.createEnhancedError(
				error instanceof Error ? error.message : "Processing failed",
				"processing_error",
				[
					"Try breaking down complex queries into simpler parts",
					"Check the data structure with a smaller sample first",
					"Use /schema endpoint to inspect current state"
				],
				{ error_details: error instanceof Error ? error.stack : undefined }
			);
		}
	}

	async executeSql(sqlQuery: string): Promise<any> {
		try {
			// Enhanced security validation with contextual feedback
			const validationResult = this.validateAnalyticalSql(sqlQuery);
			if (!validationResult.isValid) {
				return this.createSqlError(sqlQuery, validationResult.error!, [
					"Review the list of allowed SQL operations",
					"Consider using temporary tables for complex operations",
					"Check query suggestions at /query-suggestions for patterns"
				]);
			}

			const result = this.ctx.storage.sql.exec(sqlQuery);
			const results = result.toArray();

			// Update stats
			this.processingStats.queriesExecuted++;

			// Enhanced response with analysis hints
			const response = {
				success: true,
				results,
				row_count: results.length,
				column_names: result.columnNames || [],
				query_type: validationResult.queryType,
				execution_hints: this.generateExecutionHints(sqlQuery, results.length),
				performance_notes: this.generatePerformanceNotes(sqlQuery, results.length)
			};

			// Add discovery suggestions for empty results
			if (results.length === 0) {
				response.execution_hints.push("No rows returned - try PRAGMA table_info(table_name) to verify structure");
				response.execution_hints.push("Use /schema endpoint to see all available tables and data");
			}

			return response;

		} catch (error) {
			return this.createSqlError(
				sqlQuery, 
				error instanceof Error ? error.message : "SQL execution failed",
				this.generateSqlErrorSuggestions(sqlQuery, error)
			);
		}
	}

	private createEnhancedError(
		message: string, 
		errorType: string, 
		suggestions: string[], 
		context?: any
	): ProcessingResult {
		return {
			success: false,
			message: message,
			table_count: 0,
			total_rows: 0,
			error: message,
			error_type: errorType,
			suggestions,
			help_url: "/query-suggestions?context=" + errorType,
			query_context: context
		};
	}

	private createSqlError(query: string, error: string, suggestions: string[]): any {
		return {
			success: false,
			error,
			error_type: "sql_execution_error",
			query,
			suggestions,
			debugging_help: [
				"Use PRAGMA table_list to see all tables",
				"Use PRAGMA table_info(table_name) to see column details",
				"Check /schema for complete database structure"
			]
		};
	}

	private generateSqlErrorSuggestions(query: string, error: any): string[] {
		const suggestions: string[] = [];
		const errorMessage = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
		
		if (errorMessage.includes('no such table')) {
			suggestions.push("Check available tables with: PRAGMA table_list");
			suggestions.push("Verify table names match exactly (case-sensitive)");
		}
		
		if (errorMessage.includes('no such column')) {
			suggestions.push("Use PRAGMA table_info(table_name) to see all columns");
			suggestions.push("Check for typos in column names");
		}
		
		if (errorMessage.includes('syntax error')) {
			suggestions.push("Verify SQL syntax - try a simpler query first");
			suggestions.push("Check for unbalanced quotes or parentheses");
		}
		
		return suggestions.length > 0 ? suggestions : [
			"Try /query-suggestions for working query patterns",
			"Use /schema to understand the database structure"
		];
	}

	private generateExecutionHints(query: string, resultCount: number): string[] {
		const hints: string[] = [];
		const lowerQuery = query.toLowerCase();
		
		if (lowerQuery.includes('select *') && resultCount > 100) {
			hints.push("Consider adding LIMIT clause for large result sets");
		}
		
		if (lowerQuery.includes('where') && resultCount === 0) {
			hints.push("WHERE clause might be too restrictive - try removing conditions");
		}
		
		if (lowerQuery.includes('join') && resultCount === 0) {
			hints.push("JOIN might not find matching records - try LEFT JOIN or check foreign keys");
		}
		
		return hints;
	}

	private generatePerformanceNotes(query: string, resultCount: number): string[] {
		const notes: string[] = [];
		const lowerQuery = query.toLowerCase();
		
		if (resultCount > 1000) {
			notes.push("Large result set - consider pagination with LIMIT and OFFSET");
		}
		
		if (lowerQuery.includes('group by')) {
			notes.push("GROUP BY operations can be optimized with appropriate indexes");
		}
		
		return notes;
	}

	private generateProcessingGuidance(schemas: Record<string, TableSchema>): DiscoveryGuidance {
		const tableNames = Object.keys(schemas);
		
		return {
			recommended_start: [
				`SELECT * FROM ${tableNames[0]} LIMIT 5`,
				"PRAGMA table_list",
				`PRAGMA table_info(${tableNames[0]})`
			],
			working_patterns: [
				"Start with simple SELECT queries",
				"Use PRAGMA commands to explore schema",
				"Add complexity incrementally",
				"Test JOINs with small datasets first"
			],
			common_gotchas: [
				"Table/column names are case-sensitive",
				"Use quotes for names with special characters",
				"Foreign key constraints may affect JOINs",
				"JSON columns need special extraction functions"
			],
			field_suggestions: this.generateFieldSuggestions(schemas)
		};
	}

	private generateFieldSuggestions(schemas: Record<string, TableSchema>): Record<string, string[]> {
		const suggestions: Record<string, string[]> = {};
		
		for (const [tableName, schema] of Object.entries(schemas)) {
			const columns = Object.keys(schema.columns);
			suggestions[tableName] = [
				...columns.slice(0, 5), // First 5 columns
				"-- Use PRAGMA table_info(" + tableName + ") for all columns"
			];
		}
		
		return suggestions;
	}

	private validateAnalyticalSql(sql: string): {isValid: boolean, error?: string, queryType?: string} {
		const trimmedSql = sql.trim().toLowerCase();
		
		// Allowed operations for analytical work
		const allowedStarters = [
			'select',
			'with',           // CTEs for complex analysis
			'pragma',         // Schema inspection
			'explain',        // Query planning
			'create temporary table',
			'create temp table',
			'create view',
			'create temporary view',
			'create temp view',
			'drop view',      // Clean up session views
			'drop temporary table',
			'drop temp table'
		];

		// Dangerous operations that modify permanent data
		const blockedPatterns = [
			/\bdrop\s+table\s+(?!temp|temporary)/i,    // Block permanent table drops
			/\bdelete\s+from/i,                        // Block data deletion
			/\bupdate\s+\w+\s+set/i,                   // Block data updates
			/\binsert\s+into\s+(?!temp|temporary)/i,   // Block permanent inserts
			/\balter\s+table/i,                        // Block schema changes
			/\bcreate\s+table\s+(?!temp|temporary)/i,  // Block permanent table creation
			/\battach\s+database/i,                    // Block external database access
			/\bdetach\s+database/i                     // Block database detachment
		];

		// Check if query starts with allowed operation
		const startsWithAllowed = allowedStarters.some(starter => 
			trimmedSql.startsWith(starter)
		);

		if (!startsWithAllowed) {
			const suggestion = this.suggestAllowedOperation(trimmedSql);
			return {
				isValid: false, 
				error: `Query type not allowed. ${suggestion}. Permitted operations: ${allowedStarters.join(', ')}`
			};
		}

		// Check for blocked patterns
		for (const pattern of blockedPatterns) {
			if (pattern.test(sql)) {
				return {
					isValid: false,
					error: `Operation blocked for security: ${pattern.source}. Use temporary tables for data modifications.`
				};
			}
		}

		// Determine query type for response metadata
		let queryType = 'select';
		if (trimmedSql.startsWith('with')) queryType = 'cte';
		else if (trimmedSql.startsWith('pragma')) queryType = 'pragma';
		else if (trimmedSql.startsWith('explain')) queryType = 'explain';
		else if (trimmedSql.includes('create')) queryType = 'create_temp';

		return {isValid: true, queryType};
	}

	private suggestAllowedOperation(query: string): string {
		if (query.includes('insert')) {
			return "Try CREATE TEMPORARY TABLE instead of INSERT";
		}
		if (query.includes('update')) {
			return "Use SELECT with calculated columns instead of UPDATE";
		}
		if (query.includes('delete')) {
			return "Use WHERE clauses in SELECT instead of DELETE";
		}
		return "Start with SELECT, PRAGMA, or WITH statements";
	}

	private async createTablesWithValidation(schemas: Record<string, TableSchema>): Promise<ProcessingResult | { success: true }> {
		const creationResults: Array<{table: string, success: boolean, error?: string}> = [];
		
		for (const [tableName, schema] of Object.entries(schemas)) {
			try {
				// Validate table name
				const validTableName = this.validateAndFixIdentifier(tableName, 'table');
				
				// Validate and fix column definitions
				const validColumnDefs: string[] = [];
				const columnValidation: Array<{original: string, fixed: string, issues: string[]}> = [];
				
				for (const [name, type] of Object.entries(schema.columns)) {
					const validColumnName = this.validateAndFixIdentifier(name, 'column');
					const validType = this.validateSQLiteType(type);
					validColumnDefs.push(`${validColumnName} ${validType}`);
					
					if (name !== validColumnName || type !== validType) {
						columnValidation.push({
							original: `${name} ${type}`,
							fixed: `${validColumnName} ${validType}`,
							issues: [
								...(name !== validColumnName ? [`Column name changed: ${name} → ${validColumnName}`] : []),
								...(type !== validType ? [`Type changed: ${type} → ${validType}`] : [])
							]
						});
					}
				}

				if (validColumnDefs.length === 0) {
					creationResults.push({
						table: tableName,
						success: false,
						error: "No valid columns could be created"
					});
					continue;
				}

				const createTableSQL = `CREATE TABLE IF NOT EXISTS ${validTableName} (${validColumnDefs.join(', ')})`;
				
				this.ctx.storage.sql.exec(createTableSQL);
				creationResults.push({
					table: tableName,
					success: true
				});
				
			} catch (error) {
				creationResults.push({
					table: tableName,
					success: false,
					error: error instanceof Error ? error.message : "Unknown error"
				});
				
				// Try to create a fallback table
				try {
					const fallbackTableName = this.validateAndFixIdentifier(tableName, 'table');
					const fallbackSQL = `CREATE TABLE IF NOT EXISTS ${fallbackTableName} (id INTEGER PRIMARY KEY AUTOINCREMENT, data_json TEXT)`;
					this.ctx.storage.sql.exec(fallbackSQL);
					
					creationResults[creationResults.length - 1].error += " (fallback table created)";
				} catch (fallbackError) {
					creationResults[creationResults.length - 1].error += " (fallback creation also failed)";
				}
			}
		}
		
		const failedTables = creationResults.filter(r => !r.success);
		if (failedTables.length === creationResults.length) {
			return this.createEnhancedError(
				"All table creation attempts failed",
				"table_creation_error",
				[
					"Check your data structure for valid field names",
					"Try processing a simpler subset of your data first",
					"Use introspection to understand the source data format"
				],
				{ creation_results: creationResults }
			);
		}
		
		return { success: true };
	}

	private validateAndFixIdentifier(name: string, type: 'table' | 'column'): string {
		if (!name || typeof name !== 'string') {
			return type === 'table' ? 'fallback_table' : 'fallback_column';
		}

		// Remove or replace problematic characters
		let fixed = name
			.replace(/[^a-zA-Z0-9_]/g, '_')
			.replace(/_{2,}/g, '_')
			.replace(/^_|_$/g, '');

		// Ensure it doesn't start with a number
		if (/^[0-9]/.test(fixed)) {
			fixed = (type === 'table' ? 'table_' : 'col_') + fixed;
		}

		// Ensure it's not empty
		if (!fixed || fixed.length === 0) {
			fixed = type === 'table' ? 'fallback_table' : 'fallback_column';
		}

		// Handle SQL reserved words by adding suffix
		const reservedWords = [
			'table', 'index', 'view', 'column', 'primary', 'key', 'foreign', 'constraint',
			'order', 'group', 'select', 'from', 'where', 'insert', 'update', 'delete',
			'create', 'drop', 'alter', 'join', 'inner', 'outer', 'left', 'right',
			'union', 'all', 'distinct', 'having', 'limit', 'offset', 'as', 'on'
		];
		
		if (reservedWords.includes(fixed.toLowerCase())) {
			fixed = fixed + (type === 'table' ? '_tbl' : '_col');
		}

		return fixed.toLowerCase();
	}

	private validateSQLiteType(type: string): string {
		if (!type || typeof type !== 'string') {
			return 'TEXT';
		}

		const upperType = type.toUpperCase();
		
		// Map common types to valid SQLite types
		const validTypes = [
			'INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC',
			'INTEGER PRIMARY KEY', 'INTEGER PRIMARY KEY AUTOINCREMENT',
			'JSON'  // SQLite supports JSON since 3.38
		];

		// Check if it's already a valid type
		if (validTypes.some(validType => upperType.includes(validType))) {
			return type;
		}

		// Map common type variations
		const typeMap: Record<string, string> = {
			'STRING': 'TEXT',
			'VARCHAR': 'TEXT',
			'CHAR': 'TEXT',
			'CLOB': 'TEXT',
			'INT': 'INTEGER',
			'BIGINT': 'INTEGER',
			'SMALLINT': 'INTEGER',
			'TINYINT': 'INTEGER',
			'FLOAT': 'REAL',
			'DOUBLE': 'REAL',
			'DECIMAL': 'NUMERIC',
			'BOOLEAN': 'INTEGER',
			'BOOL': 'INTEGER',
			'DATE': 'TEXT',
			'DATETIME': 'TEXT',
			'TIMESTAMP': 'TEXT'
		};

		return typeMap[upperType] || 'TEXT';
	}

	private async generateEnhancedMetadata(schemas: Record<string, TableSchema>, sourceQuery?: string): Promise<{
		schemas: Record<string, any>;
		total_rows: number;
		query_guidance: any;
	}> {
		const metadata = {
			schemas: {} as Record<string, any>,
			total_rows: 0,
			query_guidance: {
				next_steps: [] as string[],
				recommended_queries: [] as string[],
				analysis_opportunities: [] as string[]
			}
		};

		for (const [tableName, schema] of Object.entries(schemas)) {
			try {
				const countResult = this.ctx.storage.sql.exec(`SELECT COUNT(*) as count FROM ${tableName}`);
				const countRow = countResult.one();
				const rowCount = typeof countRow?.count === 'number' ? countRow.count : 0;

				const sampleResult = this.ctx.storage.sql.exec(`SELECT * FROM ${tableName} LIMIT 3`);
				const sampleData = sampleResult.toArray();

				metadata.schemas[tableName] = {
					columns: schema.columns,
					row_count: rowCount,
					sample_data: sampleData,
					suggested_queries: [
						`SELECT * FROM ${tableName} LIMIT 10`,
						`SELECT COUNT(*) FROM ${tableName}`,
						`PRAGMA table_info(${tableName})`
					]
				};

				metadata.total_rows += rowCount;

				// Add contextual guidance
				if (rowCount > 0) {
					metadata.query_guidance.next_steps.push(`Explore ${tableName} (${rowCount} rows)`);
					metadata.query_guidance.recommended_queries.push(`SELECT * FROM ${tableName} LIMIT 5`);
				}

			} catch (error) {
				// Continue with other tables on error but note the issue
				metadata.schemas[tableName] = {
					columns: schema.columns,
					row_count: 0,
					sample_data: [],
					error: "Could not access table data",
					suggested_queries: [`PRAGMA table_info(${tableName})`]
				};
			}
		}

		// Add cross-table analysis opportunities
		const tableNames = Object.keys(schemas);
		if (tableNames.length > 1) {
			metadata.query_guidance.analysis_opportunities.push(
				"Multiple tables available - consider JOIN operations",
				"Look for common fields to establish relationships",
				"Use foreign key analysis for data integrity checks"
			);
		}

		return metadata;
	}

	async getSchemaInfo(): Promise<any> {
		try {
			const tables = this.ctx.storage.sql.exec(`
				SELECT name, type 
				FROM sqlite_master 
				WHERE type IN ('table', 'view') 
				ORDER BY name
			`).toArray();

			const schemaInfo: any = {
				database_summary: {
					total_tables: tables.length,
					table_names: tables.map(t => String(t.name)),
					processing_stats: this.processingStats,
					discovery_guide: {
						quick_start: [
							"1. Start with: PRAGMA table_list",
							"2. Pick a table: PRAGMA table_info(table_name)",
							"3. Sample data: SELECT * FROM table_name LIMIT 5",
							"4. Build complexity: Add WHERE, GROUP BY, etc."
						],
						best_practices: [
							"Always test with LIMIT first",
							"Use PRAGMA commands to understand structure", 
							"Check foreign keys before complex JOINs",
							"Test incremental complexity"
						]
					}
				},
				tables: {}
			};

			for (const table of tables) {
				const tableName = String(table.name);
				if (!tableName || tableName === 'undefined' || tableName === 'null') {
					continue;
				}
				
				try {
					// Get column information
					const columns = this.ctx.storage.sql.exec(`PRAGMA table_info(${tableName})`).toArray();
					
					// Get row count
					const countResult = this.ctx.storage.sql.exec(`SELECT COUNT(*) as count FROM ${tableName}`).one();
					const rowCount = typeof countResult?.count === 'number' ? countResult.count : 0;
					
					// Get sample data (first 3 rows)
					const sampleData = this.ctx.storage.sql.exec(`SELECT * FROM ${tableName} LIMIT 3`).toArray();
					
					// Get foreign key information
					const foreignKeys = this.ctx.storage.sql.exec(`PRAGMA foreign_key_list(${tableName})`).toArray();
					
					// Get indexes
					const indexes = this.ctx.storage.sql.exec(`PRAGMA index_list(${tableName})`).toArray();

					schemaInfo.tables[tableName] = {
						type: String(table.type),
						row_count: rowCount,
						columns: columns.map((col: any) => ({
							name: String(col.name),
							type: String(col.type),
							not_null: Boolean(col.notnull),
							default_value: col.dflt_value,
							primary_key: Boolean(col.pk)
						})),
						foreign_keys: foreignKeys.map((fk: any) => ({
							column: String(fk.from),
							references_table: String(fk.table),
							references_column: String(fk.to)
						})),
						indexes: indexes.map((idx: any) => ({
							name: String(idx.name),
							unique: Boolean(idx.unique)
						})),
						sample_data: sampleData,
						recommended_starter_queries: [
							`SELECT * FROM ${tableName} LIMIT 5`,
							`SELECT COUNT(*) FROM ${tableName}`,
							...(rowCount > 0 ? [`SELECT * FROM ${tableName} WHERE ${columns[0]?.name} IS NOT NULL LIMIT 10`] : [])
						]
					};
				} catch (tableError) {
					schemaInfo.tables[tableName] = {
						error: "Could not access table",
						suggested_action: `Try: PRAGMA table_info(${tableName})`
					};
				}
			}

			return {
				success: true,
				schema_info: schemaInfo
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Schema inspection failed",
				suggestions: [
					"Database might be empty - try processing some data first",
					"Check if tables were created successfully", 
					"Use /process endpoint to stage data before inspection"
				]
			};
		}
	}

	async getTableColumns(tableName: string): Promise<any> {
		try {
			const columns = this.ctx.storage.sql.exec(`PRAGMA table_info(${tableName})`).toArray();
			const foreignKeys = this.ctx.storage.sql.exec(`PRAGMA foreign_key_list(${tableName})`).toArray();
			
			return {
				success: true,
				table: tableName,
				columns: columns.map((col: any) => {
					const fkRef = foreignKeys.find((fk: any) => fk.from === col.name);
					return {
						name: col.name,
						type: col.type,
						not_null: Boolean(col.notnull),
						default_value: col.dflt_value,
						primary_key: Boolean(col.pk),
						is_foreign_key: Boolean(fkRef),
						references: fkRef ? {
							table: fkRef.table,
							column: fkRef.to
						} : null
					};
				}),
				usage_examples: [
					`SELECT ${columns[0]?.name} FROM ${tableName} LIMIT 5`,
					`SELECT COUNT(*) FROM ${tableName}`,
					`SELECT * FROM ${tableName} WHERE ${columns[0]?.name} IS NOT NULL`
				]
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Table inspection failed",
				suggestions: [
					`Verify table name: ${tableName}`,
					"Use PRAGMA table_list to see all available tables",
					"Check if the table was created successfully"
				]
			};
		}
	}

	async generateAnalyticalQueries(tableName?: string): Promise<any> {
		try {
			const contextualSuggestions = await this.generateContextualSuggestions(tableName);
			
			const suggestions: any = {
				discovery_phase: {
					description: "Start here to understand your data",
					queries: [
						"PRAGMA table_list",
						"SELECT name FROM sqlite_master WHERE type='table'",
						tableName ? `PRAGMA table_info(${tableName})` : "-- Specify table name for column info",
						tableName ? `SELECT * FROM ${tableName} LIMIT 5` : "-- Sample data from specific table"
					]
				},
				basic_analysis: {
					description: "Simple data exploration",
					queries: [
						tableName ? `SELECT COUNT(*) FROM ${tableName}` : "SELECT COUNT(*) FROM table_name",
						tableName ? `SELECT COUNT(DISTINCT column_name) FROM ${tableName}` : "-- Count unique values",
						"-- Check for NULL values:",
						tableName ? `SELECT COUNT(*) - COUNT(column_name) as null_count FROM ${tableName}` : "SELECT COUNT(*) - COUNT(column_name) as null_count FROM table_name"
					]
				},
				json_analysis: {
					description: "Working with JSON columns",
					queries: [
						"-- SQLite JSON functions for analyzing JSON columns:",
						"SELECT json_extract(column_name, '$.field') FROM table_name",
						"SELECT json_array_length(column_name) FROM table_name WHERE column_name IS NOT NULL",
						"SELECT json_each.value FROM table_name, json_each(table_name.column_name)"
					]
				},
				statistical_analysis: {
					description: "Statistical operations",
					queries: [
						"-- Basic statistics:",
						"SELECT COUNT(*), AVG(numeric_column), MIN(numeric_column), MAX(numeric_column) FROM table_name",
						"-- Distribution analysis:",
						"SELECT column_name, COUNT(*) as frequency FROM table_name GROUP BY column_name ORDER BY frequency DESC",
						"-- Cross-table analysis with CTEs:",
						"WITH summary AS (SELECT column, COUNT(*) as cnt FROM table_name GROUP BY column) SELECT * FROM summary WHERE cnt > 10"
					]
				},
				...contextualSuggestions
			};

			return {
				success: true,
				query_suggestions: suggestions,
				usage_tips: [
					"Start with discovery_phase queries to understand your data",
					"Always test with LIMIT clause for large datasets",
					"Use PRAGMA commands extensively for schema exploration",
					"Build complexity incrementally - simple queries first"
				]
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Query generation failed",
				fallback_suggestions: [
					"PRAGMA table_list",
					"SELECT * FROM sqlite_master WHERE type='table'",
					"-- Start with basic schema exploration"
				]
			};
		}
	}

	private async generateContextualSuggestions(tableName?: string): Promise<any> {
		if (!tableName) {
			return {
				getting_started: {
					description: "No specific table - general guidance",
					queries: [
						"PRAGMA table_list",
						"SELECT name, sql FROM sqlite_master WHERE type='table'",
						"-- Choose a table and explore with: SELECT * FROM table_name LIMIT 5"
					]
				}
			};
		}

		try {
			// Get actual table structure for contextual suggestions
			const columns = this.ctx.storage.sql.exec(`PRAGMA table_info(${tableName})`).toArray();
			const sampleRow = this.ctx.storage.sql.exec(`SELECT * FROM ${tableName} LIMIT 1`).toArray()[0];
			
			const suggestions: any = {
				table_specific: {
					description: `Queries tailored for ${tableName}`,
					queries: []
				}
			};

			// Add column-specific suggestions
			for (const col of columns.slice(0, 5)) { // Limit to first 5 columns
				const colName = String(col.name);
				const colType = String(col.type).toUpperCase();
				
				if (colType.includes('INTEGER') || colType.includes('REAL') || colType.includes('NUMERIC')) {
					suggestions.table_specific.queries.push(
						`SELECT MIN(${colName}), MAX(${colName}), AVG(${colName}) FROM ${tableName}`
					);
				} else if (colType.includes('TEXT')) {
					suggestions.table_specific.queries.push(
						`SELECT ${colName}, COUNT(*) FROM ${tableName} GROUP BY ${colName} ORDER BY COUNT(*) DESC LIMIT 10`
					);
				}
			}

			// Add pattern-based suggestions based on common naming conventions
			if (columns.some((col: any) => String(col.name).toLowerCase().includes('id'))) {
				suggestions.relationships = {
					description: "ID columns found - potential for JOINs",
					queries: [
						`SELECT COUNT(DISTINCT id_column) FROM ${tableName}`,
						"-- Look for foreign key relationships with other tables"
					]
				};
			}

			return suggestions;

		} catch (error) {
			return {
				table_exploration: {
					description: `Basic exploration for ${tableName}`,
					queries: [
						`PRAGMA table_info(${tableName})`,
						`SELECT * FROM ${tableName} LIMIT 5`,
						`SELECT COUNT(*) FROM ${tableName}`
					]
				}
			};
		}
	}

	async getStats(): Promise<any> {
		return {
			success: true,
			stats: {
				...this.processingStats,
				database_info: {
					available_tables: await this.getTableCount(),
					last_activity: this.processingStats.lastProcessedAt?.toISOString()
				}
			}
		};
	}

	private async getTableCount(): Promise<number> {
		try {
			const result = this.ctx.storage.sql.exec(`
				SELECT COUNT(*) as count 
				FROM sqlite_master 
				WHERE type='table'
			`).one();
			return typeof result?.count === 'number' ? result.count : 0;
		} catch {
			return 0;
		}
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		try {
			if (url.pathname === '/process' && request.method === 'POST') {
				const requestBody = await request.json() as { jsonData: any; sourceQuery?: string };
				const result = await this.processAndStoreJson(requestBody.jsonData, requestBody.sourceQuery);
				return new Response(JSON.stringify(result), {
					headers: { 'Content-Type': 'application/json' }
				});
			} else if (url.pathname === '/query' && request.method === 'POST') {
				const { sql } = await request.json() as { sql: string };
				const result = await this.executeSql(sql);
				return new Response(JSON.stringify(result), {
					headers: { 'Content-Type': 'application/json' }
				});
			} else if (url.pathname === '/schema' && request.method === 'GET') {
				const result = await this.getSchemaInfo();
				return new Response(JSON.stringify(result), {
					headers: { 'Content-Type': 'application/json' }
				});
			} else if (url.pathname === '/table-info' && request.method === 'POST') {
				const { table_name } = await request.json() as { table_name: string };
				const result = await this.getTableColumns(table_name);
				return new Response(JSON.stringify(result), {
					headers: { 'Content-Type': 'application/json' }
				});
			} else if (url.pathname === '/query-suggestions' && request.method === 'GET') {
				const tableName = url.searchParams.get('table');
				const result = await this.generateAnalyticalQueries(tableName || undefined);
				return new Response(JSON.stringify(result), {
					headers: { 'Content-Type': 'application/json' }
				});
			} else if (url.pathname === '/stats' && request.method === 'GET') {
				const result = await this.getStats();
				return new Response(JSON.stringify(result), {
					headers: { 'Content-Type': 'application/json' }
				});
			} else if (url.pathname === '/delete' && request.method === 'DELETE') {
				await this.ctx.storage.deleteAll();
				// Reset stats
				this.processingStats = {
					queriesExecuted: 0,
					tablesCreated: 0,
					lastProcessedAt: null,
					successfulPatterns: []
				};
				return new Response(JSON.stringify({ 
					success: true, 
					message: "All data and statistics cleared" 
				}), {
					headers: { 'Content-Type': 'application/json' }
				});
			} else {
				// Enhanced 404 with API guidance
				return new Response(JSON.stringify({
					error: "Endpoint not found",
					available_endpoints: {
						"POST /process": "Process JSON data into SQLite tables",
						"POST /query": "Execute SQL queries against staged data",
						"GET /schema": "Get complete database schema information",
						"POST /table-info": "Get detailed info for specific table",
						"GET /query-suggestions": "Get contextual query suggestions",
						"GET /stats": "Get processing statistics",
						"DELETE /delete": "Clear all data and reset"
					},
					getting_started: [
						"1. POST your JSON data to /process",
						"2. Use GET /schema to explore the created tables",
						"3. Use GET /query-suggestions for query ideas",
						"4. POST SQL queries to /query"
					]
				}), { 
					status: 404,
					headers: { 'Content-Type': 'application/json' }
				});
			}
		} catch (error) {
			return new Response(JSON.stringify({
				error: error instanceof Error ? error.message : 'Unknown error',
				error_type: 'request_processing_error',
				suggestions: [
					"Check your request format and Content-Type",
					"Verify all required fields are included",
					"Try a simpler request to test connectivity"
				],
				debug_info: {
					method: request.method,
					pathname: url.pathname,
					timestamp: new Date().toISOString()
				}
			}), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	}
}