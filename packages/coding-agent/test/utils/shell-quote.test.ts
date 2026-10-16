import { describe, expect, it } from "bun:test";
import { quoteShellArgument } from "../../src/utils/shell-quote";

describe("quoteShellArgument", () => {
	it("leaves plain words and Windows drive paths bare so they paste into any shell", () => {
		expect(quoteShellArgument("work", "linux")).toBe("work");
		expect(quoteShellArgument("/home/me/ov/deep.yml", "darwin")).toBe("/home/me/ov/deep.yml");
		expect(quoteShellArgument("C:\\Users\\me\\deep.yml", "win32")).toBe("C:\\Users\\me\\deep.yml");
	});

	it("quotes POSIX values with the '\\'' escape, including backslash paths", () => {
		expect(quoteShellArgument("/tmp/My Config.yml", "linux")).toBe("'/tmp/My Config.yml'");
		expect(quoteShellArgument("/tmp/O'Brien.yml", "darwin")).toBe("'/tmp/O'\\''Brien.yml'");
		expect(quoteShellArgument("a\\b.yml", "linux")).toBe("'a\\b.yml'");
	});

	it("quotes Windows values for PowerShell, doubling apostrophes instead of POSIX escaping", () => {
		expect(quoteShellArgument("C:\\Users\\O'Brien\\overlay.yml", "win32")).toBe("'C:\\Users\\O''Brien\\overlay.yml'");
		expect(quoteShellArgument("C:\\My Config\\a;b.yml", "win32")).toBe("'C:\\My Config\\a;b.yml'");
	});
});
