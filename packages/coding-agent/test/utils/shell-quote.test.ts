import { describe, expect, it } from "bun:test";
import { detectInteractiveShell, quotePowerShellArgument, quoteShellArgument } from "../../src/utils/shell-quote";

const values = [
	"",
	"work",
	"-n",
	"a b\t\nc",
	"O'Brien",
	"left‘middle’right",
	"‘; throw 'injected'; ’",
	"left‚middle‛right",
	"‘‚;Write-Output injected;‚‘.yml",
	"a\\b\\\\c\\",
	"C:\\My Config\\O’Brien\\overlay.yml",
	"$HOME $(printf injected) `printf injected`",
	"a;b&c|d<e>f",
	"*?[abc]~{}!",
	"@args",
	"a,b",
	"%PATH% !PATH!",
	"日本語 😀",
];

describe("detectInteractiveShell", () => {
	it("selects shell dialects independently of the host platform", () => {
		expect(detectInteractiveShell({ SHELL: "C:\\Program Files\\Git\\bin\\bash.exe" }, "win32")).toBe("posix");
		expect(detectInteractiveShell({ SHELL: "/usr/local/bin/pwsh" }, "linux")).toBe("powershell");
		expect(detectInteractiveShell({ SHELL: "/bin/zsh" }, "darwin")).toBe("posix");
		expect(detectInteractiveShell({ SHELL: "/usr/bin/fish" }, "linux")).toBe("fish");
	});

	it("does not let inherited PowerShell variables override an explicit shell", () => {
		const inherited = { PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules" };
		expect(detectInteractiveShell({ ...inherited, SHELL: "/usr/bin/bash", MSYSTEM: "MINGW64" }, "win32")).toBe(
			"posix",
		);
		expect(detectInteractiveShell({ ...inherited, SHELL: "C:\\Windows\\System32\\cmd.exe" }, "win32")).toBe("cmd");
		expect(detectInteractiveShell({ ...inherited, SHELL: "/usr/bin/nu" }, "linux")).toBe("unknown");
		expect(detectInteractiveShell(inherited, "linux")).toBe("powershell");
		expect(detectInteractiveShell({ POWERSHELL_DISTRIBUTION_CHANNEL: "MSI:Windows" }, "win32")).toBe("powershell");
	});

	it("does not assume Windows is PowerShell or Unix is POSIX", () => {
		expect(detectInteractiveShell({ ComSpec: "C:\\Windows\\System32\\cmd.exe" }, "win32")).toBe("cmd");
		expect(detectInteractiveShell({}, "win32")).toBe("cmd");
		expect(detectInteractiveShell({}, "linux")).toBe("unknown");
		expect(detectInteractiveShell({ SHELL: "/usr/bin/nu" }, "win32")).toBe("unknown");
	});
});

for (const name of ["bash", "zsh", "fish"] as const) {
	const executable = Bun.which(name);
	const dialect = name === "fish" ? "fish" : "posix";
	describe(`${name} argument boundaries`, () => {
		it.skipIf(!executable)("round-trips exact argv without evaluating argument contents", () => {
			const runtime = process.platform === "win32" ? process.execPath.replace(/\\/g, "/") : process.execPath;
			const argv = [runtime, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", ...values];
			const command = argv.map(value => quoteShellArgument(value, dialect)).join(" ");
			const options = name === "bash" ? ["--noprofile", "--norc"] : name === "zsh" ? ["-f"] : ["--no-config"];
			const result = Bun.spawnSync([executable!, ...options, "-c", command], {
				env: { ...process.env, BASH_ENV: "", ENV: "" },
			});
			expect(result.stderr.toString()).toBe("");
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.stdout.toString())).toEqual(values);
		});
	});
}

for (const name of ["pwsh", "powershell"] as const) {
	const executable = Bun.which(name);
	describe(`${name} string argument boundaries`, () => {
		for (const [label, quote] of [
			["PowerShell quoting", quotePowerShellArgument],
			["interactive quoting", (value: string) => quoteShellArgument(value, "powershell")],
		] as const) {
			it.skipIf(!executable)(`${label} preserves smart apostrophes and blocks injected statements`, () => {
				// A PowerShell function captures parser arguments without involving the
				// separate, version-dependent native executable argument marshaller.
				const command = `function capture { ConvertTo-Json -InputObject @($args) -Compress }; capture ${values.map(quote).join(" ")}`;
				const result = Bun.spawnSync(
					[executable!, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
					{
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				expect(result.stderr.toString()).toBe("");
				expect(result.exitCode).toBe(0);
				expect(JSON.parse(result.stdout.toString().replace(/^\uFEFF/, ""))).toEqual(values);
			});
		}
	});
}
