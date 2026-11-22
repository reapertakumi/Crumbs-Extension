# Crumbs for Chrome

A Chrome extension for [Crumbs](https://github.com/reapertakumi/Crumbs), the
tiny bookmark manager for your Raspberry Pi. It drops the page you're on into
your Crumbs jar: thumbnail, name, URL, folder and description, filled in for you.

It works in Chrome, Edge, Brave and other Chromium browsers.

## Install

1. Download `crumbs-extension-vX.Y.Z.zip` from the
   [latest release](https://github.com/reapertakumi/Crumbs-Extension/releases/latest) and unzip it
   somewhere it can stay (Chrome loads it from that folder).
   Or clone this repo.
2. Open `chrome://extensions`, switch on **Developer mode** (top right), click
   **Load unpacked** and pick the unzipped folder.
3. The settings page opens. Type your Crumbs address, for example
   `192.168.1.20:9099` or `raspberrypi.local:9099`, and click **Connect**.
   Chrome asks you to let the extension talk to that address.
4. Sign in with your Crumbs account. If you're already signed in to Crumbs in
   Chrome, or login is turned off on your Crumbs, you can skip that.
5. Pin the cookie icon in the toolbar (the puzzle piece, then the pin).

## Saving a page

Click the cookie icon or press **Alt + Shift + C**. The popup fills in:

| Field | Where it comes from |
| --- | --- |
| **Thumbnail** | The page's preview image (`og:image`, `twitter:image`, the real YouTube thumbnail, or the biggest image on the page). If the page has none, a screenshot of what you see. |
| **Favicon** | The page's own icon, the one in the tab, or Chrome's cached one. Shown next to the name. |
| **Name** | The page's title, without the "- YouTube" style suffixes. |
| **URL** | The page address, with tracking junk like `?utm_source=` removed. |
| **Folder** | Your Crumbs folders and subfolders. Starts with the folder you used last. **+** makes a new one. |
| **Description** | Text you selected on the page, or else the page's description. |

The extension reads the page in your browser first, so it also works on pages
you're signed in to. When the page gives too little, it asks your Pi
(`/api/meta`), like the Crumbs web app does.

On the thumbnail, hover to flip through the other images (‹ ›), take a
**screenshot**, **upload** your own, or **remove** it. You can also paste
(Ctrl + V) or drop an image onto it. Images are made into the same 640×360
JPEG and 64×64 PNG favicon the web app makes, then uploaded to the Pi.

If the page is already in Crumbs, the popup says so, shows what you saved, and
**Update** changes that bookmark instead of making a copy.

Saved pages get a ✓ on the toolbar icon until you leave the page.

### Right-click menu

- **Save page to Crumbs**
- **Save link to Crumbs** saves the link without opening it. The Pi fetches
  its title, description and images.
- **Save page to Crumbs with this image** uses the image you right-clicked as
  the thumbnail.

## Settings

| Setting | Default |
| --- | --- |
| Fill in the description | On |
| Pick a thumbnail | On |
| Remember the last folder | On |
| Close after saving | On |

The title and favicon are always filled in. With the description or thumbnail
switched off, the popup still offers **Fill from page** and **Find preview**.

## Permissions

| Permission | Why |
| --- | --- |
| Your Crumbs address (asked when you connect) | To save bookmarks. Nothing else is ever contacted, except image downloads for thumbnails. |
| `activeTab`, `scripting` | To read the title, description and images of the page you're saving, only when you click the button. |
| `favicon` | To use Chrome's own copy of a site's icon. |
| `contextMenus` | The right-click entries. |
| `storage` | Your Crumbs address, sign-in and settings, stored on this computer. |

## Sign-in and the server

The extension signs in with its own token (`POST /api/token`), kept on this
computer. It lasts a year; **Disconnect** in the settings or changing your
Crumbs password ends it. Every request carries an `X-Crumbs-Client` header,
which is how Crumbs lets the extension past its cross-site protection while
still blocking other websites.

Update Crumbs on your Pi to a version with extension support. With an older
Crumbs the extension falls back to your normal Crumbs sign-in cookie, and
saving may fail with "Your Crumbs server blocked the extension".

## Releasing a new version

Add the changes under a new `## [x.y.z] - date` heading in
[CHANGELOG.md](CHANGELOG.md), bump `version` in `manifest.json`, commit, then
tag and push:

```sh
git tag v1.0.1
git push origin v1.0.1
```

GitHub Actions builds the zip and publishes the release, with that version's
changelog section as the release notes.

## Files

```
manifest.json   Chrome extension manifest (Manifest V3)
popup.*         the save popup
options.*       the settings page
background.js   right-click menu, first-run setup, ✓ badge
lib.js          talking to Crumbs, reading pages, making thumbnails
avatars.js      Crumbs' profile picture icons, so your avatar looks the same
ui.css          shared black & white styles
icons/          toolbar icons
.github/        the release workflow
```
