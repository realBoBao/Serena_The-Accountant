/**
 * lib/langchain_bridge.js — LangChain lazy bridge
 *
 * Gộp tất cả LangChain imports vào 1 file để giảm startup time.
 * Thay vì import trực tiếp từ @langchain/core/messages ở nhiều file,
 * chỉ cần import từ file này — Node.js sẽ cache module sau lần đầu.
 *
 * @module lib/langchain_bridge
 */

// Re-export tất cả LangChain APIs dùng trong project
export { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
export { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
export { StringOutputParser } from '@langchain/core/output_parsers';
export { RunnableSequence } from '@langchain/core/runnables';
export { BaseMemory } from '@langchain/core/memory';
export { Document } from '@langchain/core/documents';

// Re-export LangChain community (optional — only if installed)
// Uncomment when @langchain/openai is added to package.json
// export { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';

// Re-export LangChain core (lazy loaded internally)
export { CallbackManager } from '@langchain/core/callbacks/manager';
export { BaseCallbackHandler } from '@langchain/core/callbacks/base';

export default {
  HumanMessage,
  SystemMessage,
  AIMessage,
  ChatPromptTemplate,
  MessagesPlaceholder,
  StringOutputParser,
  RunnableSequence,
  BaseMemory,
  Document,
  ChatGoogleGenerativeAI,
  CallbackManager,
  BaseCallbackHandler,
};
