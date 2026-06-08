/**
 * Knowledge Graph Tests — Phase 19
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  upsertEntity,
  getEntity,
  searchEntities,
  addRelationship,
  getRelationships,
  traverseGraph,
  getGraphStats,
  clearGraph,
  exportGraphForVisualization,
} from '../lib/knowledge_graph.js';

beforeAll(async () => {
  await clearGraph();
});

afterAll(async () => {
  await clearGraph();
});

describe('Knowledge Graph — Entity CRUD', () => {
  test('upsertEntity creates a new entity', async () => {
    const id = await upsertEntity('QuickSort', 'algorithm', 'A fast sorting algorithm');
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  test('getEntity retrieves by ID', async () => {
    const id = await upsertEntity('BinaryTree', 'data_structure', 'A tree data structure');
    const entity = await getEntity(id);
    expect(entity).not.toBeNull();
    expect(entity.name).toBe('BinaryTree');
    expect(entity.type).toBe('data_structure');
  });

  test('getEntity returns null for non-existent ID', async () => {
    const entity = await getEntity('nonexistent123');
    expect(entity).toBeNull();
  });

  test('upsertEntity updates existing entity', async () => {
    const id = await upsertEntity('QuickSort', 'algorithm', 'Updated description');
    const entity = await getEntity(id);
    expect(entity.description).toBe('Updated description');
  });

  test('searchEntities finds by name', async () => {
    await upsertEntity('MergeSort', 'algorithm', 'A merge sort algorithm');
    const results = await searchEntities('sort');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.name === 'MergeSort')).toBe(true);
  });

  test('searchEntities filters by type', async () => {
    const results = await searchEntities('sort', 'algorithm');
    expect(results.every(r => r.type === 'algorithm')).toBe(true);
  });
});

describe('Knowledge Graph — Relationships', () => {
  test('addRelationship creates edge between entities', async () => {
    const result = await addRelationship('QuickSort', 'BinaryTree', 'uses', 0.9);
    expect(result.sourceId).toBeTruthy();
    expect(result.targetId).toBeTruthy();
    expect(result.relation).toBe('uses');
  });

  test('getRelationships returns outgoing and incoming', async () => {
    await addRelationship('Node', 'BinaryTree', 'part_of', 1.0, 'concept', 'data_structure');
    const entity = (await searchEntities('BinaryTree', 'data_structure'))[0];
    if (entity) {
      const rels = await getRelationships(entity.id);
      expect(rels.outgoing.length + rels.incoming.length).toBeGreaterThan(0);
    }
  });
});

describe('Knowledge Graph — Graph Traversal', () => {
  test('traverseGraph BFS from entity', async () => {
    await clearGraph();
    await addRelationship('A', 'B', 'related_to', 1.0);
    await addRelationship('B', 'C', 'related_to', 1.0);
    await addRelationship('C', 'D', 'related_to', 1.0);

    const entityA = (await searchEntities('A'))[0];
    if (entityA) {
      const { nodes, links } = await traverseGraph(entityA.id, 2);
      expect(nodes.length).toBeGreaterThanOrEqual(1);
      expect(nodes.length).toBeLessThanOrEqual(3); // A, B, C within 2 hops
    }
  });
});

describe('Knowledge Graph — Stats & Export', () => {
  test('getGraphStats returns counts', async () => {
    await clearGraph();
    await upsertEntity('TestEntity', 'concept');
    const stats = await getGraphStats();
    expect(stats.totalEntities).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(stats.entityTypes)).toBe(true);
  });

  test('exportGraphForVisualization returns D3 format', async () => {
    await clearGraph();
    await upsertEntity('VisNode', 'concept', 'A visualization node');
    const data = await exportGraphForVisualization();
    expect(Array.isArray(data.nodes)).toBe(true);
    expect(Array.isArray(data.edges)).toBe(true);
    expect(data.nodes.length).toBeGreaterThanOrEqual(1);
    expect(data.nodes[0]).toHaveProperty('id');
    expect(data.nodes[0]).toHaveProperty('label');
  });
});
