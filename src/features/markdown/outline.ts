export interface OutlineItem {
  level: number;
  text: string;
  line: number;
  offset: number;
}

export function parseOutline(content: string): OutlineItem[] {
  const lines = content.split("\n");
  const items: OutlineItem[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      items.push({
        level: match[1].length,
        text: match[2].trim(),
        line: i,
        offset,
      });
    }
    offset += line.length + 1;
  }
  return items;
}
