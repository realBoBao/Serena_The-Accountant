/**
 * ═══════════════════════════════════════════════════════════════
 * Raft Consensus Algorithm — Leader Election + Log Replication
 * ═══════════════════════════════════════════════════════════════
 *
 * Nền tảng của Kubernetes (etcd), HashiCorp Consul, CockroachDB.
 *
 * Kiến trúc:
 * ┌─────────────────────────────────────────────────────────────┐
 * │  Raft Cluster (N nodes)                                     │
 * │                                                             │
 * │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐      │
 * │  │ Node 0  │  │ Node 1  │  │ Node 2  │  │ Node 3  │      │
 * │  │ LEADER  │  │FOLLOWER │  │FOLLOWER │  │FOLLOWER │      │
 * │  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘      │
 * │       │            │            │            │             │
 * │       └────────────┼────────────┼────────────┘             │
 * │                    │            │                           │
 * │  1. Client sends proposal to Leader                        │
 * │  2. Leader replicates to Followers (AppendEntries)         │
 * │  3. Wait for majority ACK (N/2 + 1)                       │
 * │  4. Commit → Apply to state machine                        │
 * │  5. Notify client of success                               │
 * │                                                             │
 * │  Leader Election:                                           │
 * │  - Follower timeout → Candidate → RequestVote              │
 * │  - Majority votes → Leader                                 │
 * │  - Leader sends heartbeats to prevent new elections        │
 * └─────────────────────────────────────────────────────────────┘
 *
 * @author Serena_Project00
 */

import { getLogger } from './logger.js';

const logger = getLogger('Raft');

// ═══════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════

const NODE_STATE = {
  FOLLOWER: 'follower',
  CANDIDATE: 'candidate',
  LEADER: 'leader',
};

const MIN_ELECTION_TIMEOUT = 100; // ms
const MAX_ELECTION_TIMEOUT = 200; // ms
const HEARTBEAT_INTERVAL = 30;    // ms

// ═══════════════════════════════════════════════════════════
//  RaftNode — Single node in the Raft cluster
// ═══════════════════════════════════════════════════════════

export class RaftNode {
  /**
   * @param {Object} opts
   * @param {string} opts.id       — Unique node ID
   * @param {Function} opts.sendMessage — async (targetId, message) => response
   * @param {Function} [opts.onCommit]   — callback when entry is committed
   * @param {Function} [opts.onStateChange] — callback when node state changes
   */
  constructor({ id, sendMessage, onCommit, onStateChange } = {}) {
    this.id = id;
    this.send = sendMessage;
    this.onCommit = onCommit || (() => {});
    this.onStateChange = onStateChange || (() => {});

    // Persistent state
    this.currentTerm = 0;
    this.votedFor = null;
    this.log = []; // [{ term, index, command }]

    // Volatile state
    this.state = NODE_STATE.FOLLOWER;
    this.commitIndex = -1;
    this.lastApplied = -1;

    // Leader state (reset on election)
    this.nextIndex = {};   // nodeId → next log index to send
    this.matchIndex = {};  // nodeId → highest known replicated index

    // Election timing
    this._electionTimeout = this._randomElectionTimeout();
    this._heartbeatTimer = null;
    this._electionTimer = null;

    // Vote tracking
    this._votesReceived = new Set();

    // Pending client requests
    this._pendingCommits = new Map(); // logIndex → { resolve, reject }

    this._running = false;
  }

  // ── Lifecycle ─────────────────────────────────────────────

  start(delayMs = 0) {
    this._running = true;
    if (delayMs > 0) {
      setTimeout(() => {
        if (this._running) this._resetElectionTimer();
      }, delayMs);
    } else {
      this._resetElectionTimer();
    }
    logger.info(`[Raft:${this.id}] Started as ${this.state}`);
  }

  stop() {
    this._running = false;
    this._clearTimers();
    logger.info(`[Raft:${this.id}] Stopped`);
  }

  // ── Client API ────────────────────────────────────────────

