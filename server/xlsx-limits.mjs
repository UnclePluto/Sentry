// XLSX 是 ZIP：在解压前检查中央目录声明的大小，防止小文件无限膨胀。
// ExcelJS 的实际解压仍在有内存上限和超时的独立线程中运行。
export function checkArchive(bytes) {
  const b = Buffer.from(bytes);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--)
    if (b.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  const bad = () => {
    throw Error('Excel 压缩结构无效或超过安全解析上限。');
  };
  if (end < 0) bad();
  const count = b.readUInt16LE(end + 10),
    size = b.readUInt32LE(end + 12),
    offset = b.readUInt32LE(end + 16);
  if (
    count > 2048 ||
    offset + size > end ||
    b.readUInt16LE(end + 4) ||
    b.readUInt16LE(end + 6)
  )
    bad();
  let cursor = offset,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || b.readUInt32LE(cursor) !== 0x02014b50) bad();
    const expanded = b.readUInt32LE(cursor + 24),
      compressed = b.readUInt32LE(cursor + 20);
    total += expanded;
    if (
      total > 96 * 1024 * 1024 ||
      expanded === 0xffffffff ||
      compressed === 0xffffffff ||
      b.readUInt16LE(cursor + 8) & 1
    )
      bad();
    cursor +=
      46 +
      b.readUInt16LE(cursor + 28) +
      b.readUInt16LE(cursor + 30) +
      b.readUInt16LE(cursor + 32);
  }
  if (cursor !== offset + size) bad();
}
