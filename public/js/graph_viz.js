/**
 * Visual Knowledge Map — Phase 19: Interactive Graph Visualization
 * Uses D3.js for force-directed graph rendering in the PWA.
 *
 * Features:
 * - Force-directed layout with drag support
 * - Color-coded nodes by entity type
 * - Zoom & pan
 * - Click node to see details & relationships
 * - Search highlight
 */

const API_BASE = window.location.origin;
let API_KEY = localStorage.getItem('ai_brain_api_key') || '';

async function apiGraph(path) {
  const headers = {};
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;
  try {
    const res = await fetch(`${API_BASE}${path}`, { headers });
    if (res.status === 401) {
      const key = prompt('Nhập API Key:');
      if (key) { API_KEY = key; localStorage.setItem('ai_brain_api_key', key); return apiGraph(path); }
      return null;
    }
    return await res.json();
  } catch { return null; }
}

// ── Color scheme by entity type ──
const TYPE_COLORS = {
  concept: '#6366f1',
  algorithm: '#22c55e',
  technology: '#f59e0b',
  person: '#ec4899',
  system: '#06b6d4',
  data_structure: '#8b5cf6',
  organization: '#f97316',
  event: '#14b8a6',
  place: '#a855f7',
  other: '#64748b',
};

const TYPE_LABELS = {
  concept: 'Khái niệm',
  algorithm: 'Thuật toán',
  technology: 'Công nghệ',
  person: 'Người',
  system: 'Hệ thống',
  data_structure: 'Cấu trúc dữ liệu',
  organization: 'Tổ chức',
  event: 'Sự kiện',
  place: 'Địa điểm',
  other: 'Khác',
};

export class KnowledgeGraphViz {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    this.width = options.width || this.container.clientWidth || 600;
    this.height = options.height || 400;
    this.nodes = [];
    this.links = [];
    this.simulation = null;
    this.svg = null;
    this.g = null;
    this.zoom = null;
    this.selectedNode = null;
    this.tooltip = null;

