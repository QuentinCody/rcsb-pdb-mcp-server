# RCSB-PDB MCP Server Tool Evaluation Framework

## Overview

This framework provides comprehensive instructions and evaluation tests for two critical tools in the rcsb-pdb-mcp-server:

1. **`rcsb_pdb_graphql_query`** - Data Ingestion & Staging Tool
2. **`rcsb_pdb_query_sql`** - Data Querying Tool

## Tool Requirements Specification

### Tool #1: `rcsb_pdb_graphql_query`

**Purpose**: Execute GraphQL queries against the RCSB PDB Data API, convert JSON responses into properly structured SQLite tables, and return metadata for subsequent SQL operations.

**Critical Requirements**:

1. **GraphQL Execution**: Must execute valid GraphQL queries against `https://data.rcsb.org/graphql`
2. **Response Processing**: Must handle RCSB PDB API responses correctly
3. **Schema Inference**: Must infer proper relational schemas from GraphQL JSON responses
4. **Entity Extraction**: Must correctly identify and extract entities from complex PDB data structures
5. **Table Creation**: Must create SQLite tables with proper column types and constraints
6. **Relationship Mapping**: Must properly map foreign key relationships between related entities
7. **Data Insertion**: Must insert individual records as separate rows with proper foreign key references
8. **Junction Table Handling**: Must create and populate junction tables for many-to-many relationships
9. **Metadata Generation**: Must return comprehensive metadata about created tables and schema
10. **Error Handling**: Must provide detailed error messages for failures
11. **Complex Object Decomposition**: Must decompose nested PDB objects into relational structures

**Input Format**:
```json
{
  "query": "GraphQL query string",
  "variables": {} // Optional GraphQL variables
}
```

**Expected Output Format**:
```json
{
  "success": true,
  "message": "descriptive message",
  "data_access_id": "unique-identifier-for-this-dataset",
  "processing_details": {
    "tables_created": ["entry", "polymer_entity", "citation"],
    "total_rows_inserted": 123,
    "relationships_created": 15,
    "junction_tables": ["entry_citation", "entity_polymer_entity_instance"]
  },
  "schemas": {
    "entry": {
      "columns": {"id": "INTEGER PRIMARY KEY", "struct_title": "TEXT", "resolution": "REAL"},
      "row_count": 10,
      "foreign_keys": {"polymer_entity_id": "polymer_entity(id)"},
      "sample_data": [...]
    }
  },
  "table_count": 5,
  "total_rows": 123
}
```

### Tool #2: `rcsb_pdb_query_sql`

**Purpose**: Execute SQL queries against SQLite data staged by Tool #1.

**Critical Requirements**:

1. **SQL Execution**: Must execute valid SQL SELECT statements
2. **Data Access**: Must access data using the `data_access_id` from Tool #1
3. **Result Formatting**: Must return results in structured JSON format
4. **Complex Query Support**: Must handle JOINs, aggregations, and analytical queries
5. **Security**: Must reject non-SELECT queries
6. **Error Handling**: Must provide detailed error messages for SQL errors
7. **Performance**: Must handle complex structural biology queries efficiently

**Input Format**:
```json
{
  "data_access_id": "identifier-from-tool-1",
  "sql": "SELECT statement",
  "params": [] // Optional parameterized query values
}
```

**Expected Output Format**:
```json
{
  "success": true,
  "results": [
    {"entry_id": "4HHB", "resolution": 1.74, "method": "X-RAY DIFFRACTION"},
    {"entry_id": "1CRN", "resolution": 1.5, "method": "X-RAY DIFFRACTION"}
  ],
  "row_count": 2,
  "column_names": ["entry_id", "resolution", "method"]
}
```

## Comprehensive Test Suite

### Test Category 1: Basic PDB Entity Tests

#### Test 1.1: Simple Entry Query
**Purpose**: Verify basic GraphQL query execution and single entry handling.

**Query**:
```graphql
{
  entry(entry_id: "4HHB") {
    rcsb_id
    struct {
      title
    }
    rcsb_entry_info {
      resolution_combined
      experimental_method
    }
  }
}
```

