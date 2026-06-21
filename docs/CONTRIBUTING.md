# 🧩 Plugin Development Guide

## Kiến trúc Plugin

Plugins hoạt động giống **Linux kernel modules**:
- **Permission boundary**: Plugin chỉ gọi được những gì `PluginAPI` cho phép
- **Lifecycle**: `onLoad()` → `onMessage()` → `onUnload()`
- **Fail isolation**: 1 plugin lỗi không crash bot

## Tạo Plugin Mới

### 1. Tạo thư mục plugin

```
plugins/your-plugin/
├── manifest.json    # Metadata + permissions
└── agent.js         # Plugin class
```

### 2. Viết `manifest.json`

```json
{
  "name": "your-plugin",
  "version": "1.0.0",
  "author": "your-name",
  "description": "Mô tả plugin",
  "entry": "agent.js",
  "permissions": ["llm:ask", "discord:reply"],
  "intents": ["YOUR_INTENT"],
  "config_schema": {
    "YOUR_API_KEY": { "type": "string", "required": true, "secret": true }
  }
}
```

### 3. Viết `agent.js`

```javascript
export default class YourAgent {
  constructor(api, config) {
    this.api = api;        // PluginAPI instance
    this.config = config;  // Env vars từ config_schema
  }

  async onLoad() { /* khởi tạo */ }
  async onMessage(message, userId) { /* xử lý message */ }
  async onUnload() { /* cleanup */ }
}
```

## Permissions

| Permission | Methods | Mô tả |
|---|---|---|
| `llm:ask` | `api.ask()` | Gọi LLM (max 500 tokens) |
| `kg:read` | `api.kgSearch()`, `api.kgGetEntity()` | Đọc Knowledge Graph |
| `kg:write` | `api.kgAddFact()` | Ghi facts (confidence 0.6) |
| `memory:read` | `api.memoryGetStrength()` | Đọc memory strength |
| `memory:write` | `api.memoryRecord()` | Ghi memory (type: plugin_interaction) |
| `discord:reply` | `api.reply()` | Reply Discord message |
| `f1:log` | `api.logMetric()` | Log metrics |

## Quy tắc

1. **KHÔNG** import trực tiếp `lib/llm.js`, `lib/knowledge_graph.js`, etc.
2. **CHỈ** tương tác qua `this.api`
3. Facts ghi vào KG tự động có `source: 'plugin:name'` và confidence 0.6
4. Mọi reply tự động có footer "via plugin: name"

## Test Plugin

```bash
# Load plugin
node -e "import('./lib/plugin_loader.js').then(m => m.PluginLoader.load('your-plugin'))"

# Xem danh sách plugins
!plugins

# Unload plugin
!plugin unload your-plugin
```
