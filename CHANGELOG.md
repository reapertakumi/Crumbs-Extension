# Changelog

All notable changes to Crumbs for Chrome. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

Each version is published as a release with an installable zip:
https://github.com/reapertakumi/Crumbs-Extension/releases

## [1.0.3] - 2026-11-22

### Added
- **Tags.** A tag icon left of the folder opens a menu to add tags as chips.
  Enter or a comma adds one, Backspace removes the last. A small number on the
  icon shows how many a crumb has. Tags of an already saved page are shown and
  can be changed.
- **Suggested tags** from the tags you already use, most used first. Turn them
  off with **Suggest tags** in the settings.
- **Find or create a folder.** Click the folder and type to find one by name,
  including subfolders (shown with their path). A name that doesn't exist yet
  offers **Create "name"**.
- The **✓** on the toolbar button now also shows on any page that's already
  in Crumbs, not only right after saving it. This needs the new `tabs`
  permission, so Chrome asks you to accept it when updating.
- Works with the encrypted Crumbs database: when Crumbs is locked after a
  restart, the popup and the settings say so and link to Crumbs to unlock it.
- Works with Crumbs over HTTPS as well as HTTP. Connecting asks for both on
  your Crumbs host, and a self-signed certificate or a Crumbs that now only
  answers on https:// gets a clear message with what to do.

### Changed
- The thumbnail preview is back to its full 16:9 size. The popup can scroll a
  little when the "already saved" notice is showing.
- The **+** button and the separate new-folder field are replaced by
  **Create** in the folder menu.

## [1.0.2] - 2026-11-22

### Added
- Your Crumbs profile picture and name in the popup header: your uploaded photo,
  one of the 28 built-in Crumbs icons, or the first letter of your name, the same
  as in Crumbs. It updates when you change it in Crumbs.
- The server address, centered at the bottom of the popup.
- A **Cancel** button for a new folder. Escape or **+** also closes it.
- In the settings, a refresh icon next to the connection status to check the
  connection again, and an ✕ icon to disconnect.

### Changed
- The big **Disconnect** button in the settings is replaced by the ✕ icon.
- **Open Crumbs** and **Sign in as someone else** moved lower, below a divider.

### Removed
- The notice on pages Crumbs can't save (like `chrome://` pages).

## [1.0.1] - 2026-11-22

### Fixed
- Updating a page you already saved no longer clears its tags. Crumbs replaces
  every field on update, so the popup now sends the saved tags back.

## [1.0.0] - 2026-11-22

### Added
- Save the current page to Crumbs from a toolbar popup, with its thumbnail,
  favicon, name, URL, folder and description filled in.
- Thumbnails from the page's preview image, the real YouTube thumbnail or the
  biggest image on the page, with a screenshot as a fallback. Flip through the
  choices, take a screenshot, upload, paste or drop your own, or remove it.
- Text you select on the page becomes the description.
- Folder picker with subfolders, remembers the last folder, and can create a
  new folder.
- Pages you already saved are spotted, and saving updates them instead of
  making a copy.
- Tracking parameters like `utm_source` are removed from saved links.
- Right-click menu: save the page, save a link, or save the page with the
  right-clicked image as its thumbnail.
- Keyboard shortcut **Alt + Shift + C**.
- A ✓ on the toolbar icon after saving a page.
- Settings page: connect to your Crumbs address, sign in with a token (or use
  your Crumbs sign-in in Chrome, or no sign-in when login is off), and switches
  for filling in the description, picking a thumbnail, remembering the last
  folder and closing after saving. All are on by default.
- Black and white look matching Crumbs, with light and dark mode.

[Unreleased]: https://github.com/reapertakumi/Crumbs-Extension/compare/v1.0.3...HEAD
[1.0.3]: https://github.com/reapertakumi/Crumbs-Extension/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/reapertakumi/Crumbs-Extension/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/reapertakumi/Crumbs-Extension/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/reapertakumi/Crumbs-Extension/releases/tag/v1.0.0