**Required Validations**:
1. Tool returns `success: true`
2. Creates tables for `entry` and `rcsb_entry_info`
3. Entry table has columns: `id` (TEXT), `struct_title` (TEXT)
4. Entry info table has proper resolution and method fields
5. Foreign key relationship established between tables
6. SQL query `SELECT e.struct_title, r.resolution FROM entry e JOIN rcsb_entry_info r ON e.entry_info_id = r.id` works

**Failure Conditions**:
- Foreign key columns are NULL
- Related tables are empty
- Cannot perform JOIN operations

#### Test 1.2: Multiple Entries Query
**Purpose**: Verify handling of multiple entries in single query.

**Query**:
```graphql
{
  entries(entry_ids: ["4HHB", "1CRN", "2PPN"]) {
    rcsb_id
    struct {
      title
    }
    exptl {
      method
    }
  }
}
```

**Required Validations**:
1. Creates exactly 1 table named `entry`
2. Inserts exactly 3 rows (one per entry)
3. Each row contains different entry data
4. Experimental method data properly extracted from JSON or related table
5. SQL query `SELECT COUNT(DISTINCT rcsb_id) FROM entry` returns 3
6. All entries have valid experimental methods

### Test Category 2: Complex Structural Relationships

#### Test 2.1: Entry-Entity Relationships
**Purpose**: Verify proper handling of entry-to-entity relationships.

**Query**:
```graphql
{
  entry(entry_id: "4HHB") {
    rcsb_id
    struct {
      title
    }
    polymer_entities {
      rcsb_id
      entity_poly {
        type
      }
      rcsb_polymer_entity {
        formula_weight
      }
    }
  }
}
```

**Required Validations**:
1. Creates separate tables for `entry` and `polymer_entity`
2. Establishes proper foreign key relationships
3. Entry has foreign key references to its polymer entities
4. Junction table created for many-to-many relationships if needed
5. Can query entities for specific entry using JOINs
6. No polymer entity data stored as JSON blobs

**Critical SQL Validation**:
```sql
-- This query must work and return hemoglobin entities
SELECT e.struct_title, pe.entity_poly_type, pe.formula_weight
FROM entry e
JOIN entry_polymer_entity epe ON e.id = epe.entry_id
JOIN polymer_entity pe ON epe.polymer_entity_id = pe.id
WHERE e.rcsb_id = '4HHB'
```

**Failure Conditions**:
- Junction table `entry_polymer_entity` is empty
- Foreign key constraints fail
- Cannot link entities back to their parent entry

#### Test 2.2: Assembly-Entity-Instance Hierarchy
**Purpose**: Verify complex hierarchical relationships in PDB data.

**Query**:
```graphql
{
  entry(entry_id: "4HHB") {
    rcsb_id
    assemblies {
      rcsb_id
      polymer_entity_instances {
        rcsb_id
        polymer_entity {
          rcsb_id
          entity_poly {
            type
          }
        }
      }
    }
  }
}
```

**Required Validations**:
1. Creates tables for `entry`, `assembly`, `polymer_entity_instance`, `polymer_entity`
2. Establishes complete relationship hierarchy
3. Can traverse from entry → assembly → instance → entity
4. All foreign keys properly populated
5. Junction tables created where needed

**Advanced SQL Validation**:
```sql
-- This query must traverse the complete hierarchy
SELECT 
  e.rcsb_id as entry_id,
  a.rcsb_id as assembly_id,
  pei.rcsb_id as instance_id,
  pe.entity_poly_type as entity_type,
  COUNT(*) as instance_count
FROM entry e
JOIN entry_assembly ea ON e.id = ea.entry_id
JOIN assembly a ON ea.assembly_id = a.id
JOIN assembly_polymer_entity_instance apei ON a.id = apei.assembly_id
JOIN polymer_entity_instance pei ON apei.polymer_entity_instance_id = pei.id
JOIN polymer_entity pe ON pei.polymer_entity_id = pe.id
GROUP BY e.rcsb_id, a.rcsb_id, pe.entity_poly_type
```

#### Test 2.3: Citation and Author Relationships
**Purpose**: Verify handling of publication data and author lists.

**Query**:
```graphql
{
  entry(entry_id: "4HHB") {
    rcsb_id
    citation {
      id
      title
      rcsb_authors
      year
      pdbx_database_id_PubMed
    }
    audit_author {
      name
      identifier_ORCID
    }
  }
}
```

