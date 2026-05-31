---
name: png-to-svg
description: Vectorize raster images (PNG, JPEG) to clean SVG graphics using sips and vtracer on macOS.
---

# PNG to SVG Tracing Skill

Use this workflow to convert raster images (like PNG or JPEG) into clean, scalable SVG vector graphics on macOS.

## Tracing Workflow

### 1. Verify True Image Format
Many AI-generated or web-downloaded images may have format/extension mismatches (e.g. a JPEG file saved with a `.png` extension). The Rust-based `vtracer` library will panic if the extension does not match the actual binary signature.

Run the `file` command to identify the actual image format:
```bash
file path/to/image.png
```

### 2. Normalize to Real PNG
If the file format is JPEG or another type, convert it to a true PNG using macOS's built-in `sips` (Scriptable Image Processing System):
```bash
sips -s format png path/to/image.png --out path/to/image_real.png
```

### 3. Trace and Vectorize using vtracer
Run the Rust-powered `vtracer` engine inside a temporary Python context using the `uv` package manager (to avoid modifying global system packages):
```bash
uv run --with vtracer python3 -c 'import vtracer; vtracer.convert_image_to_svg_py("path/to/image_real.png", "path/to/output.svg")'
```

### 4. Verify Output
Check that the SVG was generated and check its file size:
```bash
ls -lh path/to/output.svg
```
