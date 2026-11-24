// A fast, dependency-free reimplementation of the makefun-site 1.0.0 build: run(input) returns the same output
// tree (path -> text) for every input. Written from the documented dialect: front matter, permalinks, a Markdown
// subset, collections, tags, layouts and the build report, in the reference build's order.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------- text

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const ESC_TEST = /[&<>"']/;

/** `s` with & < > " ' escaped; returns `s` itself when there is nothing to escape. */
function escapeStr(s) {
  if (!ESC_TEST.test(s)) return s;
  let parts = null;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    if (parts === null) parts = [];
    if (i > last) parts.push(s.slice(last, i));
    parts.push(rep);
    last = i + 1;
  }
  if (parts === null) return s;
  if (last < s.length) parts.push(s.slice(last));
  return parts.join('');
}

const SLUG_MAX = 64;

/** The slug of `text`, by the reference rule; `cache` memoises per build. */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const out = slugifyRaw(text);
  cache.set(text, out);
  return out;
}

const ASCII_ONLY = /^[\x00-\x7F]*$/;
const NON_SLUG_RUN = /[^a-z0-9]+/g;
const LEADING_DASHES = /^-+/;

function slugifyRaw(text) {
  // Fast path: pure ASCII is its own NFKD and holds no combining marks, so the slug is the lowercased text with
  // every run of non-[a-z0-9] collapsed to one dash.
  if (ASCII_ONLY.test(text)) {
    const out = text.toLowerCase().replace(NON_SLUG_RUN, '-').replace(LEADING_DASHES, '').slice(0, SLUG_MAX).replace(/-+$/, '');
    return out === '' ? 'untitled' : out;
  }
  // Fast path: pure ASCII is its own NFKD and holds no combining marks.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  let out = '';
  let gap = false;
  if (ascii) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** Whether code point `c` is JavaScript whitespace (\s). */
function isSpaceCode(c) {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** Matches whitespace other than a plain space: the rare lines that need the general word count. */
const NON_SPACE_WS = /[^\S ]/;

/** The number of words (runs of non-whitespace) in `line`. */
function countWords(line) {
  let n = 0;
  let inWord = false;
  if (!NON_SPACE_WS.test(line)) {
    // Only plain spaces separate words here: one comparison per character.
    for (let i = 0; i < line.length; i++) {
      if (line.charCodeAt(i) === 32) inWord = false;
      else if (!inWord) {
        inWord = true;
        n++;
      }
    }
    return n;
  }
  for (let i = 0; i < line.length; i++) {
    if (isSpaceCode(line.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const LAYOUT_NAME = /^[a-z0-9-]+$/;
const SLUG_VALUE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimRightSpaceTab(s) {
  let end = s.length;
  while (end > 0) {
    const c = s.charCodeAt(end - 1);
    if (c !== 32 && c !== 9) break;
    end--;
  }
  return end === s.length ? s : s.slice(0, end);
}

function trimSpaceTab(s) {
  let start = 0;
  let end = s.length;
  while (start < end) {
    const c = s.charCodeAt(start);
    if (c !== 32 && c !== 9) break;
    start++;
  }
  while (end > start) {
    const c = s.charCodeAt(end - 1);
    if (c !== 32 && c !== 9) break;
    end--;
  }
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

/** A front matter string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function dateValue(raw) {
  if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return false;
  let y = 0;
  let mo = 0;
  let d = 0;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
    const digit = c - 48;
    if (i < 4) y = y * 10 + digit;
    else if (i < 7) mo = mo * 10 + digit;
    else d = d * 10 + digit;
  }
  return y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
}

/** One front matter key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return dateValue(raw) ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return LAYOUT_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_VALUE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter over its `lines`: { data, bodyStart }, or { error } with the first reason it is refused.
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = trimRightSpaceTab(line.slice(k + 2));
    else return { error: `line ${i + 1} is not "key: value"` };
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const INCLUDE_DEPTH = 8;

function isPathText(text) {
  if (text === '') return false;
  let segStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 46) {
      if (segStart) return false;
      segStart = true;
      continue;
    }
    const letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
    const digit = c >= 48 && c <= 57;
    if (segStart) {
      if (!letter) return false;
      segStart = false;
    } else if (!letter && !digit) return false;
  }
  return !segStart;
}

function pathOf(name, text) {
  if (!isPathText(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function isSpaceTabRange(src, from, to) {
  for (let i = from; i < to; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function hasWhitespace(s) {
  for (let i = 0; i < s.length; i++) if (isSpaceCode(s.charCodeAt(i))) return true;
  return false;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = isSpaceTabRange(src, lineStart, open) && isSpaceTabRange(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** A "for <name> in <path>" tag's parts, or null when the tag is not exactly that shape. */
function forTag(tag) {
  if (!tag.startsWith('for ')) return null;
  let p = 4;
  const first = tag.charCodeAt(p);
  if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122) || first === 95)) return null;
  p++;
  while (p < tag.length) {
    const c = tag.charCodeAt(p);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95) p++;
    else break;
  }
  if (tag.slice(p, p + 4) !== ' in ') return null;
  const pathText = tag.slice(p + 4);
  if (pathText === '' || hasWhitespace(pathText)) return null;
  return { name: tag.slice(4, p), pathText };
}

/** An "if [not] <path>" tag's parts, or null. */
function ifTag(tag) {
  if (!tag.startsWith('if ')) return null;
  let rest = tag.slice(3);
  let not = false;
  if (rest.startsWith('not ')) {
    not = true;
    rest = rest.slice(4);
  }
  if (rest === '' || hasWhitespace(rest)) return null;
  return { not, pathText: rest };
}

/** An 'include "<name>"' tag's name, or null. */
function includeTag(tag) {
  if (!tag.startsWith('include "') || tag.charCodeAt(tag.length - 1) !== 34) return null;
  const inner = tag.slice(9, -1);
  if (inner === '') return null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return inner;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      const f = forTag(tag);
      if (f !== null) {
        const node = { kind: 'for', name: f.name, path: pathOf(name, f.pathText), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
        continue;
      }
      const cond = ifTag(tag);
      if (cond !== null) {
        const node = { kind: 'if', not: cond.not, path: pathOf(name, cond.pathText), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
        continue;
      }
      if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
        continue;
      }
      if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
        continue;
      }
      const inc = includeTag(tag);
      if (inc !== null) {
        body.push({ kind: 'include', name: inc });
        continue;
      }
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope stack: its first name from the nearest scope holding it, then own properties. */
function lookup(scopes, path) {
  const head = path[0];
  for (let si = scopes.length - 1; si >= 0; si--) {
    const vars = scopes[si];
    if (!hasOwn(vars, head)) continue;
    let v = vars[head];
    for (let k = 1; k < path.length; k++) {
      if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
      v = v[path[k]];
    }
    return v;
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered with the scope stack `scopes`, fragments pushed onto `out`. `ctx` holds the parsed templates. */
function renderInto(nodes, scopes, ctx, depth, out) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const nd = nodes[idx];
    switch (nd.kind) {
      case 'text':
        out.push(nd.text);
        break;
      case 'var':
        out.push(escapeStr(textOf(lookup(scopes, nd.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scopes, nd.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scopes, nd.path));
        const branch = v !== nd.not ? nd.then : nd.else;
        if (branch !== null) renderInto(branch, scopes, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scopes, nd.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          if (nd.noLoop) scopes.push({ [nd.name]: xs[k] });
          else scopes.push({ [nd.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } });
          renderInto(nd.body, scopes, ctx, depth, out);
          scopes.pop();
        }
        break;
      }
      case 'include': {
        if (depth < INCLUDE_DEPTH) {
          const reads = ctx.memoFor !== undefined ? ctx.memoFor(nd.name) : null;
          if (reads !== null && scopesClearOf(scopes, reads)) out.push(ctx.memo(nd.name));
          else {
            const t = ctx.templates.get(nd.name);
            if (t !== undefined) t.fn(scopes, ctx, depth + 1, out);
          }
        }
        break;
      }
    }
  }
}

/** Whether no loop scope on the stack (index 2 and up) binds any of `reads`. */
function scopesClearOf(scopes, reads) {
  for (let i = 2; i < scopes.length; i++) {
    const vars = scopes[i];
    for (const r of reads) if (hasOwn(vars, r)) return false;
  }
  return true;
}

/**
 * `nodes` compiled into a render function with the interpreter's exact semantics: the node dispatch becomes
 * straight-line code, paths are hoisted into `P`, and the shared helpers are bound once by the factory.
 */
function compileTemplate(nodes, memoReads) {
  const P = [];
  let tmp = 0;
  const parts = [];
  const gen = (list, out, bound) => {
    for (const nd of list) {
      switch (nd.kind) {
        case 'text':
          out.push(`out.push(${JSON.stringify(nd.text)});`);
          break;
        case 'var':
          P.push(nd.path);
          out.push(`out.push(escapeStr(textOf(lookup(scopes, P[${P.length - 1}]))));`);
          break;
        case 'raw':
          P.push(nd.path);
          out.push(`out.push(textOf(lookup(scopes, P[${P.length - 1}])));`);
          break;
        case 'if': {
          P.push(nd.path);
          const pi = P.length - 1;
          const thenParts = [];
          gen(nd.then, thenParts, bound);
          out.push(`if (truthy(lookup(scopes, P[${pi}])) !== ${nd.not}) {`, ...thenParts);
          if (nd.else !== null) {
            const elseParts = [];
            gen(nd.else, elseParts, bound);
            out.push('} else {', ...elseParts);
          }
          out.push('}');
          break;
        }
        case 'for': {
          P.push(nd.path);
          const pi = P.length - 1;
          const id = tmp++;
          const xs = `xs$${id}`;
          const kk = `k$${id}`;
          const bodyParts = [];
          const inner = new Set(bound);
          inner.add(nd.name);
          inner.add('loop');
          gen(nd.body, bodyParts, inner);
          const push = nd.noLoop
            ? `scopes.push({ [${JSON.stringify(nd.name)}]: ${xs}[${kk}] });`
            : `scopes.push({ [${JSON.stringify(nd.name)}]: ${xs}[${kk}], loop: { index: ${kk} + 1, first: ${kk} === 0, last: ${kk} === ${xs}.length - 1, length: ${xs}.length } });`;
          out.push(
            `{ const ${xs} = lookup(scopes, P[${pi}]); if (Array.isArray(${xs})) { for (let ${kk} = 0; ${kk} < ${xs}.length; ${kk}++) { ${push}`,
            ...bodyParts,
            'scopes.pop(); } } }',
          );
          break;
        }
        case 'include': {
          const reads = memoReads.get(nd.name);
          let memo = reads !== undefined;
          if (memo) for (const r of reads) if (bound.has(r)) { memo = false; break; }
          if (memo) out.push(`{ if (depth < ${INCLUDE_DEPTH}) out.push(ctx.memo(${JSON.stringify(nd.name)})); }`);
          else out.push(`{ const t$ = ctx.templates.get(${JSON.stringify(nd.name)}); if (t$ !== undefined && depth < ${INCLUDE_DEPTH}) t$.fn(scopes, ctx, depth + 1, out); }`);
          break;
        }
      }
    }
  };
  gen(nodes, parts, new Set());
  const factory = new Function('lookup', 'textOf', 'truthy', 'escapeStr', 'P', `return function (scopes, ctx, depth, out) {\n${parts.join('\n')}\n};`);
  return factory(lookup, textOf, truthy, escapeStr, P);
}

/** A template ready to render: its compiled function, or the interpreter when compilation fails. */
function compileEntry(nodes, memoReads) {
  try {
    return { fn: compileTemplate(nodes, memoReads) };
  } catch {
    return { fn: (scopes, ctx, depth, out) => renderInto(nodes, scopes, ctx, depth, out) };
  }
}

/**
 * The root names `nodes` read — path heads not bound by an enclosing for — or null when the tree includes another
 * template. A template whose reads are all case-global (site, tags, recent) renders the same text every time.
 */
function rootReads(nodes) {
  const reads = new Set();
  const walk = (list, bound) => {
    for (const nd of list) {
      if (nd.kind === 'include') return false;
      if (nd.kind === 'var' || nd.kind === 'raw' || nd.kind === 'for' || nd.kind === 'if') {
        if (!bound.has(nd.path[0])) reads.add(nd.path[0]);
      }
      if (nd.kind === 'if') {
        if (!walk(nd.then, bound)) return false;
        if (nd.else !== null && !walk(nd.else, bound)) return false;
      } else if (nd.kind === 'for') {
        const inner = new Set(bound);
        inner.add(nd.name);
        inner.add('loop');
        if (!walk(nd.body, inner)) return false;
      }
    }
    return true;
  };
  return walk(nodes, new Set()) ? reads : null;
}

/**
 * Flags every for node whose `loop` record can never be read — no `loop` path in its body outside a nested for,
 * and no included template reads one either — as `noLoop`, so rendering skips building the record object.
 */
function markLoopElision(parsed) {
  const memo = new Map();
  const active = new Set();
  const treeFree = (nodes) => {
    for (const nd of nodes) {
      if (nd.kind === 'var' || nd.kind === 'raw' || nd.kind === 'for') {
        if (nd.path[0] === 'loop') return true;
      } else if (nd.kind === 'if') {
        if (nd.path[0] === 'loop' || treeFree(nd.then) || (nd.else !== null && treeFree(nd.else))) return true;
      } else if (nd.kind === 'include') {
        if (templateFree(nd.name)) return true;
      }
    }
    return false;
  };
  const templateFree = (name) => {
    if (memo.has(name)) return memo.get(name);
    if (active.has(name)) return true; // an include cycle: assume the record is read
    const nodes = parsed.get(name);
    if (nodes === undefined) return false;
    active.add(name);
    const r = treeFree(nodes);
    active.delete(name);
    memo.set(name, r);
    return r;
  };
  const markFors = (nodes) => {
    for (const nd of nodes) {
      if (nd.kind === 'for') {
        nd.noLoop = !treeFree(nd.body);
        markFors(nd.body);
      } else if (nd.kind === 'if') {
        markFors(nd.then);
        if (nd.else !== null) markFors(nd.else);
      }
    }
  };
  for (const nodes of parsed.values()) markFors(nodes);
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Array(128).fill(false);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = true;

function isEscapable(code) {
  return code < 128 && ESCAPABLE[code];
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const last = s.length - what.length;
  for (let j = from; j <= last; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Matches the next character that can start an inline construct or needs escaping. */
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;

/** `s` rendered inline, fragments pushed onto `out`; `env.link(target)` is a link's href. */
function inlineInto(s, env, out) {
  const n = s.length;
  let i = 0; // scan position; the regex's lastIndex is reset to it after every construct
  let run = 0; // start of the pending raw slice
  const re = INLINE_SPECIAL;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    i = m.index;
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (i > run) out.push(s.slice(run, i));
      out.push(c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;');
      i++;
      run = i;
    } else if (c === 92) {
      if (i + 1 < n && isEscapable(s.charCodeAt(i + 1))) {
        if (i > run) out.push(s.slice(run, i));
        const e = s.charCodeAt(i + 1);
        out.push(e === 62 ? '&gt;' : s[i + 1]);
        i += 2;
        run = i;
      } else i++;
    } else if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<code>', escapeStr(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        run = i;
      } else i++;
    } else if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > run) out.push(s.slice(run, i));
          out.push('<strong>');
          inlineInto(s.slice(i + 2, j), env, out);
          out.push('</strong>');
          i = j + 2;
          run = i;
        } else i += 2;
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          if (i > run) out.push(s.slice(run, i));
          out.push('<em>');
          inlineInto(s.slice(i + 1, j), env, out);
          out.push('</em>');
          i = j + 1;
          run = i;
        } else i++;
      }
    } else { // [
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !hasWhitespace(target)) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<a href="', escapeStr(env.link(target)), '">');
        inlineInto(s.slice(i + 1, k), env, out);
        out.push('</a>');
        i = mm + 1;
        run = i;
      } else i++;
    }
    re.lastIndex = i;
  }
  if (n > run) out.push(s.slice(run, n));
}

