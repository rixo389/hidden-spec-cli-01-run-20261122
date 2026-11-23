// mend: apply an AI-written edit to a tree of text files (SPEC.md v1).
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

// A file's lines, its line break, and whether it ends with one (SPEC.md section 3).
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}
function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, final: fin };
}
function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}
function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

// The tree as the edits leave it: changed paths in `now` (null: deleted),
// the rest read from disk. Moves are recorded for the R output lines.
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: Array<{ old: string; nw: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// Matching lines at three tiers (SPEC.md section 5).
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}
function occurrences(O: string[], F: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j]!, F[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
function findTier(O: string[], F: string[], from = 0, strict = false): { tier: number; occ: number[] } | null {
  const max = strict ? 1 : 3;
  for (let t = 0; t < max; t++) {
    const occ = occurrences(O, F, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}
function reindent(line: string, P: string, F: string): string {
  if (line === '' || line.trim() === '') return line;
  if (line.startsWith(P)) return F + line.slice(P.length);
  return line;
}
// Replace O (matched at pos in F) by N. nCtx[n] is the index into O of a
// context line, or -1 for a new line. Context lines keep the file's own line.
function applyReplace(F: string[], pos: number, O: string[], N: string[], nCtx: number[], tier: number): string[] {
  const P = O.length > 0 ? leadingWS(O[0]!) : '';
  const Flead = F.length > pos ? leadingWS(F[pos]!) : '';
  const rep: string[] = [];
  for (let n = 0; n < N.length; n++) {
    if (nCtx[n]! >= 0) rep.push(F[pos + nCtx[n]!]!);
    else rep.push(tier === 2 ? reindent(N[n]!, P, Flead) : N[n]!);
  }
  return [...F.slice(0, pos), ...rep, ...F.slice(pos + O.length)];
}

// One JSON edit object (SPEC.md section 9), or null when it is not one.
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const need = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = need(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count++;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = need(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// --- unified diffs (SPEC.md section 6) ---
interface BodyLine {
  type: ' ' | '-' | '+';
  text: string;
  bs: boolean;
}
interface Hunk {
  A: number;
  O: string[];
  N: string[];
  nCtx: number[];
  plus: string[];
  lastBs: boolean;
  lastPlusBs: boolean;
}
interface UniSec {
  oldP: string | null;
  newP: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

// The path of a `--- ` or `+++ ` line: text after the four characters, up to
// the first tab, surrounding spaces removed, a leading a/ or b/ removed.
function hdrPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t.startsWith('a/')) t = t.slice(2);
  else if (t.startsWith('b/')) t = t.slice(2);
  return t;
}

function buildHunk(A: number, body: BodyLine[]): Hunk {
  const O: string[] = [];
  const N: string[] = [];
  const nCtx: number[] = [];
  const plus: string[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  body.forEach((b, i) => {
    if (b.type === ' ' || b.type === '+') lastCtxPlus = i;
    if (b.type === '+') lastPlus = i;
  });
  const lastBs = lastCtxPlus >= 0 ? body[lastCtxPlus]!.bs : false;
  const lastPlusBs = lastPlus >= 0 ? body[lastPlus]!.bs : false;
  for (const b of body) {
    if (b.type === ' ') {
      nCtx.push(O.length);
      O.push(b.text);
      N.push(b.text);
    } else if (b.type === '-') {
      O.push(b.text);
    } else {
      nCtx.push(-1);
      N.push(b.text);
      plus.push(b.text);
    }
  }
  return { A, O, N, nCtx, plus, lastBs, lastPlusBs };
}

// Apply one hunk to the file's lines. Returns the new lines and final break.
function applyHunk(fl: FileLines, h: Hunk, d: number, strict: boolean, path: string): FileLines {
  const lines = fl.lines;
  if (h.O.length === 0) {
    const at = Math.max(0, Math.min(h.A + d, lines.length));
    const out = [...lines.slice(0, at), ...h.N, ...lines.slice(at)];
    let fin = fl.final;
    if (at === lines.length) fin = !h.lastBs;
    return { lines: out, br: fl.br, final: fin };
  }
  const found = findTier(h.O, lines, 0, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.A - 1 + d;
  let best = found.occ[0]!;
  for (const pos of found.occ) {
    if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
  }
  const out = applyReplace(lines, best, h.O, h.N, h.nCtx, found.tier);
  let fin = fl.final;
  if (best + h.O.length === lines.length) fin = !h.lastBs;
  return { lines: out, br: fl.br, final: fin };
}

function makeUniEdit(sec: UniSec, strict: boolean): Edit {
  const { oldP, newP, creation, deletion, hunks } = sec;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (creation) {
      const p = newP!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of hunks) plus.push(...h.plus);
      let lastPlusBs = false;
      for (let i = hunks.length - 1; i >= 0; i--) {
        if (hunks[i]!.plus.length > 0) {
          lastPlusBs = hunks[i]!.lastPlusBs;
          break;
        }
      }
      const text = plus.length === 0 ? '' : plus.join('\n') + (lastPlusBs ? '' : '\n');
      tree.now.set(p, text);
      return;
    }
    if (deletion) {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const isMove = oldP !== null && newP !== null && oldP !== newP;
    const src = oldP!;
    const cur = tree.get(src);
    if (cur === null) throw new Fail('missing', src);
    if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    let fl = splitFile(cur);
    let d = 0;
    for (const h of hunks) {
      fl = applyHunk(fl, h, d, strict, src);
      d += h.N.length - h.O.length;
    }
    const text = joinFile(fl);
    if (isMove) {
      tree.now.set(newP!, text);
      tree.now.set(src, null);
      tree.moves.push({ old: src, nw: newP! });
    } else {
      tree.now.set(src, text);
    }
  };
}

// Parse one hunk body starting after the @@ header at headIdx.
// Returns the hunk and the index of the line that ended the body.
function parseHunk(lines: string[], headIdx: number, A: number): { hunk: Hunk; next: number } {
  const body: BodyLine[] = [];
  let i = headIdx + 1;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) break;
    if (l === '') {
      body.push({ type: ' ', text: '', bs: false });
      i++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      body.push({ type: ' ', text: l.slice(1), bs: false });
      i++;
      continue;
    }
    if (c === '-') {
      body.push({ type: '-', text: l.slice(1), bs: false });
      i++;
      continue;
    }
    if (c === '+') {
      body.push({ type: '+', text: l.slice(1), bs: false });
      i++;
      continue;
    }
    if (c === '\\') {
      if (body.length > 0) body[body.length - 1]!.bs = true;
      i++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1]!.type === ' ' && body[body.length - 1]!.text === '') body.pop();
  return { hunk: buildHunk(A, body), next: i };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  const hunkHead = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const diffGitRe = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
  let i = 0;
  let sec: {
    oldP: string | null;
    newP: string | null;
    hasPair: boolean;
    renameFrom: string | null;
    renameTo: string | null;
    newMode: boolean;
    delMode: boolean;
    gitX: string | null;
    gitY: string | null;
    hunks: Hunk[];
  } | null = null;
  let inHeader = false;
  const resolve = (s: NonNullable<typeof sec>): UniSec => {
    let oldP: string | null = null;
    let newP: string | null = null;
    if (s.hasPair) {
      oldP = s.oldP;
      newP = s.newP;
    } else if (s.renameFrom !== null || s.renameTo !== null) {
      oldP = s.renameFrom;
      newP = s.renameTo;
    } else if (s.gitX !== null) {
      oldP = s.gitX;
      newP = s.gitY;
    }
    if (oldP === null && newP === null) newP = '';
    const creation = oldP === null || s.newMode;
    const deletion = newP === null || s.delMode;
    return { oldP, newP, creation, deletion, hunks: s.hunks };
  };
  const finish = (): void => {
    if (sec === null) return;
    edits.push(makeUniEdit(resolve(sec), strict));
    sec = null;
    inHeader = false;
  };
  const startSection = (gitX: string | null, gitY: string | null): void => {
    sec = {
      oldP: null,
      newP: null,
      hasPair: false,
      renameFrom: null,
      renameTo: null,
      newMode: false,
      delMode: false,
      gitX,
      gitY,
      hunks: [],
    };
    inHeader = true;
  };
  while (i < n) {
    const l = lines[i]!;
    if (sec === null) {
      if (l.startsWith('diff --git ')) {
        const m = diffGitRe.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        startSection(m[1]!, m[2]!);
        i++;
        continue;
      }
      if (l.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
        startSection(null, null);
        continue;
      }
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('diff --git ')) {
        const m = diffGitRe.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        finish();
        startSection(m[1]!, m[2]!);
        i++;
        continue;
      }
      if (l.startsWith('--- ')) {
        if (i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
          if (!sec.hasPair) {
            const oldT = hdrPath(l);
            const newT = hdrPath(lines[i + 1]!);
            sec.oldP = oldT === '/dev/null' ? null : oldT;
            sec.newP = newT === '/dev/null' ? null : newT;
            sec.hasPair = true;
            i += 2;
            continue;
          }
          finish();
          startSection(null, null);
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('+++ ')) {
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        sec.renameFrom = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        sec.renameTo = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.newMode = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.delMode = true;
        i++;
        continue;
      }
      if (l.startsWith('@@')) {
        const m = hunkHead.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        inHeader = false;
        const r = parseHunk(lines, i, parseInt(m[1]!, 10));
        sec.hunks.push(r.hunk);
        i = r.next;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const m = diffGitRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      finish();
      startSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
      finish();
      startSection(null, null);
      continue;
    }
    if (l.startsWith('@@')) {
      const m = hunkHead.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const r = parseHunk(lines, i, parseInt(m[1]!, 10));
      sec.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    i++;
  }
  finish();
  return edits;
}


// --- SEARCH/REPLACE blocks (SPEC.md section 7) ---
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevPath: string | null = null;
  let after = 0;
  let i = 0;
  while (i < n) {
    if (stripTrail(lines[i]!) !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let k = i - 1; k >= after; k--) {
      const t = lines[k]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let j = i + 1;
    const oldLines: string[] = [];
    let foundEq = false;
    while (j < n) {
      const t = stripTrail(lines[j]!);
      if (t === '=======') {
        foundEq = true;
        j++;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
      oldLines.push(lines[j]!);
      j++;
    }
    if (!foundEq) throw new Exit2(`error: parse ${searchLine}`);
    const newLines: string[] = [];
    let foundRep = false;
    while (j < n) {
      const t = stripTrail(lines[j]!);
      if (t === '>>>>>>> REPLACE') {
        foundRep = true;
        j++;
        break;
      }
      newLines.push(lines[j]!);
      j++;
    }
    if (!foundRep) throw new Exit2(`error: parse ${searchLine}`);
    const safePath = path;
    const oldL = oldLines;
    const newL = newLines;
    edits.push((tree) => {
      if (!safe(safePath)) throw new Fail('unsafe', safePath);
      if (oldL.length === 0) {
        if (tree.get(safePath) !== null) throw new Fail('exists', safePath);
        tree.now.set(safePath, newL.length === 0 ? '' : newL.join('\n') + '\n');
        return;
      }
      const cur = tree.get(safePath);
      if (cur === null) throw new Fail('missing', safePath);
      const fl = splitFile(cur);
      const found = findTier(oldL, fl.lines, 0, strict);
      if (found === null) throw new Fail('no-match', safePath);
      if (found.occ.length > 1) throw new Fail('ambiguous', safePath);
      const pos = found.occ[0]!;
      const nCtx = newL.map(() => -1);
      fl.lines = applyReplace(fl.lines, pos, oldL, newL, nCtx, found.tier);
      tree.now.set(safePath, joinFile(fl));
    });
    prevPath = path;
    after = j;
    i = j;
  }
  return edits;
}

// --- V4A patches (SPEC.md section 8) ---
interface V4AChunk {
  anchor: string | null;
  body: Array<{ t: 'c' | 'm' | 'a'; text: string }>;
  eof: boolean;
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      // A body line is the file line plus whether it came from a blank patch
      // line (only those are stripped from the end of the section).
      const body: Array<{ text: string; blank: boolean }> = [];
      i++;
      while (i < last) {
        const bl = lines[i]!;
        if (bl.startsWith('*** ')) break;
        if (bl === '') {
          body.push({ text: '', blank: true });
          i++;
          continue;
        }
        if (bl.startsWith('+')) {
          body.push({ text: bl.slice(1), blank: false });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (body.length > 0 && body[body.length - 1]!.blank) body.pop();
      const safePath = path;
      const text = body.length === 0 ? '' : body.map((b) => b.text).join('\n') + '\n';
      edits.push((tree) => {
        if (!safe(safePath)) throw new Fail('unsafe', safePath);
        if (tree.get(safePath) !== null) throw new Fail('exists', safePath);
        tree.now.set(safePath, text);
      });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      const safePath = path;
      edits.push((tree) => {
        if (!safe(safePath)) throw new Fail('unsafe', safePath);
        if (tree.get(safePath) === null) throw new Fail('missing', safePath);
        tree.now.set(safePath, null);
      });
      i++;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      let firstChunk = true;
      while (i < last) {
        const bl = lines[i]!;
        if (bl.startsWith('*** ')) {
          if (stripTrail(bl) === '*** End of File') {
            if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
            cur.eof = true;
            chunks.push(cur);
            cur = null;
            firstChunk = false;
            i++;
            continue;
          }
          break;
        }
        if (bl.startsWith('@@')) {
          if (cur !== null) {
            chunks.push(cur);
            cur = null;
          }
          const anchor = bl.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          firstChunk = false;
          i++;
          continue;
        }
        if (cur === null) {
          if (!firstChunk) throw new Exit2(`error: parse ${i + 1}`);
          cur = { anchor: null, body: [], eof: false };
          firstChunk = false;
        }
        if (bl === '') {
          cur.body.push({ t: 'c', text: '' });
          i++;
          continue;
        }
        if (bl.startsWith(' ')) {
          cur.body.push({ t: 'c', text: bl.slice(1) });
          i++;
          continue;
        }
        if (bl.startsWith('-')) {
          cur.body.push({ t: 'm', text: bl.slice(1) });
          i++;
          continue;
        }
        if (bl.startsWith('+')) {
          cur.body.push({ t: 'a', text: bl.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1]!;
        if (!lc.eof) {
          while (lc.body.length > 0 && lc.body[lc.body.length - 1]!.t === 'c' && lc.body[lc.body.length - 1]!.text.trim() === '') lc.body.pop();
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updLine}`);
      const safePath = path;
      const safeMove = moveTo;
      const hs = chunks;
      edits.push((tree) => {
        if (!safe(safePath)) throw new Fail('unsafe', safePath);
        if (safeMove !== null && !safe(safeMove)) throw new Fail('unsafe', safeMove);
        const curText = tree.get(safePath);
        if (curText === null) throw new Fail('missing', safePath);
        if (safeMove !== null && tree.get(safeMove) !== null) throw new Fail('exists', safeMove);
        let fl = splitFile(curText);
        let cursor = 0;
        for (const h of hs) {
          if (h.anchor !== null) {
            const foundA = findTier([h.anchor], fl.lines, cursor, strict);
            if (foundA === null) throw new Fail('no-match', safePath);
            cursor = foundA.occ[0]! + 1;
          }
          const O: string[] = [];
          const N: string[] = [];
          const nCtx: number[] = [];
          for (const b of h.body) {
            if (b.t === 'c') {
              nCtx.push(O.length);
              O.push(b.text);
              N.push(b.text);
            } else if (b.t === 'm') {
              O.push(b.text);
            } else {
              nCtx.push(-1);
              N.push(b.text);
            }
          }
          if (O.length === 0) {
            const pos = h.eof ? fl.lines.length : Math.min(cursor, fl.lines.length);
            fl.lines = [...fl.lines.slice(0, pos), ...N, ...fl.lines.slice(pos)];
            cursor = pos + N.length;
            continue;
          }
          let found: { tier: number; occ: number[] } | null = null;
          if (h.eof) {
            for (let t = 0; t < (strict ? 1 : 3); t++) {
              const occ = occurrences(O, fl.lines, t, cursor).filter((p) => p + O.length === fl.lines.length);
              if (occ.length > 0) {
                found = { tier: t, occ };
                break;
              }
            }
          } else {
            found = findTier(O, fl.lines, cursor, strict);
          }
          if (found === null) throw new Fail('no-match', safePath);
          const pos = found.occ[0]!;
          fl.lines = applyReplace(fl.lines, pos, O, N, nCtx, found.tier);
          cursor = pos + N.length;
        }
        const text = joinFile(fl);
        if (safeMove !== null) {
          tree.now.set(safeMove, text);
          tree.now.set(safePath, null);
          tree.moves.push({ old: safePath, nw: safeMove });
        } else {
          tree.now.set(safePath, text);
        }
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// --- format detection (SPEC.md section 4) ---
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => stripTrail(l) === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')),
    )
  )
    return 'unified';
  return null;
}

// The output lines for a successful run (SPEC.md section 2), with R lines
// replacing the D/A pair of a move that qualifies, sorted in UTF-8 byte order.
function outputLines(tree: Tree): string[] {
  const byKey: Array<{ key: string; line: string }> = [];
  const consumed = new Set<string>();
  for (const m of tree.moves) {
    const beforeOld = tree.original(m.old);
    const afterOld = tree.now.get(m.old);
    const beforeNew = tree.original(m.nw);
    const afterNew = tree.now.get(m.nw);
    if (beforeOld !== null && afterOld === null && beforeNew === null && afterNew !== null) {
      byKey.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      consumed.add(m.old);
      consumed.add(m.nw);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const before = tree.original(p);
    const after = tree.now.get(p)!;
    if (before === after) continue;
    if (before === null) byKey.push({ key: p, line: `A ${p}` });
    else if (after === null) byKey.push({ key: p, line: `D ${p}` });
    else byKey.push({ key: p, line: `M ${p}` });
  }
  byKey.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  return byKey.map((x) => x.line);
}

function writeTree(tree: Tree): void {
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))) {
    const before = tree.original(p);
    const after = tree.now.get(p)!;
    if (before === after) continue;
    if (after === null) {
      rmSync(p, { force: true });
    } else {
      const dir = dirname(p);
      if (dir !== '.' && dir !== '') mkdirSync(dir, { recursive: true });
      writeFileSync(p, after, 'utf8');
    }
  }
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let ended = false;
  for (const a of args) {
    if (ended) {
      pos.push(a);
      continue;
    }
    if (a === '--') {
      ended = true;
      continue;
    }
    if (a === '-') {
      pos.push(a);
      continue;
    }
    if (a.startsWith('-')) {
      if (a === '--check') {
        if (seenCheck) return { code: 2, out: ['error: usage'] };
        seenCheck = true;
        check = true;
        continue;
      }
      if (a === '--strict') {
        if (seenStrict) return { code: 2, out: ['error: usage'] };
        seenStrict = true;
        strict = true;
        continue;
      }
      if (a.startsWith('--format=')) {
        if (seenFormat) return { code: 2, out: ['error: usage'] };
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
        continue;
      }
      return { code: 2, out: ['error: usage'] };
    }
    pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else if (kind === 'v4a') edits = parseV4A(lines, strict);
    else edits = jsonEdits(text, lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snapNow = new Map(tree.now);
    const snapMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of snapNow) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...snapMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0)
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows = outputLines(tree);
  if (!check) writeTree(tree);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