**Required Validations**:
1. Creates separate tables for `citation` and `audit_author`
2. Handles author arrays properly (not as JSON strings)
3. Establishes many-to-many relationships via junction tables
4. Can query all citations for an entry
5. Author ORCID identifiers properly stored

**SQL Validation**:
```sql
-- This query must return multiple authors and citations
SELECT 
  e.rcsb_id,
  c.title,
  a.name as author_name,
  a.identifier_ORCID
FROM entry e
JOIN entry_citation ec ON e.id = ec.entry_id
JOIN citation c ON ec.citation_id = c.id
JOIN entry_audit_author eaa ON e.id = eaa.entry_id
JOIN audit_author a ON eaa.audit_author_id = a.id
WHERE e.rcsb_id = '4HHB'
```

### Test Category 3: Chemical Component and Ligand Tests

#### Test 3.1: Chemical Component Details
**Purpose**: Verify handling of chemical component data.

**Query**:
```graphql
{
  chem_comp(comp_id: "ATP") {
    chem_comp {
      id
      name
      formula
      formula_weight
      type
    }
    rcsb_chem_comp_descriptor {
      SMILES
      InChI
    }
  }
}
```

**Required Validations**:
1. Creates `chem_comp` and related descriptor tables
2. Chemical identifiers properly stored
3. Molecular weight as numeric type
4. Formula stored as text
5. Descriptors in separate related table

#### Test 3.2: Nonpolymer Entity Instances
**Purpose**: Verify ligand and small molecule binding site data.

**Query**:
```graphql
{
  entry(entry_id: "4HHB") {
    nonpolymer_entities {
      rcsb_id
      nonpolymer_comp {
        chem_comp {
          name
          formula
        }
      }
      nonpolymer_entity_instances {
        rcsb_id
        rcsb_ligand_neighbors {
          ligand_asym_id
          distance
        }
      }
    }
  }
}
```

**Required Validations**:
1. Creates tables for nonpolymer entities and instances
2. Links to chemical component data
3. Binding site neighbor data properly structured
4. Distance values stored as numeric types

### Test Category 4: Structural Analysis Tests

#### Test 4.1: Experimental Method and Resolution Analysis
**Purpose**: Enable analysis of structural determination methods.

**Query**:
```graphql
{
  entries(entry_ids: ["4HHB", "1CRN", "2PPN", "1A0M"]) {
    rcsb_id
    exptl {
      method
    }
    rcsb_entry_info {
      resolution_combined
      experimental_method
    }
    symmetry {
      space_group_name_H_M
    }
  }
}
```

**Required Validations**:
1. All entries properly stored with experimental metadata
2. Resolution values stored as numeric types
3. Can perform statistical analysis on resolution data
4. Space group information accessible

**Analytical SQL Validation**:
```sql
-- Statistical analysis must work
SELECT 
  JSON_EXTRACT(exptl, '$[0].method') as method,
  COUNT(*) as structure_count,
  AVG(JSON_EXTRACT(resolution, '$[0]')) as avg_resolution,
  MIN(JSON_EXTRACT(resolution, '$[0]')) as best_resolution,
  MAX(JSON_EXTRACT(resolution, '$[0]')) as worst_resolution
FROM entry e
JOIN rcsb_entry_info r ON e.entry_info_id = r.id
GROUP BY JSON_EXTRACT(exptl, '$[0].method')
ORDER BY avg_resolution
```

#### Test 4.2: Protein Sequence and Structure Analysis
**Purpose**: Enable sequence-structure relationship analysis.

**Query**:
```graphql
{
  polymer_entity(entry_id: "4HHB", entity_id: "1") {
    rcsb_id
    entity_poly {
      type
      pdbx_seq_one_letter_code
    }
    rcsb_polymer_entity {
      formula_weight
      pdbx_number_of_molecules
    }
    uniprots {
      rcsb_id
      rcsb_uniprot_protein {
        name
        source_organism
      }
    }
  }
}
```

**Required Validations**:
1. Sequence data properly stored (not as JSON blob)
2. UniProt cross-references in separate table with proper relationships
3. Can analyze sequence lengths and molecular weights
4. Organism information accessible