  /**
   * Propose a command to the cluster.
   * Only the Leader accepts proposals.
   *
   * @param {*} command — The command to replicate
   * @returns {Promise} Resolves when committed
   */
  async propose(command) {
    if (this.state !== NODE_STATE.LEADER) {
      throw new Error(`Node ${this.id} is not the leader (state: ${this.state})`);
    }

    const entry = {
      term: this.currentTerm,
      index: this.log.length,
      command,
    };

    this.log.push(entry);
    logger.info(`[Raft:${this.id}] Proposed entry #${entry.index} (term ${entry.term})`);

    // Replicate to all followers
    return new Promise((resolve, reject) => {
      this._pendingCommits.set(entry.index, { resolve, reject });
      this._replicateLog().catch(reject);
    });
  }

  /**
   * Get the current leader ID (if known).
   */
  getLeaderId() {
    if (this.state === NODE_STATE.LEADER) return this.id;
    return this._leaderId || null;
  }

  /**
   * Check if this node is the leader.
   */
  get isLeader() {
    return this.state === NODE_STATE.LEADER;
  }

  // ── Message Handlers ──────────────────────────────────────

  /**
   * Handle incoming message from another node.
   * @param {Object} msg — { type, term, from, ... }
   * @returns {Object} Response
   */
  async handleMessage(msg) {
    // If message has higher term → step down to follower
    if (msg.term > this.currentTerm) {
      this.currentTerm = msg.term;
      this._becomeFollower();
    }

    switch (msg.type) {
      case 'RequestVote':
        return this._handleRequestVote(msg);
      case 'AppendEntries':
        return this._handleAppendEntries(msg);
      case 'VoteResponse':
        return this._handleVoteResponse(msg);
      case 'AppendResponse':
        return this._handleAppendResponse(msg);
      default:
        return { ok: false, error: `Unknown message type: ${msg.type}` };
    }
  }

  // ── Leader Election ───────────────────────────────────────

  _startElection() {
    if (!this._running) return;

    this.currentTerm++;
    this.state = NODE_STATE.CANDIDATE;
    this.votedFor = this.id;
    this._votesReceived = new Set([this.id]);

    this.onStateChange(this.id, this.state, this.currentTerm);
    logger.info(`[Raft:${this.id}] Starting election for term ${this.currentTerm}`);

    // Request votes from all other nodes
    const lastLogIndex = this.log.length - 1;
    const lastLogTerm = lastLogIndex >= 0 ? this.log[lastLogIndex].term : 0;

    // Broadcast vote requests and collect responses
    const self = this;
    const votePromises = this._getPeerIds().map(peerId =>
      this.send(peerId, {
        type: 'RequestVote',
        term: this.currentTerm,
        candidateId: this.id,
        lastLogIndex,
        lastLogTerm,
      }).then(response => {
        if (response) {
          self.handleMessage({ ...response, from: peerId });
        }
        return response;
      }).catch(() => null)
    );

    // Wait for vote responses, then reset election timer
    // This prevents starting a new election while votes are in-flight
    Promise.allSettled(votePromises).then(() => {
      if (this._running) {
        this._resetElectionTimer();
      }
    });
  }

  _handleRequestVote(msg) {
    const { term, candidateId, lastLogIndex, lastLogTerm } = msg;

    // Reject if term is lower
    if (term < this.currentTerm) {
      return { term: this.currentTerm, voteGranted: false };
    }

    // Check if candidate's log is at least as up-to-date
    const myLastIndex = this.log.length - 1;
    const myLastTerm = myLastIndex >= 0 ? this.log[myLastIndex].term : 0;

    const logOk = (lastLogTerm > myLastTerm) ||
                  (lastLogTerm === myLastTerm && lastLogIndex >= myLastIndex);

    // Grant vote if we haven't voted or already voted for this candidate
    const canVote = (this.votedFor === null || this.votedFor === candidateId) && logOk;

    if (canVote) {
      this.votedFor = candidateId;
      this._resetElectionTimer();
      logger.info(`[Raft:${this.id}] Voted for ${candidateId} in term ${term}`);
    }

    return { type: 'VoteResponse', term: this.currentTerm, voteGranted: canVote };
  }

