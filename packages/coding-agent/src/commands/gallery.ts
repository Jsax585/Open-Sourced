/**
 * Render every built-in tool's renderer across its lifecycle states.
 */

import { t } from "@oh-my-pi/pi-utils/i18n";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { galleryHelp as commandHelp } from "../cli/command-help";
import {
	GALLERY_STATE_TOKENS,
	GALLERY_SURFACE_TOKENS,
	type GalleryState,
	type GallerySurface,
	parseGalleryStates,
	parseGallerySurfaces,
	runGalleryCommand,
} from "../cli/gallery-cli";

export default class Gallery extends Command {
	static description = commandHelp.description;
	static flags = {
		surface: Flags.string({
			description: t("Render only tool, composer, or segment surfaces (repeatable; default: all)"),
			options: [...GALLERY_SURFACE_TOKENS],
			multiple: true,
		}),
		tool: Flags.string({ char: "t", description: t("Render a single tool by name") }),
		composer: Flags.string({ description: t("Render a single composer shape by name") }),
		segment: Flags.string({ description: t("Render a single status-line segment by name") }),
		state: Flags.string({
			char: "s",
			description: t("Render only the given lifecycle state(s)"),
			options: GALLERY_STATE_TOKENS,
			multiple: true,
		}),
		width: Flags.integer({ char: "w", description: t("Render width in columns") }),
		expanded: Flags.boolean({
			char: "e",
			description: t("Render the expanded variant of each renderer"),
			default: false,
		}),
		plain: Flags.boolean({ description: t("Strip ANSI styling from the output"), default: false }),
		screenshot: Flags.boolean({
			description:
				t("Capture the rendered output as PNG screenshot(s) via VHS instead of printing ANSI (requires vhs)"),
			default: false,
		}),
		out: Flags.string({
			char: "o",
			description: t("Screenshot output path (with --screenshot); suffixed per image when split across multiple"),
		}),
		font: Flags.string({ description: t("Screenshot font family (default: JetBrainsMono Nerd Font)") }),
		"font-size": Flags.integer({ description: t("Screenshot font size in points (default: 18)") }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Gallery);
		let states: GalleryState[] | undefined;
		let surfaces: GallerySurface[] | undefined;
		try {
			states = parseGalleryStates(flags.state);
			surfaces = parseGallerySurfaces(flags.surface);
		} catch (err) {
			process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
			process.exitCode = 1;
			return;
		}
		await runGalleryCommand({
			surfaces,
			tool: flags.tool,
			composer: flags.composer,
			segment: flags.segment,
			states,
			width: flags.width,
			expanded: flags.expanded,
			plain: flags.plain,
			screenshot: flags.screenshot,
			out: flags.out,
			font: flags.font,
			fontSize: flags["font-size"],
		});
	}
}
