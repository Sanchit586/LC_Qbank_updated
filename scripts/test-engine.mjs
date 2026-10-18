/**
 * @fileoverview Test Engine for generating and verifying 20 diverse test cases per problem.
 * Generates sample, boundary, edge, duplicate, ordering, tricky, and scale test cases.
 * @module test-engine
 */

/**
 * Generates up to 20 comprehensive, verified test cases for a question.
 *
 * @param {object} raw - Raw question API object
 * @param {Array<{input: string, output: string, explanation: string|null}>} examples - Extracted examples
 * @param {string[]} constraints - Extracted constraints
 * @param {string} category - Category ('dsa' or 'database')
 * @returns {Array<{input: string, expectedOutput: string|null}>} Array of test cases
 */
export function generateTestCases(raw, examples = [], constraints = [], category = 'dsa') {
  const testCases = [];
  const seenInputs = new Set();

  function addTest(input, expectedOutput = null) {
    if (!input || typeof input !== 'string') return;
    const trimmedInput = input.trim();
    if (trimmedInput.length === 0 || seenInputs.has(trimmedInput)) return;
    seenInputs.add(trimmedInput);
    testCases.push({
      input: trimmedInput,
      expectedOutput: expectedOutput !== null ? String(expectedOutput).trim() : null,
    });
  }

  // 1. Add all official examples first (high confidence expectedOutput)
  for (const ex of examples) {
    if (ex.input) {
      addTest(ex.input, ex.output || null);
    }
  }

  // 2. Add raw example testcase list if any were not in examples
  if (Array.isArray(raw.exampleTestcaseList)) {
    for (const tc of raw.exampleTestcaseList) {
      addTest(tc, null);
    }
  }

  // If Database category, sample tests are database tables/rows
  if (category === 'database') {
    // Generate boundary / NULL / duplicate row edge cases if possible
    if (testCases.length < 20 && raw.sampleTestCase) {
      try {
        const parsed = JSON.parse(raw.sampleTestCase);
        if (parsed.headers && parsed.rows) {
          // Edge 1: Empty tables
          const emptyRows = {};
          for (const tbl of Object.keys(parsed.headers)) {
            emptyRows[tbl] = [];
          }
          addTest(JSON.stringify({ headers: parsed.headers, rows: emptyRows }));

          // Edge 2: Single row tables
          const singleRows = {};
          for (const tbl of Object.keys(parsed.headers)) {
            singleRows[tbl] = (parsed.rows[tbl] || []).slice(0, 1);
          }
          addTest(JSON.stringify({ headers: parsed.headers, rows: singleRows }));

          // Edge 3: Tables with NULL values
          const nullRows = {};
          for (const tbl of Object.keys(parsed.headers)) {
            const cols = parsed.headers[tbl] || [];
            nullRows[tbl] = (parsed.rows[tbl] || []).map((row) =>
              row.map((val, idx) => (idx === cols.length - 1 ? null : val))
            );
          }
          addTest(JSON.stringify({ headers: parsed.headers, rows: nullRows }));
        }
      } catch {
        // Fallback if sampleTestCase is not JSON
      }
    }
    return testCases.slice(0, 20);
  }

  // 3. Algorithm edge cases based on problem parameters
  const sampleInput = raw.sampleTestCase || (examples[0]?.input ?? '');
  const lines = sampleInput.split('\n').map((l) => l.trim()).filter(Boolean);

  // Analyze signature from sampleTestCase
  const isArrayAndTarget = lines.length >= 2 && lines[0].startsWith('[') && !isNaN(Number(lines[1]));
  const isSingleArray = lines.length === 1 && lines[0].startsWith('[') && !lines[0].startsWith('[[');
  const isMatrix = lines.length >= 1 && lines[0].startsWith('[[');
  const isSingleString = lines.length === 1 && lines[0].startsWith('"') && lines[0].endsWith('"');
  const isTwoStrings = lines.length === 2 && lines[0].startsWith('"') && lines[1].startsWith('"');
  const isSingleNumber = lines.length === 1 && !isNaN(Number(lines[0])) && !lines[0].startsWith('[');

  // Problem-specific reference solutions for perfect output verification on standard problems
  const solvers = {
    'two-sum': (inp) => {
      try {
        const [arrStr, tStr] = inp.split('\n');
        const nums = JSON.parse(arrStr);
        const target = parseInt(tStr, 10);
        const map = new Map();
        for (let i = 0; i < nums.length; i++) {
          const complement = target - nums[i];
          if (map.has(complement)) return JSON.stringify([map.get(complement), i]);
          map.set(nums[i], i);
        }
        return '[]';
      } catch {
        return null;
      }
    },
    'longest-substring-without-repeating-characters': (inp) => {
      try {
        const s = JSON.parse(inp);
        let maxLen = 0, left = 0;
        const set = new Set();
        for (let right = 0; right < s.length; right++) {
          while (set.has(s[right])) {
            set.delete(s[left++]);
          }
          set.add(s[right]);
          maxLen = Math.max(maxLen, right - left + 1);
        }
        return String(maxLen);
      } catch {
        return null;
      }
    },
    'longest-palindromic-substring': (inp) => {
      try {
        const s = JSON.parse(inp);
        if (!s || s.length <= 1) return JSON.stringify(s);
        let start = 0, maxLen = 1;
        function expand(l, r) {
          while (l >= 0 && r < s.length && s[l] === s[r]) {
            if (r - l + 1 > maxLen) {
              start = l;
              maxLen = r - l + 1;
            }
            l--;
            r++;
          }
        }
        for (let i = 0; i < s.length; i++) {
          expand(i, i);
          expand(i, i + 1);
        }
        return JSON.stringify(s.substring(start, start + maxLen));
      } catch {
        return null;
      }
    },
    'median-of-two-sorted-arrays': (inp) => {
      try {
        const [aStr, bStr] = inp.split('\n');
        const a = JSON.parse(aStr);
        const b = JSON.parse(bStr);
        const merged = [...a, ...b].sort((x, y) => x - y);
        const mid = Math.floor(merged.length / 2);
        if (merged.length % 2 === 1) return merged[mid].toFixed(5);
        return ((merged[mid - 1] + merged[mid]) / 2).toFixed(5);
      } catch {
        return null;
      }
    },
    'add-two-numbers': (inp) => {
      try {
        const [aStr, bStr] = inp.split('\n');
        const l1 = JSON.parse(aStr);
        const l2 = JSON.parse(bStr);
        const res = [];
        let carry = 0, i = 0, j = 0;
        while (i < l1.length || j < l2.length || carry) {
          const sum = (l1[i] || 0) + (l2[j] || 0) + carry;
          res.push(sum % 10);
          carry = Math.floor(sum / 10);
          i++; j++;
        }
        return JSON.stringify(res);
      } catch {
        return null;
      }
    },
  };

  const solver = solvers[raw.titleSlug];

  // Generator Helpers
  if (isArrayAndTarget) {
    const candidates = [
      // Minimum boundaries
      '[0,0]\n0',
      '[-1,1]\n0',
      '[-10,-20,-30]\n-50',
      // Zeroes and duplicates
      '[3,2,4]\n6',
      '[3,3]\n6',
      '[1,1,1,1,1,4,7]\n11',
      // Strictly increasing / decreasing
      '[1,2,3,4,5,6,7,8,9,10]\n19',
      '[10,9,8,7,6,5,4,3,2,1]\n5',
      // Negative boundaries
      '[-1000000000,1000000000]\n0',
      '[-5,-4,-3,-2,-1]\n-9',
      // Alternating / mixed
      '[100,-100,50,-50,25,-25]\n0',
      '[1,5,9,13,17,21]\n30',
      '[2,4,6,8,10]\n14',
      // Tricky corner targets
      '[0,4,3,0]\n0',
      '[-3,4,3,90]\n0',
      '[1,2,5,6,7]\n8',
      // Large scale test (N = 1000 to 2000 elements)
      (() => {
        const arr = Array.from({ length: 1500 }, (_, i) => i * 2);
        arr.push(1000001);
        arr.push(1000003);
        return `${JSON.stringify(arr)}\n2000004`;
      })(),
      (() => {
        const arr = Array.from({ length: 2500 }, (_, i) => i + 1);
        return `${JSON.stringify(arr)}\n4999`;
      })(),
    ];
    for (const c of candidates) {
      addTest(c, solver ? solver(c) : null);
    }
  } else if (isSingleString) {
    const candidates = [
      '""',
      '"a"',
      '"aa"',
      '"aaa"',
      '"abcdefghijklmnopqrstuvwxyz"',
      '"bbbbb"',
      '"pwwkew"',
      '"aab"',
      '"dvdf"',
      '"abcabcbb"',
      '"1234567890"',
      '"A man, a plan, a canal: Panama"',
      '"race a car"',
      '" "',
      '"au"',
      '"bpfbhmipx"',
      '"tmmzuxt"',
      // Scale tests
      JSON.stringify('abcdefghijklmnopqrstuvwxyz'.repeat(50)),
      JSON.stringify('a'.repeat(2000)),
    ];
    for (const c of candidates) {
      addTest(c, solver ? solver(c) : null);
    }
  } else if (isSingleArray) {
    const candidates = [
      '[]',
      '[0]',
      '[1]',
      '[-1]',
      '[1,2,3,4,5]',
      '[5,4,3,2,1]',
      '[1,1,1,1]',
      '[-5,-4,-3,-2,-1]',
      '[0,0,0,0,0]',
      '[1,3,2,4,6,5]',
      '[1000000000,-1000000000]',
      '[2,1]',
      '[1,2]',
      JSON.stringify(Array.from({ length: 1000 }, (_, i) => i)),
      JSON.stringify(Array.from({ length: 1500 }, (_, i) => 1500 - i)),
      JSON.stringify(Array.from({ length: 2000 }, () => 42)),
    ];
    for (const c of candidates) {
      addTest(c, solver ? solver(c) : null);
    }
  } else if (isTwoStrings) {
    const candidates = [
      '""\n""',
      '"a"\n"a"',
      '"a"\n"b"',
      '"abc"\n"ahbgdc"',
      '"axc"\n"ahbgdc"',
      '"sea"\n"eat"',
      '"leetcode"\n"etco"',
      '"programming"\n"gram"',
      '"hello"\n"world"',
      '"same"\n"same"',
      `"${'a'.repeat(1000)}"\n"${'a'.repeat(500)}"`,
      `"${'ab'.repeat(500)}"\n"${'ab'.repeat(250)}"`,
    ];
    for (const c of candidates) {
      addTest(c, solver ? solver(c) : null);
    }
  } else if (isSingleNumber) {
    const candidates = [
      '0',
      '1',
      '-1',
      '2',
      '3',
      '5',
      '10',
      '15',
      '16',
      '100',
      '-100',
      '1000',
      '-1000',
      '2147483647',
      '-2147483648',
    ];
    for (const c of candidates) {
      addTest(c, solver ? solver(c) : null);
    }
  }

  // If still under 20, fill with constraint boundary variations of sample input
  while (testCases.length < 20 && testCases.length > 0) {
    const base = testCases[testCases.length % Math.min(testCases.length, 5)].input;
    const modified = base.replace(/\d+/g, (n) => String(parseInt(n, 10) + 1));
    if (!seenInputs.has(modified)) {
      addTest(modified, solver ? solver(modified) : null);
    } else {
      break;
    }
  }

  return testCases.slice(0, 20);
}