  _handleVoteResponse(msg) {
    console.log(`    [DEBUG] ${this.id}._handleVoteResponse: state=${this.state}, msg.term=${msg.term}, myTerm=${this.currentTerm}, granted=${msg.voteGranted}, votes=${this._votesReceived.size}`);
    if (this.state !== NODE_STATE.CANDIDATE) {
      console.log(`    [DEBUG] ${this.id}: SKIP - not candidate (state=${this.state})`);
      return;
    }
    if (msg.term !== this.currentTerm) {
      console.log(`    [DEBUG] ${this.id}: SKIP - term mismatch (msg=${msg.term}, mine=${this.currentTerm})`);
      return;
    }

    if (msg.voteGranted) {
      this._votesReceived.add(msg.from);
      const clusterSize = this._getClusterSize();
      const majority = Math.floor(clusterSize / 2) + 1;
      console.log(`    [DEBUG] ${this.id}: vote added, total=${this._votesReceived.size}, clusterSize=${clusterSize}, majority=${majority}`);
      // Reset election timer to prevent starting a new election
      this._resetElectionTimer();

      // Majority achieved → become leader
      if (this._votesReceived.size >= majority) {
        console.log(`    [DEBUG] ${this.id}: MAJORITY REACHED → becoming leader`);
        this._becomeLeader();
      }
    }
  }

  _becomeLeader() {
    this.state = NODE_STATE.LEADER;
    this._leaderId = this.id;
    this._clearElectionTimer();

    // Initialize leader state
    const nextIdx = this.log.length;
    // We'll populate nextIndex/matchIndex as we discover peers
    this.nextIndex = {};
    this.matchIndex = {};

    this.onStateChange(this.id, this.state, this.currentTerm);
    logger.info(`[Raft:${this.id}] Became LEADER for term ${this.currentTerm}`);

    // Start sending heartbeats
    this._startHeartbeats();

    // Immediately send empty AppendEntries (heartbeat)
    this._broadcastAppendEntries();
  }

  _becomeFollower() {
    const wasLeader = this.state === NODE_STATE.LEADER;
    this.state = NODE_STATE.FOLLOWER;
    this.votedFor = null;
    this._clearHeartbeatTimer();
    this._resetElectionTimer();

    if (wasLeader) {
      this.onStateChange(this.id, this.state, this.currentTerm);
      logger.info(`[Raft:${this.id}] Stepped down to FOLLOWER`);
    }
  }

  // ── Log Replication ───────────────────────────────────────

  async _replicateLog() {
    if (this.state !== NODE_STATE.LEADER) return;

    // Send AppendEntries to all followers
    await this._broadcastAppendEntries();
  }

  async _broadcastAppendEntries() {
    const promises = [];
    const peerIds = this._getPeerIds();

    for (const peerId of peerIds) {
      const nextIdx = this.nextIndex[peerId] || 0;
      const prevLogIndex = nextIdx - 1;
      const prevLogTerm = prevLogIndex >= 0 && prevLogIndex < this.log.length
        ? this.log[prevLogIndex].term : 0;

      const entries = this.log.slice(nextIdx);

      promises.push(
        this.send(peerId, {
          type: 'AppendEntries',
          term: this.currentTerm,
          leaderId: this.id,
          prevLogIndex,
          prevLogTerm,
          entries,
          leaderCommit: this.commitIndex,
        }).then(response => {
          if (response) {
            return this.handleMessage({ ...response, from: peerId });
          }
        }).catch(() => {
          // Peer unreachable — will retry on next heartbeat
        })
      );
    }

    await Promise.allSettled(promises);
  }

