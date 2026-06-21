import { routerAgent } from './agents/RouterAgent.js';
console.log('RouterAgent loaded OK');
console.log('getDetailedAgentUsage:', typeof routerAgent.getDetailedAgentUsage);
console.log('getUnusedAgents:', typeof routerAgent.getUnusedAgents);
const usage = routerAgent.getDetailedAgentUsage();
console.log('Usage entries:', usage.length);
const unused = routerAgent.getUnusedAgents(7);
console.log('Unused agents:', unused.length);
