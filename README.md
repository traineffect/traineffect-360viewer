# 360 Viewer

Browser-based viewer for equirectangular panoramas. Static, no backend, no build step.
Deployed at `360viewer.traineffect.co.nz` on Cloudflare Pages.

Built to check drone panorama stitches without uploading client site imagery to a third
party service. The panoramas come off a DJI Neo 2 flown in 360 degree yaw passes at
several pitch angles, frames pulled with ffmpeg, stitched in Microsoft ICE.

## The privacy claim, and how to check it

The image never leaves the machine it is dropped on. That is not a policy, it is a
property of the page: there is no server to send anything to, and the Content Security
Policy in `_headers` sets `default-src 'none'` with `connect-src 'none'`, so the page has
no mechanism to transmit. No fetch, no XHR, no WebSocket, no form action, no third party
origin of any kind.

To verify: open DevTools, go to the Network tab, drop an image in. Zero requests.

This is why three.js and both fonts are served from this origin rather than from a CDN.
Self-hosting is what makes the claim checkable instead of merely stated.

**Anything that would require relaxing the CSP needs a deliberate decision, not a quiet
edit.** `font-src 'self'` was added when the brand fonts were vendored in. It permits
same-origin font files only and opens no outbound path.

## Files

| File | Purpose |
|---|---|
| `index.html` | Markup. No inline script or style, so the CSP needs no `unsafe-inline`. |
| `app.css` | Styles, design tokens, and the two `@font-face` rules. |
| `app.js` | Viewer logic. |
| `three.min.js` | three.js r128, MIT, self-hosted rather than pulled from a CDN. |
| `fonts/` | Fraunces Variable and Geist Mono Variable, latin subset, weight axis only. Roughly 66 KB together. Licences alongside. |
| `favicon.svg` | |
| `_headers` | Cloudflare Pages response headers, including the CSP. |

## Design

Palette, type and motion follow the Train Effect design system, as shipped in
`astro-matthewpaterson/src/styles/tokens.css`.

The system's warm charcoal nocturne is used here rather than the light ground planned for
`traineffect.co.nz`. A viewer's chrome surrounds image content, and a bright interface
around a panorama wrecks your read of its exposure. That exception is recorded in
`traineffect-designer/clients/traineffect/360viewer-design-note.md`.

## Deploying

Git-connected Cloudflare Pages project:

1. Workers & Pages → Create → Pages → Connect to Git, and pick this repository
2. Framework preset **None**, build command **empty**, output directory **`/`**
3. Deploy

Note that a Pages project is fixed as either Git-connected or direct-upload when it is
created. Changing your mind later means a new project and moving the custom domain across.

### Custom domain

Project → Custom domains → `360viewer.traineffect.co.nz`. The zone is already on
Cloudflare DNS, so the CNAME and certificate are issued automatically, usually within a
couple of minutes.

## Behaviour worth knowing

**Decode ladder.** ICE exports can exceed the browser's decode budget. The viewer tries
full resolution first, then steps down through 8192, 4096 and 2048 pixels wide until one
succeeds. If every rung fails, the message reports the *first* error, which is the
informative one.

**Working canvas.** The decoded bitmap is drawn into a working canvas capped at 8192 wide
and then released. A full resolution 14848 x 6311 bitmap is roughly 375 MB, and holding
one for the session so the Gap control can recomposite is the wrong trade. The cap is
about video memory rather than the GPU's stated limit: a 2:1 RGBA texture at 8192 costs
about 134 MB, and at 16384 about 537 MB, which fails on integrated graphics.

**The `Gap` control.** A full sphere is 2:1. When a panorama is shorter than that it
covers less than 180 degrees vertically, and the viewer reports the actual coverage.
Rather than stretching the image to fill the sphere, which puts the horizon in the wrong
place, the missing band is filled by stretching the adjacent edge row. `Gap` cycles where
that band sits: top, centre, or bottom. Drone panoramas normally have full nadir coverage
and a hole at zenith, so `top` is the default.

A source *taller* than 2:1 claims more than 180 degrees of vertical coverage, which an
equirectangular projection cannot mean. Those are fitted by width and cropped evenly top
and bottom rather than squashed, and the strip says so.

**Canvas round trip.** The texture is composited through a 2D canvas before it reaches
three.js. This is deliberate: `ImageBitmap` and `HTMLImageElement` disagree on Y origin
and the sphere renders upside down otherwise. Do not simplify it away.

**Touch.** One finger looks around. Two fingers zoom and pan together: spreading widens
the span between them, which narrows the field of view. Lifting one finger of a pinch
re-anchors on the one still down rather than jumping.

## Deliberately not built

**A hosted delivery mode**, where the panorama ships alongside the page so a client opens a
link rather than dragging a file in. Decided against on 2026-08-10: the viewer's job is
checking a stitch, and whoever is looking has the file. Adding hosting would also mean
deciding retention, link guessability and access periods, which is a lot of surface for a
tool that is one screen.

If it is ever wanted, it needs no CSP change. `img-src 'self'` already permits loading a
bundled same-origin image, and the canvas round trip means the `HTMLImageElement` path
drops straight in.

## The social card

`og.svg` is the source, `og.png` is what gets served, and both are committed because the
deploy has no build step. Regenerate after editing the SVG:

```bash
node scripts/render-og.mjs ../path-to-a-project-with-playwright/
```

It renders through headless Chromium rather than an SVG rasteriser because the card sets
type in Fraunces and Geist Mono, which are `@font-face` files here rather than installed
system fonts. A rasteriser falls back to Georgia without saying so, and the script refuses
to write a card if the fonts did not load. Playwright is not a dependency of this repo, so
point it at a project that has one.
