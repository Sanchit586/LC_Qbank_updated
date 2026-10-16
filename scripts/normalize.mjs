#!/usr/bin/env node

/**
 * @fileoverview Normalization script – converts raw collected LeetCode data
 * into the project's final JSON schema.
 *
 * For each raw file in tmp/raw/, this script:
 *   1. Converts HTML content → Markdown (via turndown)
 *   2. Extracts constraints and examples from the content
 *   3. Resolves category/subcategory via shared utility
 *   4. Builds starter-code, stats, SQL, and test-case objects
 *   5. Writes the normalized JSON to questions/{cat}/{subcat}/{slug}.json
 *
 * Usage:
 *   node scripts/normalize.mjs [--force] [--slug <slug>]
 *
 * Flags:
 *   --force        Re-normalize all questions (even if output file exists).
 *   --slug <slug>  Normalize only the specified question.
 *
 * @module normalize
 */

import { readFile, readdir, writeFile, access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import TurndownService from 'turndown';
import {
  PROJECT_ROOT,
  QUESTIONS_DIR,
  ensureDir,
  resolveCategory,
  getQuestionFilePath,
} from './utils.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directory containing raw API responses. */
const RAW_DIR = join(PROJECT_ROOT, 'tmp', 'raw');

// ---------------------------------------------------------------------------
// Turndown setup
// ---------------------------------------------------------------------------

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

// Preserve <pre> blocks as fenced code blocks
turndown.addRule('pre', {
  filter: 'pre',
  replacement(content, node) {
    const code = node.querySelector('code');
    const lang = code?.getAttribute('class')?.replace('language-', '') ?? '';
    const text = code ? code.textContent : node.textContent;
    return `\n\`\`\`${lang}\n${text.trim()}\n\`\`\`\n`;
  },
});

// Inline <code> → backticks
turndown.addRule('code', {
  filter(node) {
    return node.nodeName === 'CODE' && !node.closest('pre');
  },
  replacement(content) {
    return `\`${content}\``;
  },
});

// <sup> → superscript notation
turndown.addRule('sup', {
  filter: 'sup',
  replacement(content) {
    return `^(${content})`;
  },
});

// <sub> → subscript notation
turndown.addRule('sub', {
  filter: 'sub',
  replacement(content) {
    return `_(${content})`;
  },
});

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * Parses command-line flags.
 *
 * @returns {{ force: boolean, slug: string | null }}
 */
function parseArgs() {
  const args = process.argv.slice(2);
  let force = false;
  let slug = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force') {
      force = true;
    } else if (args[i] === '--slug' && i + 1 < args.length) {
      slug = args[++i];
    }
  }

  return { force, slug };
}

// ---------------------------------------------------------------------------
// Content extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extracts constraints from the HTML content.
 * Looks for a <ul> list following a "Constraints:" heading or bold label.
 *
 * @param {string} html - The raw HTML content string.
 * @returns {string[]} Array of constraint strings.
 */
function extractConstraints(html) {
  if (!html) return [];

  // Match constraints section: look for "Constraints:" followed by a <ul>
  const constraintsRegex =
    /(?:<strong>|<b>|<p><strong>)\s*Constraints:\s*(?:<\/strong>|<\/b>|<\/p>)\s*<ul>([\s\S]*?)<\/ul>/i;
  const match = html.match(constraintsRegex);

  if (!match) return [];

  const listHtml = match[1];
  const items = [];
  const liRegex = /<li>([\s\S]*?)<\/li>/gi;
  let m;

  while ((m = liRegex.exec(listHtml)) !== null) {
    // Strip inner HTML tags for a clean text constraint
    const text = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .trim();
    if (text) items.push(text);
  }

  return items;
}

/**
 * Extracts examples from the HTML content.
 * Looks for "Example N:" sections and pulls input, output, explanation.
 *
 * @param {string} html - The raw HTML content string.
 * @returns {Array<{input: string, output: string, explanation: string|null}>}
 */
