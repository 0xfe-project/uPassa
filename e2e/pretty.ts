/**
 * 把 AST 渲染成紧凑的 s-表达式样子，给人看。
 *
 * 为什么不直接 `JSON.stringify`：每门语言的 AST 都带 __lang__ / __meta__，JSON 会把这些
 * 也吐出来，一步就是几十行。这里只印**语言看得见的那部分**（tag + 字段），一行一个节点。
 */

/** 框架字段不印：它们不是语言的一部分。 */
const FRAMEWORK = new Set(["__lang__", "__meta__"]);

/** 宿主值怎么印（数字/布尔/字符串）。 */
function host(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

function isNode(x: unknown): x is Record<string, unknown> {
  return (
    x !== null &&
    typeof x === "object" &&
    !Array.isArray(x) &&
    typeof (x as Record<string, unknown>)["type"] === "string"
  );
}

/** 一个节点 → 一行。子节点缩进在下一行。 */
export function prettyAst(x: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(x)) {
    if (x.length === 0) return "()";
    return x.map((y) => prettyAst(y, indent)).join("\n");
  }
  if (!isNode(x)) return host(x);

  const tag = x["type"] as string;
  const kids: string[] = [];
  const atoms: string[] = [];
  for (const [k, v] of Object.entries(x)) {
    if (FRAMEWORK.has(k) || k === "type") continue;
    if (isNode(v)) kids.push(`  ${k}: ${prettyAst(v, indent + 1).trimStart()}`);
    else if (Array.isArray(v) && v.some(isNode)) {
      const inner = (v as unknown[]).map((y) => prettyAst(y, indent + 2)).join("\n");
      kids.push(`  ${k}:\n${inner}`);
    } else if (Array.isArray(v)) atoms.push(`${k}=[]`);
    else if (v !== undefined) atoms.push(`${k}=${host(v)}`);
  }

  const head = atoms.length > 0 ? `(${tag} ${atoms.join(" ")})` : `(${tag})`;
  if (kids.length === 0) return pad + head;
  return pad + head + "\n" + kids.map((k) => pad + k).join("\n");
}

/** 一行式（不换行）—— 适合"只看一眼"的地方。太长就截断。 */
export function prettyInline(x: unknown, max = 200): string {
  const one = prettyAst(x).replace(/\n\s*/g, " ");
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}
