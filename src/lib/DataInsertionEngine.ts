import { TableSchema } from "./types.js";

export class DataInsertionEngine {
	private processedEntities: Map<string, Map<any, number>> = new Map();
	private entityToRowMap: Map<any, { tableName: string; id: number }> = new Map();
	private relationshipData: Map<string, Set<string>> = new Map();
	private semanticMappings: Map<string, string> = new Map();
	private foreignKeyUpdates: Array<{ tableName: string; id: number; columnName: string; referencedId: number }> = [];
	private entityIdCounter: number = 1; // For generating sequential IDs
	
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
		this.entityToRowMap.clear();
		this.relationshipData.clear();
		this.foreignKeyUpdates = [];
		this.entityIdCounter = 1;

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

		// PHASE 1: Insert all entities first (without foreign keys)
		console.log("Phase 1: Inserting all entities without foreign keys...");
		await this.insertAllEntitiesWithoutForeignKeys(data, schemas, sql);
		
		// PHASE 2: Update foreign key relationships
		console.log("Phase 2: Updating foreign key relationships...");
		await this.updateForeignKeyRelationships(data, schemas, sql);
		
		// PHASE 3: Handle many-to-many relationships via junction tables
		console.log("Phase 3: Creating junction table relationships...");
		await this.insertJunctionTableRecords(data, schemas, sql);
	}

	private async insertAllEntitiesWithoutForeignKeys(obj: any, schemas: Record<string, TableSchema>, sql: any, path: string[] = []): Promise<void> {
		if (!obj || typeof obj !== 'object') return;
		
		// Handle arrays of entities
		if (Array.isArray(obj)) {
			for (const item of obj) {
				await this.insertAllEntitiesWithoutForeignKeys(item, schemas, sql, path);
			}
			return;
		}
		
		// Handle GraphQL edges pattern
		if (obj.edges && Array.isArray(obj.edges)) {
			const nodes = obj.edges.map((edge: any) => edge.node).filter(Boolean);
			for (const node of nodes) {
				await this.insertAllEntitiesWithoutForeignKeys(node, schemas, sql, path);
			}
			return;
		}
		
		// Handle individual entities - insert this entity first if it matches a schema
		if (this.isEntityOrCouldBeEntity(obj)) {
			const entityType = this.inferEntityType(obj, path);
			if (schemas[entityType]) {
				const insertedId = await this.insertEntityRecordWithoutForeignKeys(obj, entityType, schemas[entityType], sql);
				if (insertedId) {
					this.entityToRowMap.set(obj, { tableName: entityType, id: insertedId });
					console.log(`Tracked entity: ${entityType}(${insertedId})`);
				}
			}
		}
		
		// Recursively explore nested objects to find more entities
		for (const [key, value] of Object.entries(obj)) {
			await this.insertAllEntitiesWithoutForeignKeys(value, schemas, sql, [...path, key]);
		}
	}
	
	private async insertEntityRecordWithoutForeignKeys(entity: any, tableName: string, schema: TableSchema, sql: any): Promise<number | null> {
		// Check if this entity was already processed
		const entityMap = this.processedEntities.get(tableName) || new Map();
		if (entityMap.has(entity)) {
			return entityMap.get(entity)!;
		}
		
		const rowData = this.extractEntityFields(entity, schema);
		if (Object.keys(rowData).length === 0) {
			return null;
		}
		
		// Use sequential ID if no natural ID exists
		if (!rowData.id) {
			rowData.id = this.entityIdCounter++;
		}
		
		const columns = Object.keys(rowData);
		const placeholders = columns.map(() => '?').join(', ');
		const values = Object.values(rowData);
		
		// Use INSERT OR REPLACE to handle potential duplicates
		const insertSQL = `INSERT OR REPLACE INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
		
		try {
			// Handle different SQL interfaces for execution
			if (typeof sql.prepare === 'function') {
				// better-sqlite3 interface
				const stmt = sql.prepare(insertSQL);
				stmt.run(...values);
			} else {
				// Cloudflare Workers SQL interface
				sql.exec(insertSQL, ...values);
			}
			
			// Get the inserted ID
			const insertedId = rowData.id;
			
			// Track this entity
			if (insertedId) {
				entityMap.set(entity, insertedId);
				this.processedEntities.set(tableName, entityMap);
			}
			
			return insertedId;
		} catch (error) {
			console.error(`Error inserting entity into ${tableName}:`, error);
			return null;
		}
	}

	private async updateForeignKeyRelationships(obj: any, schemas: Record<string, TableSchema>, sql: any, path: string[] = []): Promise<void> {
		if (!obj || typeof obj !== 'object') return;
		
		// Handle arrays
		if (Array.isArray(obj)) {
			for (const item of obj) {
				await this.updateForeignKeyRelationships(item, schemas, sql, path);
			}
			return;
		}
		
		// Handle GraphQL edges pattern
		if (obj.edges && Array.isArray(obj.edges)) {
			const nodes = obj.edges.map((edge: any) => edge.node).filter(Boolean);
			for (const node of nodes) {
				await this.updateForeignKeyRelationships(node, schemas, sql, path);
			}
			return;
		}
		
		// If this object is an entity, update its foreign key relationships
		if (this.isEntityOrCouldBeEntity(obj)) {
			const entityType = this.inferEntityType(obj, path);
			const entityInfo = this.entityToRowMap.get(obj);
			
			if (schemas[entityType] && entityInfo) {
				await this.updateEntityForeignKeys(obj, entityInfo, schemas[entityType], sql);
			}
		}
		
		// Recursively process nested objects
		for (const [key, value] of Object.entries(obj)) {
			await this.updateForeignKeyRelationships(value, schemas, sql, [...path, key]);
		}
	}

	private async updateEntityForeignKeys(entity: any, entityInfo: { tableName: string; id: number }, schema: TableSchema, sql: any): Promise<void> {
		const updates: Array<{ column: string; value: number }> = [];
		
		// Find foreign key columns in the schema
		for (const [columnName, columnType] of Object.entries(schema.columns)) {
			if (columnName.endsWith('_id') && columnType.includes('REFERENCES') && !columnType.includes('PRIMARY KEY')) {
				const baseKey = columnName.slice(0, -3); // Remove '_id' suffix
				
				// First try to find a direct nested entity
				let foundEntity = null;
				const originalKey = this.findOriginalKeyWithSemantics(entity, baseKey);
				
				if (originalKey && entity[originalKey]) {
					const value = entity[originalKey];
					if (value && typeof value === 'object' && this.isEntityOrCouldBeEntity(value)) {
						foundEntity = value;
					}
				}
				
				// If no direct match, try finding nested entity
				if (!foundEntity) {
					foundEntity = this.findNestedEntityForForeignKey(entity, columnName, baseKey);
				}
				
				// If still no match, check for semantic mappings
				if (!foundEntity) {
					foundEntity = this.findEntityBySemanticMapping(entity, baseKey);
				}
				
				if (foundEntity) {
					const referencedEntityInfo = this.entityToRowMap.get(foundEntity);
					if (referencedEntityInfo) {
						updates.push({ column: columnName, value: referencedEntityInfo.id });
						console.log(`Found foreign key relationship: ${entityInfo.tableName}.${columnName} -> ${referencedEntityInfo.tableName}(${referencedEntityInfo.id})`);
					}
				}
			}
		}
		
		// Apply the updates
		for (const update of updates) {
			const updateSQL = `UPDATE ${entityInfo.tableName} SET ${update.column} = ? WHERE id = ?`;
			console.log(`Updating foreign key: ${updateSQL}`, [update.value, entityInfo.id]);
			
			try {
				// Handle different SQL interfaces for execution
				if (typeof sql.prepare === 'function') {
					// better-sqlite3 interface
					const stmt = sql.prepare(updateSQL);
					stmt.run(update.value, entityInfo.id);
				} else {
					// Cloudflare Workers SQL interface
					sql.exec(updateSQL, update.value, entityInfo.id);
				}
			} catch (error) {
				console.error(`Error updating foreign key ${entityInfo.tableName}.${update.column}:`, error);
			}
		}
	}

	private findEntityBySemanticMapping(entity: any, baseKey: string): any {
		// Check for common PDB field mappings
		const semanticMappings: Record<string, string[]> = {
			'entry_info': ['rcsb_entry_info', 'entryInfo', 'entry_information'],
			'polymer_entity': ['rcsb_polymer_entity', 'polymerEntity', 'polymer_entities'],
			'chem_comp': ['chem_comp', 'chemComp', 'chemical_component'],
			'citation': ['citation', 'citations', 'reference'],
			'assembly': ['assembly', 'assemblies', 'biological_assembly']
		};
		
		const possibleKeys = semanticMappings[baseKey] || [baseKey];
		
		for (const possibleKey of possibleKeys) {
			const originalKey = this.findOriginalKeyWithSemantics(entity, possibleKey);
			if (originalKey && entity[originalKey]) {
				const value = entity[originalKey];
				if (value && typeof value === 'object' && this.isEntityOrCouldBeEntity(value)) {
					return value;
				}
			}
		}
		
		return null;
	}

	private findNestedEntityForForeignKey(entity: any, foreignKeyColumn: string, baseKey: string): any {
		// Look for nested entities that could be referenced by this foreign key
		for (const [key, value] of Object.entries(entity)) {
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				// Check if this nested object could be the referenced entity
				const semanticKey = this.getSemanticColumnName(key);
				if (semanticKey === baseKey || key === baseKey || this.sanitizeColumnName(key) === baseKey) {
					if (this.isEntityOrCouldBeEntity(value)) {
						return value;
					}
				}
			}
		}
		return null;
	}

	private extractEntityFields(entity: any, schema: TableSchema): any {
		const rowData: any = {};
		
		if (!entity || typeof entity !== 'object') {
			return { value: entity };
		}
		
		for (const [columnName, columnType] of Object.entries(schema.columns)) {
			if (columnName === 'id') continue; // Skip auto-generated ID
			
			// Handle foreign key columns
			if (columnName.endsWith('_id') && columnType.includes('REFERENCES')) {
				// Foreign keys will be populated later in updateEntityForeignKeys
				rowData[columnName] = null;
				continue;
			}
			
			// Find the corresponding field in the entity
			const value = this.findValueForColumn(entity, columnName);
			
			if (value !== undefined) {
				// Convert boolean to integer for SQLite
				if (typeof value === 'boolean') {
					rowData[columnName] = value ? 1 : 0;
				} else if (value === null) {
					rowData[columnName] = null;
				} else if (typeof value === 'object') {
					// Store complex objects as JSON
					rowData[columnName] = JSON.stringify(value);
				} else {
					rowData[columnName] = value;
				}
			} else {
				rowData[columnName] = null;
			}
		}
		
		return rowData;
	}
	
	private findValueForColumn(entity: any, columnName: string): any {
		// Direct field match
		if (entity.hasOwnProperty(columnName)) {
			return entity[columnName];
		}
		
		// Try semantic mapping reverse lookup
		const originalKey = this.findOriginalKeyWithSemantics(entity, columnName);
		if (originalKey && entity.hasOwnProperty(originalKey)) {
			return entity[originalKey];
		}
		
		// Handle nested field extraction (e.g., entity_poly_type from entity_poly.type)
		if (columnName.includes('_')) {
			const parts = columnName.split('_');
			
			// Try to find the nested path by reconstructing from semantic mappings
			for (let splitPoint = 1; splitPoint < parts.length; splitPoint++) {
				const parentPath = parts.slice(0, splitPoint).join('_');
				const childPath = parts.slice(splitPoint).join('_');
				
				// Find the parent object
				const parentKey = this.findOriginalKeyWithSemantics(entity, parentPath);
				if (parentKey && entity[parentKey] && typeof entity[parentKey] === 'object' && !Array.isArray(entity[parentKey])) {
					const parentObj = entity[parentKey];
					
					// Find the child field in the parent object
					const childKey = this.findOriginalKeyWithSemantics(parentObj, childPath);
					if (childKey && parentObj.hasOwnProperty(childKey)) {
						return parentObj[childKey];
					}
					
					// Try direct child field access
					if (parentObj.hasOwnProperty(childPath)) {
						return parentObj[childPath];
					}
				}
			}
			
			// Fallback: traverse the nested structure step by step
			let current = entity;
			for (let i = 0; i < parts.length && current; i++) {
				const part = parts[i];
				
				// Try exact match first
				if (current.hasOwnProperty(part)) {
					current = current[part];
					continue;
				}
				
				// Try semantic mapping
				const semanticKey = this.findOriginalKeyWithSemantics(current, part);
				if (semanticKey && current.hasOwnProperty(semanticKey)) {
					current = current[semanticKey];
					continue;
				}
				
				// If we can't find this part, return undefined
				return undefined;
			}
			
			// Return the final value only if it's a scalar
			if (current !== null && typeof current !== 'object') {
				return current;
			}
		}
		
		return undefined;
	}

	private async insertJunctionTableRecords(data: any, schemas: Record<string, TableSchema>, sql: any): Promise<void> {
		// Find many-to-many relationships and create junction table records
		await this.discoverAndInsertManyToManyRelationships(data, schemas, sql);
	}

	private async discoverAndInsertManyToManyRelationships(obj: any, schemas: Record<string, TableSchema>, sql: any, path: string[] = []): Promise<void> {
		if (!obj || typeof obj !== 'object') return;
		
		// Handle arrays
		if (Array.isArray(obj)) {
			for (const item of obj) {
				await this.discoverAndInsertManyToManyRelationships(item, schemas, sql, path);
			}
			return;
		}
		
		// If this is an entity, check for array relationships
		if (this.isEntityOrCouldBeEntity(obj)) {
			const entityInfo = this.entityToRowMap.get(obj);
			if (entityInfo) {
				for (const [key, value] of Object.entries(obj)) {
					if (Array.isArray(value) && value.length > 0) {
						// Check if array contains entities
						const entityItems = value.filter(item => this.isEntityOrCouldBeEntity(item));
						if (entityItems.length > 0) {
							const firstItem = entityItems[0];
							const relatedEntityType = this.inferEntityType(firstItem, [key]);
							const junctionTableName = this.getJunctionTableName(entityInfo.tableName, relatedEntityType);
							
							if (schemas[junctionTableName]) {
								// Insert relationships for all entities in this array
								for (const relatedEntity of entityItems) {
									const relatedEntityInfo = this.entityToRowMap.get(relatedEntity);
									if (relatedEntityInfo) {
										const insertSQL = `INSERT OR IGNORE INTO ${junctionTableName} (${entityInfo.tableName}_id, ${relatedEntityInfo.tableName}_id) VALUES (?, ?)`;
										console.log(`Creating junction table relationship: ${insertSQL}`, [entityInfo.id, relatedEntityInfo.id]);
										try {
											sql.exec(insertSQL, entityInfo.id, relatedEntityInfo.id);
										} catch (error) {
											console.error(`Error creating junction relationship in ${junctionTableName}:`, error);
										}
									}
								}
							}
						}
					} else if (value && typeof value === 'object' && this.isEntityOrCouldBeEntity(value)) {
						// Handle one-to-one relationships that might need junction tables
						const relatedEntityInfo = this.entityToRowMap.get(value);
						if (relatedEntityInfo && relatedEntityInfo.tableName !== entityInfo.tableName) {
							const junctionTableName = this.getJunctionTableName(entityInfo.tableName, relatedEntityInfo.tableName);
							if (schemas[junctionTableName]) {
								const insertSQL = `INSERT OR IGNORE INTO ${junctionTableName} (${entityInfo.tableName}_id, ${relatedEntityInfo.tableName}_id) VALUES (?, ?)`;
								console.log(`Creating junction table relationship (1:1): ${insertSQL}`, [entityInfo.id, relatedEntityInfo.id]);
								try {
									sql.exec(insertSQL, entityInfo.id, relatedEntityInfo.id);
								} catch (error) {
									console.error(`Error creating junction relationship (1:1) in ${junctionTableName}:`, error);
								}
							}
						}
					}
				}
			}
		}
		
		// Recursively process nested objects
		for (const [key, value] of Object.entries(obj)) {
			await this.discoverAndInsertManyToManyRelationships(value, schemas, sql, [...path, key]);
		}
	}

	private getJunctionTableName(table1: string, table2: string): string {
		// Use the same logic as SchemaInferenceEngine for consistency
		return [table1, table2].sort().join('_');
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
			if (hasNonObjectFields) return true;
		}
		
		return false;
	}
	
	private inferEntityType(obj: any, path: string[]): string {
		// Try to infer from object keys first
		const keys = Object.keys(obj);
		
		// Look for type indicators in the object itself
		if (keys.includes('__typename')) {
			return this.sanitizeTableName(this.singularize(obj.__typename));
		}
		
		// Use path context
		if (path.length > 0) {
			const lastName = path[path.length - 1];
			// Skip GraphQL wrapper fields
			if (!this.isGraphQLWrapperField(lastName)) {
				return this.sanitizeTableName(this.singularize(lastName));
			}
			
			// If last name is wrapper, try previous
			if (path.length > 1) {
				const prevName = path[path.length - 2];
				if (!this.isGraphQLWrapperField(prevName)) {
					return this.sanitizeTableName(this.singularize(prevName));
				}
			}
		}
		
		// Look for entity indicator fields
		const entityIndicators = ['name', 'title', 'id', 'type', 'description'];
		for (const indicator of entityIndicators) {
			if (keys.includes(indicator)) {
				return this.sanitizeTableName(indicator + '_entity');
			}
		}
		
		// Fallback
		return this.sanitizeTableName('entity_' + Math.random().toString(36).substr(2, 6));
	}
	
	private isGraphQLWrapperField(fieldName: string): boolean {
		return ['edges', 'node', 'nodes', 'data', 'items', 'results', 'list'].includes(fieldName.toLowerCase());
	}
	
	private singularize(word: string): string {
		if (!word || typeof word !== 'string') return word;
		
		const singularRules: Array<[RegExp, string]> = [
			[/ies$/i, 'y'],
			[/([^aeiou])ies$/i, '$1y'],
			[/ves$/i, 'f'],
			[/([lr])ves$/i, '$1f'],
			[/([^f])ves$/i, '$1fe'],
			[/([^aeiouy]|qu)ies$/i, '$1y'],
			[/s$/i, ''],
		];
		
		for (const [pattern, replacement] of singularRules) {
			if (pattern.test(word)) {
				return word.replace(pattern, replacement);
			}
		}
		
		return word;
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
		if (!obj || typeof obj !== 'object') return null;
		
		const keys = Object.keys(obj);
		
		// First try exact match (case-insensitive)
		let exactMatch = keys.find(k => k.toLowerCase() === sanitizedKey.toLowerCase());
		if (exactMatch) return exactMatch;
		
		// Then try semantic mapping (reverse lookup)
		const semanticKey = this.getSemanticColumnName(sanitizedKey);
		if (semanticKey !== sanitizedKey) {
			exactMatch = keys.find(k => k.toLowerCase() === semanticKey.toLowerCase());
			if (exactMatch) return exactMatch;
		}
		
		// Try finding original key through reverse mapping
		for (const [original, mapped] of this.semanticMappings.entries()) {
			if (mapped === sanitizedKey || mapped === semanticKey) {
				exactMatch = keys.find(k => k.toLowerCase() === original);
				if (exactMatch) return exactMatch;
			}
		}
		
		// Try partial matches and common variations
		return this.findOriginalKey(obj, sanitizedKey);
	}
	
	private getSemanticColumnName(originalName: string): string {
		return this.semanticMappings.get(originalName.toLowerCase()) || originalName;
	}
	
	private findOriginalKey(obj: any, sanitizedKey: string): string | null {
		if (!obj || typeof obj !== 'object') return null;
		
		const keys = Object.keys(obj);
		const cleanSanitized = sanitizedKey.toLowerCase().replace(/_/g, '');
		
		// Try to find a key that matches when underscores and casing are ignored
		for (const key of keys) {
			const cleanKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
			if (cleanKey === cleanSanitized) {
				return key;
			}
		}
		
		return null;
	}
	
	private sanitizeColumnName(name: string): string {
		if (!name || typeof name !== 'string') {
			return 'col_' + Math.random().toString(36).substr(2, 9);
		}
		
		let sanitized = name
			.replace(/[^a-zA-Z0-9_]/g, '_')
			.replace(/_{2,}/g, '_')
			.replace(/^_|_$/g, '')
			.toLowerCase();
		
		if (/^[0-9]/.test(sanitized)) {
			sanitized = 'col_' + sanitized;
		}
		
		if (!sanitized || sanitized.length === 0) {
			sanitized = 'col_' + Math.random().toString(36).substr(2, 9);
		}
		
		const reservedWords = [
			'abort', 'action', 'add', 'after', 'all', 'alter', 'analyze', 'and', 'as', 'asc',
			'attach', 'autoincrement', 'before', 'begin', 'between', 'by', 'cascade', 'case',
			'cast', 'check', 'collate', 'column', 'commit', 'conflict', 'constraint', 'create',
			'cross', 'current_date', 'current_time', 'current_timestamp', 'database', 'default',
			'deferrable', 'deferred', 'delete', 'desc', 'detach', 'distinct', 'drop', 'each',
			'else', 'end', 'escape', 'except', 'exclusive', 'exists', 'explain', 'fail', 'for',
			'foreign', 'from', 'full', 'glob', 'group', 'having', 'if', 'ignore', 'immediate',
			'in', 'index', 'indexed', 'initially', 'inner', 'insert', 'instead', 'intersect',
			'into', 'is', 'isnull', 'join', 'key', 'left', 'like', 'limit', 'match', 'natural',
			'no', 'not', 'notnull', 'null', 'of', 'offset', 'on', 'or', 'order', 'outer', 'plan',
			'pragma', 'primary', 'query', 'raise', 'recursive', 'references', 'regexp', 'reindex',
			'release', 'rename', 'replace', 'restrict', 'right', 'rollback', 'row', 'savepoint',
			'select', 'set', 'table', 'temp', 'temporary', 'then', 'to', 'transaction', 'trigger',
			'union', 'unique', 'update', 'using', 'vacuum', 'values', 'view', 'virtual', 'when',
			'where', 'with', 'without'
		];
		
		if (reservedWords.includes(sanitized)) {
			sanitized = sanitized + '_col';
		}
		
		return sanitized;
	}
	
	private async insertSimpleRow(obj: any, tableName: string, schema: TableSchema, sql: any): Promise<void> {
		const rowData = this.mapObjectToSimpleSchema(obj, schema, tableName);
		if (Object.keys(rowData).length === 0) return;
		
		const columns = Object.keys(rowData);
		const placeholders = columns.map(() => '?').join(', ');
		const values = Object.values(rowData);
		
		const insertSQL = `INSERT OR IGNORE INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
		sql.exec(insertSQL, ...values);
	}
	
	private mapObjectToSimpleSchema(obj: any, schema: TableSchema, tableName: string): any {
		const rowData: any = {};
		
		for (const columnName of Object.keys(schema.columns)) {
			if (columnName === 'id' && schema.columns[columnName].includes('AUTOINCREMENT')) {
				continue;
			}
			
			let value = null;
			if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
				const originalKey = this.findOriginalKeyWithSemantics(obj, columnName);
				if (originalKey && obj[originalKey] !== undefined) {
					value = obj[originalKey];
					if (typeof value === 'boolean') value = value ? 1 : 0;
					if (typeof value === 'object') value = JSON.stringify(value);
				}
			} else if (columnName === 'value') {
				value = obj;
			}
			
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
} 