  _handleAppendEntries(msg) {
    const { term, leaderId, prevLogIndex, prevLogTerm, entries, leaderCommit } = msg;

    // Reject if term is lower
    if (term < this.currentTerm) {
      return { term: this.currentTerm, success: false };
    }

    // Valid leader → reset election timer and step down if needed
    this._leaderId = leaderId;
    this._becomeFollower();
    this.currentTerm = term;
    this._resetElectionTimer();

    // Check if we have the previous log entry
    if (prevLogIndex >= 0) {
      if (prevLogIndex >= this.log.length) {
        return { term: this.currentTerm, success: false, hint: 'missing_prev' };
      }
      if (this.log[prevLogIndex].term !== prevLogTerm) {
        // Conflict — delete this entry and all after
        this.log = this.log.slice(0, prevLogIndex);
        return { term: this.currentTerm, success: false, hint: 'conflict' };
      }
    }

    // Append new entries
    for (const entry of entries) {
      if (entry.index < this.log.length) {
        // Existing entry with different term → delete it and all after
        if (this.log[entry.index].term !== entry.term) {
          this.log = this.log.slice(0, entry.index);
          this.log.push(entry);
        }
        // Same term → skip (already have it)
      } else {
        this.log.push(entry);
      }
    }

    // Update commit index
    if (leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(leaderCommit, this.log.length - 1);
      this._applyCommitted();
    }

    return { term: this.currentTerm, success: true };
  }

  _handleAppendResponse(msg) {
    if (this.state !== NODE_STATE.LEADER) return;
    if (msg.term !== this.currentTerm) return;

    const peerId = msg.from;

    if (msg.success) {
      // Update nextIndex and matchIndex
      this.matchIndex[peerId] = this.log.length - 1;
      this.nextIndex[peerId] = this.log.length;

      // Check if we can advance commitIndex
      this._tryAdvanceCommit();
    } else {
      // Decrement nextIndex and retry
      this.nextIndex[peerId] = Math.max(0, (this.nextIndex[peerId] || 0) - 1);
    }
  }

  _tryAdvanceCommit() {
    // Find the highest N such that majority of matchIndex[i] >= N
    // and log[N].term == currentTerm
    for (let n = this.log.length - 1; n > this.commitIndex; n--) {
      if (this.log[n].term !== this.currentTerm) continue;

      let count = 1; // Count self
      for (const peerId of Object.keys(this.matchIndex)) {
        if (this.matchIndex[peerId] >= n) count++;
      }

      const majority = Math.floor(this._getClusterSize() / 2) + 1;
      if (count >= majority) {
        this.commitIndex = n;
        this._applyCommitted();
        break;
      }
    }
  }

  _applyCommitted() {
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied++;
      const entry = this.log[this.lastApplied];

      // Notify pending client
      const pending = this._pendingCommits.get(entry.index);
      if (pending) {
        pending.resolve({ index: entry.index, term: entry.term });
        this._pendingCommits.delete(entry.index);
      }

      // Apply to state machine
      this.onCommit(entry);
      logger.info(`[Raft:${this.id}] Committed entry #${entry.index} (term ${entry.term})`);
    }
  }

  // ── Heartbeats ────────────────────────────────────────────

  _startHeartbeats() {
    this._heartbeatTimer = setInterval(() => {
      if (this.state === NODE_STATE.LEADER && this._running) {
        this._broadcastAppendEntries();
      }
    }, HEARTBEAT_INTERVAL);

    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
  }

  // ── Election Timer ────────────────────────────────────────

  _resetElectionTimer() {
    this._clearElectionTimer();
    this._electionTimeout = this._randomElectionTimeout();

    this._electionTimer = setTimeout(() => {
      if (this._running && this.state !== NODE_STATE.LEADER) {
        this._startElection();
      }
    }, this._electionTimeout);

    if (this._electionTimer.unref) this._electionTimer.unref();
  }

  _randomElectionTimeout() {
    return MIN_ELECTION_TIMEOUT + Math.random() * (MAX_ELECTION_TIMEOUT - MIN_ELECTION_TIMEOUT);
  }

  // ── Helpers ───────────────────────────────────────────────

  _clearTimers() {
    this._clearElectionTimer();
    this._clearHeartbeatTimer();
  }

  _clearElectionTimer() {
    if (this._electionTimer) {
      clearTimeout(this._electionTimer);
      this._electionTimer = null;
    }
  }

  _clearHeartbeatTimer() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /**
   * Broadcast a message to all peers.
   * Override this in cluster setup.
   */
  _broadcast(msg) {
    // This is handled by the RaftCluster
    logger.debug(`[Raft:${this.id}] Broadcast: ${msg.type}`);
  }

  _getPeerIds() {
    return []; // Overridden by cluster
  }

  _getClusterSize() {
    return 1; // Overridden by cluster
  }

  // ── State ─────────────────────────────────────────────────

  getState() {
    return {
      id: this.id,
      state: this.state,
      term: this.currentTerm,
      logLength: this.log.length,
      commitIndex: this.commitIndex,
      lastApplied: this.lastApplied,
      isLeader: this.isLeader,
      leaderId: this._leaderId || null,
    };
  }
}

