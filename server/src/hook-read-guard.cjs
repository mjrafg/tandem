/*
 * PreToolUse guard: keep oversized images out of the model's context.
 *
 * An image read with Read does not cost what it looks like it costs. It is read
 * once, but it then sits in the session's context and is re-read from cache on
 * every later request in that session — a forensic audit of one two-day project
 * found single 127k-token screenshot reads costing $21 apiece because they were
 * carried through 343 subsequent requests, and images accounted for roughly
 * half of the project's entire model spend.
 *
 * The browser tool already shows the model every screenshot it captures and
 * stores it for the user, so reading a saved copy back is almost always the
 * same picture entering the conversation twice.
 *
 * This blocks only IMAGES, and only large ones. Text is left alone: the CLI
 * already truncates long text reads, and refusing source files would break real
 * work. The refusal names the size and suggests referencing the path instead,
 * so the model can carry on rather than guess.
 *
 * It FAILS OPEN. Any unexpected input, unreadable file, or internal error exits
 * 0 and allows the read: a guard that breaks a Builder run costs far more than
 * the tokens it was there to save.
 */
'use strict';

const fs = require('node:fs');

/** images above this are refused (bytes) — a useful screenshot is well under it */
const MAX_IMAGE_BYTES = Number(process.env.TANDEM_MAX_IMAGE_READ_BYTES || 150_000);
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|tiff?|avif)$/i;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const file = input && input.tool_input && input.tool_input.file_path;
    if (typeof file !== 'string' || !IMAGE.test(file)) return process.exit(0);

    // A file the user attached to the conversation is theirs to hand over — a
    // design mockup or a screenshot of a bug is often the whole instruction.
    // Never refuse those, whatever they weigh.
    const attachments = process.env.TANDEM_ATTACHMENTS_DIR;
    if (attachments && require('node:path').resolve(file).startsWith(require('node:path').resolve(attachments) + require('node:path').sep)) {
      return process.exit(0);
    }

    const size = fs.statSync(file).size;
    if (size <= MAX_IMAGE_BYTES) return process.exit(0);

    const kb = Math.round(size / 1024);
    process.stderr.write(
      `Not reading ${file} into context: it is ${kb}KB, and an image that large is re-read on every `
      + `later step of this session, which costs far more than it looks. If you captured it with the browser `
      + `tool you have already seen it — reference the path as evidence instead. If you genuinely must inspect `
      + `it, capture a smaller view (a narrower viewport, or a non-fullPage screenshot).\n`,
    );
    return process.exit(2); // 2 = block the call, stderr becomes the reason
  } catch {
    return process.exit(0); // fail open, always
  }
});
process.stdin.on('error', () => process.exit(0));