**Analytical SQL Validation**:
```sql
-- Sequence analysis must work
SELECT 
  pe.rcsb_id,
  LENGTH(pe.pdbx_seq_one_letter_code) as sequence_length,
  pe.formula_weight,
  up.source_organism,
  ROUND(pe.formula_weight / LENGTH(pe.pdbx_seq_one_letter_code), 2) as avg_residue_weight
FROM polymer_entity pe
JOIN polymer_entity_uniprot peu ON pe.id = peu.polymer_entity_id
JOIN uniprot up ON peu.uniprot_id = up.id
WHERE pe.entity_poly_type = 'polypeptide(L)'
ORDER BY sequence_length DESC
```

### Test Category 5: Advanced Structural Biology Analysis

#### Test 5.1: Crystallographic Analysis
**Purpose**: Enable crystallographic parameter analysis for X-ray structures.

**Query**:
```graphql
{
  entries(entry_ids: ["4HHB", "1CRN", "2PPN"]) {
    rcsb_id
    cell {
      length_a
      length_b
      length_c
      angle_alpha
      angle_beta
      angle_gamma
      volume
    }
    symmetry {
      space_group_name_H_M
      Int_Tables_number
    }
    diffrn {
      ambient_temp
      crystal_id
    }
    reflns {
      d_resolution_high
      d_resolution_low
      number_obs
    }
  }
}
```

**Required Validations**:
1. Unit cell parameters stored as numeric types
2. Can calculate cell volumes and compare with stored values
3. Space group information properly normalized
4. Diffraction data accessible for analysis

**Crystallographic Analysis Validation**:
```sql
-- Crystallographic analysis must work
SELECT 
  e.rcsb_id,
  c.length_a, c.length_b, c.length_c,
  c.angle_alpha, c.angle_beta, c.angle_gamma,
  c.volume as stored_volume,
  -- Calculate volume from parameters
  (c.length_a * c.length_b * c.length_c * 
   SQRT(1 + 2*COS(RADIANS(c.angle_alpha))*COS(RADIANS(c.angle_beta))*COS(RADIANS(c.angle_gamma)) - 
        COS(RADIANS(c.angle_alpha))*COS(RADIANS(c.angle_alpha)) - 
        COS(RADIANS(c.angle_beta))*COS(RADIANS(c.angle_beta)) - 
        COS(RADIANS(c.angle_gamma))*COS(RADIANS(c.angle_gamma)))) as calculated_volume,
  s.space_group_name_H_M,
  r.d_resolution_high
FROM entry e
JOIN cell c ON e.cell_id = c.id
JOIN symmetry s ON e.symmetry_id = s.id
JOIN reflns r ON e.reflns_id = r.id
WHERE JSON_EXTRACT(e.exptl, '$[0].method') = 'X-RAY DIFFRACTION'
```

#### Test 5.2: Comparative Structure Analysis
**Purpose**: Enable comparative analysis across multiple structures.

**Query**:
```graphql
{
  entries(entry_ids: ["4HHB", "1A3N", "1BZ0", "2DN1", "2DN2"]) {
    rcsb_id
    struct {
      title
    }
    rcsb_entry_info {
      resolution_combined
      experimental_method
      deposited_nonpolymer_entity_instance_count
      deposited_polymer_entity_instance_count
    }
    polymer_entities {
      rcsb_id
      entity_poly {
        type
      }
      rcsb_polymer_entity {
        formula_weight
      }
      rcsb_cluster_membership {
        cluster_id
        identity
      }
    }
  }
}
```

**Required Validations**:
1. All entries properly related to their polymer entities
2. Clustering information accessible
3. Can perform comparative analysis across structures
4. Entity counts properly stored as integers

**Comparative Analysis Validation**:
```sql
-- Comparative analysis across hemoglobin structures
SELECT 
  e.rcsb_id,
  e.struct_title,
  JSON_EXTRACT(ei.resolution, '$[0]') as resolution,
  ei.deposited_polymer_entity_instance_count as chain_count,
  COUNT(DISTINCT pe.id) as unique_entities,
  AVG(pe.formula_weight) as avg_entity_weight,
  STRING_AGG(DISTINCT pe.entity_poly_type, ', ') as entity_types
FROM entry e
JOIN rcsb_entry_info ei ON e.entry_info_id = ei.id
JOIN entry_polymer_entity epe ON e.id = epe.entry_id
JOIN polymer_entity pe ON epe.polymer_entity_id = pe.id
WHERE e.rcsb_id IN ('4HHB', '1A3N', '1BZ0', '2DN1', '2DN2')
GROUP BY e.rcsb_id, e.struct_title, ei.resolution, ei.deposited_polymer_entity_instance_count
ORDER BY JSON_EXTRACT(ei.resolution, '$[0]')
```

