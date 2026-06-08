import 'dotenv/config';
import { addFlashcard } from './flashcard_db.js';

const openRouterApiKey = process.env.OPENROUTER_API_KEY;

async function generateFlashcardsFromText(text, source = 'unknown', category = 'general') {
  if (!openRouterApiKey) {
    console.warn('OPENROUTER_API_KEY not set, using fallback extraction');
    return extractFlashcardsFallback(text, source, category);
  }

  const prompt = `You are an expert at creating technical flashcards for spaced repetition learning.

Given the following text, extract 3-5 high-quality flashcards focusing on SYSTEM ARCHITECTURE, PERFORMANCE OPTIMIZATION, DATA STRUCTURES, or MEMORY MANAGEMENT.

Return ONLY valid JSON:
{
  "flashcards": [
    {
      "question": "What is...?",
      "answer": "Answer with code excerpt or proof. Source: ${source}"
    }
  ]
}

Text:
${text.slice(0, 8000)}`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openRouterApiKey}`
      },
      body: JSON.stringify({
        model: 'google/gemma-2-9b-it:free',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return extractFlashcardsFallback(text, source, category);
    
    const parsed = JSON.parse(match[0]);
    const cards = parsed.flashcards || [];
    
    return cards.map(card => ({
      question: card.question || '',
      answer: card.answer || '',
      source,
      category
    })).filter(c => c.question && c.answer);
    
  } catch (err) {
    console.error('Flashcard generation failed:', err.message);
    return extractFlashcardsFallback(text, source, category);
  }
}

function extractFlashcardsFallback(text, source, category) {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20);
  const cards = [];
  
  for (let i = 0; i < Math.min(3, sentences.length); i++) {
    const sentence = sentences[i].trim();
    cards.push({
      question: `What is the key concept from: "${sentence.slice(0, 60)}..."?`,
      answer: `${sentence}. Source: ${source}`,
      source,
      category
    });
  }
  
  return cards;
}

async function processAndStoreFlashcards(text, source, category = 'general') {
  const cards = await generateFlashcardsFromText(text, source, category);
  const results = [];
  
  for (const card of cards) {
    try {
      const id = await addFlashcard(card);
      results.push({ id, ...card });
    } catch (err) {
      console.error('Failed to store flashcard:', err.message);
    }
  }
  
  return results;
}

export { generateFlashcardsFromText, extractFlashcardsFallback, processAndStoreFlashcards };