function inlineStr(s, env) {
  const out = [];
  inlineInto(s, env, out);
  return out.join('');
}

/** A fence opening line's language, or null when the line is not a fence opening. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = line.slice(3, j);
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    j++;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  let c = 0;
  while (line.charCodeAt(c) === 35) c++;
  if (c === 0 || c > 6) return null;
  const after = line.charCodeAt(c);
  if (after !== 32 && after !== 9) return null;
  const text = trimSpaceTab(line.slice(c));
  return text === '' ? null : { depth: c, text };
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isHr(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let j = 3; j < line.length; j++) {
    const cc = line.charCodeAt(j);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/** A list item line's content: { ordered, content, start } or null. `ordered` selects the marker kind. */
function listMarker(line, ordered) {
  if (ordered === null || ordered === false) {
    const c = line.charCodeAt(0);
    if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return { ordered: false, content: line.slice(2), start: 1 };
    if (ordered !== null) return null;
  }
  if (ordered === null || ordered === true) {
    let d = 0;
    while (d < line.length) {
      const c = line.charCodeAt(d);
      if (c >= 48 && c <= 57) d++;
      else break;
    }
    if (d >= 1 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
      return { ordered: true, content: line.slice(d + 2), start: Number(line.slice(0, d)) };
    }
  }
  return null;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let j = 0;
  while (line.charCodeAt(j) === 32) j++;
  return j >= 2 && j < line.length && !isSpaceCode(line.charCodeAt(j));
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  const c = line.charCodeAt(0);
  if (c === 96) return fenceLang(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  if (c === 32 || c === 9 || line === '') return isBlankLine(line);
  return false;
}

/**
 * The body at `lines[start..]`, rendered: its HTML (a "\n" after every block), its table of contents (level 2 and 3
 * headings) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(lines, start, env, slugCache) {
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  const n = lines.length;
  let i = start;
  while (i < n) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if ((c0 === 32 || c0 === 9 || line === '') && isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = c0 === 96 ? fenceLang(line) : null;
    if (lang !== null) {
      i++;
      out.push(lang === '' ? '<pre><code>' : `<pre><code class="language-${escapeStr(lang)}">`);
      const codeStart = i;
      while (i < n && !isFenceClose(lines[i])) i++;
      if (i > codeStart) out.push(escapeStr(lines.slice(codeStart, i).join('\n')), '\n');
      i++;
      out.push('</code></pre>\n');
      continue;
    }
    const heading = c0 === 35 ? headingOf(line) : null;
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text, slugCache), ids);
      const frags = [];
      inlineInto(heading.text, env, frags);
      const html = frags.join('');
      out.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const qlines = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const raw = lines[i];
        const stripped = raw.charCodeAt(1) === 32 ? raw.slice(2) : raw.slice(1);
        const t = trimSpaceTab(stripped);
        if (t !== '') qlines.push(t);
        i++;
      }
      if (qlines.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineInto(qlines.join('\n'), env, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const marker = c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57) ? listMarker(line, null) : null;
    if (marker !== null) {
      const items = [];
      let cur = trimSpaceTab(marker.content);
      i++;
      while (i < n) {
        const m = listMarker(lines[i], marker.ordered);
        if (m !== null) {
          items.push(cur);
          cur = trimSpaceTab(m.content);
          i++;
        } else if (isContinued(lines[i])) {
          cur += '\n' + trimSpaceTab(lines[i]);
          i++;
        } else break;
      }
      items.push(cur);
      const tag = marker.ordered ? 'ol' : 'ul';
      out.push(marker.ordered && marker.start !== 1 ? `<ol start="${marker.start}">\n` : `<${tag}>\n`);
      for (const item of items) {
        out.push('<li>');
        inlineInto(item, env, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    const parts = [trimSpaceTab(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      parts.push(trimSpaceTab(lines[i]));
      i++;
    }
    if (excerpt === null) {
      const html = inlineStr(parts.join('\n'), env);
      excerpt = html;
      out.push('<p>', html, '</p>\n');
    } else {
      out.push('<p>');
      inlineInto(parts.join('\n'), env, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` resolved from the directory whose segments are `dirParts`, or null when it climbs out of the root. */
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** A source's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => t.linkObj ?? (t.linkObj = { name: t.name, slug: t.slug, url: t.url })),
  };
}