    this._init();
  }

  _init() {
    // Clear container
    this.container.innerHTML = '';

    // Create SVG
    this.svg = d3.select(this.container)
      .append('svg')
      .attr('width', '100%')
      .attr('height', this.height)
      .attr('viewBox', [0, 0, this.width, this.height])
      .style('background', '#0f172a')
      .style('border-radius', '12px');

    // Define arrow marker for directed edges
    this.svg.append('defs').append('marker')
      .attr('id', 'arrowhead')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 20)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#475569');

    // Zoom behavior
    this.zoom = d3.zoom()
      .scaleExtent([0.2, 4])
      .on('zoom', (event) => {
        this.g.attr('transform', event.transform);
      });

    this.svg.call(this.zoom);

    // Main group for zoomable content
    this.g = this.svg.append('g');

    // Tooltip
    this.tooltip = d3.select(this.container)
      .append('div')
      .attr('class', 'graph-tooltip')
      .style('position', 'absolute')
      .style('background', '#1e293b')
      .style('border', '1px solid #334155')
      .style('border-radius', '8px')
      .style('padding', '8px 12px')
      .style('font-size', '12px')
      .style('color', '#e2e8f0')
      .style('pointer-events', 'none')
      .style('opacity', 0)
      .style('z-index', 1000)
      .style('max-width', '250px');

    // Legend
    this._renderLegend();
  }

  _renderLegend() {
    const legend = this.svg.append('g')
      .attr('class', 'legend')
      .attr('transform', 'translate(10, 10)');

    const types = Object.entries(TYPE_LABELS);
    types.forEach(([type, label], i) => {
      const row = legend.append('g')
        .attr('transform', `translate(0, ${i * 20})`);

      row.append('circle')
        .attr('r', 5)
        .attr('fill', TYPE_COLORS[type] || '#64748b');

      row.append('text')
        .attr('x', 12)
        .attr('y', 4)
        .text(label)
        .attr('fill', '#94a3b8')
        .attr('font-size', '10px');
    });
  }

  async loadGraph() {
    const data = await apiGraph('/api/graph/export');
    if (!data || !data.nodes) {
      this._showEmpty('Không có dữ liệu knowledge graph. Hãy thêm tài liệu trước.');
      return;
    }

    this.nodes = data.nodes.map(n => ({
      id: n.id,
      name: n.label || n.id,
      type: n.group || 'other',
      size: Math.max(5, Math.min(20, (n.size || 1) * 3)),
      description: n.description || '',
    }));

    this.links = data.edges.map(e => ({
      source: e.source,
      target: e.target,
      type: e.label || 'related_to',
      weight: e.weight || 1,
    }));

    this._render();
  }

  async searchAndFocus(query) {
    if (!query || query.length < 2) {
      this.loadGraph();
      return;
    }

    const data = await apiGraph(`/api/graph/search?q=${encodeURIComponent(query)}&limit=5`);
    if (!data || !data.entities || data.entities.length === 0) {
      this._showEmpty(`Không tìm thấy entity: "${query}"`);
      return;
    }

    // Get the full graph and highlight matching nodes
    const graphData = await apiGraph('/api/graph/export');
    if (!graphData) return;

    this.nodes = graphData.nodes.map(n => ({
      id: n.id,
      name: n.label || n.id,
      type: n.group || 'other',
      size: Math.max(5, Math.min(20, (n.size || 1) * 3)),
      description: n.description || '',
      highlighted: data.entities.some(e => e.id === n.id || e.name === n.label),
    }));

    this.links = graphData.edges.map(e => ({
      source: e.source,
      target: e.target,
      type: e.label || 'related_to',
      weight: e.weight || 1,
    }));

    this._render();

    // Focus on first matching node
    const match = this.nodes.find(n => n.highlighted);
    if (match) {
      this._focusNode(match);
    }
  }

  _render() {
    if (this.nodes.length === 0) {
      this._showEmpty('Knowledge graph trống.');
      return;
    }

    // Clear previous
    this.g.selectAll('*').remove();

    // Force simulation
    this.simulation = d3.forceSimulation(this.nodes)
      .force('link', d3.forceLink(this.links).id(d => d.id).distance(80))
      .force('charge', d3.forceManyBody().strength(-200))
      .force('center', d3.forceCenter(this.width / 2, this.height / 2))
      .force('collision', d3.forceCollide().radius(d => d.size + 5));

    // Links
    const link = this.g.append('g')
      .selectAll('line')
      .data(this.links)
      .join('line')
      .attr('stroke', '#334155')
      .attr('stroke-opacity', 0.6)
      .attr('stroke-width', d => Math.max(1, (d.weight || 1) * 1.5))
      .attr('marker-end', 'url(#arrowhead)');

    // Link labels
    const linkLabel = this.g.append('g')
      .selectAll('text')
      .data(this.links)
      .join('text')
      .attr('font-size', '8px')
      .attr('fill', '#64748b')
      .attr('text-anchor', 'middle')
      .text(d => d.type.length > 15 ? d.type.slice(0, 15) + '…' : d.type);

    // Nodes
    const node = this.g.append('g')
      .selectAll('g')
      .data(this.nodes)
      .join('g')
      .attr('class', 'graph-node')
      .style('cursor', 'pointer')
      .call(d3.drag()
        .on('start', (event, d) => {
          if (!event.active) this.simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on('drag', (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', (event, d) => {
          if (!event.active) this.simulation.alphaTarget(0.3).restart();
          d.fx = null;
          d.fy = null;
        }));

    // Node circles
    node.append('circle')
      .attr('r', d => d.size)
      .attr('fill', d => TYPE_COLORS[d.type] || '#64748b')
      .attr('stroke', d => d.highlighted ? '#fbbf24' : '#1e293b')
      .attr('stroke-width', d => d.highlighted ? 3 : 1.5)
      .style('filter', d => d.highlighted ? 'drop-shadow(0 0 8px rgba(251, 191, 36, 0.5))' : 'none');

    // Node labels
    node.append('text')
      .attr('dy', d => d.size + 12)
      .attr('text-anchor', 'middle')
      .attr('fill', '#e2e8f0')
      .attr('font-size', '10px')
      .attr('font-weight', d => d.highlighted ? 'bold' : 'normal')
      .text(d => d.name.length > 20 ? d.name.slice(0, 20) + '…' : d.name);

    // Hover tooltip
    node.on('mouseover', (event, d) => {
      const color = TYPE_COLORS[d.type] || '#64748b';
      const typeLabel = TYPE_LABELS[d.type] || d.type;
      this.tooltip
        .style('opacity', 1)
        .html(`<strong style="color:${color}">${d.name}</strong><br/>
               <span style="color:#94a3b8">${typeLabel}</span><br/>
               ${d.description ? d.description.slice(0, 100) : ''}`)
        .style('left', (event.offsetX + 10) + 'px')
        .style('top', (event.offsetY - 10) + 'px');
    })
    .on('mouseout', () => {
      this.tooltip.style('opacity', 0);
    });

    // Click to show details
    node.on('click', (event, d) => {
      this._showNodeDetails(d);
    });

    // Tick
    this.simulation.on('tick', () => {
      link
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);

      linkLabel
        .attr('x', d => (d.source.x + d.target.x) / 2)
        .attr('y', d => (d.source.y + d.target.y) / 2);

      node.attr('transform', d => `translate(${d.x},${d.y})`);
    });
  }

  _showNodeDetails(nodeData) {
    // Dispatch custom event for the app to handle
    const event = new CustomEvent('graphNodeSelected', {
      detail: { node: nodeData }
    });
    document.dispatchEvent(event);
  }

  _focusNode(node) {
    if (!node) return;
    // Center view on node
    this.svg.transition().duration(750).call(
      this.zoom.transform,
      d3.zoomIdentity
        .translate(this.width / 2 - node.x, this.height / 2 - node.y)
        .scale(1.5)
    );
  }

  _showEmpty(msg) {
    this.g.selectAll('*').remove();
    this.g.append('text')
      .attr('x', this.width / 2)
      .attr('y', this.height / 2)
      .attr('text-anchor', 'middle')
      .attr('fill', '#64748b')
      .attr('font-size', '14px')
      .text(msg);
  }

  resize(width, height) {
    this.width = width || this.width;
    this.height = height || this.height;
    this.svg.attr('viewBox', [0, 0, this.width, this.height]);
    if (this.simulation) {
      this.simulation.force('center', d3.forceCenter(this.width / 2, this.height / 2));
      this.simulation.alpha(0.3).restart();
    }
  }

  destroy() {
    if (this.simulation) this.simulation.stop();
    if (this.container) this.container.innerHTML = '';
  }
}

export default KnowledgeGraphViz;