#### Test 5.3: Ligand Binding Analysis
**Purpose**: Enable analysis of protein-ligand interactions.

**Query**:
```graphql
{
  entry(entry_id: "3AID") {
    rcsb_id
    polymer_entity_instances {
      rcsb_id
      rcsb_ligand_neighbors {
        ligand_asym_id
        ligand_entity_id
        distance
        ligand_is_bound
      }
    }
    nonpolymer_entities {
      rcsb_id
      nonpolymer_comp {
        chem_comp {
          name
          formula
          formula_weight
        }
      }
      nonpolymer_entity_instances {
        rcsb_id
        rcsb_target_neighbors {
          target_asym_id
          distance
        }
      }
    }
  }
}
```

**Required Validations**:
1. Ligand-protein interaction data properly structured
2. Distance measurements stored as numeric values
3. Can identify binding partners through relationships
4. Chemical component data accessible

**Binding Analysis Validation**:
```sql
-- Protein-ligand interaction analysis
SELECT 
  pei.rcsb_id as protein_chain,
  nei.rcsb_id as ligand_instance,
  cc.name as ligand_name,
  cc.formula,
  ln.distance as binding_distance,
  COUNT(*) as contact_count
FROM polymer_entity_instance pei
JOIN polymer_entity_instance_ligand_neighbor peiln ON pei.id = peiln.polymer_entity_instance_id
JOIN ligand_neighbor ln ON peiln.ligand_neighbor_id = ln.id
JOIN nonpolymer_entity_instance nei ON ln.ligand_entity_instance_id = nei.id
JOIN nonpolymer_entity ne ON nei.nonpolymer_entity_id = ne.id
JOIN chem_comp cc ON ne.chem_comp_id = cc.id
WHERE ln.distance < 4.0
  AND ln.ligand_is_bound = true
GROUP BY pei.rcsb_id, nei.rcsb_id, cc.name, cc.formula, ln.distance
ORDER BY ln.distance
```

### Test Category 6: Error Handling and Edge Cases

#### Test 6.1: Invalid Entry ID
**Purpose**: Verify proper error handling for non-existent entries.

**Query**:
```graphql
{
  entry(entry_id: "INVALID") {
    rcsb_id
    struct {
      title
    }
  }
}
```

**Required Validations**:
1. Returns `success: true` (not an error)
2. Returns `entry: null` in GraphQL response
3. Creates no tables or empty table structures
4. Handles gracefully without server errors

#### Test 6.2: Complex Query Failure Recovery
**Purpose**: Verify system handles relationship mapping failures gracefully.

**Query**:
```graphql
{
  entry(entry_id: "4HHB") {
    rcsb_id
    citation {
      id
      title
      rcsb_authors
    }
    polymer_entities {
      rcsb_id
      entity_poly {
        type
      }
    }
    assemblies {
      rcsb_id
      polymer_entity_instances {
        rcsb_id
      }
    }
  }
}
```

**Required Validations**:
1. If relationships fail, return detailed error message
2. Specify which relationship mappings failed
3. Provide suggestions for simpler queries
4. Don't create partially populated databases

#### Test 6.3: GraphQL Schema Validation
**Purpose**: Verify proper handling of schema violations.

**Query**:
```graphql
{
  entry(entry_id: "4HHB") {
    invalid_field
    struct {
      non_existent_property
    }
  }
}
```

**Required Validations**:
1. Returns GraphQL validation error
2. Identifies specific invalid fields
3. Provides helpful error messages
4. Suggests valid field names

### Test Category 7: Data Integrity and Quality

#### Test 7.1: Foreign Key Integrity
**Purpose**: Verify all foreign key relationships are properly maintained.

**Setup**: Use complex query from Test 2.2

**Required Validations**:
1. All foreign key values exist in referenced tables
2. No orphaned records in child tables
3. Junction tables properly populated
4. Referential integrity constraints enforced

