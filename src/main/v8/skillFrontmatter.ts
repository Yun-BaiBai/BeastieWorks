// A skill's name and description from the front of its SKILL.md. Moved here unchanged from the old skills.ts when it
// was removed with the old harness (老板 2026-11-20). Deliberately not a YAML parser: a description is often a
// multi-line `|` block, which a naive key:value split would cut at the first line.
export function parseSkillFrontmatter(md: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const body = m[1];
  const out: { name?: string; description?: string } = {};
  const nameM = /^name:\s*(.+)$/m.exec(body);
  if (nameM) out.name = nameM[1].trim().replace(/^["']|["']$/g, '');
  // Block scalar (`description: |`) → take the indented lines that follow.
  // Consecutive INDENTED lines after `description: |`. The earlier lookahead
  // form ended at `\r?\n?$`, which under /m matches the end of the FIRST line —
  // so every multi-line description silently arrived truncated to one line.
  const blockM = /^description:\s*[|>]-?[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)/m.exec(body);
  if (blockM) {
    out.description = blockM[1].split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ').trim();
  } else {
    const inlineM = /^description:\s*(.+)$/m.exec(body);
    if (inlineM) out.description = inlineM[1].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
