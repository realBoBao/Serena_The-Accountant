# 🔑 API Keys Setup Guide

Hệ thống cần các API keys sau để hoạt động đầy đủ:

## 1. Gemini API Key (BẮT BUỘC)
- Truy cập: https://aistudio.google.com/app/apikey
- Tạo key mới → Copy vào `.env`:
  ```
  GEMINI_API_KEY=AIzaSy...
  ```
- Free tier: 20 requests/min, 1500 requests/day
- Nếu bị rate limit: đợi 60s hoặc nâng lên paid tier

## 2. OpenRouter API Key (KHUYẾN NGHỊ)
- Truy cập: https://openrouter.ai/keys
- Tạo key mới → Copy vào `.env`:
  ```
  OPENROUTER_API_KEY=sk-or-v1-...
  ```
- Có nhiều model free: gemma-2-9b-it, mistral-7b-instruct, llama-3.1-8b
- Không bị rate limit nặng như Gemini

## 3. Tavily API Key (TÙY CHỌN)
- Truy cập: https://app.tavily.com
- Free tier: 1000 requests/tháng
- Dùng cho web search khi Gemini không đủ context

## 4. YouTube API Key (TÙY CHỌN)
- Truy cập: https://console.cloud.google.com/apis/credentials
- Enable YouTube Data API v3
- Free tier: 10,000 units/day

## 5. GitHub Token (TÙY CHỌN)
- Truy cập: https://github.com/settings/tokens
- Tạo token với quyền `public_repo`
- Dùng cho GitHub search

## 6. Google Custom Search (TÙY CHỌN)
- Truy cập: https://console.cloud.google.com/apis/library/customsearch.googleapis.com
- Enable API → Tạo API key
- Tạo Custom Search Engine: https://programmablesearchengine.google.com
- Copy CX ID vào `.env`

## Thứ tự ưu tiên LLM
1. OpenRouter (nhiều model free, ít rate limit)
2. Gemini (nhanh nhưng quota thấp)
3. Local LLM (nếu có llama-server)
4. Static fallback (offline mode)

## Kiểm tra API keys
```powershell
node test_api_keys.mjs
```
