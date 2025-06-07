import { TableSchema } from "./types.js";

export class DataInsertionEngine {
	private processedEntities: Map<string, Map<any, number>> = new Map();
	private relationshipData: Map<string, Set<string>> = new Map();
	private semanticMappings: Map<string, string> = new Map();
	
	constructor() {
		this.initializeSemanticMappings();
	}
	
	private initializeSemanticMappings(): void {
		// Keep same mappings as SchemaInferenceEngine for consistency
		const mappings: Record<string, string> = {
			// PDB-specific mappings
			'pdbx_seq_one_letter_code_can': 'amino_acid_sequence',
			'pdbx_seq_one_letter_code': 'sequence',
			'ncbi_scientific_name': 'organism_name',
			'ncbi_taxonomy_id': 'taxonomy_id',
			'rcsb_id': 'id',
			'rcsb_entity_id': 'entity_id',
			'rcsb_entry_info': 'entry_info',
			'rcsb_polymer_entity': 'polymer_entity',
			'rcsb_chem_comp_synonyms': 'chemical_synonyms',
			'rcsb_chem_comp_descriptor': 'chemical_descriptor',
			'formula_weight': 'molecular_weight',
			'exptl_method': 'experimental_method',
			'resolution_combined': 'resolution',
			'deposit_date': 'deposition_date',
			'release_date': 'release_date',
			'revision_date': 'last_modified_date',
			'struct_title': 'title',
			'struct_keywords': 'keywords',
			'entity_src_gen': 'source_organism',
			'entity_src_nat': 'natural_source',
			
			// Common GraphQL patterns
			'__typename': 'type',
			'displayName': 'display_name',
			'createdAt': 'created_at',
			'updatedAt': 'updated_at',
			'startDate': 'start_date',
			'endDate': 'end_date',
			'firstName': 'first_name',
			'lastName': 'last_name',
			'phoneNumber': 'phone_number',
			'emailAddress': 'email',
			'streetAddress': 'street_address',
			'postalCode': 'postal_code',
			'countryCode': 'country_code',
		};
		
		for (const [key, value] of Object.entries(mappings)) {
			this.semanticMappings.set(key.toLowerCase(), value);
		}
	}
	
	async insertData(data: any, schemas: Record<string, TableSchema>, sql: any): Promise<void> {
		// Reset state for new insertion
		this.processedEntities.clear();
		this.relationshipData.clear();

		const schemaNames = Object.keys(schemas);

		// Check if this is one of the simple fallback schemas
		if (schemaNames.length === 1 && ['data_scalar', 'data_array', 'root_object', 'main_data'].includes(schemaNames[0])) {
			const tableName = schemaNames[0];
			const schema = schemas[tableName];
			if (tableName === 'data_scalar' || tableName === 'root_object' || tableName === 'main_data') {
				await this.insertSimpleRow(data, tableName, schema, sql);
			} else { // data_array
				if (Array.isArray(data)) {
					for (const item of data) {
						await this.insertSimpleRow(item, tableName, schema, sql);
					}
				} else {
					await this.insertSimpleRow(data, tableName, schema, sql); 
				}
			}
			return;
		}

		// Phase 1: Insert all entities first (to establish primary keys)
		await this.insertAllEntities(data, schemas, sql);
		
		// Phase 2: Handle relationships via junction tables (only for tables with data)
		await this.insertJunctionTableRecords(data, schemas, sql);
	}

	private async insertAllEntities(obj: any, schemas: Record<string, TableSchema>, sql: any, path: string[] = []): Promise<void> {
		if (!obj || typeof obj !== 'object') return;
		
		// Handle arrays of entities
		if (Array.isArray(obj)) {
			for (const item of obj) {
				await this.insertAllEntities(item, schemas, sql, path);
			}
			return;
		}
		
		// Handle GraphQL edges pattern
		if (obj.edges && Array.isArray(obj.edges)) {
			const nodes = obj.edges.map((edge: any) => edge.node).filter(Boolean);
			for (const node of nodes) {
				await this.insertAllEntities(node, schemas, sql, path);
			}
			return;
		}
		
		// Handle individual entities with enhanced detection
		if (this.isEntityOrCouldBeEntity(obj)) {
			const entityType = this.inferEntityType(obj, path);
			if (schemas[entityType]) {
				await this.insertEntityRecord(obj, entityType, schemas[entityType], sql);
				
				// Process nested entities and record relationships
				await this.processEntityRelationships(obj, entityType, schemas, sql, path);
			}
		}
		
		// Recursively explore nested objects
		for (const [key, value] of Object.entries(obj)) {
			await this.insertAllEntities(value, schemas, sql, [...path, key]);
		}
	}
	
