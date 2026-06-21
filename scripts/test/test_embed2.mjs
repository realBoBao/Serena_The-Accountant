import 'dotenv/config';
import { embedText } from '../lib/embeddings.js';

const result = await embedText('microservices and distributed systems');
console.log('Type:', result?.constructor?.name);
console.log('Length:', result?.length);
console.log('Sample [0-9]:', result?.slice(0, 10));
console.log('Sample [100-110]:', result?.slice(100, 110));
console.log('Max:', result ? Math.max(...result) : 'N/A');
console.log('Min:', result ? Math.min(...result) : 'N/A');
