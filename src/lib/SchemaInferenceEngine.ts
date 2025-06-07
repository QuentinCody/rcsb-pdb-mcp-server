import { TableSchema } from "./types.js";

// Enhanced schema inference engine with improved intelligence and consistency
export class SchemaInferenceEngine {
	private discoveredEntities: Map<string, any[]> = new Map();
	private entityRelationships: Map<string, Set<string>> = new Map();
	private semanticMappings: Map<string, string> = new Map();
	private typeMappings: Map<string, string> = new Map();
	private indexSuggestions: Map<string, string[]> = new Map();
	
	constructor() {
		this.initializeSemanticMappings();
		this.initializeTypeMappings();
	}
	
	private initializeSemanticMappings(): void {
		// GraphQL field name -> Semantic column name mappings
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
	
	private initializeTypeMappings(): void {
		// Field name patterns -> SQLite type mappings
		const patterns: Record<string, string> = {
			// ID patterns
			'_id$': 'INTEGER',
			'^id$': 'TEXT PRIMARY KEY',
			'taxonomy_id': 'INTEGER',
			'entity_id': 'TEXT',
			'comp_id': 'TEXT',
			
			// Numeric patterns
			'weight': 'REAL',
			'resolution': 'REAL',
			'temperature': 'REAL',
			'ph': 'REAL',
			'length': 'REAL',
			'count': 'INTEGER',
			'number': 'INTEGER',
			'index': 'INTEGER',
			'rank': 'INTEGER',
			'score': 'REAL',
			'percentage': 'REAL',
			
			// Date patterns
			'_date$': 'DATE',
			'_time$': 'DATETIME',
			'_at$': 'DATETIME',
			'timestamp': 'DATETIME',
			
			// Boolean patterns
			'is_': 'INTEGER',
			'has_': 'INTEGER',
			'can_': 'INTEGER',
			'active': 'INTEGER',
			'enabled': 'INTEGER',
			'visible': 'INTEGER',
			
			// Text patterns
			'description': 'TEXT',
			'title': 'TEXT',
			'name': 'TEXT',
			'comment': 'TEXT',
			'note': 'TEXT',
			'summary': 'TEXT',
			'sequence': 'TEXT',
			'formula': 'TEXT',
			'smiles': 'TEXT',
			'inchi': 'TEXT',
			'url': 'TEXT',
			'uri': 'TEXT',
			'email': 'TEXT',
			'phone': 'TEXT',
		};
		
		for (const [pattern, type] of Object.entries(patterns)) {
			this.typeMappings.set(pattern, type);
		}
	}
	
	inferFromJSON(data: any): Record<string, TableSchema> {
		// Clear previous state
		this.discoveredEntities.clear();
		this.entityRelationships.clear();
		
		// Initialize with empty schemas object
		const schemas: Record<string, TableSchema> = {};
		
		if (data === null || data === undefined) {
			return schemas;
		}
		
		// Force aggressive entity extraction for complex structure
		this.forceEntityExtraction(data, schemas);
		
		// Process discovered entities
		if (this.discoveredEntities.size > 0) {
			this.createSchemasFromEntities(schemas);
			this.createJunctionTableSchemas(schemas);
			this.addRelationalConstraints(schemas);
			this.addIndexSuggestions(schemas);
		} else if (this.isPrimitiveData(data)) {
			// Handle primitive or simple data
			schemas['data'] = this.createSchemaFromPrimitiveOrSimpleArray(data, 'data');
		} else {
			// Single object case
			schemas['entry'] = this.createSchemaFromObject(data, 'entry');
		}
		
		return schemas;
	}
	
	private isPrimitiveData(data: any): boolean {
		if (Array.isArray(data)) {
			return data.length === 0 || data.every(item => 
				typeof item !== 'object' || item === null
			);
		}
		return typeof data !== 'object' || data === null;
	}
	
	private forceEntityExtraction(data: any, schemas: Record<string, TableSchema>): void {
		// Use aggressive entity discovery first
		this.discoverEntitiesAggressively(data, []);
		
		// If that didn't find entities, fall back to forced extraction
		if (this.discoveredEntities.size === 0) {
			if (Array.isArray(data) && data.length > 0) {
				// Check if array items have common structure
				const firstItem = data[0];
				if (typeof firstItem === 'object' && firstItem !== null) {
					const entityType = this.generateEntityName([], Object.keys(firstItem));
					this.discoveredEntities.set(entityType, data);
					return;
				}
			}
			
			if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
				// Check for nested arrays or objects that could be entities
				for (const [key, value] of Object.entries(data)) {
					if (Array.isArray(value) && value.length > 0) {
						const firstItem = value[0];
						if (typeof firstItem === 'object' && firstItem !== null) {
							const entityType = this.generateEntityName([key], Object.keys(firstItem));
							this.discoveredEntities.set(entityType, value);
							
							// Record relationship if this is nested under a parent entity
							if (Object.keys(data).some(k => ['id', 'rcsb_id', '_id'].includes(k))) {
								const parentEntityType = this.generateEntityName([], Object.keys(data));
								this.discoveredEntities.set(parentEntityType, [data]);
								this.recordRelationship(parentEntityType, entityType);
							}
						}
					}
				}
				
				if (this.discoveredEntities.size === 0) {
					// Last resort: create a main table from the root object
					const entityType = 'entry';  // Use 'entry' for PDB data
					this.discoveredEntities.set(entityType, [data]);
				}
			}
		}
	}
	