function extractExamples(html) {
  if (!html) return [];

  const examples = [];

  // Split by "Example N:" markers
  const exampleBlocks =
    html.split(/(?:<strong>|<b>|<p><strong>)\s*Example\s+\d+:\s*(?:<\/strong>|<\/b>|<\/p>)/i);

  // First element is content before examples – skip it
  for (let i = 1; i < exampleBlocks.length; i++) {
    const block = exampleBlocks[i];
    const example = { input: '', output: '', explanation: null };

    // Extract Input
    const inputMatch = block.match(
      /(?:<strong>|<b>)\s*Input:\s*(?:<\/strong>|<\/b>)\s*([\s\S]*?)(?=(?:<strong>|<b>)\s*Output:|$)/i
    );
    if (inputMatch) {
      example.input = inputMatch[1].replace(/<[^>]+>/g, '').trim();
    }

    // Extract Output
    const outputMatch = block.match(
      /(?:<strong>|<b>)\s*Output:\s*(?:<\/strong>|<\/b>)\s*([\s\S]*?)(?=(?:<strong>|<b>)\s*Explanation:|<\/pre>|$)/i
    );
    if (outputMatch) {
      example.output = outputMatch[1].replace(/<[^>]+>/g, '').trim();
    }

    // Extract Explanation (optional)
    const explainMatch = block.match(
      /(?:<strong>|<b>)\s*Explanation:\s*(?:<\/strong>|<\/b>)\s*([\s\S]*?)(?=<\/pre>|$)/i
    );
    if (explainMatch) {
      example.explanation = explainMatch[1].replace(/<[^>]+>/g, '').trim() || null;
    }

    // Only include if we got at least input or output
    if (example.input || example.output) {
      examples.push(example);
    }
  }

  return examples;
}

/**
 * Safely parses a JSON string, returning null on failure.
 *
 * @param {string|null|undefined} str - JSON string to parse.
 * @returns {object|null}
 */
