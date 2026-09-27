/**
 * 终端上色。管道 / 非 TTY 时自动关 —— 不然 `pnpm e2e | tee` 会吐一堆转义码。
 */

const enabled = process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;

function wrap(code: string) {
  return (s: string): string => (enabled ? `\u001b[${code}m${s}\u001b[0m` : s);
}

export const color = {
  enabled,
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
  grey: wrap("90"),
};

/** 每门语言一个色。语言多了就绕回复用。 */
const LANG_COLORS = [color.cyan, color.blue, color.magenta, color.yellow, color.green];

export function langColor(index: number): (s: string) => string {
  return LANG_COLORS[index % LANG_COLORS.length]!;
}