	private generateEntityName(path: string[], objectKeys: string[]): string {
		// Use path context
		if (path.length > 0) {
			const lastName = path[path.length - 1];
			return this.sanitizeTableName(this.singularize(lastName));
		}
		
		// Use object structure hints
		if (objectKeys.includes('id') || objectKeys.includes('rcsb_id')) {
			if (objectKeys.includes('title') || objectKeys.includes('name')) {
				return 'entity';
			}
			if (objectKeys.includes('sequence')) {
				return 'sequence_entity';
			}
			if (objectKeys.includes('formula')) {
				return 'chemical_compound';
			}
		}
		
		return 'extracted_entity';
	}
	
	private discoverEntitiesAggressively(obj: any, path: string[], parentEntityType?: string): void {
		if (!obj || typeof obj !== 'object') return;

		if (Array.isArray(obj)) {
			if (obj.length > 0) {
				// Check if items are entities or could be treated as entities
				const sampleItem = obj[0];
				if (this.isEntityOrCouldBeEntity(sampleItem)) {
					const arrayEntityType = this.inferEntityType(sampleItem, path);
					
					// Process all items
					for (const item of obj) {
						if (this.isEntityOrCouldBeEntity(item)) {
							const entitiesOfType = this.discoveredEntities.get(arrayEntityType) || [];
							entitiesOfType.push(item);
							this.discoveredEntities.set(arrayEntityType, entitiesOfType);
							
							// Record parent-child relationship
							if (parentEntityType && path.length > 0) {
								const fieldName = path[path.length - 1];
								if (!this.isGraphQLWrapperField(fieldName)) {
									this.recordRelationship(parentEntityType, arrayEntityType);
								}
							}
							
							this.processEntityProperties(item, arrayEntityType);
						}
					}
				}
			}
			return;
		}

		// Handle GraphQL edges pattern
		if (obj.edges && Array.isArray(obj.edges)) {
			const nodes = obj.edges.map((edge: any) => edge.node).filter(Boolean);
			if (nodes.length > 0) {
				this.discoverEntitiesAggressively(nodes, path, parentEntityType);
			}
			return;
		}

		// Process individual entities with looser criteria
		if (this.isEntityOrCouldBeEntity(obj)) {
			const entityType = this.inferEntityType(obj, path);
			
			const entitiesOfType = this.discoveredEntities.get(entityType) || [];
			entitiesOfType.push(obj);
			this.discoveredEntities.set(entityType, entitiesOfType);
			
			this.processEntityProperties(obj, entityType);
			return;
		}

		// Recursively explore nested objects
		for (const [key, value] of Object.entries(obj)) {
			this.discoverEntitiesAggressively(value, [...path, key], parentEntityType);
		}
	}
	
