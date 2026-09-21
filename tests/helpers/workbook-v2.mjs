import ExcelJS from 'exceljs';

export async function dualWorkbook(
  rows,
  codes,
  { sheet1 = 'Sheet1', sheet2 = 'Sheet2', sheet1Headers, sheet2Headers } = {},
) {
  const book = new ExcelJS.Workbook();
  const result = book.addWorksheet(sheet1);
  result.addRow(
    sheet1Headers || [
      'batch',
      'sam',
      'PathogenWithReads',
      'CT value',
      '中文',
    ],
  );
  rows.forEach((row) => result.addRow(row));
  if (sheet2) {
    const panel = book.addWorksheet(sheet2);
    panel.addRow(sheet2Headers || ['PathogenWithReads', '中文']);
    codes.forEach((code) =>
      panel.addRow(Array.isArray(code) ? code : [code, '']),
    );
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}
