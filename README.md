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

### Keyboard shortcuts

Shortcuts work whenever the player window is focused:

| Shortcut | Action |
| --- | --- |
| ⌥1 | Red |
| ⌥2 | Orange |
| ⌥3 | Yellow |
| ⌥4 | Green |
| ⌥5 | Blue |
| ⌥6 | Purple |
| ⌥7 | Gray |
| ⌥0 | Remove color tag |
| ] | Next file in folder |
| [ | Previous file in folder |

**Next/Previous File in Folder** plays the adjacent video file from the same
folder (Finder-style name order), regardless of the playlist — handy for
triaging a folder: watch, tag with ⌥1–⌥7, then ] to move on.

When you navigate away from a file that has **no color tag**, it is
automatically tagged **Red** — so every file you've visited ends up tagged,
either explicitly by you or Red by default. Only the seven standard color
tags count as "tagged" here; custom Finder tags alone won't prevent the Red
default.

To change them, edit the `key` values in [main.js](main.js) (mpv
[key binding format](https://mpv.io/manual/stable/#key-names), e.g.
`Meta+Alt+1` for ⌘⌥1) and reload the plugin.

## Limitations

- Only works for local files (`file://` URLs) — network streams have no
  Finder metadata.
- Files on volumes without extended-attribute support (some network shares)
  can't be tagged.
