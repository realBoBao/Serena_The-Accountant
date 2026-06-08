import 'dotenv/config';

const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const YOUTUBE_CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';

async function fetchChannels(topic = 'Node.js backend beginner', maxResults = 5, minViews = 100000) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error('Thiếu YOUTUBE_API_KEY trong .env. Hãy thêm khóa API Google của bạn.');
  }

  const isApiKey = apiKey.startsWith('AIza');
  const params = new URLSearchParams({
    part: 'snippet',
    q: topic,
    type: 'channel',
    maxResults: String(Math.min(maxResults * 2, 50)),
    order: 'viewCount',
  });

  if (isApiKey) {
    params.set('key', apiKey);
  }

  const headers = isApiKey ? {} : { Authorization: `Bearer ${apiKey}` };
  const response = await fetch(`${YOUTUBE_SEARCH_URL}?${params.toString()}`, { headers });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`YouTube API error ${response.status}: ${response.statusText}\n${errorBody}`);
  }

  const data = await response.json();
  const channels = data.items ?? [];

  if (channels.length === 0) {
    console.log(`Không tìm thấy kênh nào cho chủ đề:`, topic);
    return;
  }

  const channelIds = channels.map((item) => item.id.channelId).filter(Boolean).join(',');
  const statsParams = new URLSearchParams({
    part: 'statistics,snippet',
    id: channelIds,
  });
  if (isApiKey) {
    statsParams.set('key', apiKey);
  }

  const statsResponse = await fetch(`${YOUTUBE_CHANNELS_URL}?${statsParams.toString()}`, { headers });
  if (!statsResponse.ok) {
    const errorBody = await statsResponse.text();
    throw new Error(`YouTube channels API error ${statsResponse.status}: ${statsResponse.statusText}\n${errorBody}`);
  }

  const statsData = await statsResponse.json();
  const statsMap = new Map();
  for (const item of statsData.items ?? []) {
    statsMap.set(item.id, item);
  }

  const enrichedChannels = channels
    .map((item) => ({
      ...item,
      details: statsMap.get(item.id.channelId) ?? null,
    }))
    .filter((item) => item.details && Number(item.details.statistics?.viewCount ?? 0) >= minViews)
    .sort((a, b) => Number(b.details.statistics?.viewCount ?? 0) - Number(a.details.statistics?.viewCount ?? 0))
    .slice(0, maxResults);

  if (enrichedChannels.length === 0) {
    console.log(`Không tìm thấy kênh có view >= ${minViews} cho chủ đề:`, topic);
    return;
  }

  console.log(`Top ${enrichedChannels.length} kênh YouTube cho chủ đề "${topic}" (view >= ${minViews.toLocaleString('en-US')}):\n`);
  enrichedChannels.forEach((item, index) => {
    const { channelId } = item.id;
    const { title, description } = item.snippet;
    const stats = item.details.statistics;
    const viewCount = Number(stats?.viewCount || 0).toLocaleString('en-US');
    const subscriberCount = stats?.hiddenSubscriberCount ? 'Ẩn' : Number(stats?.subscriberCount || 0).toLocaleString('en-US');
    const videoCount = Number(stats?.videoCount || 0).toLocaleString('en-US');
    
    console.log(`${index + 1}. ${title}`);
    console.log(`   URL: https://www.youtube.com/channel/${channelId}`);
    console.log(`   Views: ${viewCount}`);
    console.log(`   Subscribers: ${subscriberCount}`);
    console.log(`   Videos: ${videoCount}`);
    console.log(`   Description: ${description?.slice(0, 100).replace(/\s+/g, ' ') || 'N/A'}${description && description.length > 100 ? '...' : ''}\n`);
  });
}

const [topicArg, maxResultsArg, minViewsArg] = process.argv.slice(2);
const topic = topicArg || 'Node.js backend beginner';
const maxResults = maxResultsArg ? Number(maxResultsArg) : 5;
const minViews = minViewsArg ? Number(minViewsArg) : 50000;

fetchChannels(topic, maxResults, minViews).catch((error) => {
  console.error('Lỗi khi gọi YouTube API:', error.message || error);
});
