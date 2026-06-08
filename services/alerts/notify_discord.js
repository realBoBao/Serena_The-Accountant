const CATEGORY_CONFIG = {
  Backend: { color: 0x0077ff, label: 'Backend' },
  AI: { color: 0x8a2be2, label: 'AI' },
  DevOps: { color: 0xffa500, label: 'DevOps' },
  Math: { color: 0x00cc99, label: 'Math' },
  Algorithms: { color: 0xff4500, label: 'Algorithms' },
  Facebook: { color: 0x1877f2, label: 'Facebook' },
};

const LIMITS = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
};

function truncateText(value, maxLength) {
  const text = String(value ?? '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function normalizeBullets(bullets) {
  if (Array.isArray(bullets)) return bullets;
  if (bullets) return [bullets];
  return [];
}

function buildGitHubStatsImage(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== 'github.com') return null;

    const [owner, repo] = parsed.pathname.split('/').filter(Boolean);
    if (!owner || !repo) return null;

    return `https://github-readme-stats.vercel.app/api/pin/?username=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&theme=radical`;
  } catch (_) {
    return null;
  }
}

function getTypeLabel(type) {
  switch (type) {
    case 'repo':
      return 'GitHub Repo';
    case 'video':
      return 'YouTube Video';
    case 'arxiv':
      return 'arXiv Paper';
    case 'reddit':
      return 'Reddit Post';
    case 'stackoverflow':
      return 'StackOverflow Q/A';
    case 'hackernews':
      return 'Hacker News Story';
    case 'book':
      return 'Book/PDF';
    case 'facebook':
      return 'Facebook/Web';
    default:
      return 'Other';
  }
}