	private isEntityOrCouldBeEntity(obj: any): boolean {
		if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
		
		const keys = Object.keys(obj);
		const hasId = keys.includes('id') || keys.includes('_id') || keys.includes('rcsb_id');
		const fieldCount = keys.length;
		
		// Stricter entity criteria but with fallbacks
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
	
	private isGraphQLWrapperField(fieldName: string): boolean {
		return ['nodes', 'edges', 'node', 'data', 'items', 'results'].includes(fieldName.toLowerCase());
	}
	
	private processEntityProperties(entity: any, entityType: string): void {
		for (const [key, value] of Object.entries(entity)) {
			if (Array.isArray(value) && value.length > 0) {
				const firstItem = value.find(item => this.isEntityOrCouldBeEntity(item));
				if (firstItem) {
					const relatedEntityType = this.inferEntityType(firstItem, [key]);
					this.recordRelationship(entityType, relatedEntityType);
					
					value.forEach(item => {
						if (this.isEntityOrCouldBeEntity(item)) {
							const entitiesOfType = this.discoveredEntities.get(relatedEntityType) || [];
							entitiesOfType.push(item);
							this.discoveredEntities.set(relatedEntityType, entitiesOfType);
							
							this.processEntityProperties(item, relatedEntityType);
						}
					});
				}
			} else if (value && typeof value === 'object' && this.isEntityOrCouldBeEntity(value)) {
				const relatedEntityType = this.inferEntityType(value, [key]);
				this.recordRelationship(entityType, relatedEntityType);
				
				const entitiesOfType = this.discoveredEntities.get(relatedEntityType) || [];
				entitiesOfType.push(value);
				this.discoveredEntities.set(relatedEntityType, entitiesOfType);
				
				this.processEntityProperties(value, relatedEntityType);
			}
		}
	}
	
	private inferEntityType(obj: any, path: string[]): string {
		// Try semantic type hints first
		if (obj.__typename) return this.sanitizeTableName(obj.__typename);
		if (obj.type && typeof obj.type === 'string' && !this.isGraphQLWrapperField(obj.type)) {
			return this.sanitizeTableName(obj.type);
		}
		
		// Infer from path context with better singularization
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
		
		// Fallback naming
		return 'entity_' + Math.random().toString(36).substr(2, 9);
	}
	
	private singularize(word: string): string {
		const sanitized = this.sanitizeTableName(word);
		
		// Common English pluralization patterns
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
			// Common exceptions to removing 's'
			const exceptions = ['genus', 'species', 'series', 'analysis', 'basis', 'axis'];
			if (!exceptions.includes(sanitized)) {
				return sanitized.slice(0, -1);
			}
		}
		
		return sanitized;
	}
	
	private recordRelationship(fromTable: string, toTable: string): void {
		if (fromTable === toTable) return;
		
		const fromRelationships = this.entityRelationships.get(fromTable) || new Set();
		const toRelationships = this.entityRelationships.get(toTable) || new Set();
		
		if (!fromRelationships.has(toTable) && !toRelationships.has(fromTable)) {
			fromRelationships.add(toTable);
			this.entityRelationships.set(fromTable, fromRelationships);
		}
	}
	
