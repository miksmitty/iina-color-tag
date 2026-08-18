# IINA Color Tag

An [IINA](https://iina.io) plugin that applies a macOS Finder color tag to the
currently playing video file — tag the keepers without leaving the player.

Adds a **Tag Color** submenu to IINA's **Plugins** menu with the seven standard
Finder colors plus **None**. The current file's color shows a checkmark.
Custom (non-color) Finder tags on the file are preserved.

## How it works

Finder tags live in the `com.apple.metadata:_kMDItemUserTags` extended
attribute as a binary plist array of `"Name\nColorIndex"` strings. The plugin
reads and writes that attribute with the system `xattr` and `plutil` tools via
IINA's `utils.exec` API. No third-party binaries required.

## Install (development)

Symlink the repo into IINA's plugin folder with an `.iinaplugin-dev` suffix:

```sh
ln -s "$(pwd)" ~/Library/Application\ Support/com.colliderli.iina/plugins/iina-color-tag.iinaplugin-dev
```

Then restart IINA. If the Plugins menu/preferences tab is missing, enable the
plugin system first:

```sh
defaults write com.colliderli.iina iinaEnablePluginSystem true
```

While iterating, use the **Reload** button next to the plugin in
IINA Settings → Plugins.

## Usage

Play a local video file, then pick **Plugins → Tag Color → Red** (or any other
color). An OSD message confirms the tag. **None** removes the color tag
(custom tags are kept). Verify in Finder — the file shows the color dot.

You can assign keyboard shortcuts to the menu items in
**System Settings → Keyboard → Keyboard Shortcuts → App Shortcuts** for IINA,
using the exact menu item titles (e.g. `Red`).

## Limitations

- Only works for local files (`file://` URLs) — network streams have no
  Finder metadata.
- Files on volumes without extended-attribute support (some network shares)
  can't be tagged.