// ═══════════════════════════════════════════════════════════
//  RaftCluster — In-memory cluster for testing / single-process use
// ═══════════════════════════════════════════════════════════

export class RaftCluster {
  /**
   * @param {number} numNodes — Number of nodes in the cluster
   * @param {Function} [opts.onCommit] — Global commit callback
   */
  constructor(numNodes = 3, { onCommit } = {}) {
    this.nodes = new Map();
    this._messageLog = [];

    for (let i = 0; i < numNodes; i++) {
      const nodeId = `node-${i}`;
      const node = new RaftNode({
        id: nodeId,
        sendMessage: (targetId, msg) => this._routeMessage(nodeId, targetId, msg),
        onCommit: onCommit ? (entry) => onCommit(nodeId, entry) : undefined,
        onStateChange: (id, state, term) => {
          logger.info(`[RaftCluster] ${id} → ${state} (term ${term})`);
        },
      });

      // Override broadcast to use cluster routing
      node._broadcast = (msg) => {
        for (const [peerId] of this.nodes) {
          if (peerId !== nodeId) {
            this._routeMessage(nodeId, peerId, msg).catch(() => {});
          }
        }
      };
      node._getPeerIds = () => [...this.nodes.keys()].filter(id => id !== nodeId);
      node._getClusterSize = () => this.nodes.size;

      this.nodes.set(nodeId, node);
    }
  }

  async start() {
    // Stagger node starts to prevent split votes
    let delay = 0;
    for (const [, node] of this.nodes) {
      node.start(delay);
      delay += 20; // 20ms stagger between nodes
    }

    // Wait for leader election
    await this._waitForLeader();
  }

  stop() {
    for (const [, node] of this.nodes) {
      node.stop();
    }
  }

  /**
   * Route a message from one node to another (simulates network).
   */
  async _routeMessage(fromId, toId, msg) {
    this._messageLog.push({ from: fromId, to: toId, msg, ts: Date.now() });

    const target = this.nodes.get(toId);
    if (!target) return null;

    // No network delay in single-process simulation

    return target.handleMessage({ ...msg, from: fromId });
  }

  /**
   * Propose a command through the leader.
   */
  async propose(command) {
    const leader = this.getLeader();
    if (!leader) throw new Error('No leader elected');
    return leader.propose(command);
  }

  /**
   * Get the current leader node.
   */
  getLeader() {
    for (const [, node] of this.nodes) {
      if (node.isLeader) return node;
    }
    return null;
  }

  /**
   * Get state of all nodes.
   */
  getAllStates() {
    const states = {};
    for (const [id, node] of this.nodes) {
      states[id] = node.getState();
    }
    return states;
  }

  async _waitForLeader(timeoutMs = 2000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.getLeader()) return true;
      await new Promise(r => setTimeout(r, 50));
    }
    return false;
  }

  get messageCount() {
    return this._messageLog.length;
  }
}
