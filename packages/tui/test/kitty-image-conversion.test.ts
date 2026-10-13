import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { ReadToolGroupComponent, type ReadToolGroupUi } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";

const IMAGE: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	mimeType: "image/jpeg",
};
const originalProtocol = TERMINAL.imageProtocol;

describe("Tool image rendering", () => {
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		vi.spyOn(Bun.Image.prototype, "png").mockImplementation(() => {
			throw new TypeError("synchronous image conversion failure");
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setTerminalImageProtocol(originalProtocol);
	});

	it("omits restored read images when conversion throws synchronously", () => {
		const requestRender = vi.fn();
		const group = new ReadToolGroupComponent({ ui: { requestRender } });
		group.updateArgs({ path: "repro.jpg" }, "restored-read");

		group.updateResult({ content: [IMAGE] }, false, "restored-read");
		expect(requestRender).not.toHaveBeenCalled();
		expect(group.render(80).join("\n")).not.toContain("\x1b_G");
	});

	it("omits live tool-result images when conversion throws synchronously", () => {
		const requestRender = vi.fn();
		const component = new ToolExecutionComponent("read", { path: "repro.jpg" }, {}, undefined, {
			requestRender,
			requestComponentRender: vi.fn(),
			resetDisplay: vi.fn(),
		});

		component.updateResult({ content: [IMAGE] }, false);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("surfaces images returned through xdev write results", () => {
		const component = new ToolExecutionComponent(
			"write",
			{ path: "xd://generate_image" },
			{ showImages: true },
			undefined,
			{
				requestRender: vi.fn(),
				requestComponentRender: vi.fn(),
				resetDisplay: vi.fn(),
			},
		);

		component.updateResult(
			{
				content: [{ type: "text", text: "Generated 1 image" }],
				details: {
					xdev: {
						tool: "generate_image",
						mode: "execute",
						inner: {
							images: [{ data: IMAGE.data, mimeType: "image/png" }],
						},
					},
				},
			},
			false,
		);

		expect(component.render(80).join("\n")).toContain("\x1b_G");
	});
});

describe("Kitty PNG conversion cache", () => {
	// Each test owns payload sizes nothing else converts: the conversion cache is
	// process-wide by design, so shared fixtures would arrive pre-warmed.
	const SEED_PNG = Buffer.from(IMAGE.data, "base64");
	const images: ImageContent[] = [];
	let rebuildImage: ImageContent;
	let liveImage: ImageContent;
	let evictedImage: ImageContent;
	const floodImages: ImageContent[] = [];
	let encodes = 0;
	let originalPng: typeof Bun.Image.prototype.png;
	/** When set, conversions publish this base64 payload instead of the real PNG. */
	let oversizedPng: string | undefined;

	/** A read group hosting one image per `toolCallId`, as a transcript rebuild would deliver them. */
	function readGroup(ui: ReadToolGroupUi, deliveries: Array<[toolCallId: string, image: ImageContent]>) {
		const group = new ReadToolGroupComponent({ ui });
		for (const [toolCallId, image] of deliveries) {
			group.updateArgs({ path: `${toolCallId}.webp` }, toolCallId);
			group.updateResult({ content: [image] }, false, toolCallId);
		}
		return group;
	}

	/** Resolves once `count` conversions have published their result. */
	function converted(count: number): { promise: Promise<void>; notify: () => void } {
		const { promise, resolve } = Promise.withResolvers<void>();
		let seen = 0;
		return {
			promise,
			notify: () => {
				if (++seen >= count) resolve();
			},
		};
	}

	async function webpImage(edge: number): Promise<ImageContent> {
		const webp = await new Bun.Image(SEED_PNG).resize(edge, edge).webp().bytes();
		return { type: "image", data: Buffer.from(webp).toString("base64"), mimeType: "image/webp" };
	}

	beforeAll(async () => {
		await initTheme();
		for (const edge of [137, 139, 141]) images.push(await webpImage(edge));
		rebuildImage = await webpImage(143);
		liveImage = await webpImage(145);
		evictedImage = await webpImage(147);
		for (const edge of [149, 151]) floodImages.push(await webpImage(edge));
	});

	beforeEach(() => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		encodes = 0;
		oversizedPng = undefined;
		originalPng = Bun.Image.prototype.png;
		vi.spyOn(Bun.Image.prototype, "png").mockImplementation(function (this: Bun.Image) {
			encodes++;
			const encoder = originalPng.call(this);
			if (oversizedPng === undefined) return encoder;
			const payload = oversizedPng;
			return Object.assign(Object.create(encoder), { toBase64: async () => payload });
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setTerminalImageProtocol(originalProtocol);
	});

	it("converts each read image once across re-delivery and rebuilt components", async () => {
		const first = converted(images.length);
		const deliveries = images.map((image, index): [string, ImageContent] => [`call-${index}`, image]);
		const group = readGroup({ requestRender: first.notify }, deliveries);
		await first.promise;
		expect(encodes).toBe(images.length);

		// Read-result replay delivers the same images again for one toolCallId.
		for (const [toolCallId, image] of deliveries) group.updateResult({ content: [image] }, false, toolCallId);
		expect(encodes).toBe(images.length);

		// Transcript rebuilds (resume, rewind, /tree) construct fresh components.
		for (let rebuild = 0; rebuild < 2; rebuild++) readGroup({ requestRender: () => {} }, deliveries);
		expect(encodes).toBe(images.length);
	});

	it("renders an already-converted image on a rebuilt component without waiting for a conversion", async () => {
		const warmed = converted(1);
		readGroup({ requestRender: warmed.notify }, [["call-1", rebuildImage]]);
		await warmed.promise;

		const rebuilt = readGroup({ requestRender: () => {} }, [["call-1", rebuildImage]]);

		// Synchronous: no await between delivery and render.
		expect(rebuilt.render(80).join("\n")).toContain("\x1b_G");
	});

	it("keeps a displayed conversion after the shared cache evicts it", async () => {
		const shown = converted(1);
		const group = readGroup({ requestRender: shown.notify }, [["call-1", evictedImage]]);
		await shown.promise;

		// Flood the bounded shared cache with conversions past its byte ceiling.
		oversizedPng = "A".repeat(20 * 1024 * 1024);
		const flooded = converted(floodImages.length);
		readGroup(
			{ requestRender: flooded.notify },
			floodImages.map((image, index): [string, ImageContent] => [`flood-${index}`, image]),
		);
		await flooded.promise;

		// A theme change re-renders every component synchronously.
		group.invalidate();
		expect(group.render(80).join("\n")).toContain("\x1b_G");
	});

	it("converts a live tool-result image once across repeated results and rebuilt components", async () => {
		const displayed = converted(1);
		const ui = {
			requestRender: vi.fn(() => displayed.notify()),
			requestComponentRender: vi.fn(),
			resetDisplay: vi.fn(),
		};
		const component = new ToolExecutionComponent("read", { path: "shot.webp" }, { showImages: true }, undefined, ui);
		component.updateResult({ content: [liveImage] }, false);
		await displayed.promise;
		expect(encodes).toBe(1);

		component.updateResult({ content: [liveImage] }, false);
		const rebuilt = new ToolExecutionComponent("read", { path: "shot.webp" }, { showImages: true }, undefined, ui);
		rebuilt.updateResult({ content: [liveImage] }, false);
		expect(encodes).toBe(1);
		expect(rebuilt.render(80).join("\n")).toContain("\x1b_G");
	});
});
