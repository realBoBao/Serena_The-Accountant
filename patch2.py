from pathlib import Path

# update analyze_text_gemini prompt requirement
p = Path('analyze_text_gemini.js')
t = p.read_text()
old = '- For `flashcards`, produce concise, high-quality Q/A pairs (3-10) that capture the core architecture and learning points.\n- For `complexity`, scan the provided text for code blocks or algorithm descriptions; for each significant snippet explain time and space complexity and a one-line justification. If no code found, return an empty array. Use Big-O notation.\n- Cross-check external metrics (stars/views) with the README/transcript: if stars/views are high but content lacks depth, indicate that in `summary` and in `quality` assessment.\n'
new = '- `category` must be exactly one of Backend, AI, DevOps, Math, or Algorithms based on the dominant content and architecture.\n- For `flashcards`, produce concise, high-quality Q/A pairs (3-10) that capture the core architecture and learning points.\n- For `complexity`, scan the provided text for code blocks or algorithm descriptions; for each significant snippet explain time and space complexity and a one-line justification. If no code found, return an empty array. Use Big-O notation.\n- Cross-check external metrics (stars/views) with the README/transcript: if stars/views are high but content lacks depth, indicate that in `summary` and in `quality` assessment.\n'
if old not in t:
    raise SystemExit('prompt requirement block not found')
t = t.replace(old, new, 1)
# update pipeline category validation
for path in ['pipeline_report_v2.js']:
    p = Path(path)
    t = p.read_text()
    old = "if(['Backend', 'AI', 'DevOps'].includes(parsed.category)) category = parsed.category;\n"
    new = "if(['Backend', 'AI', 'DevOps', 'Math', 'Algorithms'].includes(parsed.category)) category = parsed.category;\n"
    if old not in t:
        raise SystemExit(f'pattern not found in {path}')
    t = t.replace(old, new, 1)
    p.write_text(t)
# write analyze_text_gemini after patching requirements
Path('analyze_text_gemini.js').write_text(t if 'prompt requirement block not found' not in t else t)
print('patched')
