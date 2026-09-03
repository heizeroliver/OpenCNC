import { describe, expect, it } from "vitest";
import { elevatedBridgeCommand } from "./biesseworks-bridge.js";

describe("BiesseWorks elevated bridge command", () => {
  it("passes quoted paths to one elevated PowerShell process", () => {
    const command = elevatedBridgeCommand(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Program Files\\OpenCNC\\biesseworks-bridge.ps1",
      "C:\\Users\\Heizer Szabolcs\\AppData\\Local\\Temp\\request.json",
      "C:\\Users\\Heizer Szabolcs\\AppData\\Local\\Temp\\result.json"
    );

    expect(command).toContain("Start-Process");
    expect(command).toContain("-Verb RunAs");
    expect(command).toContain("-Wait");
    expect(command).toContain("-STA");
    expect(command).toContain("\"C:\\Program Files\\OpenCNC\\biesseworks-bridge.ps1\"");
    expect(command).toContain("\"C:\\Users\\Heizer Szabolcs\\AppData\\Local\\Temp\\request.json\"");
  });

  it("escapes PowerShell literals and rejects quotation marks in child paths", () => {
    const command = elevatedBridgeCommand("C:\\Windows\\powershell.exe", "C:\\O'Brien\\bridge.ps1", "C:\\request.json", "C:\\result.json");
    expect(command).toContain("O''Brien");
    expect(() => elevatedBridgeCommand("powershell.exe", "C:\\bad\"path.ps1", "request.json", "result.json"))
      .toThrow("cannot contain quotation marks");
  });
});