	private async processEntityRelationships(entity: any, entityType: string, schemas: Record<string, TableSchema>, sql: any, path: string[]): Promise<void> {
		for (const [key, value] of Object.entries(entity)) {
			if (Array.isArray(value) && value.length > 0) {
				// Check if this array contains entities
				const firstItem = value.find(item => this.isEntityOrCouldBeEntity(item));
				if (firstItem) {
					const relatedEntityType = this.inferEntityType(firstItem, [key]);
					
					// Process all entities in this array and record relationships
					for (const item of value) {
						if (this.isEntityOrCouldBeEntity(item) && schemas[relatedEntityType]) {
							await this.insertEntityRecord(item, relatedEntityType, schemas[relatedEntityType], sql);
							
							// Track this relationship for junction table creation
							const relationshipKey = [entityType, relatedEntityType].sort().join('_');
							const relationships = this.relationshipData.get(relationshipKey) || new Set();
							const entityId = this.getEntityId(entity, entityType);
							const relatedId = this.getEntityId(item, relatedEntityType);
							
							if (entityId && relatedId) {
								relationships.add(`${entityId}_${relatedId}`);
								this.relationshipData.set(relationshipKey, relationships);
							}
							
							// Recursively process nested entities
							await this.processEntityRelationships(item, relatedEntityType, schemas, sql, [...path, key]);
						}
					}
				}
			} else if (value && typeof value === 'object' && this.isEntityOrCouldBeEntity(value)) {
				// Single related entity
				const relatedEntityType = this.inferEntityType(value, [key]);
				if (schemas[relatedEntityType]) {
					await this.insertEntityRecord(value, relatedEntityType, schemas[relatedEntityType], sql);
					await this.processEntityRelationships(value, relatedEntityType, schemas, sql, [...path, key]);
				}
			}
		}
	}
	
