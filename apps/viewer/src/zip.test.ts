import { describe, expect, it } from "vitest";
import { createZip, zipFilename } from "./zip.js";

describe("ZIP export", () => {
  it("creates a standards-shaped archive containing every filename", () => {
    const archive = createZip([{ name: "one.cix", contents: "first" }, { name: "report.json", contents: "{}" }]);
    const view = new DataView(archive);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(archive.byteLength - 22, true)).toBe(0x06054b50);
    const text = new TextDecoder().decode(new Uint8Array(archive));
    expect(text).toContain("one.cix");
    expect(text).toContain("report.json");
  });

  it("normalizes a user-selected ZIP filename safely", () => {
    expect(zipFilename(" Kitchen batch 08-30.zip ")).toBe("Kitchen batch 08-30.zip");
    expect(zipFilename("job/one:*?")).toBe("job-one---.zip");
    expect(zipFilename(".zip")).toBe("opencnc-bulk-conversion.zip");
  });

  it("preserves Windows CRLF bytes in archived BPP files", () => {
    const name = "part.bpp";
    const contents = "[HEADER]\r\nTYPE=BPP\r\nVER=150\r\n";
    const archive = createZip([{ name, contents }]);
    const payloadOffset = 30 + new TextEncoder().encode(name).length;
    const payload = new Uint8Array(archive, payloadOffset, new TextEncoder().encode(contents).length);
    expect([...payload]).toEqual([...new TextEncoder().encode(contents)]);
    expect([...payload].filter((byte, index, bytes) => byte === 10 && bytes[index - 1] !== 13)).toHaveLength(0);
  });
});