function safeParse(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Normalization logic
// ---------------------------------------------------------------------------

/**
 * Normalizes a single raw question object into the final schema.
 *
 * @param {object} raw - The raw question data from the API.
 * @returns {object} The normalized question object.
 */
function normalizeQuestion(raw) {
  const tags = (raw.topicTags ?? []).map((t) => t.name);
  const { category, subcategory } = resolveCategory(tags, raw.categoryTitle, raw.content, raw.title);

  // Convert HTML content to Markdown
  const statement = raw.content ? turndown.turndown(raw.content) : '';

  // Extract structured data from HTML
  const constraints = extractConstraints(raw.content);
  const examples = extractExamples(raw.content);

  // Build starter code map
  let starterCode = null;
  if (raw.codeSnippets && raw.codeSnippets.length > 0) {
    starterCode = {};
    for (const snippet of raw.codeSnippets) {
      starterCode[snippet.langSlug] = snippet.code;
    }
  }

  // Parse test cases
  let publicTests = null;
  if (examples.length > 0) {
    publicTests = examples.map((e) => ({
      input: e.input,
      expectedOutput: e.output || null,
    }));
  } else if (raw.exampleTestcaseList && raw.exampleTestcaseList.length > 0) {
    publicTests = raw.exampleTestcaseList.map((tc) => ({
      input: tc,
      expectedOutput: null,
    }));
  }

  // Parse stats
  let stats = null;
  const parsedStats = safeParse(raw.stats);
  if (parsedStats) {
    stats = {
      totalAccepted: String(parsedStats.totalAccepted ?? '0'),
      totalSubmission: String(parsedStats.totalSubmission ?? '0'),
      totalAcceptedRaw: parsedStats.totalAcceptedRaw,
      totalSubmissionRaw: parsedStats.totalSubmissionRaw,
      acRate: String(parsedStats.acRate ?? '0%'),
    };
  }

  // Handle SQL/database questions
  let sqlSchema = null;
  let sqlSetup = null;
  if (raw.mysqlSchemas && raw.mysqlSchemas.length > 0) {
    const createStatements = [];
    const insertStatements = [];

    for (const schema of raw.mysqlSchemas) {
      const trimmed = schema.trim();
      if (/^CREATE\s+TABLE/i.test(trimmed)) {
        createStatements.push(trimmed);
      } else if (/^INSERT\s+INTO/i.test(trimmed)) {
        insertStatements.push(trimmed);
      } else if (trimmed) {
        // Other SQL statements – group with CREATE as schema definition
        createStatements.push(trimmed);
      }
    }

    if (createStatements.length > 0) {
      sqlSchema = createStatements.join('\n\n');
    }
    if (insertStatements.length > 0) {
      sqlSetup = insertStatements;
    }
  }

  return {
    id: String(raw.questionFrontendId),
    slug: raw.titleSlug,
    title: raw.title,
    category,
    subcategory,
    difficulty: raw.difficulty,
    tags,
    statement,
    constraints,
    examples,
    starterCode,
    publicTests,
    sqlSchema,
    sqlSetup,
    expectedOutput: null,
    solution: null,
    hints: raw.hints ?? [],
    stats,
    source: {
      name: 'LeetCode',
      url: `https://leetcode.com/problems/${raw.titleSlug}/`,
      licenseOrPermissionReference: 'Authorized collection',
      collectedAt: new Date().toISOString(),
      sourceUpdatedAt: null,
    },
  };
}

/**
 * Checks whether a file exists at the given path.
 *
 * @param {string} filePath - Absolute path.
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes the normalized question JSON to the correct output path.
 * Handles slug collisions by appending the question id.
 *
 * @param {object} normalized - The normalized question object.
 * @returns {Promise<string>} The relative output path.
 */
async function writeNormalized(normalized) {
  const dir = join(QUESTIONS_DIR, normalized.category, normalized.subcategory);
  await ensureDir(dir);

  let filename = `${normalized.slug}.json`;
  let filePath = join(dir, filename);

  // Handle slug collision – file exists with a different question id
  if (await fileExists(filePath)) {
    try {
      const existing = JSON.parse(await readFile(filePath, 'utf-8'));
      if (existing.id !== normalized.id) {
        filename = `${normalized.slug}-${normalized.id}.json`;
        filePath = join(dir, filename);
      }
    } catch {
      // If we can't read the existing file, overwrite
    }
  }

  await writeFile(filePath, JSON.stringify(normalized, null, 2), 'utf-8');

  // Return a relative path for logging
  return `questions/${normalized.category}/${normalized.subcategory}/${filename}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Entry point – runs the normalization pipeline.
 */
async function main() {
  const { force, slug } = parseArgs();

  console.log('=== LeetCode Normalization ===');
  if (force) console.log('  Mode: force (re-normalizing all)');
  if (slug) console.log(`  Single slug: ${slug}`);
  console.log();

  // 1. List raw files to process
  let rawFiles;
  try {
    rawFiles = await readdir(RAW_DIR);
    rawFiles = rawFiles.filter((f) => f.endsWith('.json'));
  } catch (err) {
    console.error(`Cannot read raw directory (${RAW_DIR}): ${err.message}`);
    console.error('Run collect.mjs first to populate tmp/raw/.');
    process.exit(1);
  }

  // Filter to single slug if requested
  if (slug) {
    rawFiles = rawFiles.filter((f) => basename(f, '.json') === slug);
    if (rawFiles.length === 0) {
      console.error(`No raw file found for slug "${slug}".`);
      process.exit(1);
    }
  }

  const total = rawFiles.length;
  console.log(`Found ${total} raw file(s) to process.\n`);

  // Counters
  let normalized = 0;
  let skipped = 0;
  let failures = 0;
  const categoryCounts = {};

  for (let i = 0; i < rawFiles.length; i++) {
    const file = rawFiles[i];
    const fileSlug = basename(file, '.json');

    try {
      // Read raw JSON
      const rawContent = await readFile(join(RAW_DIR, file), 'utf-8');
      const raw = JSON.parse(rawContent);

      // Check if output already exists (unless --force)
      if (!force) {
        const tags = (raw.topicTags ?? []).map((t) => t.name);
        const { category, subcategory } = resolveCategory(tags, raw.categoryTitle);
        const outPath = join(QUESTIONS_DIR, category, subcategory, `${raw.titleSlug}.json`);

        if (await fileExists(outPath)) {
          skipped++;
          continue;
        }
      }

      // Normalize
      const norm = normalizeQuestion(raw);
      const relPath = await writeNormalized(norm);

      // Track category stats
      const catKey = `${norm.category}/${norm.subcategory}`;
      categoryCounts[catKey] = (categoryCounts[catKey] ?? 0) + 1;

      normalized++;
      console.log(
        `[${i + 1}/${total}] Normalized: ${fileSlug} -> ${relPath}`
      );
    } catch (err) {
      failures++;
      console.error(`[${i + 1}/${total}] ✗ Failed: ${fileSlug} – ${err.message}`);
    }
  }

  // Report
  console.log('\n=== Normalization Report ===');
  console.log(`Total processed : ${total}`);
  console.log(`Normalized      : ${normalized}`);
  console.log(`Skipped (exist) : ${skipped}`);
  console.log(`Failures        : ${failures}`);

  if (Object.keys(categoryCounts).length > 0) {
    console.log('\nBy category/subcategory:');
    const sorted = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]);
    for (const [cat, count] of sorted) {
      console.log(`  ${cat.padEnd(30)} : ${count}`);
    }
  }

  console.log('\nNormalization complete.');
}

main().catch((err) => {
  console.error('Fatal error in normalize:', err);
  process.exit(1);
});
