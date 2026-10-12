//! Terminal-image encoding: SIXEL sequences, per-row image strips, and bounded
//! SIXEL decoding.
//!
//! Encodes PNG/JPEG/WebP/GIF images for terminal display and decodes captured
//! SIXEL control strings back to bounded PNG attachments.
//!
//! General-purpose image processing stays in `Bun.Image`; the native boundary
//! exists because SIXEL has no equivalent decoder there, and `Bun.Image` can
//! neither crop nor run synchronously for output that cannot wait.

use std::io::Cursor;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use icy_sixel::{EncodeOptions, SixelImage, sixel_encode};
use image::{
	DynamicImage, ExtendedColorType, ImageDecoder, ImageEncoder, ImageFormat, ImageReader,
	RgbaImage,
	codecs::png::PngEncoder,
	imageops::{self, FilterType},
	metadata::Orientation,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::task;

const MAX_DECODED_PIXELS: usize = 4 * 1024 * 1024;
const MAX_IMAGE_EDGE: usize = 8192;
const MAX_SIXEL_BYTES: usize = 20 * 1024 * 1024;
const MAX_PNG_BYTES: usize = 20 * 1024 * 1024;
/// Largest decoded source `encode_image_rows` inflates: a 6K RGBA8 screenshot
/// (about 81 MiB) fits, an 8192×8192 RGBA8 raster (256 MiB) does not.
const MAX_ROW_SOURCE_BYTES: u64 = 128 * 1024 * 1024;
/// Largest total of ICC profile bytes `encode_image_rows` repeats across its
/// strips: a Display P3 profile (about 0.5 KiB) on hundreds of rows fits,
/// a 1 MiB profile on 1,000 rows (1 GiB of strips) does not.
const MAX_ROW_PROFILE_BYTES: u64 = 16 * 1024 * 1024;

/// Decode one complete SIXEL control string into a PNG on the calling thread.
///
/// The decoder is deliberately bounded before handing the stream to
/// `icy_sixel`: raster declarations, repeats, and row advances are scanned
/// first so hostile dimensions cannot make the dependency allocate its much
/// larger internal maximum.
#[napi]
pub fn decode_sixel_to_png(bytes: Uint8Array) -> Result<Uint8Array> {
	if bytes.len() > MAX_SIXEL_BYTES {
		return Err(Error::from_reason("SIXEL payload exceeds the 20 MiB limit"));
	}
	decode_sixel(bytes.as_ref()).map(Uint8Array::from)
}

/// Same result as [`decode_sixel_to_png`], but the decode runs on the native
/// blocking pool instead of the JS thread.
#[napi]
pub fn decode_sixel_to_png_async(bytes: Uint8Array) -> task::Promise<Uint8Array> {
	// An oversized payload rejects without being copied off the JS heap.
	let bytes = (bytes.len() <= MAX_SIXEL_BYTES).then(|| bytes.to_vec());
	task::blocking("sixel.decode", (), move |_| {
		let bytes =
			bytes.ok_or_else(|| Error::from_reason("SIXEL payload exceeds the 20 MiB limit"))?;
		decode_sixel(&bytes).map(Uint8Array::from)
	})
}

fn decode_sixel(bytes: &[u8]) -> Result<Vec<u8>> {
	preflight_sixel_dimensions(bytes)?;

	let decoded = SixelImage::decode(bytes)
		.map_err(|err| Error::from_reason(format!("Failed to decode SIXEL: {err}")))?;
	guard_dimensions(decoded.width, decoded.height)?;

	let width =
		u32::try_from(decoded.width).map_err(|_| Error::from_reason("SIXEL width is too large"))?;
	let height =
		u32::try_from(decoded.height).map_err(|_| Error::from_reason("SIXEL height is too large"))?;
	let rgba = RgbaImage::from_raw(width, height, decoded.pixels)
		.ok_or_else(|| Error::from_reason("Decoded SIXEL pixel buffer has invalid dimensions"))?;
	let mut png = Vec::with_capacity(rgba.len().min(MAX_PNG_BYTES));
	DynamicImage::ImageRgba8(rgba)
		.write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
		.map_err(|err| Error::from_reason(format!("Failed to encode decoded SIXEL as PNG: {err}")))?;
	if png.len() > MAX_PNG_BYTES {
		return Err(Error::from_reason("Decoded SIXEL PNG exceeds the 20 MiB limit"));
	}
	Ok(png)
}

fn guard_dimensions(width: usize, height: usize) -> Result<()> {
	if width == 0
		|| height == 0
		|| width > MAX_IMAGE_EDGE
		|| height > MAX_IMAGE_EDGE
		|| width.saturating_mul(height) > MAX_DECODED_PIXELS
	{
		return Err(Error::from_reason("Image dimensions exceed the decode limit"));
	}
	Ok(())
}

fn preflight_sixel_dimensions(bytes: &[u8]) -> Result<()> {
	let payload_start = bytes
		.windows(2)
		.position(|window| window == b"\x1bP")
		.map(|index| index + 2)
		.or_else(|| {
			bytes
				.iter()
				.position(|byte| *byte == 0x90)
				.map(|index| index + 1)
		})
		.ok_or_else(|| Error::from_reason("SIXEL data is missing a DCS introducer"))?;
	let q = bytes[payload_start..]
		.iter()
		.position(|byte| *byte == b'q')
		.map(|index| payload_start + index + 1)
		.ok_or_else(|| Error::from_reason("SIXEL data is missing its q introducer"))?;

	let mut x = 0usize;
	let mut y = 0usize;
	let mut max_width = 0usize;
	let mut max_height = 0usize;
	let mut index = q;
	while index < bytes.len() {
		let byte = bytes[index];
		if byte == 0x9c || (byte == 0x1b && bytes.get(index + 1) == Some(&b'\\')) {
			break;
		}
		match byte {
			b'?'..=b'~' => {
				x = x.saturating_add(1);
				max_width = max_width.max(x);
				max_height = max_height.max(y.saturating_add(6));
			},
			b'!' => {
				let (count, next) = decimal(bytes, index + 1);
				if let Some(sixel) = bytes.get(next)
					&& (b'?'..=b'~').contains(sixel)
				{
					x = x.saturating_add(count);
					max_width = max_width.max(x);
					max_height = max_height.max(y.saturating_add(6));
					index = next;
				}
			},
			b'-' => {
				y = y.saturating_add(6);
				x = 0;
			},
			b'$' => x = 0,
			b'"' => {
				let mut values = [0usize; 4];
				let mut next = index + 1;
				for value in &mut values {
					let (parsed, end) = decimal(bytes, next);
					*value = parsed;
					next = end;
					if bytes.get(next) != Some(&b';') {
						break;
					}
					next += 1;
				}
				if values[2] > 0 || values[3] > 0 {
					guard_dimensions(values[2].max(1), values[3].max(1))?;
					max_width = max_width.max(values[2]);
					max_height = max_height.max(values[3]);
				}
				index = next.saturating_sub(1);
			},
			_ => {},
		}
		guard_dimensions(max_width.max(1), max_height.max(1))?;
		index += 1;
	}
	guard_dimensions(max_width.max(1), max_height.max(1))
}

fn decimal(bytes: &[u8], mut index: usize) -> (usize, usize) {
	let mut value = 0usize;
	while let Some(&digit @ b'0'..=b'9') = bytes.get(index) {
		value = value
			.saturating_mul(10)
			.saturating_add((digit - b'0') as usize);
		index += 1;
	}
	(value, index)
}

/// Encode image bytes into a SIXEL escape sequence for terminal rendering, on
/// the calling thread.
///
/// The input image is decoded and resized to the requested pixel dimensions
/// before encoding. Prefer [`encode_sixel_async`] unless the caller cannot
/// wait: the decode, resize and dither block the JS thread.
///
/// # Errors
/// Returns an error if decoding, resizing, or SIXEL encoding fails.
#[napi]
pub fn encode_sixel(
	bytes: Uint8Array,
	target_width_px: u32,
	target_height_px: u32,
) -> Result<String> {
	encode_image(bytes.as_ref(), target_width_px, target_height_px)
}

/// Same result as [`encode_sixel`], but the decode, resize and dither run on
/// the native blocking pool, so they never stall the JavaScript event loop.
///
/// # Errors
/// Rejects if decoding, resizing, or SIXEL encoding fails.
#[napi]
pub fn encode_sixel_async(
	bytes: Uint8Array,
	target_width_px: u32,
	target_height_px: u32,
) -> task::Promise<String> {
	let bytes = bytes.to_vec();
	task::blocking("sixel.encode", (), move |_| {
		encode_image(&bytes, target_width_px, target_height_px)
	})
}

fn encode_image(bytes: &[u8], target_width_px: u32, target_height_px: u32) -> Result<String> {
	if target_width_px == 0 || target_height_px == 0 {
		return Err(Error::from_reason("Target SIXEL dimensions must be greater than zero"));
	}

	let source = decode_image_from_bytes(bytes)?;
	let resized = if source.width() == target_width_px && source.height() == target_height_px {
		source
	} else {
		source.resize_exact(target_width_px, target_height_px, FilterType::Lanczos3)
	};
	// Reuses the pixel buffer when the image is already RGBA8.
	let rgba = resized.into_rgba8();
	let options = EncodeOptions::default();
	sixel_encode(rgba.as_raw(), target_width_px as usize, target_height_px as usize, &options)
		.map_err(|err| Error::from_reason(format!("Failed to encode SIXEL: {err}")))
}

/// Encode image bytes as one base64 PNG per terminal row, on the calling
/// thread.
///
/// The image is scaled to `target_width_px` with its aspect ratio kept
/// (squashed if it would be taller than `rows` × `row_height_px`), then cut
/// into `rows` strips of `row_height_px`; rows past the image bottom are
/// transparent. Geometry beyond the decode limits is scaled down with its
/// shape kept, so the strips can be smaller than requested. Each strip
/// carries the source's embedded RGB ICC profile, if any. A terminal that
/// draws each strip into exactly one cell row (such as iTerm2 inline images)
/// shows the image row by row, so any subset of rows can be repainted,
/// clipped, or scrolled without the others. Prefer
/// [`encode_image_rows_async`] unless the caller cannot wait.
///
/// # Errors
/// Returns an error if a dimension is zero, if `rows` cannot fit the decode
/// limit even at one pixel each, if the source is wider or taller than the
/// 8192 px decode edge or would decode to more than 128 MiB, if the image
/// carries an EXIF orientation other than none or a non-RGB ICC profile (the
/// strips could not honour either), if its ICC profile repeated on every row
/// would exceed 16 MiB, or if decoding, resizing, or PNG encoding fails.
#[napi]
pub fn encode_image_rows(
	bytes: Uint8Array,
	target_width_px: u32,
	row_height_px: u32,
	rows: u32,
) -> Result<Vec<String>> {
	encode_rows(bytes.as_ref(), target_width_px, row_height_px, rows)
}

/// Same result as [`encode_image_rows`], but the decode, resize and encodes
/// run on the native blocking pool, so they never stall the JavaScript event
/// loop.
///
/// # Errors
/// Rejects if a dimension is zero, if `rows` cannot fit the decode limit
/// even at one pixel each, if the source is wider or taller than the 8192 px
/// decode edge or would decode to more than 128 MiB, if the image carries an
/// EXIF orientation other than none or a non-RGB ICC profile, if its ICC
/// profile repeated on every row would exceed 16 MiB, or if decoding,
/// resizing, or PNG encoding fails.
#[napi]
pub fn encode_image_rows_async(
	bytes: Uint8Array,
	target_width_px: u32,
	row_height_px: u32,
	rows: u32,
) -> task::Promise<Vec<String>> {
	let bytes = bytes.to_vec();
	task::blocking("image.rows", (), move |_| {
		encode_rows(&bytes, target_width_px, row_height_px, rows)
	})
}

fn encode_rows(
	bytes: &[u8],
	target_width_px: u32,
	row_height_px: u32,
	rows: u32,
) -> Result<Vec<String>> {
	if target_width_px == 0 || row_height_px == 0 || rows == 0 {
		return Err(Error::from_reason("Image row geometry must be greater than zero"));
	}
	let (target_width_px, row_height_px) = fit_row_geometry(target_width_px, row_height_px, rows);
	let total_height_px = row_height_px.saturating_mul(rows);
	guard_dimensions(target_width_px as usize, total_height_px as usize)?;

	// Header probe before the full decode. A source too large to inflate in the
	// worker, one needing EXIF reorientation (strips carry no EXIF, and the
	// caller sized the rows from the stored raster), or one whose colour profile
	// cannot describe RGB strips (CMYK, grey) or is too large to repeat per row
	// is left to a viewer of the original. An RGB profile is copied into every
	// strip.
	let mut header = ImageReader::new(Cursor::new(bytes))
		.with_guessed_format()
		.map_err(|e| Error::from_reason(format!("Failed to detect image format: {e}")))?
		.into_decoder()
		.map_err(|e| Error::from_reason(format!("Failed to decode image: {e}")))?;
	let (source_width, source_height) = header.dimensions();
	if source_width as usize > MAX_IMAGE_EDGE
		|| source_height as usize > MAX_IMAGE_EDGE
		|| header.total_bytes() > MAX_ROW_SOURCE_BYTES
	{
		return Err(Error::from_reason("Image dimensions exceed the decode limit"));
	}
	if header
		.orientation()
		.is_ok_and(|orientation| orientation != Orientation::NoTransforms)
	{
		return Err(Error::from_reason("Image needs EXIF reorientation"));
	}
	let icc_profile = header.icc_profile().ok().flatten();
	// The ICC header names the profile's colour space at bytes 16..20.
	if icc_profile
		.as_deref()
		.is_some_and(|profile| profile.get(16..20) != Some(&b"RGB "[..]))
	{
		return Err(Error::from_reason("Image has a non-RGB colour profile"));
	}
	if icc_profile
		.as_ref()
		.is_some_and(|profile| profile.len() as u64 * u64::from(rows) > MAX_ROW_PROFILE_BYTES)
	{
		return Err(Error::from_reason("Image colour profile is too large to repeat per row"));
	}
	let source = decode_image_from_bytes(bytes)?;
	if source.width() == 0 || source.height() == 0 {
		return Err(Error::from_reason("Image has no pixels"));
	}
	let scaled_height = (u64::from(source.height()) * u64::from(target_width_px))
		.div_ceil(u64::from(source.width()))
		.clamp(1, u64::from(total_height_px)) as u32;
	let scaled = if source.width() == target_width_px && source.height() == scaled_height {
		source.into_rgba8()
	} else {
		source
			.resize_exact(target_width_px, scaled_height, FilterType::Lanczos3)
			.into_rgba8()
	};

	let mut strips = Vec::with_capacity(rows as usize);
	let mut png = Vec::new();
	for row in 0..rows {
		let mut strip = RgbaImage::new(target_width_px, row_height_px);
		let top = row * row_height_px;
		if top < scaled_height {
			let height = row_height_px.min(scaled_height - top);
			let source_rows = imageops::crop_imm(&scaled, 0, top, target_width_px, height);
			imageops::replace(&mut strip, &*source_rows, 0, 0);
		}
		png.clear();
		let mut encoder = PngEncoder::new(&mut png);
		if let Some(profile) = &icc_profile {
			encoder
				.set_icc_profile(profile.clone())
				.map_err(|err| Error::from_reason(format!("Failed to embed ICC profile: {err}")))?;
		}
		encoder
			.write_image(strip.as_raw(), target_width_px, row_height_px, ExtendedColorType::Rgba8)
			.map_err(|err| Error::from_reason(format!("Failed to encode image row as PNG: {err}")))?;
		strips.push(STANDARD.encode(&png));
	}
	Ok(strips)
}

/// Scales the strip width and row height down by one factor until the whole
/// strip stack fits `MAX_IMAGE_EDGE` and `MAX_DECODED_PIXELS`.
fn fit_row_geometry(width: u32, row_height: u32, rows: u32) -> (u32, u32) {
	let width_px = f64::from(width);
	let height_px = f64::from(row_height) * f64::from(rows);
	let scale = (MAX_DECODED_PIXELS as f64 / (width_px * height_px))
		.sqrt()
		.min(MAX_IMAGE_EDGE as f64 / width_px)
		.min(MAX_IMAGE_EDGE as f64 / height_px);
	if scale >= 1.0 {
		return (width, row_height);
	}
	let shrink = |px: u32| ((f64::from(px) * scale).floor() as u32).max(1);
	(shrink(width), shrink(row_height))
}

fn decode_image_from_bytes(bytes: &[u8]) -> Result<DynamicImage> {
	let reader = ImageReader::new(Cursor::new(bytes))
		.with_guessed_format()
		.map_err(|e| Error::from_reason(format!("Failed to detect image format: {e}")))?;

	reader
		.decode()
		.map_err(|e| Error::from_reason(format!("Failed to decode image: {e}")))
}