	private createSchemasFromEntities(schemas: Record<string, TableSchema>): void {
		for (const [entityType, entities] of this.discoveredEntities.entries()) {
			const tableName = this.sanitizeTableName(entityType);
			
			if (entities.length === 0) continue;
			
			const columnTypes: Record<string, Set<string>> = {};
			const sampleData: any[] = [];
			
			// Extract fields from first few entities
			const sampleSize = Math.min(entities.length, 3);
			for (let i = 0; i < sampleSize; i++) {
				const rowData = this.extractEntityFields(entities[i], columnTypes, entityType);
				sampleData.push(rowData);
			}
			
			// Process remaining entities to continue type discovery
			for (let i = sampleSize; i < entities.length; i++) {
				this.extractEntityFields(entities[i], columnTypes, entityType);
			}
			
			const columns = this.resolveColumnTypes(columnTypes, tableName);
			this.ensureIdColumn(columns, tableName);
			
			schemas[tableName] = {
				columns,
				sample_data: sampleData
			};
			
			// Add foreign key columns for related entities
			const relatedTables = this.entityRelationships.get(tableName);
			if (relatedTables) {
				for (const relatedTable of relatedTables) {
					this.addForeignKeyColumn(schemas[tableName], relatedTable, tableName);
				}
			}
			
			this.suggestIndexesForTable(tableName, columns);
		}
	}
	
	private extractEntityFields(obj: any, columnTypes: Record<string, Set<string>>, entityType: string): any {
		const rowData: any = {};
		
		if (!obj || typeof obj !== 'object') {
			this.addColumnType(columnTypes, 'value', this.getSQLiteType(obj));
			return { value: obj };
		}
		
		for (const [key, value] of Object.entries(obj)) {
			const semanticName = this.getSemanticColumnName(key);
			const columnName = this.sanitizeColumnName(semanticName);
			
			if (Array.isArray(value)) {
				if (value.length > 0 && this.isEntityOrCouldBeEntity(value[0])) {
					// Skip - handled as relationships
					continue;
				} else if (value.length <= 10 && value.every(v => typeof v !== 'object' || v === null)) {
					// Store small primitive arrays as JSON
					this.addColumnType(columnTypes, columnName, 'JSON');
					rowData[columnName] = JSON.stringify(value);
				} else {
					// Store large or complex arrays as JSON
					this.addColumnType(columnTypes, columnName, 'JSON');
					rowData[columnName] = JSON.stringify(value);
				}
			} else if (value && typeof value === 'object') {
				if (this.isEntityOrCouldBeEntity(value)) {
					// Create foreign key relationship
					const foreignKeyColumn = columnName + '_id';
					const inferredType = this.inferTypeFromName(foreignKeyColumn) || 'INTEGER';
					this.addColumnType(columnTypes, foreignKeyColumn, inferredType);
					// Don't set the foreign key value here - let DataInsertionEngine handle it
				} else {
					// Always extract nested scalar fields from ANY nested object
					const nestedFields = this.extractNestedScalarFields(value, columnName);
					for (const [nestedColumn, nestedValue] of Object.entries(nestedFields)) {
						const inferredType = this.inferTypeFromName(nestedColumn) || this.getSQLiteType(nestedValue);
						this.addColumnType(columnTypes, nestedColumn, inferredType);
						rowData[nestedColumn] = typeof nestedValue === 'boolean' ? (nestedValue ? 1 : 0) : nestedValue;
					}
					
					// Only store as JSON if it has complex nested structure AND we got no useful fields
					if (Object.keys(nestedFields).length === 0 || this.hasComplexNestedStructure(value)) {
						this.addColumnType(columnTypes, columnName + '_json', 'JSON');
						rowData[columnName + '_json'] = JSON.stringify(value);
					}
				}
			} else {
				// Scalar values
				const inferredType = this.inferTypeFromName(columnName) || this.getSQLiteType(value);
				this.addColumnType(columnTypes, columnName, inferredType);
				rowData[columnName] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
			}
		}
		
		return rowData;
	}
	
	private extractNestedScalarFields(obj: any, parentKey: string): Record<string, any> {
		const fields: Record<string, any> = {};
		
		if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
			return fields;
		}
		