/** One site's output tree: path -> text. */
export function build(input) {
  const report = [];
  const parsed = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  markLoopElision(parsed);
  const memoReads = new Map();
  for (const [name, nodes] of parsed) {
    const reads = rootReads(nodes);
    if (reads !== null && [...reads].every((r) => r === 'site' || r === 'tags' || r === 'recent')) memoReads.set(name, reads);
  }
  const templates = new Map();
  for (const [name, nodes] of parsed) templates.set(name, compileEntry(nodes, memoReads));
  const base = input.site.base_url.replace(/\/+$/, '');
  const slugCache = new Map();

  // The sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, lines: text.split('\n') });
    } else statics.push(f);
  }

  // Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Each body's Markdown, its links resolved; the body's word count for its card.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const env = {
      link: (target) => {
        if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dirParts, rel);
        const hit = path === null ? undefined : bySource.get(path);
        if (hit !== undefined) return `${hit.url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.lines, s.bodyStart, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    let words = 0;
    for (let i = s.bodyStart; i < s.lines.length; i++) words += countWords(s.lines[i]);
    s.words = words;
  }

  // The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }
  for (const s of kept) {
    if (s.newer === undefined) s.newer = null;
    if (s.older === undefined) s.older = null;
  }

  // The tags: grouped by slug, named as first met in the posts' order, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, slugCache);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Every page through its layout, the index pages and the tag pages through theirs.
  for (const s of kept) s.card = cardOf(s);
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const ctx = { templates };
  const baseVars = { site, tags: allTags, recent };
  const memoCache = new Map();
  const EMPTY_VARS = {};
  ctx.memoFor = (name) => memoReads.get(name) ?? null;
  ctx.memo = (name) => {
    let s = memoCache.get(name);
    if (s === undefined) {
      const t = templates.get(name);
      if (t === undefined) return '';
      const out = [];
      t.fn([baseVars, EMPTY_VARS], ctx, 0, out);
      s = out.join('');
      memoCache.set(name, s);
    }
    return s;
  };
  const scopes = [baseVars, null];
  const render = (name, vars) => {
    const t = templates.get(name);
    if (t === undefined) return null;
    const out = [];
    scopes[1] = vars;
    t.fn(scopes, ctx, 0, out);
    return out.join('');
  };
  const output = {};
  for (const s of kept) {
    const page = {
      ...s.card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer),
      older: linkOf(s.older),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.reduce((acc, s) => acc + (s.post ? 0 : 1), 0);
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