function getSourceLabel(type) {
  switch (type) {
    case 'repo':
      return 'GitHub';
    case 'video':
      return 'YouTube';
    case 'arxiv':
      return 'arXiv';
    case 'reddit':
      return 'Reddit';
    case 'stackoverflow':
      return 'StackOverflow';
    case 'hackernews':
      return 'Hacker News';
    case 'book':
      return 'Local PDF';
    case 'facebook':
      return 'Facebook';
    default:
      return 'Unknown';
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AGGREGATED WEBHOOK — Gộp tất cả sources vào 1 Discord Embed duy nhất
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Thay vì gửi N embed rời rạc (1 cho mỗi item), hàm này gộp TẤT CẢ
 * sources (YouTube, GitHub, SO, HN, arXiv, Facebook...) vào 1 embed.
 * 
 * Format output:
 * 📦 [Topic Title]
 *    📊 Sources (Tổng số):
 *    1. [SO] Tên bài viết [Score: 1.00]
 *    2. [HN] Tên bài viết [Score: 0.80]
 *    3. [YouTube] Tên Video [Score: 0.73]
 *    4. [GitHub] Tên Repo [Score: 0.72]
 *    5. [Facebook] Tên post [Score: 0.60]
 * 
 * @param {object} options
 * @param {string} options.topic — Chủ đề tìm kiếm
 * @param {Array}  options.results — Mảng tất cả sources [{title, url, type, category, score, ...}]
 * @param {string} [options.bullets] — Summary bullets (optional)
 */
export async function sendAggregatedWebhook({ topic, results, bullets }) {
  const webhook = process.env.DISCORD_WEBHOOK;
  if (!webhook) throw new Error('DISCORD_WEBHOOK not set');
  if (!isHttpUrl(webhook)) throw new Error('DISCORD_WEBHOOK must be a valid http(s) URL');

  if (!results || results.length === 0) {
    console.log('[Webhook] No results to send');
    return false;
  }

  // Sort by score giảm dần
  const sorted = [...results].sort((a, b) => (b.score || 0) - (a.score || 0));

  // Build sources list with Markdown hyperlinks
  const sourcesLines = sorted.slice(0, 15).map((r, i) => {
    const sourceTag = getSourceTag(r.type);
    const score = r.score != null ? `[Score: ${Number(r.score).toFixed(2)}]` : '';
    const title = (r.title || r.url || `Source ${i + 1}`).slice(0, 70);
    const url = r.url || '';
    // Markdown hyperlink: [title](url)
    const linkedTitle = url ? `[${title}](${url})` : title;
    return `**${i + 1}.** ${sourceTag} ${linkedTitle} ${score}`;
  });

  // Group by type for summary
  const typeCounts = {};
  for (const r of sorted) {
    const tag = getSourceTag(r.type);
    typeCounts[tag] = (typeCounts[tag] || 0) + 1;
  }
  const summaryLine = Object.entries(typeCounts).map(([tag, count]) => `${tag}: ${count}`).join(' | ');

  // Build description
  let description = `📊 **Sources (${sorted.length}):** ${summaryLine}\n\n`;
  description += sourcesLines.join('\n');

  if (bullets) {
    const formattedBullets = normalizeBullets(bullets)
      .slice(0, 3)
      .map(line => `- ${String(line).trim().replace(/^[-*\s]+/, '')}`)
      .filter(line => line.length > 2)
      .join('\n');
    if (formattedBullets) {
      description += `\n\n---\n\n**Summary:**\n${formattedBullets}`;
    }
  }

  // Truncate if too long (Discord limit 4096 for description)
  if (description.length > 4000) {
    description = description.slice(0, 3997) + '...';
  }

  const embed = {
    title: `🔍 ${topic.slice(0, 200)}`,
    description,
    color: 0x00aa55,
    fields: [
      { name: '📦 Total Sources', value: String(sorted.length), inline: true },
      { name: '🏆 Top Score', value: sorted[0]?.score?.toFixed(3) || 'N/A', inline: true },
      { name: '📊 Avg Score', value: (sorted.reduce((a, b) => a + (b.score || 0), 0) / sorted.length).toFixed(3), inline: true },
    ],
    timestamp: new Date().toISOString(),
  };

  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord webhook failed ${res.status}: ${text}`);
  }

  console.log(`[Webhook] ✓ Sent aggregated embed with ${sorted.length} sources`);
  return true;
}

/**
 * Lấy tag hiển thị cho từng loại source
 */
function getSourceTag(type) {
  switch (type) {
    case 'repo':        return '[GitHub]';
    case 'video':       return '[YouTube]';
    case 'stackoverflow': return '[SO]';
    case 'hackernews':  return '[HN]';
    case 'arxiv':       return '[arXiv]';
    case 'reddit':      return '[Reddit]';
    case 'facebook':    return '[FB]';
    case 'twitter':     return '[Twitter]';
    case 'linkedin':    return '[LinkedIn]';
    case 'medium':      return '[Medium]';
    case 'web':         return '[Web]';
    default:            return `[${type || 'Unknown'}]`;
  }
}

export async function sendDiscordNotification({ title, url, bullets, type, category, score, sources }) {
  const webhook = process.env.DISCORD_WEBHOOK;
  if (!webhook) throw new Error('DISCORD_WEBHOOK not set');
  if (!isHttpUrl(webhook)) throw new Error('DISCORD_WEBHOOK must be a valid http(s) URL');

  const formattedBullets = normalizeBullets(bullets)
    .slice(0, 3)
    .map((line) => `- ${String(line).trim().replace(/^[-*\s]+/, '')}`)
    .filter((line) => line.length > 2)
    .join('\n');
  const meta = CATEGORY_CONFIG[category] || { color: 0x999999, label: category || 'General' };
  const embedTitle = truncateText(`${meta.label}: ${title || 'Untitled'}`, LIMITS.title);
  const typeLabel = getTypeLabel(type);
  const sourceLabel = getSourceLabel(type);

  // Build fields array
  const fields = [
    { name: truncateText('Category', LIMITS.fieldName), value: truncateText(category || 'General', LIMITS.fieldValue), inline: true },
    { name: truncateText('Type', LIMITS.fieldName), value: truncateText(typeLabel, LIMITS.fieldValue), inline: true },
    { name: truncateText('Source', LIMITS.fieldName), value: truncateText(sourceLabel, LIMITS.fieldValue), inline: true },
  ];

  // Add score field if available
  if (score != null) {
    const scoreNum = Number(score);
    const barLen = Math.min(10, Math.max(0, Math.round(scoreNum * 10)));
    const scoreBar = '█'.repeat(barLen) + '░'.repeat(10 - barLen);
    fields.push({ name: '📊 Score (Weight)', value: `**${scoreNum.toFixed(3)}** ${scoreBar}`, inline: false });
  }

  // Add sources field
  if (sources && sources.length > 0) {
    const sourcesText = sources.slice(0, 5).map((s, i) => {
      const sScore = s.score != null ? ` [${Number(s.score).toFixed(2)}]` : '';
      const sTitle = s.title || s.url || `Source ${i + 1}`;
      return `**${i + 1}.** ${sTitle.slice(0, 60)}${sScore}`;
    }).join('\n');
    fields.push({ name: `📚 Sources (${sources.length})`, value: truncateText(sourcesText, LIMITS.fieldValue), inline: false });
  }

  const embed = {
    title: embedTitle,
    description: truncateText(formattedBullets || 'No analysis summary available.', LIMITS.description),
    color: meta.color,
    fields,
  };

  if (isHttpUrl(url)) embed.url = url;
  if (type === 'repo' && isHttpUrl(url)) {
    const imageUrl = buildGitHubStatsImage(url);
    if (imageUrl) embed.image = { url: imageUrl };
  }

  // Sử dụng unified sender với retry + rate limit handling
  const { executeDiscordWebhook } = await import('../webhook_bot.js');
  const result = await executeDiscordWebhook({ embeds: [embed] });

  if (!result.sent) {
    throw new Error(`Discord webhook failed: ${result.error || result.status}`);
  }

  return true;
}