		for (const [key, value] of Object.entries(obj)) {
			const semanticSubKey = this.getSemanticColumnName(key);
			const prefixedColumn = parentKey + '_' + this.sanitizeColumnName(semanticSubKey);
			
			if (value === null || typeof value !== 'object') {
				// Direct scalar value - always extract
				fields[prefixedColumn] = value;
			} else if (Array.isArray(value)) {
				// Handle primitive arrays
				if (value.length <= 5 && value.every(v => typeof v !== 'object' || v === null)) {
					fields[prefixedColumn] = JSON.stringify(value);
				}
			} else {
				// Nested object - go deeper if it looks like it has useful scalar data
				if (this.hasOnlyScalarFields(value)) {
					// Extract all scalar fields from this nested object
					const nestedFields = this.extractNestedScalarFields(value, prefixedColumn);
					Object.assign(fields, nestedFields);
				} else {
					// If mixed content, still try to extract scalar fields at this level
					for (const [nestedKey, nestedValue] of Object.entries(value)) {
						if (nestedValue === null || typeof nestedValue !== 'object') {
							const nestedColumnName = prefixedColumn + '_' + this.sanitizeColumnName(this.getSemanticColumnName(nestedKey));
							fields[nestedColumnName] = nestedValue;
						}
					}
				}
			}
		}
		
