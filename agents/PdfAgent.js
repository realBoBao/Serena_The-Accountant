import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { analyzePdf } from '../analyze_pdf.js';
import { sendDiscordNotification } from '../notify_discord.js';
import { processAndStoreFlashcards } from '../lib/flashcard_generator.js';

const execFileAsync = promisify(execFile);

export async function processPdf(pdfPath) {
  const fileName = path.basename(pdfPath);
  const title = fileName.replace(/\.pdf$/i, '');

  console.log(chalk.cyan(`PDF Agent: processing file ${fileName}`));
  const pdfResult = await analyzePdf(pdfPath, { outputDir: './artifacts/pdf' });
  console.log(chalk.green(`PDF Agent: extracted ${pdfResult.chunksCount} chunks from ${fileName}`));

  const analysisLabel = `${title} (PDF)`;
  let flashcardMessage = 'No flashcards generated.';
  let flashcardCount = 0;

  // Try to generate flashcards using Gemini first
  try {
    const { stdout, stderr } = await execFileAsync('node', ['analyze_text_gemini.js', pdfResult.descriptionPath, analysisLabel], {
      cwd: path.resolve('./'),
      shell: false,
    });
    if (stderr?.trim()) {
      console.warn(chalk.yellow(`PDF Agent warning: ${stderr.trim()}`));
    }
    flashcardMessage = stdout.trim().split('\n').slice(-2).join(' ');
  } catch (err) {
    console.error(chalk.red('PDF Agent: flashcard generation failed:'), err.message || err);
    flashcardMessage = `Flashcard generation failed: ${err.message || err}`;
  }

  // Also store flashcards in the spaced repetition database
  try {
    const fs = await import('fs/promises');
    const descriptionText = await fs.readFile(pdfResult.descriptionPath, 'utf8');
    const storedCards = await processAndStoreFlashcards(descriptionText, title, 'academic');
    flashcardCount = storedCards.length;
    console.log(chalk.green(`PDF Agent: stored ${flashcardCount} flashcards in spaced repetition DB`));
  } catch (err) {
    console.warn(chalk.yellow('PDF Agent: failed to store flashcards in DB:'), err.message || err);
  }

  try {
    await sendDiscordNotification({
      title: `Book loaded: ${title}`,
      url: pdfPath,
      bullets: [
        `Kết quả PDF: ${pdfResult.chunksCount} đoạn đã vector hoá.`,
        `Flashcards: ${flashcardMessage}`,
        `Spaced repetition: ${flashcardCount} thẻ đã lưu vào database.`,
        `File moved to archive sau khi xử lý.`,
      ],
      type: 'book',
      category: 'AI',
    });
  } catch (notifyErr) {
    console.warn(chalk.yellow('PDF Agent: unable to send Discord notification:'), notifyErr.message || notifyErr);
  }

  return {
    status: 'processed',
    fileName,
    chunks: pdfResult.chunksCount,
    descriptionPath: pdfResult.descriptionPath,
    flashcardSummary: flashcardMessage,
    flashcardCount,
  };
}