	private async insertEntityRecord(entity: any, tableName: string, schema: TableSchema, sql: any): Promise<number | null> {
		// Check if this entity was already processed
		const entityMap = this.processedEntities.get(tableName) || new Map();
		if (entityMap.has(entity)) {
			return entityMap.get(entity)!;
		}
		
		const rowData = this.mapEntityToSchema(entity, schema, tableName);
		if (Object.keys(rowData).length === 0) return null;
		
		const columns = Object.keys(rowData);
		const placeholders = columns.map(() => '?').join(', ');
		const values = Object.values(rowData);
		
		// Use INSERT OR IGNORE to handle potential duplicates
		const insertSQL = `INSERT OR IGNORE INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
		sql.exec(insertSQL, ...values);
		
		// Get the inserted or existing ID
		let insertedId: number | null = null;
		if (rowData.id) {
			// If we have the ID in the data, use it
			insertedId = typeof rowData.id === 'number' ? rowData.id : null;
		}
		
		if (!insertedId) {
			// Otherwise get the last inserted row ID
			const result = sql.exec(`SELECT last_insert_rowid() as id`).one();
			insertedId = result?.id || null;
		}
		
		// Track this entity
		if (insertedId) {
			entityMap.set(entity, insertedId);
			this.processedEntities.set(tableName, entityMap);
		}
		
		return insertedId;
	}
	
	private async insertJunctionTableRecords(data: any, schemas: Record<string, TableSchema>, sql: any): Promise<void> {
		// Only create junction table records for relationships that actually have data
		for (const [relationshipKey, relationshipPairs] of this.relationshipData.entries()) {
			if (schemas[relationshipKey]) {
				const [table1, table2] = relationshipKey.split('_');
				
				for (const pairKey of relationshipPairs) {
					const [id1, id2] = pairKey.split('_').map(Number);
					
					const insertSQL = `INSERT OR IGNORE INTO ${relationshipKey} (${table1}_id, ${table2}_id) VALUES (?, ?)`;
					sql.exec(insertSQL, id1, id2);
				}
			}
		}
	}
	
	private getEntityId(entity: any, entityType: string): number | null {
		const entityMap = this.processedEntities.get(entityType);
		return entityMap?.get(entity) || null;
	}
	
	private mapEntityToSchema(obj: any, schema: TableSchema, tableName: string): any {
		const rowData: any = {};
		
		if (!obj || typeof obj !== 'object') {
			if (schema.columns.value) rowData.value = obj;
			return rowData;
		}
		
		for (const columnName of Object.keys(schema.columns)) {
			if (columnName === 'id' && schema.columns[columnName].includes('AUTOINCREMENT')) {
				continue;
			}
			
			let value = null;
			
			// Handle foreign key columns with enhanced matching
			if (columnName.endsWith('_id') && !columnName.includes('_json')) {
				const baseKey = columnName.slice(0, -3);
				const originalKey = this.findOriginalKeyWithSemantics(obj, baseKey);
				if (originalKey && obj[originalKey] && typeof obj[originalKey] === 'object') {
					const referencedEntity = obj[originalKey];
					value = referencedEntity.id || referencedEntity.rcsb_id || null;
				}
			}
			// Handle prefixed columns (from nested scalar fields) with semantic awareness
			else if (columnName.includes('_') && !columnName.endsWith('_json')) {
				const parts = columnName.split('_');
				if (parts.length >= 2) {
					const baseKey = parts[0];
					const subKey = parts.slice(1).join('_');
					const originalKey = this.findOriginalKeyWithSemantics(obj, baseKey);
					if (originalKey && obj[originalKey] && typeof obj[originalKey] === 'object') {
						const nestedObj = obj[originalKey];
						const originalSubKey = this.findOriginalKeyWithSemantics(nestedObj, subKey);
						if (originalSubKey && nestedObj[originalSubKey] !== undefined) {
							value = nestedObj[originalSubKey];
							if (typeof value === 'boolean') value = value ? 1 : 0;
						}
					}
				}
			}
			// Handle JSON columns
			else if (columnName.endsWith('_json')) {
				const baseKey = columnName.slice(0, -5);
				const originalKey = this.findOriginalKeyWithSemantics(obj, baseKey);
				if (originalKey && obj[originalKey] && typeof obj[originalKey] === 'object') {
					value = JSON.stringify(obj[originalKey]);
				}
			}
			// Handle regular columns with semantic mapping
			else {
				const originalKey = this.findOriginalKeyWithSemantics(obj, columnName);
				if (originalKey && obj[originalKey] !== undefined) {
					value = obj[originalKey];
					if (typeof value === 'boolean') value = value ? 1 : 0;
					
					// Skip arrays of entities (they're handled via junction tables)
					if (Array.isArray(value) && value.length > 0 && this.isEntityOrCouldBeEntity(value[0])) {
						continue;
					}
					
					// Store primitive arrays as JSON
					if (Array.isArray(value)) {
						value = JSON.stringify(value);
					}
				}
			}
			
			// CRITICAL: Type coercion to match schema expectations
			if (value !== null && value !== undefined) {
				const expectedType = schema.columns[columnName].toUpperCase();
				const coercedValue = this.coerceValueToSchemaType(value, expectedType, columnName);
				if (coercedValue !== null) {
					rowData[columnName] = coercedValue;
				}
			}
		}
		
		return rowData;
	}
	
	/**
	 * Coerces a value to match the expected SQLite column type to prevent SQLITE_MISMATCH errors
	 */
	private coerceValueToSchemaType(value: any, expectedType: string, columnName: string): any {
		try {
			// Handle NULL values
			if (value === null || value === undefined) {
				return null;
			}
			
			// Extract base type (remove constraints like PRIMARY KEY, AUTOINCREMENT, etc.)
			const baseType = this.extractBaseType(expectedType);
			
			switch (baseType) {
				case 'INTEGER':
					if (typeof value === 'number') {
						return Math.floor(value);
					}
					if (typeof value === 'string') {
						const parsed = parseInt(value, 10);
						return isNaN(parsed) ? null : parsed;
					}
					if (typeof value === 'boolean') {
						return value ? 1 : 0;
					}
					return null;
					
				case 'REAL':
					if (typeof value === 'number') {
						return value;
					}
					if (typeof value === 'string') {
						const parsed = parseFloat(value);
						return isNaN(parsed) ? null : parsed;
					}
					if (typeof value === 'boolean') {
						return value ? 1.0 : 0.0;
					}
					return null;
					
				case 'TEXT':
				case 'DATE':
				case 'DATETIME':
				case 'JSON':
					// All these map to TEXT in SQLite
					if (typeof value === 'string') {
						return value;
					}
					if (typeof value === 'number' || typeof value === 'boolean') {
						return String(value);
					}
					if (typeof value === 'object') {
						return JSON.stringify(value);
					}
					return String(value);
					
				case 'BLOB':
					// Convert to Buffer/Uint8Array if not already
					if (value instanceof ArrayBuffer || value instanceof Uint8Array) {
						return value;
					}
					if (typeof value === 'string') {
						return new TextEncoder().encode(value);
					}
					return null;
					
				default:
					// Fallback to TEXT
					return typeof value === 'string' ? value : String(value);
			}
		} catch (error) {
			// Log coercion failure but don't fail the entire operation
			console.warn(`Type coercion failed for column ${columnName}: ${error}`);
			return null;
		}
	}
	
	/**
	 * Extracts the base SQLite type from a column definition
	 */
	private extractBaseType(typeDefinition: string): string {
		const upper = typeDefinition.toUpperCase().trim();
		
		// Handle compound types
		if (upper.includes('INTEGER')) return 'INTEGER';
		if (upper.includes('REAL') || upper.includes('FLOAT') || upper.includes('DOUBLE')) return 'REAL';
		if (upper.includes('TEXT') || upper.includes('VARCHAR') || upper.includes('CHAR')) return 'TEXT';
		if (upper.includes('BLOB')) return 'BLOB';
		if (upper.includes('JSON')) return 'TEXT'; // JSON is stored as TEXT in SQLite
		if (upper.includes('DATE') || upper.includes('TIME')) return 'TEXT'; // Dates are stored as TEXT
		
		// Default fallback
		return 'TEXT';
	}
	
	// Enhanced entity detection and type inference with better consistency
	private isEntityOrCouldBeEntity(obj: any): boolean {
		if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
		
		const keys = Object.keys(obj);
		const hasId = keys.includes('id') || keys.includes('_id') || keys.includes('rcsb_id');
		const fieldCount = keys.length;
		
		// Stricter entity criteria but with fallbacks (same as SchemaInferenceEngine)
		if (hasId) return true;
		
		// Has multiple meaningful fields
		if (fieldCount >= 3) {
			const hasEntityIndicators = keys.some(key => 
				['name', 'title', 'description', 'type', 'formula', 'sequence', 'value'].includes(key.toLowerCase())
			);
			if (hasEntityIndicators) return true;
		}
		
		// Could be entity if it has consistent structure for normalization
		if (fieldCount >= 2) {
			const hasNonObjectFields = keys.some(key => {
				const value = obj[key];
				return value !== null && typeof value !== 'object';
			});
			return hasNonObjectFields;
		}
		
		return false;
	}
	
	private inferEntityType(obj: any, path: string[]): string {
		// Enhanced inference matching SchemaInferenceEngine
		if (obj.__typename) return this.sanitizeTableName(obj.__typename);
		if (obj.type && typeof obj.type === 'string' && !this.isGraphQLWrapperField(obj.type)) {
			return this.sanitizeTableName(obj.type);
		}
		
		if (path.length > 0) {
			let lastName = path[path.length - 1];

			// Handle GraphQL patterns
			if (lastName === 'node' && path.length > 1) {
				lastName = path[path.length - 2];
				if (lastName === 'edges' && path.length > 2) {
					lastName = path[path.length - 3];
				}
			} else if (lastName === 'edges' && path.length > 1) {
				lastName = path[path.length - 2];
			}
			
			return this.sanitizeTableName(this.singularize(lastName));
		}
		
		// Infer from object structure
		if (obj.rcsb_id) {
			if (obj.chem_comp || obj.formula) return 'chemical_compound';
			if (obj.struct || obj.title) return 'entry';
			if (obj.sequence) return 'polymer_entity';
		}
		
		return 'entity_' + Math.random().toString(36).substr(2, 9);
	}
	
	private isGraphQLWrapperField(fieldName: string): boolean {
		return ['nodes', 'edges', 'node', 'data', 'items', 'results'].includes(fieldName.toLowerCase());
	}
	
	private singularize(word: string): string {
		const sanitized = this.sanitizeTableName(word);
		
		// Common English pluralization patterns (same as SchemaInferenceEngine)
		if (sanitized.endsWith('ies') && sanitized.length > 4) {
			return sanitized.slice(0, -3) + 'y';
		}
		if (sanitized.endsWith('ves') && sanitized.length > 4) {
			return sanitized.slice(0, -3) + 'f';
		}
		if (sanitized.endsWith('ses') && sanitized.length > 4) {
			return sanitized.slice(0, -2);
		}
		if (sanitized.endsWith('s') && !sanitized.endsWith('ss') && sanitized.length > 2) {
			const exceptions = ['genus', 'species', 'series', 'analysis', 'basis', 'axis'];
			if (!exceptions.includes(sanitized)) {
				return sanitized.slice(0, -1);
			}
		}
		
		return sanitized;
	}
	
	private sanitizeTableName(name: string): string {
		if (!name || typeof name !== 'string') {
			return 'table_' + Math.random().toString(36).substr(2, 9);
		}
		
		let sanitized = name
			.replace(/[^a-zA-Z0-9_]/g, '_')
			.replace(/_{2,}/g, '_')
			.replace(/^_|_$/g, '')
			.toLowerCase();
		
		if (/^[0-9]/.test(sanitized)) {
			sanitized = 'table_' + sanitized;
		}
		
		if (!sanitized || sanitized.length === 0) {
			sanitized = 'table_' + Math.random().toString(36).substr(2, 9);
		}
		
		const reservedWords = ['table', 'index', 'view', 'column', 'primary', 'key', 'foreign', 'constraint'];
		if (reservedWords.includes(sanitized)) {
			sanitized = sanitized + '_table';
		}
		
		return sanitized;
	}
	
	private findOriginalKeyWithSemantics(obj: any, sanitizedKey: string): string | null {
		const keys = Object.keys(obj);
		
		// Direct match first
		if (keys.includes(sanitizedKey)) return sanitizedKey;
		
		// Check semantic mappings - reverse lookup
		for (const [originalKey, semanticKey] of this.semanticMappings.entries()) {
			if (semanticKey === sanitizedKey && keys.some(k => k.toLowerCase() === originalKey)) {
				return keys.find(k => k.toLowerCase() === originalKey) || null;
			}
		}
		
		// Find key that sanitizes to the same value
		const matchingKey = keys.find(key => 
			this.sanitizeColumnName(this.getSemanticColumnName(key)) === sanitizedKey
		);
		
		return matchingKey || null;
	}
	
	private getSemanticColumnName(originalName: string): string {
		const lower = originalName.toLowerCase();
		return this.semanticMappings.get(lower) || originalName;
	}
	
	private findOriginalKey(obj: any, sanitizedKey: string): string | null {
		// Fallback to original method for compatibility
		return this.findOriginalKeyWithSemantics(obj, sanitizedKey);
	}
	
	private sanitizeColumnName(name: string): string {
		if (!name || typeof name !== 'string') {
			return 'column_' + Math.random().toString(36).substr(2, 9);
		}
		
		// Convert camelCase to snake_case
		let snakeCase = name
			.replace(/([A-Z])/g, '_$1')
			.toLowerCase()
			.replace(/[^a-zA-Z0-9_]/g, '_')
			.replace(/_{2,}/g, '_')
			.replace(/^_|_$/g, '');
		
		if (/^[0-9]/.test(snakeCase)) {
			snakeCase = 'col_' + snakeCase;
		}
		
		if (!snakeCase || snakeCase.length === 0) {
			snakeCase = 'column_' + Math.random().toString(36).substr(2, 9);
		}
		
		// Enhanced PDB terms mapping (matching SchemaInferenceEngine)
		const pdbTerms: Record<string, string> = {
			'entrezid': 'entrez_id',
			'displayname': 'display_name',
			'pdbid': 'pdb_id',
			'chainid': 'chain_id',
			'entityid': 'entity_id',
			'assemblyid': 'assembly_id',
			'molecularweight': 'molecular_weight',
			'experimentalmethod': 'experimental_method',
			'resolutionangstrom': 'resolution_angstrom',
			'ncbitaxonomyid': 'taxonomy_id',
			'ncbiscientificname': 'organism_name',
			'pdbxseqonelettercode': 'sequence',
			'pdbxseqonelettercodecan': 'amino_acid_sequence',
			'rcsbid': 'id',
			'rcsbentityid': 'entity_id',
		};
		
		const result = pdbTerms[snakeCase] || snakeCase;
		
		const reservedWords = ['table', 'index', 'view', 'column', 'primary', 'key', 'foreign', 'constraint', 'order', 'group', 'select', 'from', 'where'];
		if (reservedWords.includes(result)) {
			return result + '_col';
		}
		
		return result;
	}

	private async insertSimpleRow(obj: any, tableName: string, schema: TableSchema, sql: any): Promise<void> {
		const rowData = this.mapObjectToSimpleSchema(obj, schema, tableName);
		if (Object.keys(rowData).length === 0 && !(tableName === 'data_scalar' && obj === null)) return;

		const columns = Object.keys(rowData);
		const placeholders = columns.map(() => '?').join(', ');
		const values = Object.values(rowData);

		const insertSQL = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
		sql.exec(insertSQL, ...values);
	}

	private mapObjectToSimpleSchema(obj: any, schema: TableSchema, tableName: string): any {
		const rowData: any = {};

		if (obj === null || typeof obj !== 'object') {
			if (schema.columns.value) {
				const expectedType = schema.columns.value.toUpperCase();
				const coercedValue = this.coerceValueToSchemaType(obj, expectedType, 'value');
				if (coercedValue !== null) {
					rowData.value = coercedValue;
				}
			} else if (Object.keys(schema.columns).length > 0) {
				const firstCol = Object.keys(schema.columns)[0];
				const expectedType = schema.columns[firstCol].toUpperCase();
				const coercedValue = this.coerceValueToSchemaType(obj, expectedType, firstCol);
				if (coercedValue !== null) {
					rowData[firstCol] = coercedValue;
				}
			}
			return rowData;
		}

		if (Array.isArray(obj)) {
			// Handle array data with enhanced semantics
			const jsonKey = Object.keys(schema.columns).find(key => key.endsWith('_json')) || 'array_data_json';
			if (schema.columns[jsonKey]) {
				const expectedType = schema.columns[jsonKey].toUpperCase();
				const coercedValue = this.coerceValueToSchemaType(JSON.stringify(obj), expectedType, jsonKey);
				if (coercedValue !== null) {
					rowData[jsonKey] = coercedValue;
				}
			}
			return rowData;
		}

		for (const columnName of Object.keys(schema.columns)) {
			let valueToInsert = undefined;
			let originalKeyFound = false;

			if (columnName.endsWith('_json')) {
				const baseKey = columnName.slice(0, -5);
				const originalKey = this.findOriginalKeyWithSemantics(obj, baseKey);
				if (originalKey && obj[originalKey] !== undefined) {
					valueToInsert = JSON.stringify(obj[originalKey]);
					originalKeyFound = true;
				}
			} else {
				const originalKey = this.findOriginalKeyWithSemantics(obj, columnName);
				if (originalKey && obj[originalKey] !== undefined) {
					const val = obj[originalKey];
					if (typeof val === 'boolean') {
						valueToInsert = val ? 1 : 0;
					} else if (typeof val === 'object' && val !== null) {
						valueToInsert = JSON.stringify(val);
					} else {
						valueToInsert = val;
					}
					originalKeyFound = true;
				}
			}

			if (originalKeyFound && valueToInsert !== undefined) {
				// Apply type coercion to prevent SQLITE_MISMATCH
				const expectedType = schema.columns[columnName].toUpperCase();
				const coercedValue = this.coerceValueToSchemaType(valueToInsert, expectedType, columnName);
				if (coercedValue !== null) {
					rowData[columnName] = coercedValue;
				}
			} else if (obj.hasOwnProperty(columnName) && obj[columnName] !== undefined){
				const val = obj[columnName];
				let processedVal = val;
				if (typeof val === 'boolean') processedVal = val ? 1:0;
				else if (typeof val === 'object' && val !== null) processedVal = JSON.stringify(val);
				
				// Apply type coercion
				const expectedType = schema.columns[columnName].toUpperCase();
				const coercedValue = this.coerceValueToSchemaType(processedVal, expectedType, columnName);
				if (coercedValue !== null) {
					rowData[columnName] = coercedValue;
				}
			}
		}
		return rowData;
	}
} 