**Integrity Validation SQL**:
```sql
-- Check for orphaned polymer entities
SELECT pe.id, pe.rcsb_id 
FROM polymer_entity pe
LEFT JOIN entry_polymer_entity epe ON pe.id = epe.polymer_entity_id
WHERE epe.polymer_entity_id IS NULL;

-- Should return 0 rows

-- Check for invalid foreign keys
SELECT e.id, e.rcsb_id, e.polymer_entity_id
FROM entry e
WHERE e.polymer_entity_id IS NOT NULL 
  AND e.polymer_entity_id NOT IN (SELECT id FROM polymer_entity);

-- Should return 0 rows
```

#### Test 7.2: Data Type Consistency
**Purpose**: Verify proper SQLite type inference for PDB data.

**Query**: Use Test 4.1 query

**Required Validations**:
1. Resolution values are REAL type
2. Entry IDs are TEXT type
3. Molecular weights are REAL type
4. Counts are INTEGER type
5. Coordinate values are REAL type

**Type Validation SQL**:
```sql
-- This should work without type conversion errors
SELECT 
  COUNT(*) as total_structures,
  AVG(CAST(JSON_EXTRACT(resolution, '$[0]') AS REAL)) as avg_resolution,
  MIN(CAST(JSON_EXTRACT(resolution, '$[0]') AS REAL)) as best_resolution,
  STDEV(CAST(JSON_EXTRACT(resolution, '$[0]') AS REAL)) as resolution_stdev
FROM entry e
JOIN rcsb_entry_info r ON e.entry_info_id = r.id
WHERE JSON_EXTRACT(resolution, '$[0]') IS NOT NULL;
```

#### Test 7.3: Completeness Validation
**Purpose**: Verify no data loss during GraphQL-to-SQL transformation.

**Query**: Use Test 2.1 query

**Required Validations**:
1. All entities from GraphQL response are in database
2. All scalar fields preserved
3. All relationship data accessible
4. No silent truncation of long text fields

### Test Category 8: Performance and Scalability

#### Test 8.1: Large Dataset Query
**Purpose**: Verify system handles multiple entries efficiently.

**Query**:
```graphql
{
  entries(entry_ids: ["4HHB", "1CRN", "2PPN", "1A0M", "1BZ0", "2DN1", "2DN2", "3AID", "1A3N", "5T4V"]) {
    rcsb_id
    struct {
      title
    }
    rcsb_entry_info {
      resolution_combined
      experimental_method
      polymer_entity_count
    }
    polymer_entities {
      rcsb_id
      entity_poly {
        type
      }
      rcsb_polymer_entity {
        formula_weight
      }
    }
  }
}
```

**Required Validations**:
1. Completes within reasonable time (< 60 seconds)
2. Processes all 10 entries correctly
3. Creates proper relationships for all entries
4. Memory usage remains reasonable
5. All foreign keys properly populated

#### Test 8.2: Complex Analytical Query Performance
**Purpose**: Verify staged data supports complex structural biology queries.

**Setup**: Use data from Test 8.1

**SQL Query**:
```sql
-- Complex structural analysis across multiple entries
WITH entry_stats AS (
  SELECT 
    e.rcsb_id,
    e.struct_title,
    JSON_EXTRACT(ei.resolution, '$[0]') as resolution,
    ei.experimental_method,
    COUNT(DISTINCT pe.id) as entity_count,
    AVG(pe.formula_weight) as avg_mol_weight,
    SUM(CASE WHEN pe.entity_poly_type = 'polypeptide(L)' THEN 1 ELSE 0 END) as protein_chains
  FROM entry e
  JOIN rcsb_entry_info ei ON e.entry_info_id = ei.id
  LEFT JOIN entry_polymer_entity epe ON e.id = epe.entry_id
  LEFT JOIN polymer_entity pe ON epe.polymer_entity_id = pe.id
  GROUP BY e.rcsb_id, e.struct_title, ei.resolution, ei.experimental_method
),
resolution_rankings AS (
  SELECT 
    rcsb_id,
    struct_title,
    resolution,
    entity_count,
    ROW_NUMBER() OVER (ORDER BY resolution) as resolution_rank,
    NTILE(3) OVER (ORDER BY avg_mol_weight) as weight_tertile
  FROM entry_stats
  WHERE resolution IS NOT NULL
)
SELECT 
  rr.rcsb_id,
  SUBSTR(rr.struct_title, 1, 50) || '...' as title_short,
  ROUND(rr.resolution, 2) as resolution,
  rr.entity_count,
  rr.resolution_rank,
  CASE rr.weight_tertile
    WHEN 1 THEN 'Light'
    WHEN 2 THEN 'Medium' 
    WHEN 3 THEN 'Heavy'
  END as molecular_weight_class,
  es.protein_chains
FROM resolution_rankings rr
JOIN entry_stats es ON rr.rcsb_id = es.rcsb_id
ORDER BY rr.resolution_rank;
```

