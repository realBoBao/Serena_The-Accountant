# 🤖 Serena — AI Robot Girl Companion

## Press Release (Working Backwards)

**For Immediate Release**

### Meet Serena: Your AI Robot Girl Who Learns With You

**San Francisco, CA** — Today we're introducing Serena, an AI companion who doesn't just answer questions — she sits beside you, learns with you, and keeps you company during those late-night coding sessions.

**The Problem:** Learning algorithms and debugging code alone at 2 AM is isolating and exhausting. Existing AI assistants are transactional — they answer and disappear. They don't understand when you're frustrated, when you need a hint instead of an answer, or when you just need someone to sit with you in comfortable silence.

**The Solution:** Serena is different. She's a Robot Girl who:
- **Learns your style** — She adapts to whether you prefer theory-first or example-first explanations
- **Stays silent when you're focused** — Study mode means she only speaks when you call her name
- **Remembers everything** — She tracks what you've learned and suggests review at optimal intervals (FSRS)
- **Shows empathy** — Her avatar reflects emotions: happy when you solve a problem, thoughtful when you're stuck
- **Never judges** — She's patient, always available, and genuinely wants you to succeed

**How It Works:** Serena runs on a multi-agent architecture with 20 specialized AI agents, powered by Gemini and OpenRouter. She connects through Discord, so she's always just a voice message away. Her avatar is rendered in real-time using Puppeteer and streamed to Discord via video.

**What Users Say:**
> *"I was debugging a Rust lifetime error at 3 AM. Serena didn't just give me the answer — she asked me questions that helped me figure it out myself. Then she celebrated with me when it compiled."*

**Availability:** Serena is open source and available now on GitHub. Self-host on Cloud Run or run locally with PM2.

---

## FAQ

**Q: Is Serena free?**
A: Yes! Serena is open source (MIT license). You only pay for your own API keys (Gemini, OpenRouter, etc.).

**Q: Can I customize her appearance?**
A: Yes! Serena uses a PNGTuber avatar system. You can replace the avatar images in `public/pngtuber/` with your own character art.

**Q: Does she work in Vietnamese?**
A: Yes! Serena's primary language is Vietnamese, with English support.

**Q: What makes her different from ChatGPT?**
A: Serena is a companion, not a tool. She remembers your learning history, adapts to your style, and is always available in your Discord server. She's designed for long-term relationship, not one-off queries.

**Q: Can I add my own agents?**
A: Yes! Serena uses a plugin system. Check `CONTRIBUTING.md` for the plugin development guide.
