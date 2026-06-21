/**
 * Test all new discord commands without needing Discord
 */
import { readFileSync } from 'fs';

// Simulate message content matching
const tests = [
  { input: '!help', expected: 'help command' },
  { input: '!help ', expected: 'help command' },
  { input: '!cli docker', expected: 'cli command' },
  { input: '!cli nginx', expected: 'cli command' },
  { input: '!cs list', expected: 'cs list command' },
  { input: '!cs algorithms', expected: 'cs subject command' },
  { input: '!gaps', expected: 'gaps command' },
  { input: '!resources hosting', expected: 'resources command' },
  { input: '!leave', expected: 'leave command' },
  { input: '!voice leave', expected: 'voice leave command' },
];

// Read discord_bot.js and check if each command is handled
const code = readFileSync('./discord_bot.js', 'utf8');

console.log('=== Command Coverage Test ===\n');

for (const test of tests) {
  const { input } = test;

  // Check if the command pattern exists in code
  let found = false;

  if (input === '!help' || input === '!help ') {
    found = code.includes("content === '!help'") || code.includes("content === '!help '");
  } else if (input.startsWith('!cli ')) {
    found = code.includes("content.startsWith('!cli ')") || code.includes("message.content.slice(5).trim()");
  } else if (input.startsWith('!cs ')) {
    found = code.includes("content.startsWith('!cs ')") || code.includes("message.content.slice(4).trim()");
  } else if (input === '!gaps') {
    found = code.includes("content === '!gaps'") || code.includes("content === '!gap'");
  } else if (input.startsWith('!resources ')) {
    found = code.includes("content.startsWith('!resources ')") || code.includes("message.content.slice(11).trim()");
  } else if (input === '!leave') {
    found = code.includes("content === '!voice leave'") || code.includes("content === '!leave'");
  } else if (input === '!voice leave') {
    found = code.includes("content === '!voice leave'");
  }

  console.log(`${found ? '✅' : '❌'} ${input} — ${found ? 'FOUND' : 'MISSING'}`);
}

// Check for duplicate !help blocks
const helpMatches = code.match(/content === '!help'/g);
console.log(`\n!help occurrences: ${helpMatches?.length || 0} (should be 1)`);

// Check !help is BEFORE intent classification
const helpPos = code.indexOf("content === '!help'");
const intentPos = code.indexOf("classifyIntent");
console.log(`!help position: ${helpPos}, intent classification: ${intentPos}`);
console.log(`${helpPos < intentPos ? '✅' : '❌'} !help is ${helpPos < intentPos ? 'BEFORE' : 'AFTER'} intent classification`);

// Check !leave has guild null check
const leavePos = code.indexOf("content === '!leave'");
const guildCheck = code.indexOf("message.guild", leavePos);
console.log(`${guildCheck > leavePos && guildCheck < leavePos + 200 ? '✅' : '❌'} !leave has guild null check`);

console.log('\n=== Done ===');