		return fields;
	}
	
	private isImportantPDBField(fieldName: string): boolean {
		const importantFields = [
			'entity_poly', 'rcsb_polymer_entity', 'rcsb_entry_info', 'struct', 
			'exptl', 'cell', 'symmetry', 'diffrn', 'reflns', 'chem_comp',
			'rcsb_chem_comp_descriptor', 'nonpolymer_comp', 'citation'
		];
		return importantFields.includes(fieldName.toLowerCase());
	}
	
	private hasComplexNestedStructure(obj: any): boolean {
		if (!obj || typeof obj !== 'object') return false;
		
		// Check if object has nested objects or arrays of objects
		for (const value of Object.values(obj)) {
			if (Array.isArray(value) && value.some(item => typeof item === 'object' && item !== null)) {
				return true;
			}
			if (typeof value === 'object' && value !== null && !this.hasOnlyScalarFields(value)) {
				return true;
			}
		}
		return false;
	}
	
	private hasOnlyScalarFields(obj: any): boolean {
		if (!obj || typeof obj !== 'object') return false;
		const values = Object.values(obj);
		return values.length <= 10 && values.every(value => 
			typeof value !== 'object' || value === null || 
			(Array.isArray(value) && value.every(v => typeof v !== 'object' || v === null))
		);
	}
	
	private getSemanticColumnName(originalName: string): string {
		const lower = originalName.toLowerCase();
		return this.semanticMappings.get(lower) || originalName;
	}
	
	private inferTypeFromName(columnName: string): string | null {
		const lower = columnName.toLowerCase();
		
		// Check exact matches first
		for (const [pattern, type] of this.typeMappings.entries()) {
			if (pattern.startsWith('^') && pattern.endsWith('$')) {
				// Exact regex match
				const regex = new RegExp(pattern);
				if (regex.test(lower)) return type;
			} else if (pattern.startsWith('_') && pattern.endsWith('$')) {
				// Suffix match
				if (lower.endsWith(pattern.slice(1, -1))) return type;
			} else if (pattern.startsWith('^')) {
				// Prefix match
				if (lower.startsWith(pattern.slice(1))) return type;
			} else {
				// Contains match
				if (lower.includes(pattern)) return type;
			}
		}
		
		return null;
	}
	
	private createJunctionTableSchemas(schemas: Record<string, TableSchema>): void {
		const junctionTables = new Set<string>();
		
		for (const [fromTable, relatedTables] of this.entityRelationships.entries()) {
			for (const toTable of relatedTables) {
				const junctionName = [fromTable, toTable].sort().join('_');
				
				if (!junctionTables.has(junctionName)) {
					junctionTables.add(junctionName);
					
					schemas[junctionName] = {
						columns: {
							id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
							[`${fromTable}_id`]: `INTEGER REFERENCES ${fromTable}(id)`,
							[`${toTable}_id`]: `INTEGER REFERENCES ${toTable}(id)`
						},
						sample_data: []
					};
				}
			}
		}
	}
	
	private addRelationalConstraints(schemas: Record<string, TableSchema>): void {
		// Add foreign key constraints to existing columns
		for (const [tableName, schema] of Object.entries(schemas)) {
			for (const [columnName, columnType] of Object.entries(schema.columns)) {
				if (columnName.endsWith('_id') && !columnType.includes('REFERENCES') && !columnType.includes('PRIMARY KEY')) {
					const referencedTable = columnName.slice(0, -3);
					if (schemas[referencedTable]) {
						schema.columns[columnName] = `${columnType} REFERENCES ${referencedTable}(id)`;
					}
				}
			}
		}
	}
	
	private suggestIndexesForTable(tableName: string, columns: Record<string, string>): void {
		const indexes: string[] = [];
		
		for (const columnName of Object.keys(columns)) {
			// Index foreign keys
			if (columnName.endsWith('_id')) {
				indexes.push(`CREATE INDEX idx_${tableName}_${columnName} ON ${tableName}(${columnName})`);
			}
			
			// Index common search fields
			if (['name', 'title', 'type', 'organism_name', 'resolution'].includes(columnName)) {
				indexes.push(`CREATE INDEX idx_${tableName}_${columnName} ON ${tableName}(${columnName})`);
			}
			
			// Index date fields
			if (columnName.includes('date') || columnName.includes('time')) {
				indexes.push(`CREATE INDEX idx_${tableName}_${columnName} ON ${tableName}(${columnName})`);
			}
		}
		
		if (indexes.length > 0) {
			this.indexSuggestions.set(tableName, indexes);
		}
	}
	
	private addIndexSuggestions(schemas: Record<string, TableSchema>): void {
		// Add index suggestions as metadata to schemas
		for (const [tableName, schema] of Object.entries(schemas)) {
			const suggestions = this.indexSuggestions.get(tableName);
			if (suggestions && suggestions.length > 0) {
				(schema as any).suggested_indexes = suggestions;
			}
		}
	}
	
	private createSchemaFromPrimitiveOrSimpleArray(data: any, tableName: string): TableSchema {
		const columnTypes: Record<string, Set<string>> = {};
		const sampleData: any[] = [];
		
		if (Array.isArray(data)) {
			data.slice(0,3).forEach(item => {
				const row = this.extractSimpleFields(item, columnTypes);
				sampleData.push(row);
			});
			if (data.length > 3) {
				data.slice(3).forEach(item => this.extractSimpleFields(item, columnTypes));
			}
		} else {
			const row = this.extractSimpleFields(data, columnTypes);
			sampleData.push(row);
		}
		
		const columns = this.resolveColumnTypes(columnTypes, tableName);
		if (!Object.keys(columns).includes('id') && !Object.keys(columns).includes('value')) {
			const colNames = Object.keys(columns);
			if(colNames.length === 1 && colNames[0] !== 'value'){
				columns['value'] = columns[colNames[0]];
				delete columns[colNames[0]];
				sampleData.forEach(s => { s['value'] = s[colNames[0]]; delete s[colNames[0]]; });
			}
		}
		if (Object.keys(columns).length === 0 && data === null) {
		    columns['value'] = 'TEXT';
		}

		return { columns, sample_data: sampleData };
	}

	private createSchemaFromObject(obj: any, tableName: string): TableSchema {
		const columnTypes: Record<string, Set<string>> = {};
		const rowData = this.extractSimpleFields(obj, columnTypes);
		const columns = this.resolveColumnTypes(columnTypes, tableName);
		return { columns, sample_data: [rowData] };
	}

	private extractSimpleFields(obj: any, columnTypes: Record<string, Set<string>>): any {
		const rowData: any = {};
		
		if (obj === null || typeof obj !== 'object') {
			this.addColumnType(columnTypes, 'value', this.getSQLiteType(obj));
			return { value: obj };
		}
		
		if (Array.isArray(obj)) {
			this.addColumnType(columnTypes, 'array_data_json', 'TEXT');
			return { array_data_json: JSON.stringify(obj) };
		}

		for (const [key, value] of Object.entries(obj)) {
			const semanticName = this.getSemanticColumnName(key);
			const columnName = this.sanitizeColumnName(semanticName);
			
			if (value === null || typeof value !== 'object') {
				const inferredType = this.inferTypeFromName(columnName) || this.getSQLiteType(value);
				this.addColumnType(columnTypes, columnName, inferredType);
				rowData[columnName] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
			} else {
				this.addColumnType(columnTypes, columnName + '_json', 'TEXT');
				rowData[columnName + '_json'] = JSON.stringify(value);
			}
		}
		return rowData;
	}
	
	private addColumnType(columnTypes: Record<string, Set<string>>, column: string, type: string): void {
		if (!columnTypes[column]) columnTypes[column] = new Set();
		columnTypes[column].add(type);
	}
	
	private resolveColumnTypes(columnTypes: Record<string, Set<string>>, tableName?: string): Record<string, string> {
		const columns: Record<string, string> = {};
		
		for (const [columnName, types] of Object.entries(columnTypes)) {
			if (types.size === 1) {
				columns[columnName] = Array.from(types)[0];
			} else {
				// Mixed types - prefer in order: DATE > TEXT > REAL > INTEGER
				if (types.has('DATE')) columns[columnName] = 'DATE';
				else if (types.has('DATETIME')) columns[columnName] = 'DATETIME';
				else if (types.has('TEXT')) columns[columnName] = 'TEXT';
				else if (types.has('JSON')) columns[columnName] = 'JSON';
				else if (types.has('REAL')) columns[columnName] = 'REAL';
				else columns[columnName] = 'INTEGER';
			}
		}
		
		return columns;
	}
	
	private ensureIdColumn(columns: Record<string, string>, tableName?: string): void {
		if (!columns.id) {
			columns.id = "INTEGER PRIMARY KEY AUTOINCREMENT";
		} else if (columns.id === "INTEGER") {
			columns.id = "INTEGER PRIMARY KEY";
		} else if (columns.id === "TEXT PRIMARY KEY") {
			// Keep as is - natural primary key
		}
	}
	
	private getSQLiteType(value: any): string {
		if (value === null || value === undefined) return "TEXT";
		switch (typeof value) {
			case 'number': return Number.isInteger(value) ? "INTEGER" : "REAL";
			case 'boolean': return "INTEGER";
			case 'string': 
				// Check for date-like strings
				if (this.isDateLike(value)) return "DATE";
				return "TEXT";
			default: return "TEXT";
		}
	}
	
	private isDateLike(value: string): boolean {
		// Simple date pattern detection
		const datePatterns = [
			/^\d{4}-\d{2}-\d{2}$/,                    // YYYY-MM-DD
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,  // ISO datetime
			/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/,  // SQL datetime
		];
		
		return datePatterns.some(pattern => pattern.test(value));
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
	
	private sanitizeColumnName(name: string): string {
		if (!name || typeof name !== 'string') {
			return 'column_' + Math.random().toString(36).substr(2, 9);
		}
		
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
		
		// Enhanced PDB terms mapping
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

	private addForeignKeyColumn(schema: TableSchema, referencedTableName: string, parentTableName: string): void {
		const foreignKeyColumn = `${referencedTableName}_id`;
		
		// Only add if not already present
		if (!schema.columns[foreignKeyColumn]) {
			schema.columns[foreignKeyColumn] = `INTEGER REFERENCES ${referencedTableName}(id)`;
			schema.relationships = schema.relationships || {};
			schema.relationships[foreignKeyColumn] = {
				type: 'foreign_key',
				target_table: referencedTableName,
				foreign_key_column: foreignKeyColumn
			};
			console.log(`Added foreign key column: ${parentTableName}.${foreignKeyColumn} -> ${referencedTableName}(id)`);
		}
	}
} 