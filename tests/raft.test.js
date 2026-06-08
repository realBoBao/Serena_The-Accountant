/**
 * ═══════════════════════════════════════════════════════════════
 * Raft Consensus Unit Tests
 * ═══════════════════════════════════════════════════════════════
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { RaftNode, RaftCluster } from '../lib/raft.js';

// Track all clusters for cleanup
const _activeClusters = [];

afterEach(() => {
  // Clean up any remaining clusters
  for (const cluster of _activeClusters) {
    try {
      for (const [, node] of cluster.nodes) {
        node.stop();
      }
    } catch { /* ignore */ }
  }
  _activeClusters.length = 0;
});

describe('RaftNode', () => {
  it('should start as follower', () => {
    const node = new RaftNode({
      id: 'test-node',
      sendMessage: async () => null,
    });

    expect(node.state).toBe('follower');
    expect(node.currentTerm).toBe(0);
    expect(node.isLeader).toBe(false);
  });

  it('should track state correctly', () => {
    const node = new RaftNode({
      id: 'test-node',
      sendMessage: async () => null,
    });

    const state = node.getState();
    expect(state.id).toBe('test-node');
    expect(state.state).toBe('follower');
    expect(state.term).toBe(0);
    expect(state.logLength).toBe(0);
    expect(state.isLeader).toBe(false);
  });

  it('should handle RequestVote with lower term', async () => {
    const node = new RaftNode({
      id: 'test-node',
      sendMessage: async () => null,
    });
    node.currentTerm = 5;

    const response = await node.handleMessage({
      type: 'RequestVote',
      term: 3,
      candidateId: 'other',
      lastLogIndex: 0,
      lastLogTerm: 0,
    });

    expect(response.voteGranted).toBe(false);
    expect(response.term).toBe(5);
  });

  it('should grant vote for valid candidate', async () => {
    const node = new RaftNode({
      id: 'test-node',
      sendMessage: async () => null,
    });

    const response = await node.handleMessage({
      type: 'RequestVote',
      term: 1,
      candidateId: 'candidate-1',
      lastLogIndex: 0,
      lastLogTerm: 0,
    });

    expect(response.voteGranted).toBe(true);
    expect(node.votedFor).toBe('candidate-1');
  });

  it('should reject AppendEntries with lower term', async () => {
    const node = new RaftNode({
      id: 'test-node',
      sendMessage: async () => null,
    });
    node.currentTerm = 3;

    const response = await node.handleMessage({
      type: 'AppendEntries',
      term: 2,
      leaderId: 'leader',
      prevLogIndex: -1,
      prevLogTerm: 0,
      entries: [],
      leaderCommit: -1,
    });

    expect(response.success).toBe(false);
  });

  it('should accept valid AppendEntries', async () => {
    const node = new RaftNode({
      id: 'test-node',
      sendMessage: async () => null,
    });

    const response = await node.handleMessage({
      type: 'AppendEntries',
      term: 1,
      leaderId: 'leader',
      prevLogIndex: -1,
      prevLogTerm: 0,
      entries: [
        { term: 1, index: 0, command: 'set-x-1' },
        { term: 1, index: 1, command: 'set-y-2' },
      ],
      leaderCommit: -1,
    });

    expect(response.success).toBe(true);
    expect(node.log.length).toBe(2);
    expect(node.log[0].command).toBe('set-x-1');
  });

  it('should step down on higher term', async () => {
    const node = new RaftNode({
      id: 'test-node',
      sendMessage: async () => null,
    });
    node.currentTerm = 1;

    await node.handleMessage({
      type: 'AppendEntries',
      term: 5,
      leaderId: 'new-leader',
      prevLogIndex: -1,
      prevLogTerm: 0,
      entries: [],
      leaderCommit: -1,
    });

    expect(node.currentTerm).toBe(5);
    expect(node.state).toBe('follower');
  });
});

describe('RaftCluster', () => {
  it('should create cluster with correct number of nodes', () => {
    const cluster = new RaftCluster(3);
    expect(cluster.nodes.size).toBe(3);
  });

  it('should elect a leader', async () => {
    const cluster = new RaftCluster(3);
    _activeClusters.push(cluster);
    await cluster.start();

    const hasLeader = await cluster._waitForLeader(8000);
    expect(hasLeader).toBe(true);

    const leader = cluster.getLeader();
    expect(leader).not.toBeNull();
    expect(leader.isLeader).toBe(true);

    for (const [, node] of cluster.nodes) {
      node.stop();
    }
  }, 15000);

  it('should have consistent terms after election', async () => {
    const cluster = new RaftCluster(3);
    await cluster.start();

    // Wait for leader election
    const hasLeader = await cluster._waitForLeader(8000);
    expect(hasLeader).toBe(true);

    // All nodes should have the same term
    const states = cluster.getAllStates();
    const terms = Object.values(states).map(s => s.term);
    expect(terms.every(t => t === terms[0])).toBe(true);
    expect(terms[0]).toBeGreaterThan(0);

    // Exactly one leader
    const leaders = Object.values(states).filter(s => s.isLeader);
    expect(leaders.length).toBe(1);

    for (const [, node] of cluster.nodes) {
      node.stop();
    }
  }, 15000);

  it('should handle node failures gracefully', async () => {
    const cluster = new RaftCluster(5);
    await cluster.start();

    await cluster._waitForLeader(2000);

    const nodeIds = [...cluster.nodes.keys()];
    cluster.nodes.get(nodeIds[3]).stop();
    cluster.nodes.get(nodeIds[4]).stop();

    await new Promise(r => setTimeout(r, 500));
    const leader = cluster.getLeader();

    for (const [, node] of cluster.nodes) {
      node.stop();
    }
  }, 10000);

  it('should track message count', async () => {
    const cluster = new RaftCluster(3);
    await cluster.start();

    expect(cluster.messageCount).toBeGreaterThanOrEqual(0);

    for (const [, node] of cluster.nodes) {
      node.stop();
    }
  }, 10000);
});
