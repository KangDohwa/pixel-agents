import * as fs from 'fs';

/** Shared file boundary: only complete UTF-8 records reach a parser. */
export class TranscriptFile {
  private bytes = Buffer.alloc(0);
  private offset = 0;
  private signature = '';

  constructor(readonly file: string) {}

  read(): { reset: boolean; records: unknown[]; mtime: number } | null {
    const stat = fs.statSync(this.file);
    const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (signature === this.signature) return null;
    // ponytail: compare changed files in full to detect in-place rewrites as well
    // as append/rotation. Use block hashes if very large active logs become costly.
    const bytes = fs.readFileSync(this.file);
    const json = this.file.endsWith('.json');
    const reset =
      json ||
      bytes.length < this.bytes.length ||
      !bytes.subarray(0, this.bytes.length).equals(this.bytes);
    const records: unknown[] = [];
    let offset = reset ? 0 : this.offset;
    if (json) {
      // A partially rewritten legacy JSON document is not a new empty session.
      records.push(JSON.parse(bytes.toString('utf8')));
      offset = bytes.length;
    } else {
      for (let end = bytes.indexOf(10, offset); end !== -1; end = bytes.indexOf(10, offset)) {
        const line = bytes.subarray(offset, end).toString('utf8').trim();
        if (line) records.push(JSON.parse(line));
        offset = end + 1;
      }
    }
    this.bytes = bytes;
    this.offset = offset;
    this.signature = signature;
    return { reset, records, mtime: stat.mtimeMs };
  }
}
