// Structural chunker: markdown in (Drive's text/markdown export), chunks
// out. Pure logic — no Chrome APIs — so it is unit-testable and reusable
// verbatim by the eval harness (commit 19).
//
// Sizing: chars ÷ 4 approximates tokens (the real wordpiece tokenizer
// would couple this module to transformers.js for nothing but counting).
// Target 1000 chars ≈ 256 tokens — deliberately at all-MiniLM-L6-v2's
// max_seq_length, past which the embedder silently truncates.

export type Chunk = {
  /** `${docId}:${seq}` — stable within one export of the doc. */
  id: string;
  docId: string;
  seq: number;
  /** Heading path, outermost first, e.g. ["Q3 Planning", "Budget"]. */
  breadcrumbs: string[];
  text: string;
};

export type ChunkOptions = {
  targetChars: number;
  maxChars: number;
  overlapChars: number;
};

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  targetChars: 1000,
  maxChars: 1200,
  overlapChars: 150,
};

type Section = { breadcrumbs: string[]; blocks: string[] };

export function chunkDoc(
  doc: { id: string; name: string },
  markdown: string,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): Chunk[] {
  const chunks: Chunk[] = [];
  for (const section of parseSections(markdown)) {
    packSection(section, options, (breadcrumbs, text) => {
      const seq = chunks.length;
      chunks.push({ id: `${doc.id}:${seq}`, docId: doc.id, seq, breadcrumbs, text });
    });
  }
  return chunks;
}

/** Strips inline markdown (emphasis, code, links) for breadcrumb display. */
function cleanInline(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+#+\s*$/, "")
    .trim();
}

/** Splits markdown into heading-delimited sections. ATX headings only —
 *  that is what Drive's markdown export produces. Fenced code blocks are
 *  opaque: a `# line` inside one is content, not a heading. */
function parseSections(markdown: string): Section[] {
  const sections: Section[] = [];
  const headingStack: { level: number; title: string }[] = [];
  let current: Section = { breadcrumbs: [], blocks: [] };
  let paragraph: string[] = [];
  let inFence = false;

  const flushParagraph = () => {
    const text = paragraph.join("\n").trim();
    if (text) current.blocks.push(text);
    paragraph = [];
  };
  const closeSection = () => {
    flushParagraph();
    if (current.blocks.length) sections.push(current);
  };

  for (const line of markdown.split(/\r?\n/)) {
    if (/^(```|~~~)/.test(line.trim())) {
      inFence = !inFence;
      paragraph.push(line);
      continue;
    }
    if (inFence) {
      paragraph.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      closeSection();
      const level = heading[1]!.length;
      while (headingStack.length && headingStack.at(-1)!.level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, title: cleanInline(heading[2]!) });
      current = { breadcrumbs: headingStack.map((h) => h.title), blocks: [] };
    } else if (line.trim() === "") {
      flushParagraph();
    } else {
      paragraph.push(line);
    }
  }
  closeSection();
  return sections;
}

/** Packs a section's blocks into chunks up to targetChars. Consecutive
 *  chunks within a section share an overlap: the next chunk starts with
 *  the previous chunk's last sentence(s). Overlap never crosses sections —
 *  headings are semantic boundaries. */
function packSection(
  section: Section,
  options: ChunkOptions,
  emit: (breadcrumbs: string[], text: string) => void,
): void {
  let parts: string[] = [];
  let size = 0;
  let overlap = "";

  const flush = () => {
    if (!parts.length) return;
    const body = parts.join("\n\n");
    emit(section.breadcrumbs, overlap ? `${overlap}\n\n${body}` : body);
    overlap = sentenceTail(body, options.overlapChars);
    parts = [];
    size = 0;
  };

  for (const block of section.blocks) {
    const pieces =
      block.length > options.maxChars ? splitLongBlock(block, options) : [block];
    for (const piece of pieces) {
      if (parts.length && size + piece.length > options.targetChars) flush();
      parts.push(piece);
      size += piece.length;
    }
  }
  flush();
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0);
}

/** Last whole sentence(s) of `text`, at most `cap` chars; "" if even the
 *  final sentence exceeds the cap (better no overlap than a truncated one). */
function sentenceTail(text: string, cap: number): string {
  const sentences = splitSentences(text);
  let tail = "";
  for (let i = sentences.length - 1; i >= 0; i--) {
    const candidate = tail ? `${sentences[i]} ${tail}` : sentences[i]!;
    if (candidate.length > cap) break;
    tail = candidate;
  }
  return tail;
}

/** Splits an oversized block on sentence boundaries; a single sentence
 *  longer than maxChars is hard-split at word boundaries. */
function splitLongBlock(block: string, options: ChunkOptions): string[] {
  const pieces: string[] = [];
  let current = "";
  const push = () => {
    if (current) pieces.push(current);
    current = "";
  };

  for (const sentence of splitSentences(block)) {
    if (sentence.length > options.maxChars) {
      push();
      pieces.push(...hardSplit(sentence, options.targetChars));
      continue;
    }
    if (current && current.length + sentence.length + 1 > options.targetChars) push();
    current = current ? `${current} ${sentence}` : sentence;
  }
  push();
  return pieces;
}

function hardSplit(text: string, size: number): string[] {
  const words = text.split(/\s+/);
  const pieces: string[] = [];
  let current = "";
  for (const word of words) {
    // A single "word" over the cap — a base64 blob, long URL, minified code —
    // gets chopped at character boundaries; no piece may survive oversized.
    if (word.length > size) {
      if (current) {
        pieces.push(current);
        current = "";
      }
      for (let i = 0; i < word.length; i += size) pieces.push(word.slice(i, i + size));
      continue;
    }
    if (current && current.length + word.length + 1 > size) {
      pieces.push(current);
      current = "";
    }
    current = current ? `${current} ${word}` : word;
  }
  if (current) pieces.push(current);
  return pieces;
}
