// Minimal XML reader for Salesforce metadata files. It handles elements, text
// and entities, which is everything metadata XML uses. Not a general parser.

const ENT = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };
const decode = (s) => s.replace(/&(lt|gt|amp|quot|apos);/g, (m) => ENT[m]).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

/**
 * Parse XML into nested nodes: { name, text, children: [] }.
 * @param {string} xml
 */
export function parseXml(xml) {
  const root = { name: '#root', text: '', children: [] };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([^\s>/]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack.at(-1);
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) { if (stack.length > 1) stack.pop(); }
    else if (m[3]) {
      const node = { name: m[3], text: '', children: [] };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] && m[6].trim()) top.text += decode(m[6].trim());
  }
  return root.children[0] || root;
}

/** All direct children with this tag name. */
export const kids = (node, name) => (node ? node.children.filter((c) => c.name === name) : []);
/** Text of the first direct child with this name, or undefined. */
export const val = (node, name) => kids(node, name)[0]?.text;
/** Every descendant with this tag name, depth-first. */
export function findAll(node, name, out = []) {
  for (const c of node?.children || []) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}