**Required Validations**:
1. Query executes successfully within 10 seconds
2. Returns meaningful analytical results
3. Demonstrates proper table relationships
4. Window functions work correctly
5. Complex aggregations produce accurate results

## Critical Failure Patterns (Based on Observed Issues)

### Anti-Pattern 1: Null Foreign Keys
**Detection**:
```sql
-- If this returns any rows, foreign key mapping is broken
SELECT 'entry' as table_name, COUNT(*) as null_fk_count
FROM entry 
WHERE entry_info_id IS NULL
  AND EXISTS (SELECT 1 FROM rcsb_entry_info)
UNION ALL
SELECT 'polymer_entity_instance' as table_name, COUNT(*) as null_fk_count  
FROM polymer_entity_instance
WHERE polymer_entity_id IS NULL
  AND EXISTS (SELECT 1 FROM polymer_entity);
```

### Anti-Pattern 2: Empty Junction Tables
**Detection**:
```sql
-- Junction tables should not be empty when relationships exist
SELECT 
  'entry_polymer_entity' as junction_table,
  (SELECT COUNT(*) FROM entry) as parent_count,
  (SELECT COUNT(*) FROM polymer_entity) as child_count,
  (SELECT COUNT(*) FROM entry_polymer_entity) as junction_count;
```

### Anti-Pattern 3: Empty Related Tables
**Detection**:
```sql
-- If this returns mismatched counts, related data isn't being inserted
SELECT 
  'Entries with resolution info' as description,
  COUNT(*) as entry_count,
  (SELECT COUNT(*) FROM rcsb_entry_info) as info_count
FROM entry e
WHERE e.entry_info_id IS NOT NULL;
```

### Anti-Pattern 4: Complex Objects as JSON Blobs
**Detection**:
```sql
-- Should not find columns storing complex objects as JSON strings
SELECT 
  table_name,
  column_name,
  type
FROM pragma_table_info('entry')
WHERE column_name LIKE '%json%' 
   OR (type = 'TEXT' AND column_name IN ('polymer_entities', 'assemblies', 'citation'));
```

## Success Criteria Summary

The RCSB-PDB MCP Server tools PASS evaluation if and only if:

1. ✅ All 25+ test cases pass completely
2. ✅ No critical anti-patterns detected
3. ✅ All foreign key relationships properly populated
4. ✅ Junction tables correctly populated
5. ✅ Complex structural biology queries work
6. ✅ Performance requirements met
7. ✅ Data integrity maintained across all relationship levels
8. ✅ Full relational capabilities for structural analysis

**Current Status Based on Testing**: ❌ **FAILING** - Critical relationship mapping issues prevent most complex functionality.

## Structural Biology Analysis Requirements

The tools must enable these types of scientific analysis:

### Crystallographic Studies
- Unit cell parameter analysis and space group statistics
- Resolution distribution analysis by experimental method
- Crystal packing density calculations
- Systematic absences and symmetry analysis

### Comparative Structural Biology
- Cross-entry comparison of similar proteins
- Sequence-structure relationship analysis
- Evolutionary conservation mapping
- Structural classification analysis

### Protein-Ligand Interactions
- Binding site identification and characterization
- Ligand binding affinity correlation with structure
- Drug design target analysis
- Allosteric site identification

### Macromolecular Assemblies
- Quaternary structure analysis
- Symmetry operation analysis
- Interface characterization
- Biological assembly validation

### Data Mining and Statistics
- Large-scale structural database analysis
- Method development trend analysis
- Resolution improvement over time
- Structural coverage of protein families

Any tool that cannot support these analysis types due to relationship mapping failures is **unsuitable for structural biology research**.