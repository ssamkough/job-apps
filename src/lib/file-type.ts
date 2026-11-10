const PDF = "application/pdf";
const DOC = "application/msword";
const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Identifies an allowed resume type from the file's leading bytes. We never
 * trust the file name or the Content-Type the browser sent.
 */
export function sniffResumeType(buf: Buffer): string | null {
  // %PDF- (some generators put a few bytes of junk before it)
  if (buf.subarray(0, 1024).includes(Buffer.from("%PDF-"))) return PDF;

  // OLE2 compound file: legacy .doc
  if (
    buf.length > 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  ) {
    return DOC;
  }

  // ZIP container that holds a Word document (word/ entries)
  if (
    buf.length > 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    buf[2] === 0x03 &&
    buf[3] === 0x04 &&
    buf.includes(Buffer.from("word/"))
  ) {
    return DOCX;
  }

  return null;
}
